/**
 * AMPED-07C1 - SumUp webhook verification and the single path to `paid`.
 *
 * Every test is OFFLINE: the SumUp transport is an injected fake, the database
 * is a real ephemeral D1, and no API key is needed anywhere.
 *
 * The security claim under test is narrow and worth stating, because the
 * endpoint is deliberately unauthenticated:
 *
 *   the notification is a HINT. It carries no payment authority. Authenticity
 *   comes from an authenticated retrieval correlated against the local order.
 *
 * So the interesting tests are not "does a valid webhook work" but "what does
 * a hostile or merely wrong one fail to achieve".
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { openEphemeralDatabase } from '../../src/db/local.ts';
import { migrate } from '../../src/db/migrations.ts';
import { applySeed } from '../../src/db/seed.ts';
import {
  createD1OrderMutations,
  type CheckoutInput,
  type OrderMutationService,
} from '../../src/services/orders/service.ts';
import { createSumUpClient } from '../../src/services/payments/sumup/client.ts';
import {
  correlateCheckout,
  createSumUpPaymentVerifier,
  majorUnitsToPence,
} from '../../src/services/payments/sumup/verification.ts';
import { PaymentConfigurationError } from '../../src/services/payments/sumup/types.ts';
import type { PaymentProvider } from '../../src/services/contracts.ts';
import * as fixtures from './fixtures.ts';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/** The route reaches its dependencies only through the service locator. */
const hoisted = vi.hoisted(() => ({
  provide: null as null | (() => unknown),
}));

vi.mock('@/services/index.ts', () => ({
  getSumUpVerification: () => {
    if (!hoisted.provide) throw new PaymentConfigurationError();
    return hoisted.provide();
  },
}));

const { POST } = await import('../../src/pages/api/webhooks/sumup.ts');

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXED_NOW = new Date('2026-10-04T09:00:00.000Z');
const EVENT = 'evt_glass_hearts_nov';
const TYPE = 'tt_gh_ga';
const RETURN_URL = 'https://amped.test/checkout/return';
const MERCHANT = fixtures.FAKE_MERCHANT_CODE;

/** Post a real SumUp notification body at the real route handler. */
function deliver(body: unknown, raw?: string): Promise<Response> {
  const request = new Request('https://amped.test/api/webhooks/sumup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });
  return (POST as (ctx: { request: Request }) => Promise<Response>)({ request });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A retrieved-checkout payload that passes every correlation check. */
function paidCheckout(
  checkoutId: string,
  orderReference: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: checkoutId,
    status: 'PAID',
    checkout_reference: orderReference,
    amount: 20,
    currency: 'GBP',
    merchant_code: MERCHANT,
    transactions: [
      { id: `txn_${checkoutId}`, status: 'SUCCESSFUL', timestamp: '2026-10-04T09:05:00.000Z' },
    ],
    ...overrides,
  };
}

function checkoutInput(overrides: Partial<CheckoutInput> = {}): CheckoutInput {
  return {
    eventId: EVENT,
    items: [{ ticketTypeId: TYPE, quantity: 2 }],
    customerName: 'Webhook Probe',
    customerEmail: 'webhook-probe@example.com',
    marketingOptIn: false,
    ...overrides,
  };
}

describe('AMPED-07C1 webhook verification', () => {
  let database: Awaited<ReturnType<typeof openEphemeralDatabase>>;
  let db: D1Database;
  let counter = 0;
  let ticketsAtStart = 0;

  beforeAll(async () => {
    database = await openEphemeralDatabase();
    db = database.db;
    await migrate(db);
    await applySeed(db);
    ticketsAtStart = await ticketCount();
  });

  afterAll(async () => {
    await database.dispose();
  });

  beforeEach(() => {
    hoisted.provide = null;
  });

  function orders(now: () => Date = () => FIXED_NOW): OrderMutationService {
    return createD1OrderMutations(db, now, (p) => `${p}_w${++counter}`);
  }

  async function ticketCount(): Promise<number> {
    const row = await db.prepare('select count(*) as n from tickets').first<{ n: number }>();
    return row?.n ?? 0;
  }

  async function orderRow(id: string) {
    return db
      .prepare(
        'select reference, status, paid_at, total_in_pence, reservation_expires_at, payment_reference from orders where id = ?',
      )
      .bind(id)
      .first<Record<string, unknown>>();
  }

  async function countAudits(orderId: string, action: string): Promise<number> {
    const row = await db
      .prepare('select count(*) as n from audit_log where entity_id = ?1 and action = ?2')
      .bind(orderId, action)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  async function countObservations(key: string): Promise<number> {
    const row = await db
      .prepare(
        "select count(*) as n from processed_webhooks where provider = 'sumup' and provider_event_id = ?1",
      )
      .bind(key)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  async function committedFor(ticketTypeId: string, at: Date): Promise<number> {
    const row = await db
      .prepare(
        'select coalesce(sum(oi.quantity), 0) as n from order_items oi ' +
          'join orders o on o.id = oi.order_id ' +
          "where oi.ticket_type_id = ?1 and (o.status in ('paid', 'partially_refunded') " +
          "or (o.status = 'awaiting_payment' and julianday(o.reservation_expires_at) > julianday(?2)))",
      )
      .bind(ticketTypeId, at.toISOString())
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** An order sitting in awaiting_payment with a known checkout id. */
  async function reservedOrder(options: { expiresAt?: string } = {}) {
    counter += 1;
    const checkoutId = `chk-07c1-${counter}`;
    const expiresAt =
      options.expiresAt ?? new Date(FIXED_NOW.getTime() + 30 * 60_000).toISOString();
    const stub: PaymentProvider = {
      name: 'sumup',
      createCheckout: async () => ({
        checkoutId,
        redirectUrl: 'https://checkout.sumup.com/pay/stub',
        expiresAt,
      }),
      confirm: async () => ({ status: 'pending' as const }),
      verifyWebhook: async () => null,
    };
    const service = orders();
    const created = await service.createOrder(checkoutInput());
    const begun = await service.beginPayment(created.orderId, stub, RETURN_URL);
    return { service, orderId: created.orderId, reference: created.reference, checkoutId, begun };
  }

  /** Wire the route to a verifier backed by a scripted SumUp transport. */
  function wireRoute(
    steps: Array<() => Response | Promise<Response>>,
    service: OrderMutationService = orders(),
  ) {
    let calls = 0;
    const impl = (async () => {
      const step = steps[Math.min(calls, steps.length - 1)]!;
      calls += 1;
      return step();
    }) as typeof fetch;

    const verifier = createSumUpPaymentVerifier({
      client: createSumUpClient({
        apiKey: fixtures.FAKE_API_KEY,
        merchantCode: MERCHANT,
        fetchImpl: impl,
        sleep: async () => {},
      }),
      merchantCode: MERCHANT,
      orders: service,
      now: () => FIXED_NOW,
    });

    // Keep 07C assertions focused on payment. 08A's real-D1 suite exercises
    // the fulfilment seam, including concurrent webhook/recovery calls.
    hoisted.provide = () => ({
      orders: service,
      verifier,
      fulfilment: { issuePaidOrder: async () => ({ outcome: 'complete', issued: 0 }) },
    });
    return { retrievals: () => calls };
  }

  const notification = (id: string) => ({ event_type: 'CHECKOUT_STATUS_CHANGED', id });

  // == exact money ==========================================================

  describe('major units to pence', () => {
    it('converts exactly, without floating point', () => {
      expect(majorUnitsToPence(10)).toBe(1000);
      expect(majorUnitsToPence(10.5)).toBe(1050);
      expect(majorUnitsToPence('10.07')).toBe(1007);
      expect(majorUnitsToPence(0)).toBe(0);
      expect(majorUnitsToPence(0.01)).toBe(1);
      expect(majorUnitsToPence(1234.56)).toBe(123_456);
      // The classic float trap: 10.07 * 100 is 1006.9999999999999.
      expect(majorUnitsToPence(10.07)).toBe(1007);
      expect(majorUnitsToPence(8.3)).toBe(830);
    });

    it('rejects over-precision and anything not a plain decimal', () => {
      for (const bad of [
        10.005,
        '10.005',
        '1e3',
        '£10',
        '10,50',
        '',
        '   ',
        'abc',
        Number.NaN,
        Number.POSITIVE_INFINITY,
        null,
        undefined,
        {},
        [],
        true,
      ]) {
        expect(majorUnitsToPence(bad), String(bad)).toBeNull();
      }
    });
  });

  // == correlation (pure) ====================================================

  describe('correlation', () => {
    const local = {
      orderId: 'ord_x',
      reference: 'AMP-26-00001',
      status: 'awaiting_payment' as const,
      totalInPence: 2000,
      paymentReference: 'chk_x',
    };
    const now = () => FIXED_NOW;

    it('accepts a fully matching PAID checkout', () => {
      const outcome = correlateCheckout(paidCheckout('chk_x', 'AMP-26-00001'), local, MERCHANT, now);
      expect(outcome.kind).toBe('paid');
      if (outcome.kind !== 'paid') return;
      expect(outcome.verified.orderId).toBe('ord_x');
      expect(outcome.verified.transactionId).toBe('txn_chk_x');
      expect(outcome.verified.paidAt).toBe('2026-10-04T09:05:00.000Z');
      expect(outcome.verified.provider).toBe('sumup');
    });

    it.each([
      ['checkout-id-mismatch', { id: 'chk_other' }],
      ['reference-mismatch', { checkout_reference: 'AMP-26-99999' }],
      ['amount-mismatch', { amount: 19.99 }],
      ['amount-malformed', { amount: '20.005' }],
      ['currency-mismatch', { currency: 'EUR' }],
      ['merchant-mismatch', { merchant_code: 'SOMEONE_ELSE' }],
      ['no-successful-transaction', { transactions: [] }],
      ['no-successful-transaction', { transactions: [{ id: 't', status: 'FAILED' }] }],
    ])('refuses to credit a %s', (reason, override) => {
      const outcome = correlateCheckout(
        paidCheckout('chk_x', 'AMP-26-00001', override),
        local,
        MERCHANT,
        now,
      );
      expect(outcome.kind).toBe('mismatch');
      if (outcome.kind !== 'mismatch') return;
      expect(outcome.reason).toBe(reason);
    });

    it('marks only the unsettled-transaction case as worth retrying', () => {
      const unsettled = correlateCheckout(
        paidCheckout('chk_x', 'AMP-26-00001', { transactions: [] }),
        local,
        MERCHANT,
        now,
      );
      const wrongMoney = correlateCheckout(
        paidCheckout('chk_x', 'AMP-26-00001', { amount: 1 }),
        local,
        MERCHANT,
        now,
      );
      expect(unsettled.kind === 'mismatch' && unsettled.retryable).toBe(true);
      expect(wrongMoney.kind === 'mismatch' && wrongMoney.retryable).toBe(false);
    });

    it.each(['PENDING', 'FAILED', 'EXPIRED'])('reports %s as not-paid', (status) => {
      const outcome = correlateCheckout(
        paidCheckout('chk_x', 'AMP-26-00001', { status }),
        local,
        MERCHANT,
        now,
      );
      expect(outcome.kind).toBe('not-paid');
    });

    it('falls back to the local clock only when SumUp omits the timestamp', () => {
      const outcome = correlateCheckout(
        paidCheckout('chk_x', 'AMP-26-00001', {
          transactions: [{ id: 'txn_1', status: 'SUCCESSFUL' }],
        }),
        local,
        MERCHANT,
        now,
      );
      expect(outcome.kind).toBe('paid');
      if (outcome.kind !== 'paid') return;
      expect(outcome.verified.paidAt).toBe(FIXED_NOW.toISOString());
    });
  });

  // == the endpoint ==========================================================

  describe('endpoint behaviour', () => {
    it('acknowledges a verified payment and marks the order paid', async () => {
      const { orderId, reference, checkoutId } = await reservedOrder();
      wireRoute([() => jsonResponse(paidCheckout(checkoutId, reference))]);

      const response = await deliver(notification(checkoutId));
      expect(response.status).toBe(204);
      expect(await response.text()).toBe('');

      const row = await orderRow(orderId);
      expect(row?.status).toBe('paid');
      expect(row?.paid_at).toBe('2026-10-04T09:05:00.000Z');
      expect(await countAudits(orderId, 'order.paid')).toBe(1);
      expect(await countObservations(`sumup_txn:txn_${checkoutId}`)).toBe(1);
      expect(await ticketCount()).toBe(ticketsAtStart);
    });

    it('stores a SumUp nanosecond transaction timestamp in D1 millisecond form', async () => {
      const { orderId, reference, checkoutId } = await reservedOrder();
      wireRoute([() => jsonResponse(paidCheckout(checkoutId, reference, {
        transactions: [{
          id: `txn_${checkoutId}`,
          status: 'SUCCESSFUL',
          timestamp: '2026-10-04T09:05:00.52448389Z',
        }],
      }))]);

      const response = await deliver(notification(checkoutId));
      expect(response.status).toBe(204);
      expect((await orderRow(orderId))?.paid_at).toBe('2026-10-04T09:05:00.524Z');
      expect(await countAudits(orderId, 'order.paid')).toBe(1);
      expect(await countObservations(`sumup_txn:txn_${checkoutId}`)).toBe(1);
    });

    it.each([
      ['PENDING', 'PENDING'],
      ['FAILED', 'FAILED'],
      ['EXPIRED', 'EXPIRED'],
    ])('acknowledges %s without touching the order', async (_label, status) => {
      const { orderId, reference, checkoutId } = await reservedOrder();
      wireRoute([() => jsonResponse(paidCheckout(checkoutId, reference, { status }))]);

      const response = await deliver(notification(checkoutId));
      expect(response.status).toBe(204);

      const row = await orderRow(orderId);
      expect(row?.status).toBe('awaiting_payment');
      expect(row?.paid_at).toBeNull();
      expect(await countAudits(orderId, 'order.paid')).toBe(0);
      expect(await countAudits(orderId, 'order.expired')).toBe(0);
    });

    it.each([
      ['wrong checkout_reference', { checkout_reference: 'AMP-26-00000' }],
      ['wrong amount', { amount: 19.99 }],
      ['wrong currency', { currency: 'USD' }],
      ['wrong merchant', { merchant_code: 'NOT_US' }],
    ])('never pays an order on a PAID checkout with the %s', async (_label, override) => {
      const { orderId, reference, checkoutId } = await reservedOrder();
      wireRoute([() => jsonResponse(paidCheckout(checkoutId, reference, override))]);

      // Not retryable: the provider data will say the same thing next time.
      const response = await deliver(notification(checkoutId));
      expect(response.status).toBe(204);

      const row = await orderRow(orderId);
      expect(row?.status).toBe('awaiting_payment');
      expect(row?.paid_at).toBeNull();
      expect(await countAudits(orderId, 'order.paid')).toBe(0);
    });

    it('asks to be told again when PAID has no settled transaction yet', async () => {
      const { orderId, reference, checkoutId } = await reservedOrder();
      wireRoute([() => jsonResponse(paidCheckout(checkoutId, reference, { transactions: [] }))]);

      const response = await deliver(notification(checkoutId));
      expect(response.status).toBe(502);

      const row = await orderRow(orderId);
      expect(row?.status).toBe('awaiting_payment');
    });

    it('acknowledges an unknown local checkout without calling SumUp', async () => {
      const { retrievals } = wireRoute([() => jsonResponse({ status: 'PAID' })]);

      const response = await deliver(notification('chk-never-seen-here'));
      expect(response.status).toBe(204);
      expect(await response.text()).toBe('');
      // An unauthenticated caller must not be able to make us spend an
      // authenticated request on an id of their choosing.
      expect(retrievals()).toBe(0);
    });

    it('answers an unknown checkout exactly as it answers a known one', async () => {
      const { orderId, reference, checkoutId } = await reservedOrder();
      wireRoute([() => jsonResponse(paidCheckout(checkoutId, reference))]);
      const known = await deliver(notification(checkoutId));
      const unknown = await deliver(notification('chk-absent'));

      // No oracle: status and body are indistinguishable.
      expect(unknown.status).toBe(known.status);
      expect(await unknown.text()).toBe(await known.text());
      expect((await orderRow(orderId))?.status).toBe('paid');
    });

    it.each([
      ['unknown event type', { event_type: 'SOMETHING_NEW_ENTIRELY', id: 'chk-x' }],
      ['missing id', { event_type: 'CHECKOUT_STATUS_CHANGED' }],
      ['non-string id', { event_type: 'CHECKOUT_STATUS_CHANGED', id: 12345 }],
      ['empty id', { event_type: 'CHECKOUT_STATUS_CHANGED', id: '' }],
      ['array body', []],
      ['null body', null],
    ])('silently acknowledges %s', async (_label, body) => {
      const { retrievals } = wireRoute([() => jsonResponse({})]);
      const response = await deliver(body);
      expect(response.status).toBe(204);
      expect(await response.text()).toBe('');
      expect(retrievals()).toBe(0);
    });

    it('silently acknowledges malformed JSON', async () => {
      const { retrievals } = wireRoute([() => jsonResponse({})]);
      const response = await deliver(undefined, '{ "event_type": not json');
      expect(response.status).toBe(204);
      expect(retrievals()).toBe(0);
    });

    it('refuses an id shaped to pollute the logs, without retrieving it', async () => {
      const { retrievals } = wireRoute([() => jsonResponse({})]);
      for (const hostile of ['../../etc/passwd', 'a b', 'x\nFAKE LOG LINE', '<script>', 'x'.repeat(200)]) {
        const response = await deliver(notification(hostile));
        expect(response.status).toBe(204);
      }
      expect(retrievals()).toBe(0);
    });

    it('asks for a retry when SumUp cannot be reached, changing nothing', async () => {
      const { orderId, checkoutId } = await reservedOrder();
      wireRoute([
        () => {
          throw new TypeError('network down');
        },
      ]);
      expect((await deliver(notification(checkoutId))).status).toBe(502);

      wireRoute([
        () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          throw error;
        },
      ]);
      expect((await deliver(notification(checkoutId))).status).toBe(502);

      wireRoute([() => jsonResponse(fixtures.ERROR_500, 500)]);
      expect((await deliver(notification(checkoutId))).status).toBe(502);

      const row = await orderRow(orderId);
      expect(row?.status).toBe('awaiting_payment');
      expect(await countAudits(orderId, 'order.paid')).toBe(0);
    });

    it('asks for a retry when the integration is not configured', async () => {
      hoisted.provide = null;
      const response = await deliver(notification('chk-anything'));
      // A real payment must not be discarded because a credential is missing.
      expect(response.status).toBe(502);
    });

    it('is harmless when replayed after the order is already paid', async () => {
      const { orderId, reference, checkoutId } = await reservedOrder();
      wireRoute([() => jsonResponse(paidCheckout(checkoutId, reference))]);

      await deliver(notification(checkoutId));
      const first = await orderRow(orderId);

      for (let i = 0; i < 3; i += 1) {
        expect((await deliver(notification(checkoutId))).status).toBe(204);
      }

      const after = await orderRow(orderId);
      expect(after?.status).toBe('paid');
      expect(after?.paid_at).toBe(first?.paid_at);
      expect(await countAudits(orderId, 'order.paid')).toBe(1);
      expect(await countObservations(`sumup_txn:txn_${checkoutId}`)).toBe(1);
    });
  });

  // == the case that forbids checkout-id dedupe ==============================

  describe('FAILED then PAID on one checkout', () => {
    it('neither expires the order nor blocks the later real payment', async () => {
      const { orderId, reference, checkoutId } = await reservedOrder();

      // Attempt one declines. This is the sequence observed for real during
      // AMPED-07B certification: one checkout, several attempts.
      wireRoute([
        () =>
          jsonResponse(
            paidCheckout(checkoutId, reference, {
              status: 'FAILED',
              transactions: [{ id: 'txn_fail_1', status: 'FAILED', timestamp: '2026-10-04T09:01:00.000Z' }],
            }),
          ),
      ]);
      expect((await deliver(notification(checkoutId))).status).toBe(204);

      const afterFailure = await orderRow(orderId);
      // The hold MUST survive: the customer can still retry on SumUp's page.
      expect(afterFailure?.status).toBe('awaiting_payment');
      expect(afterFailure?.reservation_expires_at).not.toBeNull();
      expect(await countAudits(orderId, 'order.expired')).toBe(0);

      // Attempt two succeeds, on the SAME checkout id.
      wireRoute([
        () =>
          jsonResponse(
            paidCheckout(checkoutId, reference, {
              transactions: [
                { id: 'txn_fail_1', status: 'FAILED', timestamp: '2026-10-04T09:01:00.000Z' },
                { id: 'txn_ok_2', status: 'SUCCESSFUL', timestamp: '2026-10-04T09:02:00.000Z' },
              ],
            }),
          ),
      ]);
      expect((await deliver(notification(checkoutId))).status).toBe(204);

      const afterSuccess = await orderRow(orderId);
      expect(afterSuccess?.status).toBe('paid');
      expect(afterSuccess?.paid_at).toBe('2026-10-04T09:02:00.000Z');
      expect(await countAudits(orderId, 'order.paid')).toBe(1);

      // Keyed on the TRANSACTION, so the earlier failure never suppressed it.
      expect(await countObservations('sumup_txn:txn_ok_2')).toBe(1);
      expect(await countObservations(`sumup_txn:${checkoutId}`)).toBe(0);
    });
  });

  // == concurrency ===========================================================

  describe('concurrent duplicate deliveries', () => {
    it('produces exactly one transition, audit and observation for N=8', async () => {
      const { orderId, reference, checkoutId } = await reservedOrder();
      const committedBefore = await committedFor(TYPE, FIXED_NOW);

      // One shared service and one shared transport, as a real deployment
      // would have: the correctness must come from D1, not from isolation.
      wireRoute([() => jsonResponse(paidCheckout(checkoutId, reference))]);

      const responses = await Promise.all(
        Array.from({ length: 8 }, () => deliver(notification(checkoutId))),
      );

      expect(responses).toHaveLength(8);
      for (const response of responses) {
        expect(response.status).toBe(204);
        expect(await response.text()).toBe('');
      }
      expect(responses.filter((r) => r.status >= 500)).toHaveLength(0);

      const row = await orderRow(orderId);
      expect(row?.status).toBe('paid');
      expect(row?.paid_at).toBe('2026-10-04T09:05:00.000Z');

      // The defect this slice fixed: the update was conditional but the audit
      // insert was not, so N concurrent deliveries wrote N audit rows.
      expect(await countAudits(orderId, 'order.paid')).toBe(1);
      expect(await countObservations(`sumup_txn:txn_${checkoutId}`)).toBe(1);

      // The order was already holding its stock, so confirming it commits the
      // same quantity rather than adding any.
      expect(await committedFor(TYPE, FIXED_NOW)).toBe(committedBefore);
      expect(await ticketCount()).toBe(ticketsAtStart);
    });

    it('cannot both pay and expire the same order', async () => {
      // A hold on the knife edge: the sweep is run for an instant after it
      // lapses, concurrently with a verified payment arriving.
      const expiresAt = new Date(FIXED_NOW.getTime() + 60_000).toISOString();
      const { orderId, reference, checkoutId } = await reservedOrder({ expiresAt });
      const sweepClock = new Date(Date.parse(expiresAt) + 1000);

      wireRoute([() => jsonResponse(paidCheckout(checkoutId, reference))]);
      const sweeper = orders(() => sweepClock);

      await Promise.all([
        deliver(notification(checkoutId)),
        sweeper.expireDueReservations(sweepClock),
        deliver(notification(checkoutId)),
      ]);

      const row = await orderRow(orderId);
      const paid = await countAudits(orderId, 'order.paid');
      const expired = await countAudits(orderId, 'order.expired');

      // Exactly one outcome, and the audit trail agrees with the row.
      expect(['paid', 'expired']).toContain(row?.status);
      expect(paid + expired).toBe(1);
      if (row?.status === 'paid') {
        expect(paid).toBe(1);
        expect(row?.paid_at).not.toBeNull();
      } else {
        expect(expired).toBe(1);
        expect(row?.paid_at).toBeNull();
      }
      expect(await ticketCount()).toBe(ticketsAtStart);
    });

    it('refuses to pay an order whose hold has already been swept', async () => {
      const expiresAt = new Date(FIXED_NOW.getTime() + 60_000).toISOString();
      const { orderId, reference, checkoutId } = await reservedOrder({ expiresAt });

      const sweepClock = new Date(Date.parse(expiresAt) + 1000);
      await orders(() => sweepClock).expireDueReservations(sweepClock);
      expect((await orderRow(orderId))?.status).toBe('expired');

      // SumUp says PAID, but the stock is already back on sale. The handler
      // acknowledges (a retry cannot fix it) and leaves the discrepancy for
      // AMPED-07D rather than resurrecting released inventory.
      wireRoute([() => jsonResponse(paidCheckout(checkoutId, reference))]);
      expect((await deliver(notification(checkoutId))).status).toBe(204);

      const row = await orderRow(orderId);
      expect(row?.status).toBe('expired');
      expect(row?.paid_at).toBeNull();
      expect(await countAudits(orderId, 'order.paid')).toBe(0);
    });
  });

  // == structural guarantees =================================================

  describe('one writer to paid', () => {
    it('has exactly one SQL statement that sets status to paid', () => {
      const service = readFileSync(join(root, 'src', 'services', 'orders', 'service.ts'), 'utf8');
      const writers = service.match(/set status = 'paid'/g) ?? [];
      expect(writers).toHaveLength(1);
    });

    it('performs no provider I/O inside the confirmation primitive', () => {
      const service = readFileSync(join(root, 'src', 'services', 'orders', 'service.ts'), 'utf8');
      const start = service.indexOf('async applyVerifiedPayment(');
      const end = service.indexOf('async findOrderByPaymentReference(');
      expect(start).toBeGreaterThan(-1);
      const body = service.slice(start, end);
      expect(body).not.toMatch(/\bfetch\s*\(/);
      expect(body).not.toContain('provider.confirm');
      expect(body).not.toContain('createCheckout');
    });

    it('no longer expires an order because a payment attempt failed', () => {
      const service = readFileSync(join(root, 'src', 'services', 'orders', 'service.ts'), 'utf8');
      expect(service).not.toContain('Payment failed for');
    });

    it('keeps the webhook route free of credentials and SQL', () => {
      const route = readFileSync(
        join(root, 'src', 'pages', 'api', 'webhooks', 'sumup.ts'),
        'utf8',
      );
      // Comments may explain why there is no signature; code may not pretend
      // to check one.
      const code = route
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(code).not.toMatch(/SUMUP_API_KEY|SUMUP_MERCHANT_CODE|Bearer/);
      expect(code).not.toMatch(/\bselect\b.*\bfrom\b/i);
      expect(code).not.toMatch(/\bfetch\s*\(/);
      // No signature theatre: there is nothing to verify cryptographically.
      expect(code).not.toMatch(/signature|hmac|x-sumup/i);
    });

    it('has no SUMUP_WEBHOOK_SECRET left in the configuration surface', () => {
      const example = readFileSync(join(root, '.dev.vars.example'), 'utf8');
      expect(example).not.toContain('SUMUP_WEBHOOK_SECRET=');
      expect(example).toContain('SUMUP_WEBHOOK_URL');
    });
  });

  describe('payment reference identity', () => {
    it('refuses two orders sharing one checkout id', async () => {
      const first = await reservedOrder();
      await expect(
        db
          .prepare('update orders set payment_reference = ?1 where id = ?2')
          .bind(first.checkoutId, 'ord_seed_does_not_exist')
          .run(),
      ).resolves.toBeDefined();

      const second = await reservedOrder();
      await expect(
        db
          .prepare('update orders set payment_reference = ?1 where id = ?2')
          .bind(first.checkoutId, second.orderId)
          .run(),
      ).rejects.toThrow(/UNIQUE/i);
    });

    it('still allows many orders with no payment reference', async () => {
      const row = await db
        .prepare('select count(*) as n from orders where payment_reference is null')
        .first<{ n: number }>();
      expect((row?.n ?? 0) > 1).toBe(true);
    });

    it('holds across the whole seeded dataset', async () => {
      const dupes = await db
        .prepare(
          'select payment_reference, count(*) as n from orders ' +
            'where payment_reference is not null group by payment_reference having count(*) > 1',
        )
        .all<{ payment_reference: string; n: number }>();
      expect(dupes.results).toEqual([]);
    });
  });
});
