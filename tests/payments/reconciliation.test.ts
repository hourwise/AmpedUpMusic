/**
 * AMPED-07D - scheduled SumUp payment reconciliation.
 *
 * The slice exists for one failure: the customer paid and the webhook never
 * arrived. Everything else here is about making sure the rescue cannot itself
 * become a second way to pay an order, oversell a room, or resurrect stock
 * that has already gone back on sale.
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
  reconcileSumUpPayments,
  RECONCILIATION_BATCH_SIZE,
  RECONCILIATION_CONCURRENCY,
} from '../../src/services/payments/reconciliation.ts';
import { createD1DiscrepancyStore } from '../../src/services/payments/discrepancies.ts';
import { PaymentConfigurationError } from '../../src/services/payments/sumup/types.ts';
import type { PaymentProvider } from '../../src/services/contracts.ts';
import * as fixtures from './fixtures.ts';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/** Both the webhook route and the scheduled task reach the app this way. */
const hoisted = vi.hoisted(() => ({
  verification: null as null | (() => unknown),
  maintenance: null as null | (() => unknown),
  discrepancies: null as null | (() => unknown),
}));

vi.mock('@/services/index.ts', () => ({
  getSumUpVerification: () => {
    if (!hoisted.verification) throw new PaymentConfigurationError();
    return hoisted.verification();
  },
  getPaymentReconciliation: () => {
    if (!hoisted.verification) throw new PaymentConfigurationError();
    return hoisted.verification();
  },
  getReservationMaintenance: () => {
    if (!hoisted.maintenance) throw new Error('maintenance not wired in test');
    return hoisted.maintenance();
  },
  // AMPED-07D2-2 added a third scheduled pass. These tests are about
  // reconciliation, so detection is wired to the same verifier and a real
  // store, and simply finds nothing of its own to do.
  getPaymentDiscrepancyDetection: () => {
    if (!hoisted.discrepancies) throw new PaymentConfigurationError();
    return hoisted.discrepancies();
  },
}));

const { POST } = await import('../../src/pages/api/webhooks/sumup.ts');
const { runScheduledTasks } = await import('../../src/worker/scheduled.ts');

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXED_NOW = new Date('2026-10-04T12:00:00.000Z');
const EVENT = 'evt_glass_hearts_nov';
const TYPE = 'tt_gh_ga';
const RETURN_URL = 'https://amped.test/checkout/return';
const MERCHANT = fixtures.FAKE_MERCHANT_CODE;
const PAID_AT = '2026-10-04T12:05:00.000Z';

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
    customerName: 'Reconcile Probe',
    customerEmail: 'reconcile-probe@example.com',
    marketingOptIn: false,
    ...overrides,
  };
}

function deliverWebhook(checkoutId: string): Promise<Response> {
  const request = new Request('https://amped.test/api/webhooks/sumup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type: 'CHECKOUT_STATUS_CHANGED', id: checkoutId }),
  });
  return (POST as (ctx: { request: Request }) => Promise<Response>)({ request });
}

describe('AMPED-07D payment reconciliation', () => {
  let database: Awaited<ReturnType<typeof openEphemeralDatabase>>;
  let db: D1Database;
  let counter = 0;
  let ticketsAtStart = 0;

  beforeAll(async () => {
    database = await openEphemeralDatabase();
    db = database.db;
    await migrate(db);
    await applySeed(db);
    // The seed ships awaiting_payment orders; park them far in the past so
    // each test sees only the candidates it created.
    await db
      .prepare(
        "update orders set reservation_expires_at = '2020-01-01T00:00:00.000Z' " +
          "where status = 'awaiting_payment'",
      )
      .run();
    ticketsAtStart = await ticketCount();
  });

  afterAll(async () => {
    await database.dispose();
  });

  beforeEach(() => {
    hoisted.verification = null;
    hoisted.maintenance = null;
    hoisted.discrepancies = null;
  });

  function orders(now: () => Date = () => FIXED_NOW): OrderMutationService {
    return createD1OrderMutations(db, now, (p) => `${p}_d${++counter}`);
  }

  async function ticketCount(): Promise<number> {
    const row = await db.prepare('select count(*) as n from tickets').first<{ n: number }>();
    return row?.n ?? 0;
  }

  async function orderRow(id: string) {
    return db
      .prepare(
        'select reference, status, paid_at, reservation_expires_at, payment_reference from orders where id = ?',
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

  /** An order awaiting payment, exactly as checkout leaves it. */
  async function reservedOrder(options: { expiresAt?: string } = {}) {
    counter += 1;
    const checkoutId = `chk-07d-${counter}`;
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
    await service.beginPayment(created.orderId, stub, RETURN_URL);
    return { orderId: created.orderId, reference: created.reference, checkoutId };
  }

  /** A verifier over a scripted transport, keyed by checkout id. */
  function verifierFor(
    responder: (checkoutId: string) => Response | Promise<Response>,
    service: OrderMutationService = orders(),
  ) {
    let retrievals = 0;
    const impl = (async (input: RequestInfo | URL) => {
      retrievals += 1;
      const url = String(input);
      const id = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
      return responder(id);
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

    hoisted.verification = () => ({ orders: service, verifier });
    return { verifier, orders: service, retrievals: () => retrievals };
  }

  function run(
    seam: { verifier: ReturnType<typeof verifierFor>['verifier']; orders: OrderMutationService },
    overrides: { batchSize?: number; concurrency?: number } = {},
  ) {
    return reconcileSumUpPayments({
      orders: seam.orders,
      verifier: seam.verifier,
      now: () => FIXED_NOW,
      log: () => {},
      ...overrides,
    });
  }

  // == the reason this slice exists =========================================

  describe('lost-webhook recovery', () => {
    it('pays an order whose webhook never arrived', async () => {
      const { orderId, reference, checkoutId } = await reservedOrder();

      // No webhook was ever processed for this order.
      expect(await countAudits(orderId, 'order.paid')).toBe(0);
      expect((await orderRow(orderId))?.status).toBe('awaiting_payment');

      const seam = verifierFor((id) => jsonResponse(paidCheckout(id, reference)));
      const summary = await run(seam);

      expect(summary.paid).toBe(1);
      expect(summary.examined).toBeGreaterThanOrEqual(1);

      const row = await orderRow(orderId);
      expect(row?.status).toBe('paid');
      expect(row?.paid_at).toBe(PAID_AT);
      expect(await countAudits(orderId, 'order.paid')).toBe(1);
      expect(await countObservations(`sumup_txn:txn_${checkoutId}`)).toBe(1);
      expect(await ticketCount()).toBe(ticketsAtStart);
    });

    it('is harmless when run again afterwards', async () => {
      const { orderId, reference } = await reservedOrder();
      const seam = verifierFor((id) => jsonResponse(paidCheckout(id, reference)));

      await run(seam);
      const first = await orderRow(orderId);

      // A paid order no longer qualifies, so later runs do not even see it.
      const second = await run(seam);
      const third = await run(seam);

      const after = await orderRow(orderId);
      expect(after?.status).toBe('paid');
      expect(after?.paid_at).toBe(first?.paid_at);
      expect(await countAudits(orderId, 'order.paid')).toBe(1);
      expect(second.paid).toBe(0);
      expect(third.paid).toBe(0);
    });
  });

  // == candidate selection ==================================================

  describe('candidate selection', () => {
    it('does nothing and calls nobody when there is no eligible order', async () => {
      const seam = verifierFor(() => jsonResponse({ status: 'PAID' }));
      const summary = await run(seam);
      expect(summary.examined).toBe(0);
      expect(summary.paid).toBe(0);
      expect(seam.retrievals()).toBe(0);
    });

    it('ignores an awaiting-payment order with no payment reference', async () => {
      const service = orders();
      const created = await service.createOrder(checkoutInput());
      await db
        .prepare(
          "update orders set status = 'awaiting_payment', reservation_expires_at = ?1 where id = ?2",
        )
        .bind(new Date(FIXED_NOW.getTime() + 30 * 60_000).toISOString(), created.orderId)
        .run();

      const seam = verifierFor(() => jsonResponse({ status: 'PAID' }), service);
      const candidates = await service.listReconciliationCandidates('sumup', FIXED_NOW, 50);
      expect(candidates.map((c) => c.orderId)).not.toContain(created.orderId);

      await run(seam);
      expect((await orderRow(created.orderId))?.status).toBe('awaiting_payment');

      await db.prepare('delete from orders where id = ?').bind(created.orderId).run();
    });

    it('ignores orders that are already paid or already expired', async () => {
      const { orderId: paidId, reference } = await reservedOrder();
      const seam = verifierFor((id) => jsonResponse(paidCheckout(id, reference)));
      await run(seam);
      expect((await orderRow(paidId))?.status).toBe('paid');

      const expiring = await reservedOrder({
        expiresAt: new Date(FIXED_NOW.getTime() + 60_000).toISOString(),
      });
      const sweepClock = new Date(FIXED_NOW.getTime() + 120_000);
      await orders(() => sweepClock).expireDueReservations(sweepClock);
      expect((await orderRow(expiring.orderId))?.status).toBe('expired');

      const candidates = await orders().listReconciliationCandidates('sumup', FIXED_NOW, 50);
      const ids = candidates.map((c) => c.orderId);
      expect(ids).not.toContain(paidId);
      expect(ids).not.toContain(expiring.orderId);
    });

    it('never resurrects an expired reservation, even when SumUp says PAID', async () => {
      const expiring = await reservedOrder({
        expiresAt: new Date(FIXED_NOW.getTime() + 60_000).toISOString(),
      });
      const sweepClock = new Date(FIXED_NOW.getTime() + 120_000);
      await orders(() => sweepClock).expireDueReservations(sweepClock);
      expect((await orderRow(expiring.orderId))?.status).toBe('expired');

      // Reconcile with a clock past the hold, so it would be a candidate if
      // status alone decided eligibility.
      const service = orders(() => sweepClock);
      const verifier = createSumUpPaymentVerifier({
        client: createSumUpClient({
          apiKey: fixtures.FAKE_API_KEY,
          merchantCode: MERCHANT,
          fetchImpl: (async () =>
            jsonResponse(paidCheckout(expiring.checkoutId, expiring.reference))) as typeof fetch,
          sleep: async () => {},
        }),
        merchantCode: MERCHANT,
        orders: service,
        now: () => sweepClock,
      });

      await reconcileSumUpPayments({ orders: service, verifier, now: () => sweepClock, log: () => {} });

      const row = await orderRow(expiring.orderId);
      expect(row?.status).toBe('expired');
      expect(row?.paid_at).toBeNull();
      expect(await countAudits(expiring.orderId, 'order.paid')).toBe(0);
    });

    it('bounds the batch', async () => {
      const made = [];
      for (let i = 0; i < 5; i += 1) made.push(await reservedOrder());
      const seam = verifierFor((id) => jsonResponse({ id, status: 'PENDING', transactions: [] }));

      const summary = await run(seam, { batchSize: 3 });
      expect(summary.examined).toBe(3);
      expect(seam.retrievals()).toBe(3);

      for (const m of made) {
        await db.prepare('delete from orders where id = ?').bind(m.orderId).run();
      }
    });

    it('declares sane defaults derived from the lifecycle', () => {
      expect(RECONCILIATION_BATCH_SIZE).toBeGreaterThan(0);
      expect(RECONCILIATION_BATCH_SIZE).toBeLessThanOrEqual(50);
      expect(RECONCILIATION_CONCURRENCY).toBeGreaterThan(0);
      expect(RECONCILIATION_CONCURRENCY).toBeLessThanOrEqual(8);
    });
  });

  // == provider outcomes ====================================================

  describe('provider outcomes', () => {
    async function expectUntouched(label: string, responder: (id: string, ref: string) => unknown) {
      const { orderId, reference } = await reservedOrder();
      const seam = verifierFor((id) => jsonResponse(responder(id, reference)));
      const summary = await run(seam);

      const row = await orderRow(orderId);
      expect(row?.status, label).toBe('awaiting_payment');
      expect(row?.paid_at, label).toBeNull();
      expect(await countAudits(orderId, 'order.paid')).toBe(0);
      expect(await countAudits(orderId, 'order.expired')).toBe(0);
      await db.prepare('delete from orders where id = ?').bind(orderId).run();
      return summary;
    }

    it.each(['PENDING', 'FAILED', 'EXPIRED'])(
      'leaves the order alone when the provider says %s',
      async (status) => {
        const summary = await expectUntouched(status, (id, ref) =>
          paidCheckout(id, ref, { status }),
        );
        expect(summary.unchanged).toBe(1);
        expect(summary.paid).toBe(0);
      },
    );

    it.each([
      ['wrong checkout_reference', { checkout_reference: 'AMP-00-00000' }],
      ['wrong amount', { amount: 19.99 }],
      ['wrong currency', { currency: 'USD' }],
      ['wrong merchant', { merchant_code: 'SOMEONE_ELSE' }],
      ['no successful transaction', { transactions: [] }],
    ])('refuses to pay on a PAID checkout with the %s', async (label, override) => {
      const summary = await expectUntouched(label, (id, ref) => paidCheckout(id, ref, override));
      expect(summary.verificationFailures).toBe(1);
      expect(summary.paid).toBe(0);
    });

    it('changes nothing when SumUp cannot be reached', async () => {
      const { orderId } = await reservedOrder();
      const seam = verifierFor(() => {
        throw new TypeError('network down');
      });
      const summary = await run(seam);

      expect(summary.retrievalFailures).toBe(1);
      expect(summary.paid).toBe(0);
      const row = await orderRow(orderId);
      expect(row?.status).toBe('awaiting_payment');
      await db.prepare('delete from orders where id = ?').bind(orderId).run();
    });

    it('does not let one bad order strand the rest of the batch', async () => {
      const broken = await reservedOrder();
      const good = await reservedOrder();

      const seam = verifierFor((id) => {
        if (id === broken.checkoutId) throw new TypeError('network down');
        return jsonResponse(paidCheckout(id, good.reference));
      });
      const summary = await run(seam);

      expect(summary.retrievalFailures).toBe(1);
      expect(summary.paid).toBe(1);
      expect((await orderRow(good.orderId))?.status).toBe('paid');
      expect((await orderRow(broken.orderId))?.status).toBe('awaiting_payment');
      await db.prepare('delete from orders where id = ?').bind(broken.orderId).run();
    });
  });

  // == concurrency ==========================================================

  describe('concurrency', () => {
    it('cannot double-pay when a webhook and reconciliation race', async () => {
      const { orderId, reference, checkoutId } = await reservedOrder();
      const committedBefore = await committedFor(TYPE, FIXED_NOW);
      const seam = verifierFor((id) => jsonResponse(paidCheckout(id, reference)));

      const [, webhook] = await Promise.all([
        run(seam),
        deliverWebhook(checkoutId),
        run(seam),
        deliverWebhook(checkoutId),
      ]);

      expect(webhook.status).toBe(204);
      const row = await orderRow(orderId);
      expect(row?.status).toBe('paid');
      expect(row?.paid_at).toBe(PAID_AT);
      expect(await countAudits(orderId, 'order.paid')).toBe(1);
      expect(await countObservations(`sumup_txn:txn_${checkoutId}`)).toBe(1);
      expect(await committedFor(TYPE, FIXED_NOW)).toBe(committedBefore);
      expect(await ticketCount()).toBe(ticketsAtStart);
    });

    it('cannot double-pay when two reconciliation runs overlap', async () => {
      const { orderId, reference, checkoutId } = await reservedOrder();
      const seam = verifierFor((id) => jsonResponse(paidCheckout(id, reference)));

      const summaries = await Promise.all([run(seam), run(seam), run(seam), run(seam)]);

      const row = await orderRow(orderId);
      expect(row?.status).toBe('paid');
      expect(await countAudits(orderId, 'order.paid')).toBe(1);
      expect(await countObservations(`sumup_txn:txn_${checkoutId}`)).toBe(1);

      // Exactly one run performed the transition; the others saw it done.
      const applied = summaries.reduce((total, s) => total + s.paid, 0);
      expect(applied).toBe(1);
      expect(await ticketCount()).toBe(ticketsAtStart);
    });

    it('cannot let reconciliation and the expiry sweep both win', async () => {
      const expiresAt = new Date(FIXED_NOW.getTime() + 60_000).toISOString();
      const { orderId, reference } = await reservedOrder({ expiresAt });
      const sweepClock = new Date(Date.parse(expiresAt) + 1000);

      const seam = verifierFor((id) => jsonResponse(paidCheckout(id, reference)));
      const sweeper = orders(() => sweepClock);

      await Promise.all([
        run(seam),
        sweeper.expireDueReservations(sweepClock),
        run(seam),
      ]);

      const row = await orderRow(orderId);
      const paid = await countAudits(orderId, 'order.paid');
      const expired = await countAudits(orderId, 'order.expired');

      expect(['paid', 'expired']).toContain(row?.status);
      expect(paid + expired).toBe(1);
      if (row?.status === 'paid') {
        expect(row?.paid_at).not.toBeNull();
      } else {
        expect(row?.paid_at).toBeNull();
      }
      expect(await ticketCount()).toBe(ticketsAtStart);
    });

    it('never exceeds its concurrency cap', async () => {
      const made = [];
      for (let i = 0; i < 6; i += 1) made.push(await reservedOrder());

      let inFlight = 0;
      let peak = 0;
      const service = orders();
      const verifier = createSumUpPaymentVerifier({
        client: createSumUpClient({
          apiKey: fixtures.FAKE_API_KEY,
          merchantCode: MERCHANT,
          fetchImpl: (async (input: RequestInfo | URL) => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 5));
            inFlight -= 1;
            const url = String(input);
            const id = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
            return jsonResponse({ id, status: 'PENDING', transactions: [] });
          }) as typeof fetch,
          sleep: async () => {},
        }),
        merchantCode: MERCHANT,
        orders: service,
        now: () => FIXED_NOW,
      });

      await reconcileSumUpPayments({
        orders: service,
        verifier,
        now: () => FIXED_NOW,
        batchSize: 6,
        concurrency: 2,
        log: () => {},
      });

      expect(peak).toBeLessThanOrEqual(2);
      expect(peak).toBeGreaterThan(0);
      for (const m of made) {
        await db.prepare('delete from orders where id = ?').bind(m.orderId).run();
      }
    });
  });

  // == the scheduled entry point ============================================

  describe('scheduled task', () => {
    it('reconciles before it expires, so a late payment is not swept away', async () => {
      // A hold about to lapse, whose payment succeeded but was never notified.
      const expiresAt = new Date(FIXED_NOW.getTime() + 60_000).toISOString();
      const { orderId, reference } = await reservedOrder({ expiresAt });
      const tick = new Date(Date.parse(expiresAt) - 1000);

      const service = orders(() => tick);
      const verifier = createSumUpPaymentVerifier({
        client: createSumUpClient({
          apiKey: fixtures.FAKE_API_KEY,
          merchantCode: MERCHANT,
          fetchImpl: (async (input: RequestInfo | URL) => {
            const url = String(input);
            const id = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
            return jsonResponse(paidCheckout(id, reference));
          }) as typeof fetch,
          sleep: async () => {},
        }),
        merchantCode: MERCHANT,
        orders: service,
        now: () => tick,
      });

      hoisted.verification = () => ({ orders: service, verifier });
      hoisted.maintenance = () => service;
      hoisted.discrepancies = () => ({ store: createD1DiscrepancyStore(db), verifier });

      const summary = await runScheduledTasks(tick);

      expect(summary.reconciliation?.paid).toBe(1);
      expect((await orderRow(orderId))?.status).toBe('paid');
      expect(await countAudits(orderId, 'order.paid')).toBe(1);
    });

    it('still expires holds when SumUp is not configured', async () => {
      const expiresAt = new Date(FIXED_NOW.getTime() + 60_000).toISOString();
      const { orderId } = await reservedOrder({ expiresAt });
      const tick = new Date(Date.parse(expiresAt) + 1000);

      // A missing credential must not take stock off sale indefinitely.
      hoisted.verification = null;
      hoisted.maintenance = () => orders(() => tick);

      const summary = await runScheduledTasks(tick);

      expect(summary.reconciliation).toBeNull();
      expect(summary.expired).toBeGreaterThanOrEqual(1);
      expect((await orderRow(orderId))?.status).toBe('expired');
    });
  });

  // == structural guarantees ================================================

  describe('one writer to paid', () => {
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

    it('keeps the reconciler free of SQL and of verification logic', () => {
      const source = readFileSync(
        join(root, 'src', 'services', 'payments', 'reconciliation.ts'),
        'utf8',
      );
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

      expect(code).not.toMatch(/\bselect\b.*\bfrom\b/i);
      expect(code).not.toMatch(/\bupdate\b.*\bset\b/i);
      expect(code).not.toMatch(/\bfetch\s*\(/);
      expect(code).not.toContain('db.prepare');
      // No second correlation implementation.
      expect(code).not.toContain('checkout_reference');
      expect(code).not.toContain('merchant_code');
      expect(code).not.toContain('majorUnitsToPence');
      // It reaches paid only through the shared primitive.
      expect(code).toContain('applyVerifiedPayment');
      expect(code).toContain('verifier.verify');
    });

    it('writes no business audit merely for inspecting an order', async () => {
      const { orderId, reference } = await reservedOrder();
      const before = await db
        .prepare('select count(*) as n from audit_log where entity_id = ?')
        .bind(orderId)
        .first<{ n: number }>();

      const seam = verifierFor((id) => jsonResponse(paidCheckout(id, reference, { status: 'PENDING' })));
      await run(seam);

      const after = await db
        .prepare('select count(*) as n from audit_log where entity_id = ?')
        .bind(orderId)
        .first<{ n: number }>();
      expect(after?.n).toBe(before?.n);
      await db.prepare('delete from orders where id = ?').bind(orderId).run();
    });

    it('creates no processed_reconciliations mechanism', () => {
      const migrations = readdirSync(join(root, 'migrations'));
      for (const name of migrations) {
        const sql = readFileSync(join(root, 'migrations', name), 'utf8');
        expect(sql).not.toMatch(/processed_reconciliations/i);
      }
      // No reconciliation-specific correctness table was invented; the order
      // transition remains authoritative. (AMPED-07D2-2's 0013 adds
      // discrepancy storage, which is a different fact entirely.)
      expect(migrations.some((n) => /reconcil/i.test(n))).toBe(false);
    });
  });
});
