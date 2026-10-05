/** AMPED-08A: real ephemeral D1, no provider network and no Worker mutex. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { openEphemeralDatabase } from '../../src/db/local.ts';
import { migrate } from '../../src/db/migrations.ts';
import { applySeed } from '../../src/db/seed.ts';
import { createD1OrderMutations } from '../../src/services/orders/service.ts';
import { createMockPaymentProvider } from '../../src/services/payments/mock.ts';
import { createD1TicketIssuance } from '../../src/services/tickets/issuance.ts';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const NOW = new Date('2026-09-23T20:00:00.000Z');
const EVENT = 'evt_glass_hearts_nov';
const TYPE = 'tt_gh_ga';

describe('AMPED-08A paid-order ticket issuance', () => {
  let ephemeral: Awaited<ReturnType<typeof openEphemeralDatabase>>;
  let db: D1Database;
  let counter = 0;

  beforeAll(async () => {
    ephemeral = await openEphemeralDatabase();
    db = ephemeral.db;
    await migrate(db);
    await applySeed(db);
  });

  afterAll(async () => ephemeral.dispose());

  function orders() {
    return createD1OrderMutations(db, () => NOW, (prefix) => `${prefix}_08a_${++counter}`);
  }

  async function createOrder(quantity = 3) {
    const service = orders();
    const created = await service.createOrder({
      eventId: EVENT,
      items: [{ ticketTypeId: TYPE, quantity }],
      customerName: '08A Test Buyer',
      customerEmail: `08a-${++counter}@example.invalid`,
      marketingOptIn: false,
    });
    return { service, orderId: created.orderId };
  }

  async function pay(quantity = 3) {
    const order = await createOrder(quantity);
    const provider = createMockPaymentProvider({ now: () => NOW, newId: () => `08a_${++counter}` });
    const checkout = await order.service.beginPayment(
      order.orderId,
      provider,
      'https://amped.test/checkout/return',
    );
    await order.service.confirmPayment(order.orderId, checkout.checkoutId, provider);
    return order.orderId;
  }

  async function state(orderId: string) {
    const tickets = await db.prepare(
      'select id, order_item_id, unit_ordinal, reference, token_hash from tickets where order_id = ?1 order by unit_ordinal',
    ).bind(orderId).all<{
      id: string; order_item_id: string; unit_ordinal: number; reference: string; token_hash: string | null;
    }>();
    const audit = await db.prepare(
      "select count(*) as n from audit_log where entity_type = 'order' and entity_id = ?1 and action = 'order.fulfilled'",
    ).bind(orderId).first<{ n: number }>();
    const order = await db.prepare(
      'select status, tickets_fulfilled_at from orders where id = ?1',
    ).bind(orderId).first<{ status: string; tickets_fulfilled_at: string | null }>();
    return { tickets: tickets.results, audit: audit?.n ?? 0, order };
  }

  it('issues one deterministic unit per purchased quantity exactly once under 20 concurrent issuers', async () => {
    const orderId = await pay(3);
    const issuance = createD1TicketIssuance(db, () => NOW);
    const results = await Promise.all(Array.from({ length: 20 }, () => issuance.issuePaidOrder(orderId)));
    const result = await state(orderId);
    expect(results.reduce((n, value) => n + value.issued, 0)).toBe(3);
    expect(result.tickets).toHaveLength(3);
    expect(new Set(result.tickets.map((ticket) => ticket.id)).size).toBe(3);
    expect(result.tickets.map((ticket) => ticket.unit_ordinal)).toEqual([1, 2, 3]);
    expect(result.tickets.every((ticket) => ticket.token_hash === null)).toBe(true);
    expect(result.audit).toBe(1);
    expect(result.order?.status).toBe('paid');
    expect(result.order?.tickets_fulfilled_at).toBe(NOW.toISOString());
    for (let index = 0; index < 20; index += 1) {
      expect((await issuance.issuePaidOrder(orderId)).issued).toBe(0);
    }
    expect((await state(orderId)).audit).toBe(1);
  });

  it('recovers the paid-before-issuance crash window without another payment call', async () => {
    const orderId = await pay(2);
    expect((await state(orderId)).tickets).toHaveLength(0);
    const issuance = createD1TicketIssuance(db, () => NOW);
    const recovered = await issuance.recoverPending();
    expect(recovered.issued).toBeGreaterThanOrEqual(2);
    expect((await state(orderId)).tickets).toHaveLength(2);
    expect((await issuance.recoverPending()).issued).toBe(0);
  });

  it('fills only missing units in a legitimate partial keyed fixture', async () => {
    const orderId = await pay(3);
    const item = await db.prepare('select id from order_items where order_id = ?1')
      .bind(orderId).first<{ id: string }>();
    const reference = await db.prepare('select reference from orders where id = ?1')
      .bind(orderId).first<{ reference: string }>();
    await db.prepare(
      "insert into tickets (id, order_id, event_id, ticket_type_id, order_item_id, unit_ordinal, reference, status, is_guest_list, issued_at) values (?1, ?2, ?3, ?4, ?5, 1, ?6, 'issued', 0, ?7)",
    ).bind(`tkt_${item!.id}_1`, orderId, EVENT, TYPE, item!.id, `${reference!.reference}-1`, NOW.toISOString()).run();
    const issued = await createD1TicketIssuance(db, () => NOW).issuePaidOrder(orderId);
    expect(issued.issued).toBe(2);
    expect((await state(orderId)).tickets).toHaveLength(3);
    expect((await state(orderId)).audit).toBe(1);
  });

  it('assigns stable references and ordinals across multiple purchased items', async () => {
    const secondType = `tt_08a_second_${++counter}`;
    await db.prepare(
      "insert into ticket_types (id, event_id, name, price_in_pence, capacity, max_per_order, position, visibility) values (?1, ?2, '08A Second Type', 100, 10, 5, 100, 'public')",
    ).bind(secondType, EVENT).run();
    const service = orders();
    const created = await service.createOrder({
      eventId: EVENT,
      items: [
        { ticketTypeId: TYPE, quantity: 2 },
        { ticketTypeId: secondType, quantity: 3 },
      ],
      customerName: '08A Multi Item',
      customerEmail: `08a-multi-${counter}@example.invalid`,
      marketingOptIn: false,
    });
    const provider = createMockPaymentProvider({ now: () => NOW });
    const checkout = await service.beginPayment(created.orderId, provider, 'https://amped.test/checkout/return');
    await service.confirmPayment(created.orderId, checkout.checkoutId, provider);
    expect((await createD1TicketIssuance(db, () => NOW).issuePaidOrder(created.orderId)).issued).toBe(5);
    const rows = await db.prepare(
      'select ticket_type_id, unit_ordinal, reference from tickets where order_id = ?1 order by reference',
    ).bind(created.orderId).all<{ ticket_type_id: string; unit_ordinal: number; reference: string }>();
    expect(rows.results).toHaveLength(5);
    expect(rows.results.filter((row) => row.ticket_type_id === TYPE).map((row) => row.unit_ordinal).sort())
      .toEqual([1, 2]);
    expect(rows.results.filter((row) => row.ticket_type_id === secondType).map((row) => row.unit_ordinal).sort())
      .toEqual([1, 2, 3]);
    expect(new Set(rows.results.map((row) => row.reference)).size).toBe(5);
  });

  it('keeps immediate and scheduled recovery concurrent attempts idempotent', async () => {
    const orderId = await pay(2);
    const issuance = createD1TicketIssuance(db, () => NOW);
    await Promise.all([issuance.issuePaidOrder(orderId), issuance.recoverPending()]);
    const result = await state(orderId);
    expect(result.tickets).toHaveLength(2);
    expect(result.audit).toBe(1);
  });

  it('uses the incomplete-paid index and a hard bounded recovery batch', async () => {
    const first = await pay(1);
    const second = await pay(1);
    const plan = await db.prepare(
      "explain query plan select id from orders indexed by orders_unfulfilled_paid_idx where status = 'paid' and tickets_fulfilled_at is null order by paid_at, id limit ?1",
    ).bind(25).all<{ detail: string }>();
    expect(plan.results.some((row) => row.detail.includes('orders_unfulfilled_paid_idx'))).toBe(true);
    const issuance = createD1TicketIssuance(db, () => NOW);
    expect((await issuance.recoverPending(1)).examined).toBe(1);
    expect((await state(first)).tickets.length + (await state(second)).tickets.length).toBe(1);
    expect((await issuance.recoverPending(1)).examined).toBe(1);
    expect((await state(first)).tickets.length + (await state(second)).tickets.length).toBe(2);
    expect((await issuance.recoverPending(999)).examined).toBe(0);
  });

  it('refuses unpaid orders in both the service and database guard', async () => {
    const { orderId } = await createOrder(1);
    expect((await createD1TicketIssuance(db).issuePaidOrder(orderId)).outcome).toBe('unpaid');
    const item = await db.prepare('select id from order_items where order_id = ?1')
      .bind(orderId).first<{ id: string }>();
    await expect(db.prepare(
      "insert into tickets (id, order_id, event_id, ticket_type_id, order_item_id, unit_ordinal, reference, status, is_guest_list, issued_at) values ('tkt_unpaid', ?1, ?2, ?3, ?4, 1, 'TKT-UNPAID', 'issued', 0, ?5)",
    ).bind(orderId, EVENT, TYPE, item!.id, NOW.toISOString()).run()).rejects.toThrow(/paid matching order item/);
    expect((await state(orderId)).tickets).toHaveLength(0);
  });

  it('issues nothing for pending, awaiting, expired, or cancelled states', async () => {
    const issuance = createD1TicketIssuance(db, () => NOW);
    for (const status of ['pending', 'awaiting_payment', 'expired', 'cancelled']) {
      const { orderId } = await createOrder(1);
      if (status !== 'pending') {
        await db.prepare('update orders set status = ?1, reservation_expires_at = ?2 where id = ?3')
          .bind(status, new Date(NOW.getTime() + 30 * 60_000).toISOString(), orderId).run();
      }
      expect((await issuance.issuePaidOrder(orderId)).outcome).toBe('unpaid');
      expect((await state(orderId)).tickets).toHaveLength(0);
    }
  });

  it('uses purchased snapshot quantities after public ticket settings change', async () => {
    const orderId = await pay(2);
    const before = await db.prepare('select price_in_pence, capacity, visibility from ticket_types where id = ?1')
      .bind(TYPE).first<{ price_in_pence: number; capacity: number; visibility: string }>();
    await expect(db.prepare('update order_items set quantity = 3 where order_id = ?1')
      .bind(orderId).run()).rejects.toThrow(/immutable/);
    await db.prepare("update ticket_types set price_in_pence = 9999, capacity = 0, visibility = 'hidden' where id = ?1")
      .bind(TYPE).run();
    const issued = await createD1TicketIssuance(db, () => NOW).issuePaidOrder(orderId);
    expect(issued.expected).toBe(2);
    expect((await state(orderId)).tickets).toHaveLength(2);
    // Restore the shared seed type for later cases and other test files.
    await db.prepare('update ticket_types set price_in_pence = ?1, capacity = ?2, visibility = ?3 where id = ?4')
      .bind(before!.price_in_pence, before!.capacity, before!.visibility, TYPE).run();
  });
});
