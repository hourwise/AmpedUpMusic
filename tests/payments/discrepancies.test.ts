/**
 * AMPED-07D2-2 - durable payment discrepancy detection.
 *
 * The governing policy under test:
 *
 *   once `reservation_expires_at` has passed, the seats are back on sale, so
 *   the order can NEVER afterwards become paid - no matter when the provider
 *   says the money moved.
 *
 * That protects the room from being sold twice. These tests exist to prove it
 * does not quietly cost a customer their money instead: when SumUp holds cash
 * we cannot attach, a durable financial record must appear exactly once.
 *
 * Offline throughout: fake SumUp transport, real ephemeral D1, no API key.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
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
import { createSumUpPaymentVerifier } from '../../src/services/payments/sumup/verification.ts';
import {
  createD1DiscrepancyStore,
  discrepancyIdentityKey,
  DISCREPANCY_CANDIDATE_SQL,
  type DiscrepancyStore,
} from '../../src/services/payments/discrepancies.ts';
import {
  detectPaymentDiscrepancies,
  DISCREPANCY_BATCH_SIZE,
  DISCREPANCY_WINDOW_MINUTES,
} from '../../src/services/payments/discrepancy-detection.ts';
import { reconcileSumUpPayments } from '../../src/services/payments/reconciliation.ts';
import { PaymentConfigurationError } from '../../src/services/payments/sumup/types.ts';
import type { PaymentProvider } from '../../src/services/contracts.ts';
import * as fixtures from './fixtures.ts';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const hoisted = vi.hoisted(() => ({
  verification: null as null | (() => unknown),
}));

vi.mock('@/services/index.ts', () => ({
  getSumUpVerification: () => {
    if (!hoisted.verification) throw new PaymentConfigurationError();
    return hoisted.verification();
  },
}));

const { POST } = await import('../../src/pages/api/webhooks/sumup.ts');

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXED_NOW = new Date('2026-10-05T12:00:00.000Z');
const EVENT = 'evt_glass_hearts_nov';
const TYPE = 'tt_gh_ga';
const RETURN_URL = 'https://amped.test/checkout/return';
const MERCHANT = fixtures.FAKE_MERCHANT_CODE;
const PAID_AT = '2026-10-05T11:58:00.000Z';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

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
    transactions: [{ id: `txn_${checkoutId}`, status: 'SUCCESSFUL', timestamp: PAID_AT }],
    ...overrides,
  };
}

function checkoutInput(overrides: Partial<CheckoutInput> = {}): CheckoutInput {
  return {
    eventId: EVENT,
    items: [{ ticketTypeId: TYPE, quantity: 2 }],
    customerName: 'Discrepancy Probe',
    customerEmail: 'discrepancy-probe@example.com',
    marketingOptIn: false,
    ...overrides,
  };
}

describe('AMPED-07D2-2 payment discrepancies', () => {
  let database: Awaited<ReturnType<typeof openEphemeralDatabase>>;
  let db: D1Database;
  let store: DiscrepancyStore;
  let counter = 0;
  let ticketsAtStart = 0;

  beforeAll(async () => {
    database = await openEphemeralDatabase();
    db = database.db;
    await migrate(db);
    await applySeed(db);
    // Park seeded awaiting_payment holds far outside every detection window.
    await db
      .prepare(
        "update orders set reservation_expires_at = '2020-01-01T00:00:00.000Z' " +
          "where status = 'awaiting_payment'",
      )
      .run();
    store = createD1DiscrepancyStore(db, (p) => `${p}_t${++counter}`);
    ticketsAtStart = await ticketCount();
  });

  afterAll(async () => {
    await database.dispose();
  });

  beforeEach(() => {
    hoisted.verification = null;
  });

  function orders(now: () => Date = () => FIXED_NOW): OrderMutationService {
    return createD1OrderMutations(db, now, (p) => `${p}_x${++counter}`);
  }

  async function ticketCount(): Promise<number> {
    const row = await db.prepare('select count(*) as n from tickets').first<{ n: number }>();
    return row?.n ?? 0;
  }

  async function orderRow(id: string) {
    return db
      .prepare('select reference, status, paid_at, reservation_expires_at from orders where id = ?')
      .bind(id)
      .first<Record<string, unknown>>();
  }

  async function discrepanciesFor(orderId: string) {
    const rows = await db
      .prepare('select * from payment_discrepancies where order_id = ? order by detected_at')
      .bind(orderId)
      .all<Record<string, unknown>>();
    return rows.results;
  }

  async function eventsFor(orderId: string) {
    const rows = await db
      .prepare(
        'select e.* from payment_discrepancy_events e ' +
          'join payment_discrepancies d on d.id = e.discrepancy_id ' +
          'where d.order_id = ? order by e.occurred_at',
      )
      .bind(orderId)
      .all<Record<string, unknown>>();
    return rows.results;
  }

  /**
   * An order in awaiting_payment whose hold expires at a chosen instant.
   * `expiresAt` in the past yields a lapsed-but-unswept order, which is
   * exactly the boundary case this slice is about.
   */
  async function reservedOrder(expiresAt: string) {
    counter += 1;
    const checkoutId = `chk-d2-${counter}`;
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
    // Reserve with a clock before the chosen expiry so acquisition succeeds,
    // then let the real clock be whatever the test needs.
    const reserveClock = new Date(Date.parse(expiresAt) - 60_000);
    const service = orders(() => reserveClock);
    const created = await service.createOrder(checkoutInput());
    await service.beginPayment(created.orderId, stub, RETURN_URL);
    return { orderId: created.orderId, reference: created.reference, checkoutId };
  }

  function verifierFor(responder: (checkoutId: string) => Response | Promise<Response>) {
    let retrievals = 0;
    const impl = (async (input: RequestInfo | URL) => {
      retrievals += 1;
      const url = String(input);
      const id = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
      return responder(id);
    }) as typeof fetch;

    const service = orders();
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
    hoisted.verification = () => ({ orders: service, verifier });
    return { verifier, orders: service, retrievals: () => retrievals };
  }

  function detect(
    verifier: ReturnType<typeof verifierFor>['verifier'],
    overrides: { now?: Date; batchSize?: number; concurrency?: number } = {},
  ) {
    const { now, ...rest } = overrides;
    return detectPaymentDiscrepancies({
      store,
      verifier,
      now: () => now ?? FIXED_NOW,
      log: () => {},
      ...rest,
    });
  }

  const lapsed = (minutesAgo: number) =>
    new Date(FIXED_NOW.getTime() - minutesAgo * 60_000).toISOString();

  // == the core case ========================================================

  describe('money SumUp holds that we cannot credit', () => {
    it('records a discrepancy for a payment found just after expiry', async () => {
      const { orderId, reference, checkoutId } = await reservedOrder(lapsed(1));
      const seam = verifierFor((id) => jsonResponse(paidCheckout(id, reference)));

      const summary = await detect(seam.verifier);
      expect(summary.created).toBe(1);

      const rows = await discrepanciesFor(orderId);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.kind).toBe('paid_after_expiry');
      expect(row.state).toBe('open');
      expect(row.identity_key).toBe(`sumup_txn:txn_${checkoutId}`);
      expect(row.transaction_id).toBe(`txn_${checkoutId}`);
      expect(row.provider_amount_in_pence).toBe(2000);
      expect(row.local_amount_in_pence).toBe(2000);
      expect(row.provider_paid_at).toBe(PAID_AT);
      expect(row.resolved_at).toBeNull();

      // The order is untouched. This is the whole point.
      const order = await orderRow(orderId);
      expect(order?.status).toBe('awaiting_payment');
      expect(order?.paid_at).toBeNull();
      expect(await ticketCount()).toBe(ticketsAtStart);

      const events = await eventsFor(orderId);
      expect(events).toHaveLength(1);
      expect(events[0]!.event).toBe('detected');
      expect(events[0]!.actor).toBe('system:sumup-reconcile');
    });

    it('records paid_order_expired once bookkeeping has swept the order', async () => {
      const { orderId, reference } = await reservedOrder(lapsed(2));
      await orders(() => FIXED_NOW).expireDueReservations(FIXED_NOW);
      expect((await orderRow(orderId))?.status).toBe('expired');

      const seam = verifierFor((id) => jsonResponse(paidCheckout(id, reference)));
      await detect(seam.verifier);

      const rows = await discrepanciesFor(orderId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.kind).toBe('paid_order_expired');
      expect((await orderRow(orderId))?.status).toBe('expired');
    });

    it('records an amount mismatch when a completed payment disagrees on price', async () => {
      const { orderId, reference } = await reservedOrder(lapsed(1));
      const seam = verifierFor((id) => jsonResponse(paidCheckout(id, reference, { amount: 19.5 })));
      await detect(seam.verifier);

      const rows = await discrepanciesFor(orderId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.kind).toBe('amount_mismatch');
      expect(rows[0]!.provider_amount_in_pence).toBe(1950);
      expect(rows[0]!.local_amount_in_pence).toBe(2000);
    });

    it('records a correlation mismatch when a completed payment cannot be attached', async () => {
      const { orderId, reference } = await reservedOrder(lapsed(1));
      const seam = verifierFor((id) =>
        jsonResponse(paidCheckout(id, reference, { merchant_code: 'SOMEONE_ELSE' })),
      );
      await detect(seam.verifier);

      const rows = await discrepanciesFor(orderId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.kind).toBe('correlation_mismatch');
    });
  });

  // == what must NOT create a financial record ==============================

  describe('operational conditions are not financial records', () => {
    async function expectNoDiscrepancy(responder: (id: string, ref: string) => unknown) {
      const { orderId, reference } = await reservedOrder(lapsed(1));
      const seam = verifierFor((id) => jsonResponse(responder(id, reference)));
      const summary = await detect(seam.verifier);

      expect(await discrepanciesFor(orderId)).toHaveLength(0);
      expect((await orderRow(orderId))?.status).toBe('awaiting_payment');
      await db.prepare('delete from orders where id = ?').bind(orderId).run();
      return summary;
    }

    it('creates nothing for PENDING', async () => {
      const summary = await expectNoDiscrepancy((id, ref) =>
        paidCheckout(id, ref, { status: 'PENDING', transactions: [] }),
      );
      expect(summary.clear).toBe(1);
      expect(summary.created).toBe(0);
    });

    it('creates nothing for an ordinary decline', async () => {
      const summary = await expectNoDiscrepancy((id, ref) =>
        paidCheckout(id, ref, {
          status: 'FAILED',
          transactions: [{ id: 'txn_f', status: 'FAILED', timestamp: PAID_AT }],
        }),
      );
      expect(summary.clear).toBe(1);
    });

    it('creates nothing for a checkout that expired unpaid', async () => {
      const summary = await expectNoDiscrepancy((id, ref) =>
        paidCheckout(id, ref, { status: 'EXPIRED', transactions: [] }),
      );
      expect(summary.clear).toBe(1);
    });

    it('creates nothing, and mutates nothing, when SumUp cannot be reached', async () => {
      const { orderId } = await reservedOrder(lapsed(1));
      const seam = verifierFor(() => {
        throw new TypeError('network down');
      });
      const summary = await detect(seam.verifier);

      expect(summary.retrievalFailures).toBe(1);
      expect(summary.created).toBe(0);
      expect(await discrepanciesFor(orderId)).toHaveLength(0);
      expect((await orderRow(orderId))?.status).toBe('awaiting_payment');
      await db.prepare('delete from orders where id = ?').bind(orderId).run();
    });

    it('still records money when an EXPIRED checkout nonetheless shows a successful payment', async () => {
      // The discriminator is money, not status: a checkout can lapse after
      // the payment settled, and that money is still ours to refund.
      const { orderId, reference } = await reservedOrder(lapsed(1));
      const seam = verifierFor((id) =>
        jsonResponse(paidCheckout(id, reference, { status: 'EXPIRED' })),
      );
      await detect(seam.verifier);
      expect(await discrepanciesFor(orderId)).toHaveLength(1);
    });
  });

  // == the expiry boundary ==================================================

  describe('boundary', () => {
    it('one tick BEFORE expiry is ordinary reconciliation, not a discrepancy', async () => {
      const expiresAt = new Date(FIXED_NOW.getTime() + 1000).toISOString();
      const { orderId, reference } = await reservedOrder(expiresAt);
      const seam = verifierFor((id) => jsonResponse(paidCheckout(id, reference)));

      // The hold is live, so it is not even a detection candidate.
      const detection = await detect(seam.verifier);
      expect(await discrepanciesFor(orderId)).toHaveLength(0);
      expect(detection.created).toBe(0);

      // And ordinary reconciliation pays it, as it should.
      const reconciled = await reconcileSumUpPayments({
        orders: seam.orders,
        verifier: seam.verifier,
        now: () => FIXED_NOW,
        log: () => {},
      });
      expect(reconciled.paid).toBe(1);
      expect((await orderRow(orderId))?.status).toBe('paid');
      expect(await discrepanciesFor(orderId)).toHaveLength(0);
    });

    it('EXACTLY at the expiry timestamp counts as lapsed', async () => {
      // The reservation predicate is strictly `>`, so `== now` is already
      // expired and the seats are already back on sale.
      const expiresAt = FIXED_NOW.toISOString();
      const { orderId, reference } = await reservedOrder(expiresAt);
      const seam = verifierFor((id) => jsonResponse(paidCheckout(id, reference)));

      const reconciled = await reconcileSumUpPayments({
        orders: seam.orders,
        verifier: seam.verifier,
        now: () => FIXED_NOW,
        log: () => {},
      });
      expect(reconciled.paid).toBe(0);
      expect((await orderRow(orderId))?.status).toBe('awaiting_payment');

      await detect(seam.verifier);
      expect(await discrepanciesFor(orderId)).toHaveLength(1);
      expect((await orderRow(orderId))?.status).toBe('awaiting_payment');
    });

    it('one tick AFTER expiry is a discrepancy and can never be paid', async () => {
      const expiresAt = new Date(FIXED_NOW.getTime() - 1000).toISOString();
      const { orderId, reference } = await reservedOrder(expiresAt);
      const seam = verifierFor((id) => jsonResponse(paidCheckout(id, reference)));

      const reconciled = await reconcileSumUpPayments({
        orders: seam.orders,
        verifier: seam.verifier,
        now: () => FIXED_NOW,
        log: () => {},
      });
      expect(reconciled.paid).toBe(0);

      await detect(seam.verifier);
      const order = await orderRow(orderId);
      expect(order?.status).toBe('awaiting_payment');
      expect(order?.paid_at).toBeNull();
      expect(await discrepanciesFor(orderId)).toHaveLength(1);
    });
  });

  // == idempotency ==========================================================

  describe('idempotency', () => {
    it('creates exactly one row across repeated passes', async () => {
      const { orderId, reference } = await reservedOrder(lapsed(1));
      const seam = verifierFor((id) => jsonResponse(paidCheckout(id, reference)));

      const first = await detect(seam.verifier);
      const second = await detect(seam.verifier);
      const third = await detect(seam.verifier);

      expect(first.created).toBe(1);
      expect(second.created).toBe(0);
      expect(third.created).toBe(0);
      expect(await discrepanciesFor(orderId)).toHaveLength(1);
      // Repeated observation of an unresolved problem is not new information.
      expect(await eventsFor(orderId)).toHaveLength(1);
    });

    it('creates exactly one row under N concurrent detectors', async () => {
      const { orderId, reference } = await reservedOrder(lapsed(1));
      const seam = verifierFor((id) => jsonResponse(paidCheckout(id, reference)));

      const summaries = await Promise.all(
        Array.from({ length: 8 }, () => detect(seam.verifier)),
      );

      expect(await discrepanciesFor(orderId)).toHaveLength(1);
      expect(await eventsFor(orderId)).toHaveLength(1);
      expect(summaries.reduce((total, s) => total + s.created, 0)).toBe(1);
    });

    it('does not create a second row when a transaction id settles later', async () => {
      // First seen as a PAID checkout with nothing yet naming the payment, so
      // the identity falls back to the checkout. When the transaction later
      // settles, the PREFERRED identity differs - and a naive insert would
      // record the same money twice.
      //
      // The detector cannot actually reach this, because a recorded order
      // stops being a candidate (proved separately). The store is guarded
      // anyway, because that is the layer the guarantee belongs to.
      const { orderId, reference, checkoutId } = await reservedOrder(lapsed(1));

      const unsettled = verifierFor((id) =>
        jsonResponse(paidCheckout(id, reference, { transactions: [] })),
      );
      await detect(unsettled.verifier);

      const rows = await discrepanciesFor(orderId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.identity_key).toBe(`sumup_checkout:${checkoutId}`);
      expect(rows[0]!.transaction_id).toBeNull();

      // The same money, now named, arriving with a different identity key.
      const second = await store.record(
        {
          identityKey: `sumup_txn:txn_${checkoutId}`,
          orderId,
          provider: 'sumup',
          checkoutId,
          transactionId: `txn_${checkoutId}`,
          kind: 'paid_after_expiry',
          providerAmountInPence: 2000,
          localAmountInPence: 2000,
          providerPaidAt: PAID_AT,
          reservationExpiresAt: lapsed(1),
        },
        FIXED_NOW,
      );

      expect(second.created).toBe(false);
      expect(await discrepanciesFor(orderId)).toHaveLength(1);
      expect(await eventsFor(orderId)).toHaveLength(1);
    });

    it('derives identity deterministically and never randomly', () => {
      const withTxn = {
        provider: 'sumup',
        checkoutId: 'chk_1',
        transactionId: 'txn_1',
      };
      const withoutTxn = { provider: 'sumup', checkoutId: 'chk_1', transactionId: null };

      expect(discrepancyIdentityKey(withTxn)).toBe('sumup_txn:txn_1');
      expect(discrepancyIdentityKey(withTxn)).toBe(discrepancyIdentityKey(withTxn));
      expect(discrepancyIdentityKey(withoutTxn)).toBe('sumup_checkout:chk_1');
      expect(discrepancyIdentityKey(withoutTxn)).toBe(discrepancyIdentityKey(withoutTxn));
      expect(discrepancyIdentityKey(withTxn)).not.toBe(discrepancyIdentityKey(withoutTxn));
    });

    it('refuses a duplicate identity key at the database level', async () => {
      const { orderId } = await reservedOrder(lapsed(1));
      const insert = (id: string, order: string, checkout: string, key: string) =>
        db
          .prepare(
            'insert into payment_discrepancies (id, identity_key, order_id, provider, checkout_id, ' +
              'kind, local_amount_in_pence, reservation_expires_at, state, detected_at, last_checked_at) ' +
              "values (?1, ?2, ?3, 'sumup', ?4, 'paid_after_expiry', 2000, ?5, 'open', ?5, ?5)",
          )
          .bind(id, key, order, checkout, FIXED_NOW.toISOString())
          .run();

      await insert('pdx_raw_1', orderId, 'chk_raw_1', 'sumup_txn:dup');
      const other = await reservedOrder(lapsed(1));
      await expect(
        insert('pdx_raw_2', other.orderId, 'chk_raw_2', 'sumup_txn:dup'),
      ).rejects.toThrow(/UNIQUE/i);
    });
  });

  // == interaction with the rest of the system ==============================

  describe('interaction', () => {
    it('reaches the same outcome whether it runs before or after the sweep', async () => {
      // The expiry boundary is the timestamp, not the sweep, so detection
      // must not depend on bookkeeping having run.
      const before = await reservedOrder(lapsed(1));
      const beforeSeam = verifierFor((id) => jsonResponse(paidCheckout(id, before.reference)));
      await detect(beforeSeam.verifier);
      await orders(() => FIXED_NOW).expireDueReservations(FIXED_NOW);

      const after = await reservedOrder(lapsed(1));
      await orders(() => FIXED_NOW).expireDueReservations(FIXED_NOW);
      const afterSeam = verifierFor((id) => jsonResponse(paidCheckout(id, after.reference)));
      await detect(afterSeam.verifier);

      const beforeRows = await discrepanciesFor(before.orderId);
      const afterRows = await discrepanciesFor(after.orderId);

      // Both produce exactly one durable record, and neither order is paid.
      expect(beforeRows).toHaveLength(1);
      expect(afterRows).toHaveLength(1);
      expect((await orderRow(before.orderId))?.paid_at).toBeNull();
      expect((await orderRow(after.orderId))?.paid_at).toBeNull();
      // The only difference is how the row reads, not whether it exists.
      expect(beforeRows[0]!.kind).toBe('paid_after_expiry');
      expect(afterRows[0]!.kind).toBe('paid_order_expired');
    });

    it('runs concurrently with the sweep without losing or duplicating the record', async () => {
      const { orderId, reference } = await reservedOrder(lapsed(1));
      const seam = verifierFor((id) => jsonResponse(paidCheckout(id, reference)));
      const sweeper = orders(() => FIXED_NOW);

      await Promise.all([
        detect(seam.verifier),
        sweeper.expireDueReservations(FIXED_NOW),
        detect(seam.verifier),
      ]);

      expect(await discrepanciesFor(orderId)).toHaveLength(1);
      const order = await orderRow(orderId);
      expect(order?.paid_at).toBeNull();
      expect(['awaiting_payment', 'expired']).toContain(order?.status);
    });

    it('cannot be used with a late webhook to revive a lapsed reservation', async () => {
      const { orderId, reference, checkoutId } = await reservedOrder(lapsed(1));
      const seam = verifierFor((id) => jsonResponse(paidCheckout(id, reference)));

      const [, webhook] = await Promise.all([
        detect(seam.verifier),
        (POST as (ctx: { request: Request }) => Promise<Response>)({
          request: new Request('https://amped.test/api/webhooks/sumup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event_type: 'CHECKOUT_STATUS_CHANGED', id: checkoutId }),
          }),
        }),
        detect(seam.verifier),
      ]);

      // The webhook is acknowledged, because retrying cannot help it.
      expect(webhook.status).toBe(204);
      const order = await orderRow(orderId);
      expect(order?.status).toBe('awaiting_payment');
      expect(order?.paid_at).toBeNull();
      expect(await discrepanciesFor(orderId)).toHaveLength(1);
      expect(await ticketCount()).toBe(ticketsAtStart);
    });
  });

  // == candidate selection ==================================================

  describe('candidate selection', () => {
    it('uses an index rather than scanning the orders table', async () => {
      const plan = await db
        .prepare('explain query plan ' + DISCREPANCY_CANDIDATE_SQL)
        .bind('sumup', FIXED_NOW.toISOString(), lapsed(DISCREPANCY_WINDOW_MINUTES), 20)
        .all<{ detail: string }>();
      const detail = plan.results.map((r) => r.detail).join(' | ');

      expect(detail).toMatch(/USING (COVERING )?INDEX/i);
      expect(detail).not.toMatch(/SCAN orders(?! USING)/i);
    });

    it('ignores orders outside the recent window', async () => {
      const old = await reservedOrder(lapsed(DISCREPANCY_WINDOW_MINUTES + 10));
      const seam = verifierFor((id) => jsonResponse(paidCheckout(id, old.reference)));
      await detect(seam.verifier);
      expect(await discrepanciesFor(old.orderId)).toHaveLength(0);
      expect(seam.retrievals()).toBe(0);
    });

    it('ignores orders with no payment reference', async () => {
      const service = orders();
      const created = await service.createOrder(checkoutInput());
      await db
        .prepare(
          "update orders set status = 'awaiting_payment', reservation_expires_at = ?1 where id = ?2",
        )
        .bind(lapsed(1), created.orderId)
        .run();

      const seam = verifierFor(() => jsonResponse({ status: 'PAID' }));
      await detect(seam.verifier);
      expect(await discrepanciesFor(created.orderId)).toHaveLength(0);
      await db.prepare('delete from orders where id = ?').bind(created.orderId).run();
    });

    it('stops probing an order once a discrepancy is recorded', async () => {
      const { orderId, reference } = await reservedOrder(lapsed(1));
      const seam = verifierFor((id) => jsonResponse(paidCheckout(id, reference)));

      await detect(seam.verifier);
      const afterFirst = seam.retrievals();
      await detect(seam.verifier);
      await detect(seam.verifier);

      // Already-recorded orders drop out of the candidate query entirely,
      // so repeated runs cost no further provider calls.
      expect(seam.retrievals()).toBe(afterFirst);
      expect(await discrepanciesFor(orderId)).toHaveLength(1);
    });

    it('bounds the batch', async () => {
      const made = [];
      for (let i = 0; i < 4; i += 1) made.push(await reservedOrder(lapsed(1)));
      const seam = verifierFor((id) =>
        jsonResponse({ id, status: 'PENDING', transactions: [] }),
      );
      const summary = await detect(seam.verifier, { batchSize: 2 });
      expect(summary.examined).toBe(2);
      for (const m of made) {
        await db.prepare('delete from orders where id = ?').bind(m.orderId).run();
      }
    });

    it('declares a window and batch derived from the lifecycle', () => {
      expect(DISCREPANCY_WINDOW_MINUTES).toBe(30);
      expect(DISCREPANCY_BATCH_SIZE).toBeGreaterThan(0);
      expect(DISCREPANCY_BATCH_SIZE).toBeLessThanOrEqual(50);
    });
  });

  // == structural guarantees ================================================

  describe('structure', () => {
    it('still has exactly one SQL statement that sets status to paid', () => {
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          if (statSync(full).isDirectory()) walk(full);
          else if (/\.(ts|astro)$/.test(entry)) files.push(full);
        }
      };
      walk(join(root, 'src'));

      const writers = files.flatMap((file) => {
        const matches = readFileSync(file, 'utf8').match(/set status = 'paid'/g) ?? [];
        return matches.map(() => file.replaceAll('\\', '/').split('/src/')[1]);
      });
      expect(writers).toEqual(['services/orders/service.ts']);
    });

    it('keeps the detector incapable of writing an order', () => {
      const source = readFileSync(
        join(root, 'src', 'services', 'payments', 'discrepancy-detection.ts'),
        'utf8',
      );
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code).not.toContain('applyVerifiedPayment');
      expect(code).not.toContain('db.prepare');
      expect(code).not.toMatch(/\bupdate\b.*\bset\b/i);
      expect(code).not.toMatch(/\bfetch\s*\(/);
    });

    it('stores no provider payload, credential or card data', () => {
      const store = readFileSync(
        join(root, 'src', 'services', 'payments', 'discrepancies.ts'),
        'utf8',
      );
      const sql = readFileSync(
        join(root, 'migrations', '0013_payment_discrepancies.sql'),
        'utf8',
      );
      const strip = (text: string) =>
        text
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*(\/\/|--).*$/gm, '');
      for (const source of [strip(store), strip(sql)]) {
        expect(source).not.toMatch(/customer_email|customer_name|card|pan\b|cvv|cvc/i);
        expect(source).not.toMatch(/raw_payload|response_body|Authorization|api_key/i);
      }
    });

    it('does not repurpose processed_webhooks', () => {
      const detector = readFileSync(
        join(root, 'src', 'services', 'payments', 'discrepancy-detection.ts'),
        'utf8',
      );
      const store = readFileSync(
        join(root, 'src', 'services', 'payments', 'discrepancies.ts'),
        'utf8',
      );
      expect(detector).not.toContain('processed_webhooks');
      expect(store).not.toContain('processed_webhooks');
    });

    it('writes only the open state in this slice', () => {
      const store = readFileSync(
        join(root, 'src', 'services', 'payments', 'discrepancies.ts'),
        'utf8',
      );
      const code = store.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

      // The reserved refund states exist in the TYPE, mirroring migration
      // 0013, but nothing here may write or transition into them: no refund
      // operation exists, and a financial record must not imply one did.
      expect(code).not.toMatch(/update payment_discrepancies set state/i);
      expect(code).not.toMatch(/['"`]refund_(requested|confirmed|failed)['"`]\s*[,)]/);

      // The only state this slice binds.
      const inserted = code.slice(code.indexOf('insert into payment_discrepancies'));
      expect(inserted).toContain("'open'");
    });
  });
});
