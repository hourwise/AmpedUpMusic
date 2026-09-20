/**
 * AMPED-02D - D1 ticket-type and inventory reads.
 *
 * Proves the single authoritative read implementation in
 * src/services/d1/tickets.ts:
 *
 *  - sold = issued + checked_in only (void/refunded excluded);
 *  - reserved = unexpired awaiting_payment order-item quantity, with the
 *    expiry boundary decided by the database;
 *  - available = capacity - sold - reserved, floored at zero, with over-
 *    commitment surfaced rather than hidden;
 *  - hidden/guest-list types are absent publicly, present internally, and
 *    never contribute to public on-sale capacity;
 *  - deriveAvailability() still decides every public state from these inputs;
 *  - EventView is fed from this same implementation (AMPED-02C shape intact);
 *  - reads are grouped, never one pair of queries per ticket type.
 *
 * Edge cases use controlled local rows with a fixed clock. The seeded states
 * are asserted too, from the accepted AMPED-02A seed - no sleeping, no remote
 * resources, no seed changes.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { applySeed } from '../src/db/seed.ts';
import { migrate } from '../src/db/migrations.ts';
import { openEphemeralDatabase } from '../src/db/local.ts';
import { createD1EventRepository } from '../src/services/d1/events.ts';
import {
  createD1TicketInventoryService,
  type TicketInventoryService,
  type TicketTypeInventory,
} from '../src/services/d1/tickets.ts';
import { deriveAvailability, rollUpAvailability } from '../src/lib/availability.ts';
import type { AvailabilityState, TicketInventory } from '../src/types/domain.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const FIXED_NOW = new Date('2026-06-01T12:00:00.000Z');

/** A D1Database that records the SQL text of every prepared statement. */
function instrument(db: D1Database): { db: D1Database; queries: string[] } {
  const queries: string[] = [];
  const wrapped = new Proxy(db as unknown as Record<string | symbol, unknown>, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) => {
          queries.push(sql);
          return db.prepare(sql);
        };
      }
      const value = target[property];
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(db)
        : value;
    },
  }) as unknown as D1Database;
  return { db: wrapped, queries };
}

describe('AMPED-02D ticket and inventory reads', () => {
  let database: Awaited<ReturnType<typeof openEphemeralDatabase>>;
  let db: D1Database;
  let tickets: TicketInventoryService;
  let fixed: TicketInventoryService;
  let counter = 0;

  beforeAll(async () => {
    database = await openEphemeralDatabase();
    db = database.db;
    await migrate(db);
    await applySeed(db);

    tickets = createD1TicketInventoryService(db);
    fixed = createD1TicketInventoryService(db, () => FIXED_NOW);
  });

  afterAll(async () => {
    await database.dispose();
  });

  // -- probe builders --------------------------------------------------------

  async function makeProbeEvent(): Promise<string> {
    counter += 1;
    const id = `evt_02d_${counter}`;
    const stamp = '2026-01-01T00:00:00.000Z';
    const startsAt = new Date(Date.now() + 40 * 86_400_000).toISOString();
    await db
      .prepare(
        `insert into events (id, title, slug, status, description, venue_id, doors_at, starts_at, ends_at, age_restriction, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        `Probe 02D ${counter}`,
        `02d-probe-${counter}`,
        'published',
        'Temporary AMPED-02D probe event.',
        'ven_lomax',
        startsAt,
        startsAt,
        null,
        'all-ages',
        stamp,
        stamp,
      )
      .run();
    return id;
  }

  async function makeProbeType(
    eventId: string,
    options: {
      capacity: number;
      visibility?: 'public' | 'hidden';
      position?: number;
      salesOpenAt?: string | null;
      salesCloseAt?: string | null;
    },
  ): Promise<string> {
    counter += 1;
    const id = `tt_02d_${counter}`;
    await db
      .prepare(
        `insert into ticket_types (id, event_id, name, description, price_in_pence, capacity, max_per_order, sales_open_at, sales_close_at, position, visibility)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        eventId,
        `Probe Type ${counter}`,
        null,
        1000,
        options.capacity,
        null,
        options.salesOpenAt ?? null,
        options.salesCloseAt ?? null,
        options.position ?? 0,
        options.visibility ?? 'public',
      )
      .run();
    return id;
  }

  async function makeProbeOrder(
    eventId: string,
    options: { status: string; reservationExpiresAt?: string | null; paidAt?: string | null },
  ): Promise<string> {
    counter += 1;
    const id = `ord_02d_${counter}`;
    const stamp = '2026-01-01T00:00:00.000Z';
    await db
      .prepare(
        `insert into orders (id, reference, event_id, customer_name, customer_email, status, total_in_pence, fee_in_pence, paid_at, reservation_expires_at, marketing_opt_in, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        `AMP-02D-${counter}`,
        eventId,
        'Probe Customer',
        'probe@example.com',
        options.status,
        0,
        0,
        options.paidAt ?? null,
        options.reservationExpiresAt ?? null,
        0,
        stamp,
        stamp,
      )
      .run();
    return id;
  }

  async function makeProbeOrderItem(
    orderId: string,
    ticketTypeId: string,
    quantity: number,
  ): Promise<void> {
    counter += 1;
    await db
      .prepare(
        `insert into order_items (id, order_id, ticket_type_id, quantity, unit_price_in_pence, ticket_type_name)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .bind(`oi_02d_${counter}`, orderId, ticketTypeId, quantity, 1000, 'Probe Type')
      .run();
  }

  async function makeProbeTicket(
    orderId: string,
    eventId: string,
    ticketTypeId: string,
    status: 'issued' | 'checked_in' | 'void' | 'refunded',
  ): Promise<void> {
    counter += 1;
    await db
      .prepare(
        `insert into tickets (id, order_id, event_id, ticket_type_id, reference, status, is_guest_list, issued_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        `tkt_02d_${counter}`,
        orderId,
        eventId,
        ticketTypeId,
        `TKT-02D-${counter}`,
        status,
        0,
        '2026-01-01T00:00:00.000Z',
      )
      .run();
  }

  async function deleteProbe(eventId: string): Promise<void> {
    await db.prepare('delete from tickets where event_id = ?').bind(eventId).run();
    await db.prepare('delete from orders where event_id = ?').bind(eventId).run();
    await db.prepare('delete from ticket_types where event_id = ?').bind(eventId).run();
    await db.prepare('delete from events where id = ?').bind(eventId).run();
  }

  function availabilityOf(
    entry: TicketTypeInventory,
    eventSellable = true,
    now: Date = new Date(),
  ): AvailabilityState {
    const inventory: TicketInventory = {
      ticketTypeId: entry.ticketType.id,
      capacity: entry.ticketType.capacity,
      sold: entry.sold,
      reserved: entry.reserved,
      available: entry.available,
    };
    return deriveAvailability(
      {
        inventory,
        salesOpenAt: entry.ticketType.sales_open_at ?? undefined,
        salesCloseAt: entry.ticketType.sales_close_at ?? undefined,
        eventSellable,
      },
      now,
    );
  }

  // -- sold ------------------------------------------------------------------

  it('counts only issued and checked_in tickets as sold', async () => {
    const eventId = await makeProbeEvent();
    const typeId = await makeProbeType(eventId, { capacity: 100 });
    const orderId = await makeProbeOrder(eventId, {
      status: 'paid',
      paidAt: '2026-01-01T00:00:00.000Z',
    });
    await makeProbeTicket(orderId, eventId, typeId, 'issued');
    await makeProbeTicket(orderId, eventId, typeId, 'issued');
    await makeProbeTicket(orderId, eventId, typeId, 'checked_in');
    await makeProbeTicket(orderId, eventId, typeId, 'void');
    await makeProbeTicket(orderId, eventId, typeId, 'refunded');

    try {
      const inventory = await tickets.ticketTypeInventory(typeId);
      expect(inventory).not.toBeNull();
      expect(inventory?.sold).toBe(3);
      expect(inventory?.reserved).toBe(0);
      expect(inventory?.available).toBe(97);
    } finally {
      await deleteProbe(eventId);
    }
  });

  // -- reserved --------------------------------------------------------------

  it('counts only strictly future awaiting_payment reservations', async () => {
    const eventId = await makeProbeEvent();
    const typeId = await makeProbeType(eventId, { capacity: 100 });

    const active = await makeProbeOrder(eventId, {
      status: 'awaiting_payment',
      reservationExpiresAt: new Date(FIXED_NOW.getTime() + 3_600_000).toISOString(),
    });
    await makeProbeOrderItem(active, typeId, 2);
    await makeProbeOrderItem(active, typeId, 2);

    const expired = await makeProbeOrder(eventId, {
      status: 'awaiting_payment',
      reservationExpiresAt: new Date(FIXED_NOW.getTime() - 1).toISOString(),
    });
    await makeProbeOrderItem(expired, typeId, 10);

    const boundary = await makeProbeOrder(eventId, {
      status: 'awaiting_payment',
      reservationExpiresAt: FIXED_NOW.toISOString(),
    });
    await makeProbeOrderItem(boundary, typeId, 7);

    const paid = await makeProbeOrder(eventId, {
      status: 'paid',
      paidAt: '2026-01-01T00:00:00.000Z',
    });
    await makeProbeOrderItem(paid, typeId, 5);

    try {
      const inventory = await fixed.ticketTypeInventory(typeId);
      // 2 + 2 active; the expired, the exactly-at-now and the paid item do not count.
      expect(inventory?.reserved).toBe(4);
      expect(inventory?.sold).toBe(0);

      // A reservation is modelled by order_items, never by ticket rows.
      const ticketRows = await db
        .prepare('select count(*) as n from tickets where order_id = ?')
        .bind(active)
        .first<{ n: number }>();
      expect(ticketRows?.n).toBe(0);
    } finally {
      await deleteProbe(eventId);
    }
  });

  it('treats a reservation expiring exactly at now as expired', async () => {
    const eventId = await makeProbeEvent();
    const typeId = await makeProbeType(eventId, { capacity: 10 });
    const boundary = await makeProbeOrder(eventId, {
      status: 'awaiting_payment',
      reservationExpiresAt: FIXED_NOW.toISOString(),
    });
    await makeProbeOrderItem(boundary, typeId, 9);

    try {
      const inventory = await fixed.ticketTypeInventory(typeId);
      expect(inventory?.reserved).toBe(0);
      expect(inventory?.available).toBe(10);
    } finally {
      await deleteProbe(eventId);
    }
  });

  // -- available -------------------------------------------------------------

  it('computes available as capacity minus sold minus reserved', async () => {
    const eventId = await makeProbeEvent();
    const typeId = await makeProbeType(eventId, { capacity: 20 });
    const paid = await makeProbeOrder(eventId, {
      status: 'paid',
      paidAt: '2026-01-01T00:00:00.000Z',
    });
    await makeProbeTicket(paid, eventId, typeId, 'issued');
    await makeProbeTicket(paid, eventId, typeId, 'checked_in');
    await makeProbeTicket(paid, eventId, typeId, 'issued');
    const active = await makeProbeOrder(eventId, {
      status: 'awaiting_payment',
      reservationExpiresAt: new Date(FIXED_NOW.getTime() + 3_600_000).toISOString(),
    });
    await makeProbeOrderItem(active, typeId, 4);

    try {
      const inventory = await fixed.ticketTypeInventory(typeId);
      expect(inventory?.sold).toBe(3);
      expect(inventory?.reserved).toBe(4);
      expect(inventory?.available).toBe(13);
      expect(inventory?.rawAvailable).toBe(13);
      expect(inventory?.overCommitted).toBe(false);
    } finally {
      await deleteProbe(eventId);
    }
  });

  it('floors public availability at zero and surfaces over-commitment', async () => {
    const eventId = await makeProbeEvent();
    const typeId = await makeProbeType(eventId, { capacity: 3 });
    const paid = await makeProbeOrder(eventId, {
      status: 'paid',
      paidAt: '2026-01-01T00:00:00.000Z',
    });
    for (let i = 0; i < 5; i += 1) {
      await makeProbeTicket(paid, eventId, typeId, 'issued');
    }

    try {
      const inventory = await tickets.ticketTypeInventory(typeId);
      expect(inventory?.sold).toBe(5);
      expect(inventory?.available).toBe(0);
      expect(inventory?.rawAvailable).toBe(-2);
      expect(inventory?.overCommitted).toBe(true);
    } finally {
      await deleteProbe(eventId);
    }
  });

  // -- hidden / guest list ---------------------------------------------------

  it('excludes hidden types from public reads and public on-sale capacity', async () => {
    const publicInventory = await tickets.publicInventory(['evt_glass_hearts_nov']);
    const types = publicInventory.inventoryByEvent.get('evt_glass_hearts_nov');
    expect(types?.map((entry) => entry.ticketType.id)).toEqual(['tt_gh_early', 'tt_gh_ga']);
    expect(publicInventory.counters.has('tt_gh_guest')).toBe(false);

    const summary = await tickets.eventSummary('evt_glass_hearts_nov');
    expect(summary?.publicTypes.map((entry) => entry.ticketType.id)).toEqual([
      'tt_gh_early',
      'tt_gh_ga',
    ]);
    // Public capacity only: 60 + 140, not the 20 guest-list places.
    expect(summary?.publicCapacity).toBe(200);
  });

  it('keeps hidden types visible in the internal inventory summary', async () => {
    const summary = await tickets.eventSummary('evt_glass_hearts_nov');
    expect(summary?.hiddenTypes.map((entry) => entry.ticketType.id)).toEqual(['tt_gh_guest']);
    expect(summary?.allTypes).toHaveLength(3);
    expect(summary?.guestList).toBe(11);
  });

  // -- availability derivation ----------------------------------------------

  it('derives the seeded public availability states from service inputs', async () => {
    const now = new Date();

    const glass = await tickets.publicInventory(['evt_glass_hearts_nov']);
    const glassTypes = new Map(
      (glass.inventoryByEvent.get('evt_glass_hearts_nov') ?? []).map((entry) => [
        entry.ticketType.id,
        entry,
      ]),
    );
    expect(availabilityOf(glassTypes.get('tt_gh_early')!, true, now)).toBe('sold-out');
    expect(availabilityOf(glassTypes.get('tt_gh_ga')!, true, now)).toBe('selling-fast');
    expect(
      rollUpAvailability(
        [...glassTypes.values()].map((entry) => availabilityOf(entry, true, now)),
      ),
    ).toBe('selling-fast');

    const velvet = await tickets.eventSummary('evt_velvet_antler_dec');
    const velvetGa = velvet?.publicTypes.find((entry) => entry.ticketType.id === 'tt_va_ga');
    expect(velvetGa && availabilityOf(velvetGa, true, now)).toBe('last-few');

    const winter = await tickets.eventSummary('evt_winter_allday');
    const winterEarly = winter?.publicTypes.find((entry) => entry.ticketType.id === 'tt_wa_early');
    expect(winterEarly && availabilityOf(winterEarly, true, now)).toBe('not-yet-on-sale');

    const northern = await tickets.eventSummary('evt_northern_static_oct');
    const northernGa = northern?.publicTypes.find((entry) => entry.ticketType.id === 'tt_ns_ga');
    expect(northernGa && availabilityOf(northernGa, true, now)).toBe('available');
  });

  it('lets a closed sale window and an unsellable event win over stock', async () => {
    const eventId = await makeProbeEvent();
    const closedId = await makeProbeType(eventId, {
      capacity: 50,
      salesCloseAt: new Date(FIXED_NOW.getTime() - 3_600_000).toISOString(),
    });
    const futureId = await makeProbeType(eventId, {
      capacity: 50,
      position: 1,
      salesOpenAt: new Date(FIXED_NOW.getTime() + 3_600_000).toISOString(),
    });
    const openId = await makeProbeType(eventId, { capacity: 50, position: 2 });

    try {
      const closed = await fixed.ticketTypeInventory(closedId);
      const future = await fixed.ticketTypeInventory(futureId);
      const open = await fixed.ticketTypeInventory(openId);

      expect(closed && availabilityOf(closed, true, FIXED_NOW)).toBe('sales-closed');
      expect(future && availabilityOf(future, true, FIXED_NOW)).toBe('not-yet-on-sale');
      expect(open && availabilityOf(open, true, FIXED_NOW)).toBe('available');
      // A cancelled or finished event is never on sale, whatever the stock says.
      expect(open && availabilityOf(open, false, FIXED_NOW)).toBe('unavailable');
    } finally {
      await deleteProbe(eventId);
    }
  });

  // -- EventView integration -------------------------------------------------

  it('feeds EventView from this same inventory implementation', async () => {
    const repository = createD1EventRepository(db);
    const view = await repository.getBySlug('the-glass-hearts-lomax-rooms');
    expect(view).not.toBeNull();
    expect(view?.ticketTypes.length).toBeGreaterThan(0);

    for (const ticketType of view?.ticketTypes ?? []) {
      const inventory = await tickets.ticketTypeInventory(ticketType.id);
      expect(inventory, ticketType.id).not.toBeNull();
      expect(ticketType.inventory.sold).toBe(inventory?.sold);
      expect(ticketType.inventory.reserved).toBe(inventory?.reserved);
      expect(ticketType.inventory.available).toBe(inventory?.available);
      expect(ticketType.inventory.capacity).toBe(inventory?.ticketType.capacity);
    }
  });

  // -- unknown / empty -------------------------------------------------------

  it('follows null and empty semantics for unknown or empty reads', async () => {
    expect(await tickets.ticketTypeInventory('tt_does_not_exist')).toBeNull();
    expect(await tickets.eventSummary('evt_does_not_exist')).toBeNull();

    const emptyIds = await tickets.publicInventory(['evt_does_not_exist']);
    expect(emptyIds.inventoryByEvent.size).toBe(0);
    expect(emptyIds.counters.size).toBe(0);
    expect((await tickets.inventorySummary([])).size).toBe(0);

    const eventId = await makeProbeEvent();
    try {
      expect(await tickets.eventSummary(eventId)).toBeNull();
      const publicInventory = await tickets.publicInventory([eventId]);
      expect(publicInventory.inventoryByEvent.has(eventId)).toBe(false);
    } finally {
      await deleteProbe(eventId);
    }
  });

  it('reports zero counters for a type with no sales or reservations', async () => {
    const eventId = await makeProbeEvent();
    const typeId = await makeProbeType(eventId, { capacity: 25 });
    try {
      const inventory = await tickets.ticketTypeInventory(typeId);
      expect(inventory?.sold).toBe(0);
      expect(inventory?.reserved).toBe(0);
      expect(inventory?.available).toBe(25);
    } finally {
      await deleteProbe(eventId);
    }
  });

  // -- batching --------------------------------------------------------------

  it('reads a ten-type event in a bounded number of queries', async () => {
    const eventId = await makeProbeEvent();
    const typeIds: string[] = [];
    for (let position = 0; position < 10; position += 1) {
      typeIds.push(await makeProbeType(eventId, { capacity: 100, position }));
    }

    try {
      const { db: counted, queries } = instrument(db);
      const instrumented = createD1TicketInventoryService(counted);

      queries.length = 0;
      const inventory = await instrumented.publicInventory([eventId]);
      expect(inventory.inventoryByEvent.get(eventId)).toHaveLength(10);
      expect(queries.length).toBeLessThanOrEqual(3);
      expect(queries.length).toBeLessThan(typeIds.length);

      queries.length = 0;
      await instrumented.inventorySummary([eventId]);
      expect(queries.length).toBeLessThanOrEqual(3);

      queries.length = 0;
      await instrumented.ticketTypeInventory(typeIds[0]!);
      expect(queries.length).toBeLessThanOrEqual(3);
    } finally {
      await deleteProbe(eventId);
    }
  });
});
