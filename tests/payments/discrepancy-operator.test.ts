/**
 * AMPED-07D2-3 - operator visibility and manual resolution.
 *
 * Two things are being defended here.
 *
 * First, that the record stays truthful: a discrepancy first seen before
 * SumUp named the transaction must be ENRICHED when it does, not duplicated
 * and not frozen with weaker evidence.
 *
 * Second, that the operator action means what it says. "Mark resolved" is an
 * attestation that a human dealt with the money in SumUp. It must never
 * refund anything, never touch the order, and never let two clicks produce
 * two entries in a financial history.
 *
 * Offline throughout: fake SumUp transport, real ephemeral D1, no API key.
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
import { createSumUpPaymentVerifier } from '../../src/services/payments/sumup/verification.ts';
import {
  createD1DiscrepancyStore,
  type DiscrepancyStore,
} from '../../src/services/payments/discrepancies.ts';
import { detectPaymentDiscrepancies } from '../../src/services/payments/discrepancy-detection.ts';
import {
  DISCREPANCY_ACTION_LABEL,
  DISCREPANCY_KIND_LABEL,
  DISCREPANCY_STATE_LABEL,
} from '../../src/lib/text.ts';
import { PaymentConfigurationError } from '../../src/services/payments/sumup/types.ts';
import type { PaymentProvider } from '../../src/services/contracts.ts';
import * as fixtures from './fixtures.ts';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const hoisted = vi.hoisted(() => ({
  discrepancies: null as null | (() => unknown),
}));

vi.mock('@/services/index.ts', () => ({
  getPaymentDiscrepancies: () => {
    if (!hoisted.discrepancies) throw new PaymentConfigurationError();
    return hoisted.discrepancies();
  },
}));

const resolveRoute = await import('../../src/pages/api/admin/discrepancies/[id]/resolve.ts');
const reopenRoute = await import('../../src/pages/api/admin/discrepancies/[id]/reopen.ts');

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Must be in the PAST relative to the real clock: the admin routes stamp
// their events with `new Date()`, and a future fixture time would make a
// resolution appear to precede the detection it answers.
const FIXED_NOW = new Date('2026-09-28T12:00:00.000Z');
const EVENT = 'evt_glass_hearts_nov';
const TYPE = 'tt_gh_ga';
const RETURN_URL = 'https://amped.test/checkout/return';
const MERCHANT = fixtures.FAKE_MERCHANT_CODE;
const PAID_AT = '2026-09-28T11:58:00.000Z';
const OPERATOR = { email: 'anya@ampedupmusicpromo.co.uk', sub: 'access-subject-1' };

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

/** Call a protected admin route the way Astro would, with verified locals. */
function callRoute(
  route: { POST: unknown },
  id: string,
  locals: Record<string, unknown> = { operator: OPERATOR },
): Promise<Response> {
  const handler = route.POST as (ctx: {
    params: Record<string, string>;
    locals: Record<string, unknown>;
    request: Request;
  }) => Promise<Response>;
  return handler({
    params: { id },
    locals,
    request: new Request(`https://amped.test/api/admin/discrepancies/${id}/x`, { method: 'POST' }),
  });
}

describe('AMPED-07D2-3 operator workflow', () => {
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
    await db
      .prepare(
        "update orders set reservation_expires_at = '2020-01-01T00:00:00.000Z' " +
          "where status = 'awaiting_payment'",
      )
      .run();
    store = createD1DiscrepancyStore(db, (p) => `${p}_o${++counter}`);
    ticketsAtStart = await ticketCount();
  });

  afterAll(async () => {
    await database.dispose();
  });

  beforeEach(() => {
    hoisted.discrepancies = () => store;
  });

  function orders(now: () => Date = () => FIXED_NOW): OrderMutationService {
    return createD1OrderMutations(db, now, (p) => `${p}_y${++counter}`);
  }

  async function ticketCount(): Promise<number> {
    const row = await db.prepare('select count(*) as n from tickets').first<{ n: number }>();
    return row?.n ?? 0;
  }

  async function orderRow(id: string) {
    return db
      .prepare('select reference, status, paid_at from orders where id = ?')
      .bind(id)
      .first<Record<string, unknown>>();
  }

  async function rowsFor(orderId: string) {
    const rows = await db
      .prepare('select * from payment_discrepancies where order_id = ?')
      .bind(orderId)
      .all<Record<string, unknown>>();
    return rows.results;
  }

  async function eventsFor(orderId: string) {
    const rows = await db
      .prepare(
        'select e.event, e.actor, e.occurred_at from payment_discrepancy_events e ' +
          'join payment_discrepancies d on d.id = e.discrepancy_id ' +
          'where d.order_id = ? order by e.occurred_at',
      )
      .bind(orderId)
      .all<{ event: string; actor: string; occurred_at: string }>();
    return rows.results;
  }

  const lapsed = (minutesAgo: number) =>
    new Date(FIXED_NOW.getTime() - minutesAgo * 60_000).toISOString();

  async function reservedOrder(expiresAt: string) {
    counter += 1;
    const checkoutId = `chk-d3-${counter}`;
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
    const reserveClock = new Date(Date.parse(expiresAt) - 60_000);
    const service = orders(() => reserveClock);
    const created = await service.createOrder({
      eventId: EVENT,
      items: [{ ticketTypeId: TYPE, quantity: 2 }],
      customerName: 'Operator Probe',
      customerEmail: 'operator-probe@example.com',
      marketingOptIn: false,
    } satisfies CheckoutInput);
    await service.beginPayment(created.orderId, stub, RETURN_URL);
    return { orderId: created.orderId, reference: created.reference, checkoutId };
  }

  function verifierFor(responder: (checkoutId: string) => Response | Promise<Response>) {
    const impl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      return responder(decodeURIComponent(url.slice(url.lastIndexOf('/') + 1)));
    }) as typeof fetch;
    return createSumUpPaymentVerifier({
      client: createSumUpClient({
        apiKey: fixtures.FAKE_API_KEY,
        merchantCode: MERCHANT,
        fetchImpl: impl,
        sleep: async () => {},
      }),
      merchantCode: MERCHANT,
      orders: orders(),
      now: () => FIXED_NOW,
    });
  }

  const detect = (verifier: ReturnType<typeof verifierFor>) =>
    detectPaymentDiscrepancies({ store, verifier, now: () => FIXED_NOW, log: () => {} });

  /** A recorded, open discrepancy with a settled transaction. */
  async function openDiscrepancy() {
    const order = await reservedOrder(lapsed(1));
    await detect(verifierFor((id) => jsonResponse(paidCheckout(id, order.reference))));
    const rows = await rowsFor(order.orderId);
    expect(rows).toHaveLength(1);
    return { ...order, id: String(rows[0]!.id) };
  }

  // == enrichment ===========================================================

  describe('evidence enrichment', () => {
    it('enriches the existing row when the transaction later settles', async () => {
      const order = await reservedOrder(lapsed(1));

      // 1-2. PAID, but nothing yet names the payment: checkout fallback.
      await detect(
        verifierFor((id) => jsonResponse(paidCheckout(id, order.reference, { transactions: [] }))),
      );
      let rows = await rowsFor(order.orderId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.identity_key).toBe(`sumup_checkout:${order.checkoutId}`);
      expect(rows[0]!.transaction_id).toBeNull();
      expect(rows[0]!.provider_paid_at).toBeNull();
      const detectedAt = rows[0]!.detected_at;

      // 3-5. The transaction settles. The SAME row becomes authoritative.
      const summary = await detect(
        verifierFor((id) => jsonResponse(paidCheckout(id, order.reference))),
      );
      expect(summary.enriched).toBe(1);
      expect(summary.created).toBe(0);

      rows = await rowsFor(order.orderId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.transaction_id).toBe(`txn_${order.checkoutId}`);
      expect(rows[0]!.provider_paid_at).toBe(PAID_AT);
      expect(rows[0]!.provider_amount_in_pence).toBe(2000);
      expect(rows[0]!.state).toBe('open');
      // 6. Detection history intact, plus one entry for the new information.
      expect(rows[0]!.detected_at).toBe(detectedAt);
      const events = await eventsFor(order.orderId);
      expect(events.map((e) => e.event)).toEqual(['detected', 'evidence_enriched']);
    });

    it('stops probing once the transaction is known', async () => {
      const order = await reservedOrder(lapsed(1));
      let retrievals = 0;
      const counting = () =>
        verifierFor((id) => {
          retrievals += 1;
          return jsonResponse(paidCheckout(id, order.reference));
        });

      await detect(counting());
      const afterFirst = retrievals;
      await detect(counting());
      await detect(counting());
      expect(retrievals).toBe(afterFirst);
    });

    it('enriches at most once under concurrent observation', async () => {
      const order = await reservedOrder(lapsed(1));
      await detect(
        verifierFor((id) => jsonResponse(paidCheckout(id, order.reference, { transactions: [] }))),
      );

      const summaries = await Promise.all(
        Array.from({ length: 6 }, () =>
          detect(verifierFor((id) => jsonResponse(paidCheckout(id, order.reference)))),
        ),
      );

      expect(await rowsFor(order.orderId)).toHaveLength(1);
      expect(summaries.reduce((total, s) => total + s.enriched, 0)).toBe(1);
      const events = await eventsFor(order.orderId);
      expect(events.filter((e) => e.event === 'evidence_enriched')).toHaveLength(1);
    });

    it('enriches a RESOLVED record without reopening it', async () => {
      const order = await reservedOrder(lapsed(1));
      await detect(
        verifierFor((id) => jsonResponse(paidCheckout(id, order.reference, { transactions: [] }))),
      );
      const id = String((await rowsFor(order.orderId))[0]!.id);

      const resolved = await store.resolveManually(id, OPERATOR.email, FIXED_NOW);
      expect(resolved.outcome).toBe('resolved');

      await detect(verifierFor((cid) => jsonResponse(paidCheckout(cid, order.reference))));

      const rows = await rowsFor(order.orderId);
      expect(rows).toHaveLength(1);
      // Evidence improved...
      expect(rows[0]!.transaction_id).toBe(`txn_${order.checkoutId}`);
      // ...but the operator's decision stands.
      expect(rows[0]!.state).toBe('resolved_manually');
      expect(rows[0]!.resolved_at).not.toBeNull();
    });
  });

  // == resolution ===========================================================

  describe('manual resolution', () => {
    it('records an attestation without touching the order', async () => {
      const { orderId, id } = await openDiscrepancy();
      const before = await orderRow(orderId);

      const response = await callRoute(resolveRoute, id);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, state: 'resolved_manually' });

      const rows = await rowsFor(orderId);
      expect(rows[0]!.state).toBe('resolved_manually');
      expect(rows[0]!.resolved_at).not.toBeNull();

      // The order is untouched. Expired stays expired; nothing becomes paid
      // or refunded because a human ticked a box.
      const after = await orderRow(orderId);
      expect(after).toEqual(before);
      expect(after?.paid_at).toBeNull();
      expect(await ticketCount()).toBe(ticketsAtStart);

      const events = await eventsFor(orderId);
      expect(events.map((e) => e.event)).toEqual(['detected', 'resolved_manually']);
      expect(events[1]!.actor).toBe(OPERATOR.email);
    });

    it('produces exactly one resolution under N concurrent clicks', async () => {
      const { orderId, id } = await openDiscrepancy();

      const responses = await Promise.all(
        Array.from({ length: 8 }, () => callRoute(resolveRoute, id)),
      );
      for (const response of responses) expect(response.status).toBe(200);

      const rows = await rowsFor(orderId);
      expect(rows[0]!.state).toBe('resolved_manually');
      const events = await eventsFor(orderId);
      expect(events.filter((e) => e.event === 'resolved_manually')).toHaveLength(1);

      // One stable resolved_at, matching the single event.
      const resolvedEvent = events.find((e) => e.event === 'resolved_manually');
      expect(rows[0]!.resolved_at).toBe(resolvedEvent?.occurred_at);
      expect(await orderRow(orderId)).toMatchObject({ paid_at: null });
    });

    it('is an idempotent no-op when already resolved', async () => {
      const { orderId, id } = await openDiscrepancy();
      await callRoute(resolveRoute, id);
      const first = await rowsFor(orderId);

      const second = await callRoute(resolveRoute, id);
      expect(second.status).toBe(200);
      expect(await second.json()).toMatchObject({ alreadyResolved: true });

      expect((await rowsFor(orderId))[0]!.resolved_at).toBe(first[0]!.resolved_at);
      expect(
        (await eventsFor(orderId)).filter((e) => e.event === 'resolved_manually'),
      ).toHaveLength(1);
    });

    it('404s an unknown discrepancy', async () => {
      const response = await callRoute(resolveRoute, 'pdx_does_not_exist');
      expect(response.status).toBe(404);
    });

    it('survives detection running against a resolved record', async () => {
      const order = await reservedOrder(lapsed(1));
      await detect(verifierFor((id) => jsonResponse(paidCheckout(id, order.reference))));
      const id = String((await rowsFor(order.orderId))[0]!.id);

      await Promise.all([
        callRoute(resolveRoute, id),
        detect(verifierFor((cid) => jsonResponse(paidCheckout(cid, order.reference)))),
        callRoute(resolveRoute, id),
      ]);

      const rows = await rowsFor(order.orderId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.state).toBe('resolved_manually');
      const events = await eventsFor(order.orderId);
      expect(events.filter((e) => e.event === 'resolved_manually')).toHaveLength(1);
      expect(events.filter((e) => e.event === 'detected')).toHaveLength(1);
    });
  });

  // == reopen ===============================================================

  describe('reopen', () => {
    it('returns a mistakenly resolved discrepancy to the queue, keeping history', async () => {
      const { orderId, id } = await openDiscrepancy();
      await callRoute(resolveRoute, id);

      const response = await callRoute(reopenRoute, id);
      expect(response.status).toBe(200);

      const rows = await rowsFor(orderId);
      expect(rows[0]!.state).toBe('open');
      expect(rows[0]!.resolved_at).toBeNull();

      // Nothing is erased: the record still shows it was resolved once.
      const events = await eventsFor(orderId);
      expect(events.map((e) => e.event)).toEqual(['detected', 'resolved_manually', 'reopened']);
    });

    it('produces exactly one reopen under concurrent clicks', async () => {
      const { orderId, id } = await openDiscrepancy();
      await callRoute(resolveRoute, id);

      await Promise.all(Array.from({ length: 6 }, () => callRoute(reopenRoute, id)));

      expect((await rowsFor(orderId))[0]!.state).toBe('open');
      expect((await eventsFor(orderId)).filter((e) => e.event === 'reopened')).toHaveLength(1);
    });

    it('will not reopen something that was never resolved', async () => {
      const { orderId, id } = await openDiscrepancy();
      const response = await callRoute(reopenRoute, id);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ alreadyOpen: true });
      expect((await eventsFor(orderId)).filter((e) => e.event === 'reopened')).toHaveLength(0);
    });
  });

  // == authorisation ========================================================

  describe('authorisation', () => {
    it('refuses an unauthenticated caller', async () => {
      const { orderId, id } = await openDiscrepancy();
      for (const locals of [{}, { operator: undefined }, { operator: { email: '' } }]) {
        const response = await callRoute(resolveRoute, id, locals);
        expect(response.status).toBe(403);
      }
      expect((await rowsFor(orderId))[0]!.state).toBe('open');
      expect((await eventsFor(orderId)).filter((e) => e.event === 'resolved_manually')).toHaveLength(0);
    });

    it('lives in the Access-protected admin namespace', async () => {
      const { isProtectedPath } = await import('../../src/lib/access.ts');
      expect(isProtectedPath('/api/admin/discrepancies/pdx_1/resolve')).toBe(true);
      expect(isProtectedPath('/api/admin/discrepancies/pdx_1/reopen')).toBe(true);
    });

    it('trusts nothing from the request body', () => {
      for (const file of ['resolve.ts', 'reopen.ts']) {
        const source = readFileSync(
          join(root, 'src', 'pages', 'api', 'admin', 'discrepancies', '[id]', file),
          'utf8',
        );
        const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        // The only inputs are the path id and the verified operator.
        expect(code).not.toContain('readJson');
        expect(code).not.toContain('request.json');
        expect(code).toContain('operatorFrom(locals)');
        expect(code).toContain("fail(403, 'forbidden')");
      }
    });
  });

  // == read model and presentation ==========================================

  describe('operator view', () => {
    it('counts only open discrepancies', async () => {
      const before = await store.countOpen();
      const { id } = await openDiscrepancy();
      expect(await store.countOpen()).toBe(before + 1);

      await callRoute(resolveRoute, id);
      // A resolved discrepancy must stop inflating the action badge.
      expect(await store.countOpen()).toBe(before);
    });

    it('keeps resolved rows out of the actionable queue but in history', async () => {
      const { orderId, id } = await openDiscrepancy();
      const reference = String((await orderRow(orderId))!.reference);

      expect((await store.list('open', 100)).some((r) => r.orderReference === reference)).toBe(true);
      await callRoute(resolveRoute, id);

      expect((await store.list('open', 100)).some((r) => r.orderReference === reference)).toBe(false);
      const history = await store.list('resolved', 100);
      const row = history.find((r) => r.orderReference === reference);
      expect(row?.state).toBe('resolved_manually');
      expect(row?.resolvedAt).not.toBeNull();
    });

    it('exposes amounts as integer pence and a safe missing transaction', async () => {
      const order = await reservedOrder(lapsed(1));
      await detect(
        verifierFor((id) => jsonResponse(paidCheckout(id, order.reference, { transactions: [] }))),
      );
      const row = (await store.list('open', 100)).find(
        (r) => r.orderReference === order.reference,
      );
      expect(row?.localAmountInPence).toBe(2000);
      expect(row?.providerAmountInPence).toBe(2000);
      expect(Number.isInteger(row?.localAmountInPence)).toBe(true);
      // Absent, not an error.
      expect(row?.transactionId).toBeNull();
    });

    it('carries no customer name or email in the read model', async () => {
      const { orderId } = await openDiscrepancy();
      const reference = String((await orderRow(orderId))!.reference);
      const row = (await store.list('open', 100)).find((r) => r.orderReference === reference);
      const serialised = JSON.stringify(row);
      expect(serialised).not.toContain('operator-probe@example.com');
      expect(serialised).not.toContain('Operator Probe');
    });
  });

  describe('operator wording', () => {
    it('translates every stored kind into plain English', () => {
      for (const kind of [
        'paid_after_expiry',
        'paid_order_expired',
        'amount_mismatch',
        'correlation_mismatch',
      ]) {
        expect(DISCREPANCY_KIND_LABEL[kind]).toBeTruthy();
        expect(DISCREPANCY_KIND_LABEL[kind]).not.toContain('_');
        expect(DISCREPANCY_ACTION_LABEL[kind]).toMatch(/SumUp/);
      }
      expect(DISCREPANCY_STATE_LABEL.open).toBe('Needs attention');
      expect(DISCREPANCY_STATE_LABEL.resolved_manually).toBe('Resolved by operator');
    });

    it('never calls the action a refund, and says so explicitly', () => {
      const page = readFileSync(
        join(root, 'src', 'pages', 'admin', 'discrepancies.astro'),
        'utf8',
      );
      expect(page).toContain('Mark resolved');
      expect(page).toContain('NO refund is sent');
      expect(page).toContain('Amped Up does not send refunds');
      for (const forbidden of ['Issue refund', 'Refund customer', 'Complete refund', 'Send refund']) {
        expect(page).not.toContain(forbidden);
      }
      // No button labelled bare "Refund".
      expect(page).not.toMatch(/>\s*Refund\s*</);
    });

    it('renders no secrets, provider bodies or card data', () => {
      const page = readFileSync(
        join(root, 'src', 'pages', 'admin', 'discrepancies.astro'),
        'utf8',
      );
      expect(page).not.toMatch(/SUMUP_API_KEY|SUMUP_MERCHANT_CODE|Authorization|Bearer/);
      expect(page).not.toMatch(/card ?number|\bcvv\b|\bcvc\b|\bpan\b/i);
      expect(page).not.toMatch(/customerEmail|customerName|customer_email|customer_name/);
      expect(page).not.toMatch(/rawPayload|raw_payload|responseBody/);
    });

    it('does not offer dismissal in this slice', () => {
      const page = readFileSync(
        join(root, 'src', 'pages', 'admin', 'discrepancies.astro'),
        'utf8',
      );
      expect(page).not.toContain('data-dismiss');
      expect(page).not.toMatch(/>\s*Dismiss\s*</);
    });

    it('never writes an event claiming a refund happened', () => {
      const source = readFileSync(
        join(root, 'src', 'services', 'payments', 'discrepancies.ts'),
        'utf8',
      );
      // Only the event-writing SQL matters. The reserved refund STATES appear
      // in the type union because migration 0013 declares them; what must not
      // exist is any statement writing one as a historical fact.
      const inserts = source
        .split('insert into payment_discrepancy_events')
        .slice(1)
        .map((chunk) => chunk.slice(0, chunk.indexOf('.bind(')));
      expect(inserts.length).toBeGreaterThan(0);

      const written = inserts.join(' ');
      expect(written).toMatch(/'detected'/);
      expect(written).toMatch(/'resolved_manually'/);
      expect(written).toMatch(/'reopened'/);
      expect(written).toMatch(/'evidence_enriched'/);
      // Amped Up has not verified that any refund occurred, so it may not say so.
      expect(written).not.toMatch(/refunded|refund_requested|refund_confirmed|refund_failed/);
    });

    it('makes no provider call from the operator path', () => {
      for (const file of [
        join(root, 'src', 'pages', 'admin', 'discrepancies.astro'),
        join(root, 'src', 'pages', 'api', 'admin', 'discrepancies', '[id]', 'resolve.ts'),
        join(root, 'src', 'pages', 'api', 'admin', 'discrepancies', '[id]', 'reopen.ts'),
      ]) {
        const code = readFileSync(file, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        expect(code).not.toContain('api.sumup.com');
        expect(code).not.toContain('createSumUpClient');
        expect(code).not.toContain('applyVerifiedPayment');
      }
    });
  });
});
