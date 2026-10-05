/** 08A: the actual webhook handler and reconciler compete over one paid order. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { openEphemeralDatabase } from '../../src/db/local.ts';
import { migrate } from '../../src/db/migrations.ts';
import { applySeed } from '../../src/db/seed.ts';
import { createD1OrderMutations } from '../../src/services/orders/service.ts';
import { reconcileSumUpPayments } from '../../src/services/payments/reconciliation.ts';
import { createSumUpClient } from '../../src/services/payments/sumup/client.ts';
import { createSumUpPaymentVerifier } from '../../src/services/payments/sumup/verification.ts';
import { createD1TicketIssuance } from '../../src/services/tickets/issuance.ts';
import type { PaymentProvider } from '../../src/services/contracts.ts';
import { FAKE_API_KEY, FAKE_MERCHANT_CODE } from '../payments/fixtures.ts';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const hoisted = vi.hoisted(() => ({ provide: null as null | (() => unknown) }));
vi.mock('@/services/index.ts', () => ({
  getSumUpVerification: () => {
    if (!hoisted.provide) throw new Error('verification not wired');
    return hoisted.provide();
  },
}));

const { POST } = await import('../../src/pages/api/webhooks/sumup.ts');
const NOW = new Date('2026-09-23T20:00:00.000Z');

describe('AMPED-08A payment-to-fulfilment paths', () => {
  let ephemeral: Awaited<ReturnType<typeof openEphemeralDatabase>>;
  let db: D1Database;
  let sequence = 0;

  beforeAll(async () => {
    ephemeral = await openEphemeralDatabase();
    db = ephemeral.db;
    await migrate(db);
    await applySeed(db);
  });
  afterAll(async () => ephemeral.dispose());

  async function setup() {
    const checkoutId = `chk-08a-${++sequence}`;
    const orders = createD1OrderMutations(db, () => NOW, (prefix) => `${prefix}_path_${++sequence}`);
    const created = await orders.createOrder({
      eventId: 'evt_glass_hearts_nov',
      items: [{ ticketTypeId: 'tt_gh_ga', quantity: 2 }],
      customerName: '08A Payment Path',
      customerEmail: `08a-path-${sequence}@example.invalid`,
      marketingOptIn: false,
    });
    const provider: PaymentProvider = {
      name: 'sumup',
      createCheckout: async () => ({
        checkoutId,
        redirectUrl: 'https://checkout.sumup.com/pay/fake',
        expiresAt: new Date(NOW.getTime() + 30 * 60_000).toISOString(),
      }),
      confirm: async () => ({ status: 'pending' }),
      verifyWebhook: async () => null,
    };
    await orders.beginPayment(created.orderId, provider, 'https://amped.test/checkout/return');
    const order = await db.prepare('select total_in_pence from orders where id = ?1')
      .bind(created.orderId).first<{ total_in_pence: number }>();
    let retrievals = 0;
    const verifier = createSumUpPaymentVerifier({
      client: createSumUpClient({
        apiKey: FAKE_API_KEY,
        merchantCode: FAKE_MERCHANT_CODE,
        fetchImpl: (async () => {
          retrievals += 1;
          return Response.json({
            id: checkoutId,
            status: 'PAID',
            checkout_reference: created.reference,
            amount: order!.total_in_pence / 100,
            currency: 'GBP',
            merchant_code: FAKE_MERCHANT_CODE,
            transactions: [{
              id: `txn-${checkoutId}`,
              status: 'SUCCESSFUL',
              timestamp: NOW.toISOString(),
            }],
          });
        }) as typeof fetch,
        sleep: async () => {},
      }),
      merchantCode: FAKE_MERCHANT_CODE,
      orders,
      now: () => NOW,
    });
    const fulfilment = createD1TicketIssuance(db, () => NOW);
    hoisted.provide = () => ({ orders, verifier, fulfilment });
    const webhook = () => (POST as (ctx: { request: Request }) => Promise<Response>)({
      request: new Request('https://amped.test/api/webhooks/sumup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_type: 'CHECKOUT_STATUS_CHANGED', id: checkoutId }),
      }),
    });
    return { orderId: created.orderId, orders, verifier, fulfilment, webhook, retrievals: () => retrievals };
  }

  async function counts(orderId: string) {
    return db.prepare(`
      select
        (select count(*) from tickets where order_id = ?1) as tickets,
        (select count(*) from audit_log where entity_id = ?1 and action = 'order.paid') as paid_audits,
        (select count(*) from audit_log where entity_id = ?1 and action = 'order.fulfilled') as fulfilment_audits,
        (select count(*) from processed_webhooks where provider_event_id like 'sumup_txn:%'
          and provider = 'sumup') as observations,
        (select status from orders where id = ?1) as status
    `).bind(orderId).first<{
      tickets: number; paid_audits: number; fulfilment_audits: number;
      observations: number; status: string;
    }>();
  }

  it('makes webhook and reconciliation double delivery produce one ticket set', async () => {
    const path = await setup();
    const [response] = await Promise.all([
      path.webhook(),
      reconcileSumUpPayments({
        orders: path.orders,
        verifier: path.verifier,
        fulfilment: path.fulfilment,
        now: () => NOW,
        log: () => {},
      }),
    ]);
    expect(response.status).toBe(204);
    expect(path.retrievals()).toBeGreaterThanOrEqual(1);
    const result = await counts(path.orderId);
    expect(result?.status).toBe('paid');
    expect(result?.tickets).toBe(2);
    expect(result?.paid_audits).toBe(1);
    expect(result?.fulfilment_audits).toBe(1);
    await path.webhook();
    expect((await counts(path.orderId))?.tickets).toBe(2);
  });

  it('recovers when the webhook records payment but fulfilment fails afterward', async () => {
    const path = await setup();
    hoisted.provide = () => ({
      orders: path.orders,
      verifier: path.verifier,
      fulfilment: { issuePaidOrder: async () => { throw new Error('simulated crash gap'); } },
    });
    await expect(path.webhook()).rejects.toThrow('simulated crash gap');
    expect((await counts(path.orderId))?.status).toBe('paid');
    expect((await counts(path.orderId))?.tickets).toBe(0);
    const recovery = await path.fulfilment.recoverPending();
    expect(recovery.issued).toBeGreaterThanOrEqual(2);
    const result = await counts(path.orderId);
    expect(result?.tickets).toBe(2);
    expect(result?.paid_audits).toBe(1);
    expect(result?.fulfilment_audits).toBe(1);
  });
});
