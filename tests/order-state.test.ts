/**
 * AMPED-06A - order state machine and the provider-authoritative paid gate.
 *
 * Runs against an isolated seeded D1. No payment network, no credentials: the
 * mock provider's outcome is configured, and its "slow" mode is an injected
 * gate promise rather than a real sleep.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { openEphemeralDatabase } from '../src/db/local.ts';
import { migrate } from '../src/db/migrations.ts';
import { applySeed } from '../src/db/seed.ts';
import {
  createD1OrderMutations,
  isReferenceCollision,
  type CheckoutInput,
} from '../src/services/orders/service.ts';
import { createMockPaymentProvider, CHECKOUT_WINDOW_MINUTES } from '../src/services/payments/mock.ts';
import { ConflictError, NotFoundError, ValidationError } from '../src/lib/validation.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXED_NOW = new Date('2026-09-23T20:00:00.000Z');
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EVENT = 'evt_glass_hearts_nov';
const TYPE = 'tt_gh_ga';

function checkout(overrides: Partial<CheckoutInput> = {}): CheckoutInput {
  return {
    eventId: EVENT,
    items: [{ ticketTypeId: TYPE, quantity: 2 }],
    customerName: 'Probe Customer',
    customerEmail: 'probe@example.com',
    marketingOptIn: false,
    ...overrides,
  };
}

describe('AMPED-06A order state machine', () => {
  let database: Awaited<ReturnType<typeof openEphemeralDatabase>>;
  let db: D1Database;
  let counter = 0;

  beforeAll(async () => {
    database = await openEphemeralDatabase();
    db = database.db;
    await migrate(db);
    await applySeed(db);
  });

  afterAll(async () => {
    await database.dispose();
  });

  function mutations(referenceSource?: () => string) {
    return createD1OrderMutations(db, () => FIXED_NOW, (p) => `${p}_o${++counter}`, referenceSource);
  }

  async function orderRow(id: string) {
    return db
      .prepare(
        'select reference, status, total_in_pence, paid_at, reservation_expires_at, payment_provider, payment_reference from orders where id = ?',
      )
      .bind(id)
      .first<Record<string, unknown>>();
  }

  it('matches the accepted OrderStatus union and schema state requirements', async () => {
    const rows = await db
      .prepare("select sql from sqlite_master where type = 'table' and name = 'orders'")
      .first<{ sql: string }>();
    for (const status of ['pending', 'awaiting_payment', 'paid', 'cancelled', 'expired', 'refunded', 'partially_refunded']) {
      expect(rows?.sql).toContain(`'${status}'`);
    }
    expect(rows?.sql).toContain("status <> 'paid' OR paid_at IS NOT NULL");
    expect(rows?.sql).toContain("status <> 'awaiting_payment' OR reservation_expires_at IS NOT NULL");

    // The database itself refuses a paid row without paid_at.
    await expect(
      db
        .prepare(
          "insert into orders (id, reference, event_id, customer_name, customer_email, status, total_in_pence, fee_in_pence, marketing_opt_in, created_at, updated_at) values ('ord_bad', 'AMP-26-99999', ?, 'x', 'x@example.com', 'paid', 0, 0, 0, ?, ?)",
        )
        .bind(EVENT, FIXED_NOW.toISOString(), FIXED_NOW.toISOString())
        .run(),
    ).rejects.toThrow(/constraint/i);
  });

  it('creates an order from authoritative ticket data with a generated reference', async () => {
    const service = mutations();
    const type = await db
      .prepare('select name, price_in_pence from ticket_types where id = ?')
      .bind(TYPE)
      .first<{ name: string; price_in_pence: number }>();

    const created = await service.createOrder(checkout());
    expect(created.status).toBe('pending');
    expect(created.reference).toMatch(/^AMP-\d{2}-\d{5}$/);
    expect(created.totalInPence).toBe((type?.price_in_pence ?? 0) * 2);

    const items = await db
      .prepare('select quantity, unit_price_in_pence, ticket_type_name from order_items where order_id = ?')
      .bind(created.orderId)
      .all<{ quantity: number; unit_price_in_pence: number; ticket_type_name: string }>();
    expect(items.results).toEqual([
      {
        quantity: 2,
        unit_price_in_pence: type?.price_in_pence,
        ticket_type_name: type?.name,
      },
    ]);
  });

  it('refuses unknown events, foreign ticket types and invalid quantities', async () => {
    const service = mutations();
    await expect(
      service.createOrder(checkout({ eventId: 'evt_not_real' })),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      service.createOrder(checkout({ items: [{ ticketTypeId: 'tt_not_real', quantity: 1 }] })),
    ).rejects.toBeInstanceOf(NotFoundError);
    // A real ticket type that belongs to a different event.
    await expect(
      service.createOrder(checkout({ eventId: 'evt_hollow_coast_past' })),
    ).rejects.toBeInstanceOf(NotFoundError);

    for (const quantity of [0, -1, 1.5, 1000]) {
      await expect(
        service.createOrder(checkout({ items: [{ ticketTypeId: TYPE, quantity }] })),
      ).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it('ignores any client-supplied financial fields', async () => {
    const service = mutations();
    const type = await db
      .prepare('select price_in_pence from ticket_types where id = ?')
      .bind(TYPE)
      .first<{ price_in_pence: number }>();

    const tampered = { ...checkout(), totalInPence: 1, total: 1, price: 1 } as CheckoutInput;
    const created = await service.createOrder(tampered);
    expect(created.totalInPence).toBe((type?.price_in_pence ?? 0) * 2);
  });

  it('keeps captured item name and price immutable when the ticket type changes', async () => {
    const service = mutations();
    const created = await service.createOrder(checkout());
    const before = await db
      .prepare('select unit_price_in_pence, ticket_type_name from order_items where order_id = ?')
      .bind(created.orderId)
      .first<{ unit_price_in_pence: number; ticket_type_name: string }>();

    await db
      .prepare("update ticket_types set price_in_pence = 9999, name = 'Renamed later' where id = ?")
      .bind(TYPE)
      .run();
    try {
      const after = await db
        .prepare('select unit_price_in_pence, ticket_type_name from order_items where order_id = ?')
        .bind(created.orderId)
        .first();
      expect(after).toEqual(before);
    } finally {
      await db
        .prepare('update ticket_types set price_in_pence = ?, name = ? where id = ?')
        .bind(before?.unit_price_in_pence ?? 0, before?.ticket_type_name ?? '', TYPE)
        .run();
    }
  });

  it('walks the documented legal transitions with canonical timestamps', async () => {
    const service = mutations();
    const provider = createMockPaymentProvider({ now: () => FIXED_NOW });
    const created = await service.createOrder(checkout());

    const begun = await service.beginPayment(created.orderId, provider);
    let row = await orderRow(created.orderId);
    expect(row?.status).toBe('awaiting_payment');
    expect(row?.reservation_expires_at).toMatch(ISO);
    expect(row?.payment_provider).toBe('mock');
    expect(row?.payment_reference).toBe(begun.checkoutId);
    expect(Date.parse(String(row?.reservation_expires_at))).toBe(
      FIXED_NOW.getTime() + CHECKOUT_WINDOW_MINUTES * 60_000,
    );

    const confirmed = await service.confirmPayment(created.orderId, begun.checkoutId, provider);
    expect(confirmed.status).toBe('paid');
    row = await orderRow(created.orderId);
    expect(row?.status).toBe('paid');
    expect(row?.paid_at).toMatch(ISO);

    // Exactly one paid audit even after a second confirmation.
    await service.confirmPayment(created.orderId, begun.checkoutId, provider);
    const audits = await db
      .prepare("select count(*) as n from audit_log where entity_id = ? and action = 'order.paid'")
      .bind(created.orderId)
      .first<{ n: number }>();
    expect(audits?.n).toBe(1);
  });

  it('refuses every illegal transition', async () => {
    const service = mutations();
    const provider = createMockPaymentProvider({ now: () => FIXED_NOW });
    const created = await service.createOrder(checkout());

    // pending cannot expire or be confirmed as paid.
    await expect(service.expireOrder(created.orderId)).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.confirmPayment(created.orderId, 'mock_x', provider),
    ).rejects.toBeInstanceOf(ValidationError);

    const begun = await service.beginPayment(created.orderId, provider);
    // awaiting_payment cannot be cancelled through the pending-only path.
    await expect(service.cancelOrder(created.orderId)).rejects.toBeInstanceOf(ValidationError);
    await expect(service.beginPayment(created.orderId, provider)).rejects.toBeInstanceOf(ConflictError);

    await service.cancelOrder(created.orderId).catch(() => {});
    const paid = await service.confirmPayment(created.orderId, begun.checkoutId, provider);
    expect(paid.status).toBe('paid');
    // A paid order cannot be expired or cancelled.
    await expect(service.expireOrder(created.orderId)).rejects.toBeInstanceOf(ValidationError);
    await expect(service.cancelOrder(created.orderId)).rejects.toBeInstanceOf(ValidationError);
  });

  it('supports pending abandonment and checkout expiry', async () => {
    const service = mutations();
    const abandoned = await service.createOrder(checkout());
    await service.cancelOrder(abandoned.orderId);
    expect((await orderRow(abandoned.orderId))?.status).toBe('cancelled');

    const provider = createMockPaymentProvider({ now: () => FIXED_NOW });
    const expired = await service.createOrder(checkout());
    await service.beginPayment(expired.orderId, provider);
    await service.expireOrder(expired.orderId);
    expect((await orderRow(expired.orderId))?.status).toBe('expired');
  });

  it('has no direct path to paid on the public service surface', async () => {
    const service = mutations() as unknown as Record<string, unknown>;
    for (const forbidden of ['setStatus', 'markPaid', 'markAsPaid', 'setPaid', 'updateStatus']) {
      expect(service[forbidden], forbidden).toBeUndefined();
    }
    // The only public writer of `paid` is confirmPayment, which requires a
    // provider instance.
    expect(typeof (service as { confirmPayment?: unknown }).confirmPayment).toBe('function');
  });

  it('exposes a deterministic mock provider with success, failure, expiry and slow modes', async () => {
    const success = createMockPaymentProvider({ now: () => FIXED_NOW });
    expect(await success.confirm('mock_1')).toEqual({ status: 'paid', paidAt: FIXED_NOW.toISOString() });

    const failure = createMockPaymentProvider({ outcome: 'failed' });
    expect(await failure.confirm('mock_1')).toEqual({ status: 'failed' });

    const expiry = createMockPaymentProvider({ outcome: 'pending' });
    expect(await expiry.confirm('mock_1')).toEqual({ status: 'pending' });

    // Deterministic "slow": confirm waits on an injected gate, not a timer.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = createMockPaymentProvider({ gate, now: () => FIXED_NOW });
    let settled = false;
    const pendingConfirm = slow.confirm('mock_1').then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    expect(await pendingConfirm).toEqual({ status: 'paid', paidAt: FIXED_NOW.toISOString() });

    const checkoutStart = await success.createCheckout({
      orderId: 'ord_1',
      reference: 'AMP-26-00001',
      amountInPence: 1000,
      currency: 'GBP',
      customerEmail: 'probe@example.com',
      returnUrl: '/checkout/return',
    });
    expect(checkoutStart.redirectUrl).toContain('/checkout/mock');
    expect(checkoutStart.expiresAt).toBe(
      new Date(FIXED_NOW.getTime() + CHECKOUT_WINDOW_MINUTES * 60_000).toISOString(),
    );
  });

  it('produces exactly one paid order and issues no tickets', async () => {
    const service = mutations();
    const provider = createMockPaymentProvider({ now: () => FIXED_NOW });
    const ticketsBefore = await db.prepare('select count(*) as n from tickets').first<{ n: number }>();

    const created = await service.createOrder(checkout());
    const begun = await service.beginPayment(created.orderId, provider);
    await service.confirmPayment(created.orderId, begun.checkoutId, provider);

    const orders = await db
      .prepare('select count(*) as n from orders where id = ?')
      .bind(created.orderId)
      .first<{ n: number }>();
    expect(orders?.n).toBe(1);
    const ticketsAfter = await db.prepare('select count(*) as n from tickets').first<{ n: number }>();
    expect(ticketsAfter?.n).toBe(ticketsBefore?.n);
  });

  it('creates unique references under concurrent creation', async () => {
    const service = mutations();
    const created = await Promise.all(
      Array.from({ length: 20 }, () => service.createOrder(checkout({ items: [{ ticketTypeId: TYPE, quantity: 1 }] }))),
    );
    const references = created.map((order) => order.reference);
    expect(new Set(references).size).toBe(references.length);
    expect(references.every((reference) => /^AMP-\d{2}-\d{5}$/.test(reference))).toBe(true);

    const stored = await db
      .prepare('select count(*) as n from orders where id in (select value from json_each(?1))')
      .bind(JSON.stringify(created.map((order) => order.orderId)))
      .first<{ n: number }>();
    expect(stored?.n).toBe(20);
  });

  it('retries only the reference collision and never duplicates the order', async () => {
    const clash = 'AMP-26-12345';
    await db
      .prepare(
        "insert into orders (id, reference, event_id, customer_name, customer_email, status, total_in_pence, fee_in_pence, marketing_opt_in, created_at, updated_at) values ('ord_refclash', ?, ?, 'x', 'x@example.com', 'pending', 0, 0, 0, ?, ?)",
      )
      .bind(clash, EVENT, FIXED_NOW.toISOString(), FIXED_NOW.toISOString())
      .run();

    let calls = 0;
    const service = mutations(() => (++calls === 1 ? clash : 'AMP-26-54321'));
    const created = await service.createOrder(checkout());
    expect(calls).toBe(2);
    expect(created.reference).toBe('AMP-26-54321');
    const count = await db
      .prepare("select count(*) as n from orders where reference = 'AMP-26-54321'")
      .first<{ n: number }>();
    expect(count?.n).toBe(1);

    // Exhausting the retry budget is a controlled conflict, with no order left.
    const always = mutations(() => clash);
    const before = await db.prepare('select count(*) as n from orders').first<{ n: number }>();
    await expect(always.createOrder(checkout())).rejects.toBeInstanceOf(ConflictError);
    const after = await db.prepare('select count(*) as n from orders').first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });

  it('detects only reference collisions for retry', () => {
    expect(isReferenceCollision(new Error('D1_ERROR: UNIQUE constraint failed: orders.reference'))).toBe(true);
    expect(isReferenceCollision(new Error('D1_ERROR: NOT NULL constraint failed: orders.status'))).toBe(false);
    expect(isReferenceCollision(new Error('network unavailable'))).toBe(false);
  });

  it('implements the mock provider without network access or credentials', () => {
    const files = [
      join(root, 'src', 'services', 'payments', 'mock.ts'),
      join(root, 'src', 'services', 'orders', 'service.ts'),
      join(root, 'src', 'pages', 'api', 'checkout', 'orders.ts'),
      join(root, 'src', 'pages', 'api', 'checkout', 'confirm.ts'),
    ];
    for (const file of files) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/\bfetch\s*\(/);
      expect(code, file).not.toMatch(/sumup/i);
      expect(code, file).not.toMatch(/api[_-]?key/i);
    }
  });

  it('does not schedule anything itself, and never claims concurrency safety', () => {
    // AMPED-06B adds the reservation-expiry sweep method and the Worker cron,
    // but the order/payment services must not schedule their own timers or
    // claim the 06C concurrency guarantee.
    const files = [
      join(root, 'src', 'services', 'orders', 'service.ts'),
      join(root, 'src', 'services', 'payments', 'mock.ts'),
    ];
    for (const file of files) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/setInterval|setTimeout|schedule\(|cron|oversell|lazyReconcile/i);
    }
  });

  it('keeps the admin orders page read-only with no mark-paid control', () => {
    const source = readFileSync(join(root, 'src', 'pages', 'admin', 'orders.astro'), 'utf8');
    expect(source).toMatch(/services\.orders\./);
    expect(source).not.toMatch(/mark.?paid|setStatus|confirmPayment/i);
  });
});
