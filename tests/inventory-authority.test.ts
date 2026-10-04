/**
 * AMPED-06B0 - commercial inventory authority.
 *
 * Order state is the authority for sold stock; ticket rows are fulfilment
 * only. These tests prove that a paid order sells its captured quantity with
 * zero tickets, that issuing/checking-in tickets never adds a second sale, that
 * the awaiting_payment -> paid transition keeps availability committed, and
 * that the seeded fixture figures are unchanged.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { openEphemeralDatabase } from '../src/db/local.ts';
import { migrate } from '../src/db/migrations.ts';
import { applySeed } from '../src/db/seed.ts';
import { createD1TicketInventoryService } from '../src/services/d1/tickets.ts';
import { createD1OrderMutations } from '../src/services/orders/service.ts';
import { createMockPaymentProvider } from '../src/services/payments/mock.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const FIXED_NOW = new Date('2026-09-24T09:00:00.000Z');
// AMPED-07C1: `order.paid` is written by the shared confirmation primitive,
// so its actor names the verification path that caused it rather than the
// generic 'checkout' used while the mock route was the only way in.
const PAID_ACTOR = 'system:mock-payment';

interface Probe {
  eventId: string;
  typeId: string;
}

describe('AMPED-06B0 commercial inventory authority', () => {
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

  function inventory() {
    return createD1TicketInventoryService(db, () => FIXED_NOW);
  }

  function orders() {
    return createD1OrderMutations(db, () => FIXED_NOW, (p) => `${p}_a${++counter}`);
  }

  async function makeProbe(capacity = 50): Promise<Probe> {
    counter += 1;
    const eventId = `evt_auth_${counter}`;
    const typeId = `tt_auth_${counter}`;
    const stamp = FIXED_NOW.toISOString();
    await db
      .prepare(
        'insert into events (id, title, slug, status, description, venue_id, doors_at, starts_at, ends_at, age_restriction, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, null, ?, ?, ?)',
      )
      .bind(
        eventId,
        `Authority probe ${counter}`,
        `authority-probe-${counter}`,
        'published',
        'A probe event for inventory authority tests.',
        'ven_lomax',
        stamp,
        stamp,
        'all-ages',
        stamp,
        stamp,
      )
      .run();
    await db
      .prepare(
        "insert into ticket_types (id, event_id, name, description, price_in_pence, capacity, max_per_order, position, visibility) values (?, ?, 'Authority GA', null, 1000, ?, 6, 0, 'public')",
      )
      .bind(typeId, eventId, capacity)
      .run();
    return { eventId, typeId };
  }

  async function cleanup(probe: Probe): Promise<void> {
    await db.prepare('delete from tickets where event_id = ?').bind(probe.eventId).run();
    await db.prepare('delete from orders where event_id = ?').bind(probe.eventId).run();
    await db.prepare('delete from ticket_types where event_id = ?').bind(probe.eventId).run();
    await db.prepare('delete from events where id = ?').bind(probe.eventId).run();
  }

  async function checkout(probe: Probe, quantity: number) {
    const service = orders();
    const created = await service.createOrder({
      eventId: probe.eventId,
      items: [{ ticketTypeId: probe.typeId, quantity }],
      customerName: 'Authority Probe',
      customerEmail: 'authority@example.com',
      marketingOptIn: false,
    });
    return { service, created };
  }

  // -- seed parity -----------------------------------------------------------

  it('preserves every seeded ticket type figure from the old ticket-derived authority', async () => {
    const rows = await db
      .prepare(
        `select tt.id,
           (select count(*) from tickets t where t.ticket_type_id = tt.id and t.status in ('issued','checked_in')) as ticket_sold,
           (select coalesce(sum(oi.quantity),0) from order_items oi join orders o on o.id = oi.order_id
             where oi.ticket_type_id = tt.id and o.status in ('paid','partially_refunded')) as commercial_sold
         from ticket_types tt order by tt.id`,
      )
      .all<{ id: string; ticket_sold: number; commercial_sold: number }>();

    expect(rows.results.length).toBe(22);
    for (const row of rows.results) {
      expect(row.commercial_sold, row.id).toBe(row.ticket_sold);
    }

    // Spot-check the fixture figures the public site shows.
    const byId = new Map(rows.results.map((row) => [row.id, row.commercial_sold]));
    expect(byId.get('tt_gh_early')).toBe(60);
    expect(byId.get('tt_gh_ga')).toBe(96);
    expect(byId.get('tt_hc_seated')).toBe(138);
    expect(byId.get('tt_led_ga')).toBe(82);
    expect(byId.get('tt_va_ga')).toBe(186);
  });

  it('keeps seeded availability states reachable through the public read', async () => {
    const glass = await db
      .prepare(
        "select (select coalesce(sum(oi.quantity),0) from order_items oi join orders o on o.id = oi.order_id where oi.ticket_type_id = 'tt_gh_ga' and o.status in ('paid','partially_refunded')) as sold",
      )
      .first<{ sold: number }>();
    const entry = await inventory().ticketTypeInventory('tt_gh_ga');
    expect(entry?.sold).toBe(glass?.sold);
    expect(entry?.available).toBe(140 - (glass?.sold ?? 0) - (entry?.reserved ?? 0));
  });

  // -- commercial sold -------------------------------------------------------

  it('counts a paid order with zero tickets as sold (central acceptance)', async () => {
    const probe = await makeProbe(50);
    try {
      const { service, created } = await checkout(probe, 2);
      const provider = createMockPaymentProvider({ now: () => FIXED_NOW });
      const begun = await service.beginPayment(created.orderId, provider, 'https://amped.test/checkout/return');
      await service.confirmPayment(created.orderId, begun.checkoutId, provider);

      const tickets = await db
        .prepare('select count(*) as n from tickets where order_id = ?')
        .bind(created.orderId)
        .first<{ n: number }>();
      expect(tickets?.n).toBe(0);

      const entry = await inventory().ticketTypeInventory(probe.typeId);
      expect(entry?.sold).toBe(2);
      expect(entry?.reserved).toBe(0);
      expect(entry?.available).toBe(48);
    } finally {
      await cleanup(probe);
    }
  });

  it('never double counts when tickets are issued and checked in afterwards', async () => {
    const probe = await makeProbe(50);
    try {
      const { service, created } = await checkout(probe, 2);
      const provider = createMockPaymentProvider({ now: () => FIXED_NOW });
      const begun = await service.beginPayment(created.orderId, provider, 'https://amped.test/checkout/return');
      await service.confirmPayment(created.orderId, begun.checkoutId, provider);

      const before = await inventory().ticketTypeInventory(probe.typeId);

      for (let index = 0; index < 2; index += 1) {
        await db
          .prepare(
            "insert into tickets (id, order_id, event_id, ticket_type_id, reference, status, is_guest_list, issued_at) values (?, ?, ?, ?, ?, 'issued', 0, ?)",
          )
          .bind(
            `tkt_auth_${probe.typeId}_${index}`,
            created.orderId,
            probe.eventId,
            probe.typeId,
            `AMP-AUTH-${index}`,
            FIXED_NOW.toISOString(),
          )
          .run();
      }
      const afterIssue = await inventory().ticketTypeInventory(probe.typeId);
      expect(afterIssue?.sold).toBe(before?.sold);
      expect(afterIssue?.available).toBe(before?.available);

      await db
        .prepare("update tickets set status = 'checked_in', checked_in_at = ? where order_id = ?")
        .bind(FIXED_NOW.toISOString(), created.orderId)
        .run();
      const afterCheckIn = await inventory().ticketTypeInventory(probe.typeId);
      expect(afterCheckIn?.sold).toBe(before?.sold);
      expect(afterCheckIn?.available).toBe(before?.available);
    } finally {
      await cleanup(probe);
    }
  });

  it('counts quantities above one and aggregates several paid orders', async () => {
    const probe = await makeProbe(50);
    try {
      const service = orders();
      const provider = createMockPaymentProvider({ now: () => FIXED_NOW });
      for (const quantity of [3, 4]) {
        const created = await service.createOrder({
          eventId: probe.eventId,
          items: [{ ticketTypeId: probe.typeId, quantity }],
          customerName: 'Authority Probe',
          customerEmail: 'authority@example.com',
          marketingOptIn: false,
        });
        const begun = await service.beginPayment(created.orderId, provider, 'https://amped.test/checkout/return');
        await service.confirmPayment(created.orderId, begun.checkoutId, provider);
      }

      const entry = await inventory().ticketTypeInventory(probe.typeId);
      expect(entry?.sold).toBe(7);
      expect(entry?.available).toBe(43);
    } finally {
      await cleanup(probe);
    }
  });

  it('does not count non-paid order states as sold', async () => {
    const probe = await makeProbe(50);
    try {
      const service = orders();
      const statuses = ['pending', 'awaiting_payment', 'expired', 'cancelled', 'refunded'];
      for (const status of statuses) {
        const created = await service.createOrder({
          eventId: probe.eventId,
          items: [{ ticketTypeId: probe.typeId, quantity: 2 }],
          customerName: 'Authority Probe',
          customerEmail: 'authority@example.com',
          marketingOptIn: false,
        });
        // Directly set the probe status: this test is about read semantics,
        // not about driving every path through the state machine.
        if (status === 'awaiting_payment') {
          await db
            .prepare(
              "update orders set status = 'awaiting_payment', reservation_expires_at = ? where id = ?",
            )
            .bind(new Date(FIXED_NOW.getTime() + 60_000).toISOString(), created.orderId)
            .run();
        } else {
          await db
            .prepare('update orders set status = ? where id = ?')
            .bind(status, created.orderId)
            .run();
        }
        const entry = await inventory().ticketTypeInventory(probe.typeId);
        expect(entry?.sold, status).toBe(0);
      }
    } finally {
      await cleanup(probe);
    }
  });

  // -- refund semantics ------------------------------------------------------

  it('counts partially_refunded in full and refunded as zero', async () => {
    const probe = await makeProbe(50);
    try {
      const service = orders();
      const provider = createMockPaymentProvider({ now: () => FIXED_NOW });
      const created = await service.createOrder({
        eventId: probe.eventId,
        items: [{ ticketTypeId: probe.typeId, quantity: 3 }],
        customerName: 'Authority Probe',
        customerEmail: 'authority@example.com',
        marketingOptIn: false,
      });
      const begun = await service.beginPayment(created.orderId, provider, 'https://amped.test/checkout/return');
      await service.confirmPayment(created.orderId, begun.checkoutId, provider);
      expect((await inventory().ticketTypeInventory(probe.typeId))?.sold).toBe(3);

      await db
        .prepare("update orders set status = 'partially_refunded' where id = ?")
        .bind(created.orderId)
        .run();
      // Conservative V1: the schema cannot release part of an order safely.
      expect((await inventory().ticketTypeInventory(probe.typeId))?.sold).toBe(3);

      await db.prepare("update orders set status = 'refunded' where id = ?").bind(created.orderId).run();
      expect((await inventory().ticketTypeInventory(probe.typeId))?.sold).toBe(0);
      expect((await inventory().ticketTypeInventory(probe.typeId))?.available).toBe(50);
    } finally {
      await cleanup(probe);
    }
  });

  // -- reserved / transition continuity --------------------------------------

  it('keeps availability committed across awaiting_payment -> paid', async () => {
    const probe = await makeProbe(50);
    try {
      const { service, created } = await checkout(probe, 2);
      const provider = createMockPaymentProvider({ now: () => FIXED_NOW });

      const begun = await service.beginPayment(created.orderId, provider, 'https://amped.test/checkout/return');
      const held = await inventory().ticketTypeInventory(probe.typeId);
      expect(held?.sold).toBe(0);
      expect(held?.reserved).toBe(2);
      expect(held?.available).toBe(48);

      await service.confirmPayment(created.orderId, begun.checkoutId, provider);
      const paid = await inventory().ticketTypeInventory(probe.typeId);
      expect(paid?.sold).toBe(2);
      expect(paid?.reserved).toBe(0);
      expect(paid?.available).toBe(48);
      // No transient state releases the stock while tickets do not exist yet.
      expect(paid?.available).toBe(held?.available);
    } finally {
      await cleanup(probe);
    }
  });

  it('keeps the hold when a payment attempt fails, and the sweep releases it', async () => {
    const probe = await makeProbe(50);
    try {
      const { service, created } = await checkout(probe, 2);
      const failing = createMockPaymentProvider({ outcome: 'failed' });
      const begun = await service.beginPayment(created.orderId, failing, 'https://amped.test/checkout/return');
      const result = await service.confirmPayment(created.orderId, begun.checkoutId, failing);

      // AMPED-07C1: a failed attempt is not an abandoned customer. The stock
      // stays held so a retry on the provider's hosted page can still
      // succeed; only elapsed time releases it.
      expect(result.status).toBe('awaiting_payment');
      const held = await inventory().ticketTypeInventory(probe.typeId);
      expect(held?.sold).toBe(0);
      expect(held?.reserved).toBe(2);
      expect(held?.available).toBe(48);

      // Time, and only time, gives the tickets back. The sweep is global, so
      // this asserts THIS order's fate rather than a shared tally.
      const afterWindow = new Date(Date.parse(begun.expiresAt) + 1000);
      await service.expireDueReservations(afterWindow);
      const sweptRow = await db
        .prepare('select status from orders where id = ?')
        .bind(created.orderId)
        .first<{ status: string }>();
      expect(sweptRow?.status).toBe('expired');

      const released = await inventory().ticketTypeInventory(probe.typeId);
      expect(released?.sold).toBe(0);
      expect(released?.reserved).toBe(0);
      expect(released?.available).toBe(50);
    } finally {
      await cleanup(probe);
    }
  });

  it('keeps the exact expiry boundary behaviour', async () => {
    const probe = await makeProbe(50);
    try {
      const service = orders();
      const boundary = await service.createOrder({
        eventId: probe.eventId,
        items: [{ ticketTypeId: probe.typeId, quantity: 5 }],
        customerName: 'Authority Probe',
        customerEmail: 'authority@example.com',
        marketingOptIn: false,
      });
      await db
        .prepare("update orders set status = 'awaiting_payment', reservation_expires_at = ? where id = ?")
        .bind(FIXED_NOW.toISOString(), boundary.orderId)
        .run();
      // Expiring exactly at now is expired, not reserved.
      expect((await inventory().ticketTypeInventory(probe.typeId))?.reserved).toBe(0);

      await db
        .prepare('update orders set reservation_expires_at = ? where id = ?')
        .bind(new Date(FIXED_NOW.getTime() + 1).toISOString(), boundary.orderId)
        .run();
      expect((await inventory().ticketTypeInventory(probe.typeId))?.reserved).toBe(5);
    } finally {
      await cleanup(probe);
    }
  });

  // -- hidden types ----------------------------------------------------------

  it('still excludes hidden guest-list types publicly and counts them internally', async () => {
    const summary = await inventory().eventSummary('evt_glass_hearts_nov');
    expect(summary?.publicTypes.map((entry) => entry.ticketType.id)).toEqual(['tt_gh_early', 'tt_gh_ga']);
    expect(summary?.hiddenTypes.map((entry) => entry.ticketType.id)).toEqual(['tt_gh_guest']);
    expect(summary?.guestList).toBe(11);

    const publicInventory = await inventory().publicInventory(['evt_glass_hearts_nov']);
    expect(publicInventory.counters.has('tt_gh_guest')).toBe(false);
  });

  it('records who created the orders used by the probe (sanity)', async () => {
    const rows = await db
      .prepare(
        "select count(*) as n from audit_log where action = 'order.paid' and actor_email = ?",
      )
      .bind(PAID_ACTOR)
      .first<{ n: number }>();
    expect(rows?.n).toBeGreaterThan(0);
  });
});
