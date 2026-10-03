/**
 * AMPED-06C - oversell protection under concurrency.
 *
 * These are real races against local D1/workerd storage: independent service
 * invocations are launched with Promise.allSettled and the verdict comes from
 * the resulting database state, never from a fake engine or a serialized
 * helper. The capacity-1 race is repeated because one lucky run proves
 * nothing.
 *
 * The invariant asserted after every scenario is:
 *   committed (paid/partially_refunded + unexpired awaiting) <= capacity.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { openEphemeralDatabase } from '../src/db/local.ts';
import { migrate } from '../src/db/migrations.ts';
import { applySeed } from '../src/db/seed.ts';
import { createD1OrderMutations } from '../src/services/orders/service.ts';
import {
  createD1InventoryReservations,
  INVENTORY_CAPACITY_MARKER,
  type AcquireReservationInput,
} from '../src/services/inventory/acquire.ts';
import { ConflictError } from '../src/lib/validation.ts';

// The races are real work: ten capacity-1 iterations plus the larger sizes.
// The budget is generous so parallel suite load cannot flake a genuine gate.
vi.setConfig({ testTimeout: 300_000, hookTimeout: 120_000 });

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXED_NOW = new Date('2026-09-24T12:00:00.000Z');
const WINDOW_MS = 30 * 60_000;

interface Probe {
  eventId: string;
  typeId: string;
}

describe('AMPED-06C oversell protection', () => {
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

  // -- helpers -------------------------------------------------------------

  async function makeProbe(capacity: number): Promise<Probe> {
    counter += 1;
    const eventId = `evt_conc_${counter}`;
    const typeId = `tt_conc_${counter}`;
    const stamp = FIXED_NOW.toISOString();
    await db
      .prepare(
        'insert into events (id, title, slug, status, description, venue_id, doors_at, starts_at, ends_at, age_restriction, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, null, ?, ?, ?)',
      )
      .bind(
        eventId,
        `Concurrency probe ${counter}`,
        `concurrency-probe-${counter}`,
        'published',
        'A probe event for concurrency tests.',
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
        "insert into ticket_types (id, event_id, name, description, price_in_pence, capacity, max_per_order, position, visibility) values (?, ?, 'Race GA', null, 1000, ?, 99, 0, 'public')",
      )
      .bind(typeId, eventId, capacity)
      .run();
    return { eventId, typeId };
  }

  async function cleanup(probe: Probe): Promise<void> {
    await db.prepare('delete from order_items where order_id in (select id from orders where event_id = ?)').bind(probe.eventId).run();
    await db.prepare('delete from orders where event_id = ?').bind(probe.eventId).run();
    await db.prepare('delete from ticket_types where event_id = ?').bind(probe.eventId).run();
    await db.prepare('delete from events where id = ?').bind(probe.eventId).run();
  }

  function freshOrders() {
    counter += 1;
    const instanceSeed = counter;
    // Every contender gets its own service instance and id namespace, so no
    // shared object can serialize the race.
    let local = 0;
    return createD1OrderMutations(
      db,
      () => FIXED_NOW,
      (p) => `${p}_c${instanceSeed}_${++local}`,
    );
  }

  /**
   * Pending contenders are inserted directly (one batch for the whole set):
   * the mutation under test is the reservation acquisition, not order creation,
   * and this keeps ten iterations of a real race affordable. The production
   * path is still exercised separately through createOrder/beginPayment.
   */
  async function createPendingOrders(
    probe: Probe,
    count: number,
    quantity: number,
    typeId = probe.typeId,
  ): Promise<string[]> {
    counter += 1;
    const stamp = FIXED_NOW.toISOString();
    const ids: string[] = [];
    const statements: D1PreparedStatement[] = [];
    for (let index = 0; index < count; index += 1) {
      const orderId = `ord_conc_${counter}_${index}`;
      ids.push(orderId);
      statements.push(
        db
          .prepare(
            "insert into orders (id, reference, event_id, customer_name, customer_email, status, total_in_pence, fee_in_pence, marketing_opt_in, created_at, updated_at) values (?1, ?2, ?3, 'Contender', 'contender@example.com', 'pending', ?4, 0, 0, ?5, ?5)",
          )
          .bind(orderId, `AMP-CONC-${counter}-${index}`, probe.eventId, quantity * 1000, stamp),
        db
          .prepare(
            "insert into order_items (id, order_id, ticket_type_id, quantity, unit_price_in_pence, ticket_type_name) values (?1, ?2, ?3, ?4, 1000, 'Race GA')",
          )
          .bind(`oi_conc_${counter}_${index}`, orderId, typeId, quantity),
      );
    }
    await db.batch(statements);
    return ids;
  }

  function acquireInput(orderId: string, now = FIXED_NOW): AcquireReservationInput {
    return {
      orderId,
      now,
      expiresAt: new Date(now.getTime() + WINDOW_MS).toISOString(),
      provider: 'mock',
      reference: `mock_${orderId}`,
    };
  }

  /** Genuinely concurrent acquisition: independent instances, launched together. */
  async function raceAcquire(orderIds: string[], now = FIXED_NOW) {
    const results = await Promise.allSettled(
      orderIds.map((orderId) =>
        createD1InventoryReservations(db).acquireReservation(acquireInput(orderId, now)),
      ),
    );
    let acquired = 0;
    let inventoryConflicts = 0;
    let otherFailures = 0;
    for (const result of results) {
      if (result.status === 'fulfilled') {
        if (result.value.acquired) acquired += 1;
        else if (result.value.reason === 'inventory') inventoryConflicts += 1;
        else otherFailures += 1;
      } else {
        otherFailures += 1;
      }
    }
    return { acquired, inventoryConflicts, otherFailures };
  }

  async function commitment(typeId: string): Promise<{ sold: number; reserved: number; committed: number }> {
    const row = await db
      .prepare(
        `select
           (select coalesce(sum(oi.quantity),0) from order_items oi join orders o on o.id = oi.order_id
             where oi.ticket_type_id = ?1 and o.status in ('paid','partially_refunded')) as sold,
           (select coalesce(sum(oi.quantity),0) from order_items oi join orders o on o.id = oi.order_id
             where oi.ticket_type_id = ?1 and o.status = 'awaiting_payment' and julianday(o.reservation_expires_at) > julianday(?2)) as reserved`,
      )
      .bind(typeId, FIXED_NOW.toISOString())
      .first<{ sold: number; reserved: number }>();
    const sold = row?.sold ?? 0;
    const reserved = row?.reserved ?? 0;
    return { sold, reserved, committed: sold + reserved };
  }

  async function capacityOf(typeId: string): Promise<number> {
    const row = await db
      .prepare('select capacity from ticket_types where id = ?1')
      .bind(typeId)
      .first<{ capacity: number }>();
    return row?.capacity ?? 0;
  }

  // -- architecture ---------------------------------------------------------

  it('uses one conditional SQL mutation and no application lock', () => {
    const acquire = readFileSync(join(root, 'src', 'services', 'inventory', 'acquire.ts'), 'utf8');
    const code = acquire.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).toContain('update orders set');
    expect(code).toContain('not exists');
    expect(code).toMatch(/status = 'pending'/);

    const serviceFiles: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.ts$/.test(entry)) serviceFiles.push(full);
      }
    };
    walk(join(root, 'src', 'services'));
    for (const file of serviceFiles) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/\bnew Mutex\b|\bSemaphore\b|async-mutex|p-limit|p-queue/);
    }
  });

  it('classifies invalid and stale acquisitions separately', async () => {
    const probe = await makeProbe(2);
    try {
      // Bypass the advisory reads: a pending order asking for too much.
      const [orderId] = await createPendingOrders(probe, 1, 1);
      await db
        .prepare('update order_items set quantity = 5 where order_id = ?')
        .bind(orderId)
        .run();

      const inventory = createD1InventoryReservations(db);
      const refused = await inventory.acquireReservation(acquireInput(orderId!));
      expect(refused).toEqual({ acquired: false, reason: 'inventory' });

      // A legal acquisition, then a second attempt at the same order.
      const [legal] = await createPendingOrders(probe, 1, 1);
      const acquired = await createD1InventoryReservations(db).acquireReservation(acquireInput(legal!));
      expect(acquired.acquired).toBe(true);
      const stale = await createD1InventoryReservations(db).acquireReservation(acquireInput(legal!));
      expect(stale).toEqual({ acquired: false, reason: 'stale' });
    } finally {
      await cleanup(probe);
    }
  });

  // -- database guard -------------------------------------------------------

  it('has the 0011 capacity trigger installed', async () => {
    const trigger = await db
      .prepare(
        "select name from sqlite_master where type = 'trigger' and name = 'orders_inventory_capacity_guard'",
      )
      .first<{ name: string }>();
    expect(trigger?.name).toBe('orders_inventory_capacity_guard');

    const applied = await db
      .prepare("select name from schema_migrations where id = '0011'")
      .first<{ name: string }>();
    expect(applied?.name).toBe('0011_inventory_capacity_guard.sql');
  });

  it('blocks a raw SQL bypass that would oversell, and allows a legal one', async () => {
    const probe = await makeProbe(2);
    try {
      // One commercial sale already committed, one place free.
      const paidOrder = `ord_rawpaid_${probe.typeId}`;
      const stamp = FIXED_NOW.toISOString();
      await db
        .prepare(
          "insert into orders (id, reference, event_id, customer_name, customer_email, status, total_in_pence, fee_in_pence, paid_at, marketing_opt_in, created_at, updated_at) values (?, ?, ?, 'Raw', 'raw@example.com', 'paid', 1000, 0, ?, 0, ?, ?)",
        )
        .bind(paidOrder, `AMP-RAW-${probe.typeId}`, probe.eventId, stamp, stamp, stamp)
        .run();
      await db
        .prepare(
          "insert into order_items (id, order_id, ticket_type_id, quantity, unit_price_in_pence, ticket_type_name) values (?, ?, ?, 1, 1000, 'Raw')",
        )
        .bind(`oi_rawpaid_${probe.typeId}`, paidOrder, probe.typeId)
        .run();

      const pendingOrder = `ord_rawpending_${probe.typeId}`;
      await db
        .prepare(
          "insert into orders (id, reference, event_id, customer_name, customer_email, status, total_in_pence, fee_in_pence, marketing_opt_in, created_at, updated_at) values (?, ?, ?, 'Raw', 'raw@example.com', 'pending', 2000, 0, 0, ?, ?)",
        )
        .bind(pendingOrder, `AMP-RAWP-${probe.typeId}`, probe.eventId, stamp, stamp)
        .run();
      // Asks for 2 when only 1 place remains.
      await db
        .prepare(
          "insert into order_items (id, order_id, ticket_type_id, quantity, unit_price_in_pence, ticket_type_name) values (?, ?, ?, 2, 1000, 'Raw')",
        )
        .bind(`oi_rawpending_${probe.typeId}`, pendingOrder, probe.typeId)
        .run();

      await expect(
        db
          .prepare(
            "update orders set status = 'awaiting_payment', reservation_expires_at = ?, payment_provider = 'mock', updated_at = ? where id = ? and status = 'pending'",
          )
          .bind(new Date(FIXED_NOW.getTime() + WINDOW_MS).toISOString(), stamp, pendingOrder)
          .run(),
      ).rejects.toThrow(new RegExp(INVENTORY_CAPACITY_MARKER));

      const still = await db
        .prepare('select status from orders where id = ?')
        .bind(pendingOrder)
        .first<{ status: string }>();
      expect(still?.status).toBe('pending');
      const committed = await commitment(probe.typeId);
      expect(committed.committed).toBeLessThanOrEqual(await capacityOf(probe.typeId));

      // A legal raw transition inside the remaining place succeeds.
      await db
        .prepare('update order_items set quantity = 1 where id = ?')
        .bind(`oi_rawpending_${probe.typeId}`)
        .run();
      const ok = await db
        .prepare(
          "update orders set status = 'awaiting_payment', reservation_expires_at = ?, updated_at = ? where id = ? and status = 'pending'",
        )
        .bind(new Date(FIXED_NOW.getTime() + WINDOW_MS).toISOString(), stamp, pendingOrder)
        .run();
      expect((ok.meta?.changes ?? 0) as number).toBe(1);
    } finally {
      await cleanup(probe);
    }
  });

  it('aggregates duplicate order_item rows in the trigger', async () => {
    const probe = await makeProbe(2);
    try {
      const stamp = FIXED_NOW.toISOString();
      const orderId = `ord_dup_${probe.typeId}`;
      await db
        .prepare(
          "insert into orders (id, reference, event_id, customer_name, customer_email, status, total_in_pence, fee_in_pence, marketing_opt_in, created_at, updated_at) values (?, ?, ?, 'Raw', 'raw@example.com', 'pending', 2000, 0, 0, ?, ?)",
        )
        .bind(orderId, `AMP-DUP-${probe.typeId}`, probe.eventId, stamp, stamp)
        .run();
      for (const suffix of ['a', 'b']) {
        await db
          .prepare(
            "insert into order_items (id, order_id, ticket_type_id, quantity, unit_price_in_pence, ticket_type_name) values (?, ?, ?, 2, 1000, 'Raw')",
          )
          .bind(`oi_dup_${suffix}_${probe.typeId}`, orderId, probe.typeId)
          .run();
      }

      // Each line fits (2 <= 2) but their sum (4) does not.
      await expect(
        db
          .prepare(
            "update orders set status = 'awaiting_payment', reservation_expires_at = ?, updated_at = ? where id = ? and status = 'pending'",
          )
          .bind(new Date(FIXED_NOW.getTime() + WINDOW_MS).toISOString(), stamp, orderId)
          .run(),
      ).rejects.toThrow(new RegExp(INVENTORY_CAPACITY_MARKER));
    } finally {
      await cleanup(probe);
    }
  });

  it('uses the same strict expiry boundary as the application predicate', async () => {
    const probe = await makeProbe(1);
    try {
      const stamp = FIXED_NOW.toISOString();
      // An expired hold (exactly at now) does not consume capacity.
      const expired = `ord_exp_${probe.typeId}`;
      await db
        .prepare(
          "insert into orders (id, reference, event_id, customer_name, customer_email, status, total_in_pence, fee_in_pence, reservation_expires_at, marketing_opt_in, created_at, updated_at) values (?, ?, ?, 'Raw', 'raw@example.com', 'awaiting_payment', 1000, 0, ?, 0, ?, ?)",
        )
        .bind(expired, `AMP-EXP-${probe.typeId}`, probe.eventId, stamp, stamp, stamp)
        .run();
      await db
        .prepare(
          "insert into order_items (id, order_id, ticket_type_id, quantity, unit_price_in_pence, ticket_type_name) values (?, ?, ?, 1, 1000, 'Raw')",
        )
        .bind(`oi_exp_${probe.typeId}`, expired, probe.typeId)
        .run();

      const contender = `ord_bound_${probe.typeId}`;
      await db
        .prepare(
          "insert into orders (id, reference, event_id, customer_name, customer_email, status, total_in_pence, fee_in_pence, marketing_opt_in, created_at, updated_at) values (?, ?, ?, 'Raw', 'raw@example.com', 'pending', 1000, 0, 0, ?, ?)",
        )
        .bind(contender, `AMP-BND-${probe.typeId}`, probe.eventId, stamp, stamp)
        .run();
      await db
        .prepare(
          "insert into order_items (id, order_id, ticket_type_id, quantity, unit_price_in_pence, ticket_type_name) values (?, ?, ?, 1, 1000, 'Raw')",
        )
        .bind(`oi_bound_${probe.typeId}`, contender, probe.typeId)
        .run();

      const transition = await db
        .prepare(
          "update orders set status = 'awaiting_payment', reservation_expires_at = ?, updated_at = ? where id = ? and status = 'pending'",
        )
        .bind(new Date(FIXED_NOW.getTime() + WINDOW_MS).toISOString(), stamp, contender)
        .run();
      expect((transition.meta?.changes ?? 0) as number).toBe(1);

      // Make the first hold active from `later` onwards (expiry later + 1ms),
      // then try a second transition at logical now = later: the active hold
      // now counts and blocks it.
      const later = new Date(FIXED_NOW.getTime() + 1);
      await db
        .prepare('update orders set reservation_expires_at = ? where id = ?')
        .bind(new Date(later.getTime() + 1).toISOString(), expired)
        .run();
      const second = `ord_bound2_${probe.typeId}`;
      await db
        .prepare(
          "insert into orders (id, reference, event_id, customer_name, customer_email, status, total_in_pence, fee_in_pence, marketing_opt_in, created_at, updated_at) values (?, ?, ?, 'Raw', 'raw@example.com', 'pending', 1000, 0, 0, ?, ?)",
        )
        .bind(second, `AMP-BND2-${probe.typeId}`, probe.eventId, stamp, stamp)
        .run();
      await db
        .prepare(
          "insert into order_items (id, order_id, ticket_type_id, quantity, unit_price_in_pence, ticket_type_name) values (?, ?, ?, 1, 1000, 'Raw')",
        )
        .bind(`oi_bound2_${probe.typeId}`, second, probe.typeId)
        .run();

      // The trigger compares against NEW.updated_at; use that instant +1ms so
      // the now-active hold counts.
      await expect(
        db
          .prepare(
            "update orders set status = 'awaiting_payment', reservation_expires_at = ?, updated_at = ? where id = ? and status = 'pending'",
          )
          .bind(new Date(later.getTime() + WINDOW_MS).toISOString(), later.toISOString(), second)
          .run(),
      ).rejects.toThrow(new RegExp(INVENTORY_CAPACITY_MARKER));
    } finally {
      await cleanup(probe);
    }
  });

  // -- capacity-1 race ------------------------------------------------------

  it('yields exactly one winner across 10 capacity-1 races', async () => {
    const iterationWinners: number[] = [];
    let maxCommitted = 0;

    for (let iteration = 0; iteration < 10; iteration += 1) {
      const probe = await makeProbe(1);
      try {
        const orderIds = await createPendingOrders(probe, 20, 1);
        const result = await raceAcquire(orderIds);

        expect(result.acquired, `iteration ${iteration}`).toBe(1);
        expect(result.inventoryConflicts + result.otherFailures, `iteration ${iteration}`).toBe(19);
        expect(result.otherFailures, `iteration ${iteration}`).toBe(0);

        const committed = await commitment(probe.typeId);
        expect(committed.sold).toBe(0);
        expect(committed.reserved).toBe(1);
        expect(committed.committed).toBeLessThanOrEqual(1);

        const losersPending = await db
          .prepare("select count(*) as n from orders where event_id = ? and status = 'pending'")
          .bind(probe.eventId)
          .first<{ n: number }>();
        expect(losersPending?.n).toBe(19);

        iterationWinners.push(result.acquired);
        maxCommitted = Math.max(maxCommitted, committed.committed);
      } finally {
        await cleanup(probe);
      }
    }

    expect(iterationWinners).toHaveLength(10);
    expect(iterationWinners.every((winners) => winners === 1)).toBe(true);
    expect(maxCommitted).toBeLessThanOrEqual(1);
  });

  // -- other sizes ----------------------------------------------------------

  it('yields exactly M winners for capacities 3 and 10', async () => {
    for (const [capacity, buyers] of [
      [3, 20],
      [10, 30],
    ] as const) {
      const probe = await makeProbe(capacity);
      try {
        const orderIds = await createPendingOrders(probe, buyers, 1);
        const result = await raceAcquire(orderIds);

        expect(result.acquired, `capacity ${capacity}`).toBe(capacity);
        expect(result.inventoryConflicts + result.otherFailures, `capacity ${capacity}`).toBe(
          buyers - capacity,
        );
        expect(result.otherFailures, `capacity ${capacity}`).toBe(0);

        const committed = await commitment(probe.typeId);
        expect(committed.reserved).toBe(capacity);
        expect(committed.committed).toBeLessThanOrEqual(capacity);
      } finally {
        await cleanup(probe);
      }
    }
  });

  // -- multi-quantity -------------------------------------------------------

  it('never exceeds capacity for quantity-2 contenders', async () => {
    const probe = await makeProbe(5);
    try {
      const orderIds = await createPendingOrders(probe, 4, 2);
      const result = await raceAcquire(orderIds);
      expect(result.acquired).toBe(2);
      expect(result.otherFailures).toBe(0);

      let committed = await commitment(probe.typeId);
      expect(committed.reserved).toBe(4);
      expect(committed.committed).toBeLessThanOrEqual(5);

      // A final single place remains and can be taken.
      const [lastOrder] = await createPendingOrders(probe, 1, 1);
      const final = await createD1InventoryReservations(db).acquireReservation(
        acquireInput(lastOrder!),
      );
      expect(final.acquired).toBe(true);
      committed = await commitment(probe.typeId);
      expect(committed.reserved).toBe(5);
      expect(committed.committed).toBe(5);

      // And nothing more fits.
      const [tooLate] = await createPendingOrders(probe, 1, 1);
      const refused = await createD1InventoryReservations(db).acquireReservation(
        acquireInput(tooLate!),
      );
      expect(refused).toEqual({ acquired: false, reason: 'inventory' });
    } finally {
      await cleanup(probe);
    }
  });

  // -- multi-type -----------------------------------------------------------

  it('reserves a multi-type basket all-or-nothing under contention', async () => {
    const probe = await makeProbe(10);
    try {
      // A second type on the same event with capacity 1.
      const scarceType = `${probe.typeId}_scarce`;
      await db
        .prepare(
          "insert into ticket_types (id, event_id, name, description, price_in_pence, capacity, max_per_order, position, visibility) values (?, ?, 'Scarce', null, 1000, 1, 99, 1, 'public')",
        )
        .bind(scarceType, probe.eventId)
        .run();

      const service = freshOrders();
      const baskets: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const created = await service.createOrder({
          eventId: probe.eventId,
          items: [
            { ticketTypeId: probe.typeId, quantity: 1 },
            { ticketTypeId: scarceType, quantity: 1 },
          ],
          customerName: `Basket ${index}`,
          customerEmail: `basket${index}@example.com`,
          marketingOptIn: false,
        });
        baskets.push(created.orderId);
      }

      const results = await Promise.allSettled(
        baskets.map((orderId) =>
          createD1InventoryReservations(db).acquireReservation(acquireInput(orderId)),
        ),
      );
      const winners = results.filter(
        (result) => result.status === 'fulfilled' && result.value.acquired,
      ).length;
      expect(winners).toBe(1);

      const scarce = await commitment(scarceType);
      const main = await commitment(probe.typeId);
      expect(scarce.reserved).toBe(1);
      // Losing baskets must not leak a reservation on the uncontended type.
      expect(main.reserved).toBe(1);
    } finally {
      await cleanup(probe);
    }
  });

  // -- active / expired mix -------------------------------------------------

  it('reclaims expired holds under contention without counting them', async () => {
    const probe = await makeProbe(4);
    try {
      const stamp = FIXED_NOW.toISOString();
      const seedRow = async (id: string, quantity: number, expiresAt: string) => {
        await db
          .prepare(
            "insert into orders (id, reference, event_id, customer_name, customer_email, status, total_in_pence, fee_in_pence, reservation_expires_at, marketing_opt_in, created_at, updated_at) values (?, ?, ?, 'Raw', 'raw@example.com', 'awaiting_payment', 1000, 0, ?, 0, ?, ?)",
          )
          .bind(id, `AMP-MIX-${id}`, probe.eventId, expiresAt, stamp, stamp)
          .run();
        await db
          .prepare(
            "insert into order_items (id, order_id, ticket_type_id, quantity, unit_price_in_pence, ticket_type_name) values (?, ?, ?, ?, 1000, 'Raw')",
          )
          .bind(`oi_${id}`, id, probe.typeId, quantity)
          .run();
      };

      await seedRow(`ord_mix_active_${probe.typeId}`, 1, new Date(FIXED_NOW.getTime() + WINDOW_MS).toISOString());
      await seedRow(`ord_mix_exp1_${probe.typeId}`, 2, new Date(FIXED_NOW.getTime() - 1).toISOString());
      await seedRow(`ord_mix_exp2_${probe.typeId}`, 2, new Date(FIXED_NOW.getTime() - 60_000).toISOString());

      const orderIds = await createPendingOrders(probe, 6, 1);
      const result = await raceAcquire(orderIds);

      // 4 capacity - 1 active hold = 3 places; the expired rows consume none.
      expect(result.acquired).toBe(3);
      expect(result.otherFailures).toBe(0);

      const committed = await commitment(probe.typeId);
      expect(committed.reserved).toBe(4);
      expect(committed.committed).toBeLessThanOrEqual(4);
    } finally {
      await cleanup(probe);
    }
  });

  // -- reserved -> paid interleaving ----------------------------------------

  it('does not open capacity while a reservation becomes paid', async () => {
    const probe = await makeProbe(1);
    try {
      const service = freshOrders();
      const created = await service.createOrder({
        eventId: probe.eventId,
        items: [{ ticketTypeId: probe.typeId, quantity: 1 }],
        customerName: 'Winner',
        customerEmail: 'winner@example.com',
        marketingOptIn: false,
      });
      const provider = {
        name: 'mock' as const,
        createCheckout: async () => ({
          checkoutId: 'mock_x',
          redirectUrl: '/checkout/mock',
          expiresAt: new Date(FIXED_NOW.getTime() + WINDOW_MS).toISOString(),
        }),
        confirm: async () => ({ status: 'paid' as const, paidAt: FIXED_NOW.toISOString() }),
        verifyWebhook: async () => null,
      };
      const begun = await service.beginPayment(created.orderId, provider, 'https://amped.test/checkout/return');

      const contenders = await createPendingOrders(probe, 5, 1);
      const [confirmation] = await Promise.allSettled([
        service.confirmPayment(created.orderId, begun.checkoutId, provider),
        ...contenders.map((orderId) =>
          createD1InventoryReservations(db).acquireReservation(acquireInput(orderId)),
        ),
      ]);

      expect(confirmation.status).toBe('fulfilled');
      // Every contender lost while the reservation was becoming a sale.
      const contenderResults = await raceAcquire(contenders);
      expect(contenderResults.acquired).toBe(0);
      const committed = await commitment(probe.typeId);
      expect(committed.sold).toBe(1);
      expect(committed.reserved).toBe(0);
      expect(committed.committed).toBeLessThanOrEqual(1);
    } finally {
      await cleanup(probe);
    }
  });

  // -- integration through the production path ------------------------------

  it('keeps the production checkout path safe under contention', async () => {
    const probe = await makeProbe(1);
    try {
      const contenders = await createPendingOrders(probe, 5, 1);
      const providerFor = (seed: number) => ({
        name: 'mock' as const,
        createCheckout: async () => ({
          checkoutId: `mock_${seed}`,
          redirectUrl: '/checkout/mock',
          expiresAt: new Date(FIXED_NOW.getTime() + WINDOW_MS).toISOString(),
        }),
        confirm: async () => ({ status: 'paid' as const, paidAt: FIXED_NOW.toISOString() }),
        verifyWebhook: async () => null,
      });

      const results = await Promise.allSettled(
        contenders.map((orderId, index) =>
          freshOrders().beginPayment(orderId, providerFor(index), 'https://amped.test/checkout/return'),
        ),
      );
      const winners = results.filter((result) => result.status === 'fulfilled').length;
      const conflicts = results.filter(
        (result) =>
          result.status === 'rejected' &&
          result.reason instanceof ConflictError,
      ).length;

      expect(winners).toBe(1);
      expect(conflicts).toBe(4);
      const committed = await commitment(probe.typeId);
      expect(committed.reserved).toBe(1);
      expect(committed.committed).toBeLessThanOrEqual(1);
    } finally {
      await cleanup(probe);
    }
  });

  // -- query plan -----------------------------------------------------------

  it('records the query plan for the authoritative mutation', async () => {
    const { ACQUIRE_RESERVATION_SQL } = await import('../src/services/inventory/acquire.ts');
    const plan = await db
      .prepare(`explain query plan ${ACQUIRE_RESERVATION_SQL}`)
      .bind(
        FIXED_NOW.toISOString(),
        'mock',
        'mock_x',
        FIXED_NOW.toISOString(),
        'ord_plan_probe',
      )
      .all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join('\n');
    expect(detail.length).toBeGreaterThan(0);
    // The plan must reference the tables the predicate depends on; index usage
    // is recorded in the slice report.
    expect(detail).toMatch(/order_items|ticket_types|orders/);
  });
});
