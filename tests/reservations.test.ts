/**
 * AMPED-06B - ticket reservations.
 *
 * Covers the 30-minute hold, duplicate/maxPerOrder validation, sellability,
 * serial availability, payment continuity, late-confirmation safety, lazy
 * release and the idempotent expiry sweep - plus the custom Worker entrypoint
 * and the authorised reservation-expiry index.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { openEphemeralDatabase } from '../src/db/local.ts';
import { migrate } from '../src/db/migrations.ts';
import { applySeed } from '../src/db/seed.ts';
import { createD1OrderMutations } from '../src/services/orders/service.ts';
import { createD1TicketInventoryService } from '../src/services/d1/tickets.ts';
import { createMockPaymentProvider, CHECKOUT_WINDOW_MINUTES } from '../src/services/payments/mock.ts';
import { ConflictError, NotFoundError, ValidationError } from '../src/lib/validation.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXED_NOW = new Date('2026-09-24T10:00:00.000Z');
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface Probe {
  eventId: string;
  typeId: string;
}

describe('AMPED-06B ticket reservations', () => {
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

  const clock = () => FIXED_NOW;

  function orders() {
    return createD1OrderMutations(db, clock, (p) => `${p}_r${++counter}`);
  }

  function inventory() {
    return createD1TicketInventoryService(db, clock);
  }

  function provider(outcome: 'paid' | 'pending' | 'failed' = 'paid') {
    return createMockPaymentProvider({ outcome, now: clock });
  }

  async function makeProbe(options: {
    capacity?: number;
    maxPerOrder?: number | null;
    eventStatus?: string;
    openAt?: string | null;
    closeAt?: string | null;
    visibility?: 'public' | 'hidden';
  } = {}): Promise<Probe> {
    counter += 1;
    const eventId = `evt_res_${counter}`;
    const typeId = `tt_res_${counter}`;
    const stamp = FIXED_NOW.toISOString();
    const status = options.eventStatus ?? 'published';
    // cancelled/postponed rows are required by the schema to carry a message.
    const statusMessage = status === 'cancelled' || status === 'postponed' ? 'Probe status' : null;
    await db
      .prepare(
        'insert into events (id, title, slug, status, description, venue_id, doors_at, starts_at, ends_at, age_restriction, status_message, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, null, ?, ?, ?, ?)',
      )
      .bind(
        eventId,
        `Reservation probe ${counter}`,
        `reservation-probe-${counter}`,
        status,
        'A probe event for reservation tests.',
        'ven_lomax',
        stamp,
        stamp,
        'all-ages',
        statusMessage,
        stamp,
        stamp,
      )
      .run();
    await db
      .prepare(
        'insert into ticket_types (id, event_id, name, description, price_in_pence, capacity, max_per_order, sales_open_at, sales_close_at, position, visibility) values (?, ?, ?, null, 1000, ?, ?, ?, ?, 0, ?)',
      )
      .bind(
        typeId,
        eventId,
        `Reserve GA ${counter}`,
        options.capacity ?? 50,
        options.maxPerOrder === undefined ? 6 : options.maxPerOrder,
        options.openAt ?? null,
        options.closeAt ?? null,
        options.visibility ?? 'public',
      )
      .run();
    return { eventId, typeId };
  }

  async function addProbeType(probe: Probe, capacity: number): Promise<string> {
    counter += 1;
    const typeId = `tt_res_two_${counter}`;
    await db
      .prepare(
        "insert into ticket_types (id, event_id, name, description, price_in_pence, capacity, max_per_order, position, visibility) values (?, ?, 'Second type', null, 500, ?, 6, 1, 'public')",
      )
      .bind(typeId, probe.eventId, capacity)
      .run();
    return typeId;
  }

  async function cleanup(probe: Probe): Promise<void> {
    await db.prepare('delete from tickets where event_id = ?').bind(probe.eventId).run();
    await db.prepare('delete from orders where event_id = ?').bind(probe.eventId).run();
    await db.prepare('delete from ticket_types where event_id = ?').bind(probe.eventId).run();
    await db.prepare('delete from events where id = ?').bind(probe.eventId).run();
  }

  function input(probe: Probe, quantity: number, extra: Array<{ ticketTypeId: string; quantity: number }> = []) {
    return {
      eventId: probe.eventId,
      items: [{ ticketTypeId: probe.typeId, quantity }, ...extra],
      customerName: 'Reservation Probe',
      customerEmail: 'reserve@example.com',
      marketingOptIn: false,
    };
  }

  async function createAndReserve(probe: Probe, quantity: number) {
    const service = orders();
    const created = await service.createOrder(input(probe, quantity));
    const begun = await service.beginPayment(created.orderId, provider(), 'https://amped.test/checkout/return');
    return { service, created, begun };
  }

  // -- hold creation ---------------------------------------------------------

  it('creates a canonical 30-minute hold aligned with the provider checkout', async () => {
    const probe = await makeProbe({ capacity: 50 });
    try {
      const service = orders();
      const created = await service.createOrder(input(probe, 2));
      const begun = await service.beginPayment(created.orderId, provider(), 'https://amped.test/checkout/return');

      const row = await db
        .prepare('select status, reservation_expires_at, paid_at from orders where id = ?')
        .bind(created.orderId)
        .first<{ status: string; reservation_expires_at: string; paid_at: string | null }>();
      expect(row?.status).toBe('awaiting_payment');
      expect(row?.paid_at).toBeNull();
      expect(row?.reservation_expires_at).toMatch(ISO);
      expect(Date.parse(row!.reservation_expires_at)).toBe(
        FIXED_NOW.getTime() + CHECKOUT_WINDOW_MINUTES * 60_000,
      );
      // Provider checkout window and order hold are the same window.
      expect(Date.parse(begun.expiresAt)).toBe(Date.parse(row!.reservation_expires_at));

      const entry = await inventory().ticketTypeInventory(probe.typeId);
      expect(entry?.reserved).toBe(2);
      expect(entry?.sold).toBe(0);
      expect(entry?.available).toBe(48);
    } finally {
      await cleanup(probe);
    }
  });

  // -- validation ------------------------------------------------------------

  it('rejects invalid quantities, duplicates, unknown and hidden types', async () => {
    const probe = await makeProbe({});
    try {
      const service = orders();
      for (const quantity of [0, -1, 1.5]) {
        await expect(service.createOrder(input(probe, quantity))).rejects.toBeInstanceOf(ValidationError);
      }
      await expect(
        service.createOrder({
          ...input(probe, 3),
          items: [
            { ticketTypeId: probe.typeId, quantity: 3 },
            { ticketTypeId: probe.typeId, quantity: 3 },
          ],
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        service.createOrder({ ...input(probe, 1), items: [{ ticketTypeId: 'tt_not_real', quantity: 1 }] }),
      ).rejects.toBeInstanceOf(NotFoundError);
      // A real, public type from another event is not on sale for this one.
      await expect(
        service.createOrder({ ...input(probe, 1), items: [{ ticketTypeId: 'tt_gh_ga', quantity: 1 }] }),
      ).rejects.toBeInstanceOf(NotFoundError);
      const hiddenProbe = await makeProbe({ visibility: 'hidden' });
      try {
        await expect(service.createOrder(input(hiddenProbe, 1))).rejects.toBeInstanceOf(NotFoundError);
      } finally {
        await cleanup(hiddenProbe);
      }
    } finally {
      await cleanup(probe);
    }
  });

  it('enforces maxPerOrder from authoritative data', async () => {
    const probe = await makeProbe({ maxPerOrder: 4 });
    try {
      const service = orders();
      const created = await service.createOrder(input(probe, 4));
      expect(created.status).toBe('pending');
      await expect(service.createOrder(input(probe, 5))).rejects.toBeInstanceOf(ValidationError);
    } finally {
      await cleanup(probe);
    }
  });

  // -- sellability -----------------------------------------------------------

  it('refuses to reserve for unsellable events and closed windows', async () => {
    const service = orders();
    const draft = await makeProbe({ eventStatus: 'draft' });
    const cancelled = await makeProbe({ eventStatus: 'cancelled' });
    const completed = await makeProbe({ eventStatus: 'completed' });
    const notOpen = await makeProbe({ openAt: new Date(FIXED_NOW.getTime() + 3_600_000).toISOString() });
    const closed = await makeProbe({ closeAt: new Date(FIXED_NOW.getTime() - 1).toISOString() });

    // A gig that is not published cannot even create a pending order.
    for (const probe of [draft, cancelled, completed]) {
      try {
        await expect(service.createOrder(input(probe, 1))).rejects.toBeInstanceOf(NotFoundError);
      } finally {
        await cleanup(probe);
      }
    }

    // Published but outside its sales window: order can exist, the hold cannot.
    for (const probe of [notOpen, closed]) {
      try {
        const created = await service.createOrder(input(probe, 1));
        await expect(
          service.beginPayment(created.orderId, provider(), 'https://amped.test/checkout/return'),
        ).rejects.toBeInstanceOf(ConflictError);
        const row = await db
          .prepare('select status from orders where id = ?')
          .bind(created.orderId)
          .first<{ status: string }>();
        expect(row?.status, probe.eventId).toBe('pending');
      } finally {
        await cleanup(probe);
      }
    }
  });

  // -- serial availability ---------------------------------------------------

  it('enforces current available stock serially and leaves no partial hold', async () => {
    const probe = await makeProbe({ capacity: 5 });
    try {
      const { created } = await createAndReserve(probe, 3);
      expect((await inventory().ticketTypeInventory(probe.typeId))?.available).toBe(2);

      const service = orders();
      const second = await service.createOrder(input(probe, 3));
      await expect(
        service.beginPayment(second.orderId, provider(), 'https://amped.test/checkout/return'),
      ).rejects.toBeInstanceOf(ConflictError);
      const row = await db
        .prepare('select status from orders where id = ?')
        .bind(second.orderId)
        .first<{ status: string }>();
      expect(row?.status).toBe('pending');
      expect((await inventory().ticketTypeInventory(probe.typeId))?.reserved).toBe(3);

      // A multi-line basket with one unavailable line reserves nothing at all.
      const soldOutType = await addProbeType(probe, 0);
      const multi = await service.createOrder({
        eventId: probe.eventId,
        items: [
          { ticketTypeId: probe.typeId, quantity: 1 },
          { ticketTypeId: soldOutType, quantity: 2 },
        ],
        customerName: 'Reservation Probe',
        customerEmail: 'reserve@example.com',
        marketingOptIn: false,
      });
      await expect(
        service.beginPayment(multi.orderId, provider(), 'https://amped.test/checkout/return'),
      ).rejects.toBeInstanceOf(ConflictError);
      const multiRow = await db
        .prepare('select status from orders where id = ?')
        .bind(multi.orderId)
        .first<{ status: string }>();
      expect(multiRow?.status).toBe('pending');
      // The only active hold is still the first order's three.
      expect((await inventory().ticketTypeInventory(probe.typeId))?.reserved).toBe(3);
      expect((await inventory().ticketTypeInventory(soldOutType))?.reserved).toBe(0);
      expect(created.orderId).toBeTruthy();
    } finally {
      await cleanup(probe);
    }
  });

  // -- payment ---------------------------------------------------------------

  it('moves reserved into sold with availability unchanged, and failure releases it', async () => {
    const probe = await makeProbe({ capacity: 50 });
    try {
      const { service, created, begun } = await createAndReserve(probe, 2);
      const paid = await service.confirmPayment(created.orderId, begun.checkoutId, provider());
      expect(paid.status).toBe('paid');

      const entry = await inventory().ticketTypeInventory(probe.typeId);
      expect(entry?.sold).toBe(2);
      expect(entry?.reserved).toBe(0);
      expect(entry?.available).toBe(48);
      const tickets = await db
        .prepare('select count(*) as n from tickets where order_id = ?')
        .bind(created.orderId)
        .first<{ n: number }>();
      expect(tickets?.n).toBe(0);
    } finally {
      await cleanup(probe);
    }

    const failing = await makeProbe({ capacity: 50 });
    try {
      const { service, created, begun } = await createAndReserve(failing, 2);
      const result = await service.confirmPayment(created.orderId, begun.checkoutId, provider('failed'));
      expect(result.status).toBe('expired');
      const entry = await inventory().ticketTypeInventory(failing.typeId);
      expect(entry?.sold).toBe(0);
      expect(entry?.reserved).toBe(0);
      expect(entry?.available).toBe(50);
    } finally {
      await cleanup(failing);
    }
  });

  it('keeps a pending provider hold active and never extends it', async () => {
    const probe = await makeProbe({ capacity: 50 });
    try {
      const { service, created, begun } = await createAndReserve(probe, 2);
      const pending = await service.confirmPayment(created.orderId, begun.checkoutId, provider('pending'));
      expect(pending.status).toBe('awaiting_payment');
      expect((await inventory().ticketTypeInventory(probe.typeId))?.reserved).toBe(2);

      const row = await db
        .prepare('select reservation_expires_at from orders where id = ?')
        .bind(created.orderId)
        .first<{ reservation_expires_at: string }>();
      expect(Date.parse(row!.reservation_expires_at)).toBe(
        FIXED_NOW.getTime() + CHECKOUT_WINDOW_MINUTES * 60_000,
      );
    } finally {
      await cleanup(probe);
    }
  });

  it('never resurrects an expired hold on late confirmation', async () => {
    const probe = await makeProbe({ capacity: 50 });
    try {
      const { service, created, begun } = await createAndReserve(probe, 2);
      await db
        .prepare('update orders set reservation_expires_at = ? where id = ?')
        .bind(new Date(FIXED_NOW.getTime() - 1).toISOString(), created.orderId)
        .run();

      await expect(
        service.confirmPayment(created.orderId, begun.checkoutId, provider()),
      ).rejects.toBeInstanceOf(ConflictError);

      const row = await db
        .prepare('select status, paid_at from orders where id = ?')
        .bind(created.orderId)
        .first<{ status: string; paid_at: string | null }>();
      expect(row?.status).toBe('awaiting_payment');
      expect(row?.paid_at).toBeNull();
      // Lazy release: the read already ignores the expired hold.
      const entry = await inventory().ticketTypeInventory(probe.typeId);
      expect(entry?.reserved).toBe(0);
      expect(entry?.available).toBe(50);
    } finally {
      await cleanup(probe);
    }
  });

  // -- lazy release / boundaries ---------------------------------------------

  it('keeps the exact expiry boundary and reports released capacity before any sweep', async () => {
    const probe = await makeProbe({ capacity: 50 });
    try {
      const service = orders();
      const created = await service.createOrder(input(probe, 2));
      // Exactly at now is expired.
      await db
        .prepare("update orders set status = 'awaiting_payment', reservation_expires_at = ? where id = ?")
        .bind(FIXED_NOW.toISOString(), created.orderId)
        .run();
      expect((await inventory().ticketTypeInventory(probe.typeId))?.reserved).toBe(0);

      // One millisecond in the future is active.
      await db
        .prepare('update orders set reservation_expires_at = ? where id = ?')
        .bind(new Date(FIXED_NOW.getTime() + 1).toISOString(), created.orderId)
        .run();
      expect((await inventory().ticketTypeInventory(probe.typeId))?.reserved).toBe(2);

      // Past expiry: released on read while the row is still awaiting_payment.
      await db
        .prepare('update orders set reservation_expires_at = ? where id = ?')
        .bind(new Date(FIXED_NOW.getTime() - 1).toISOString(), created.orderId)
        .run();
      const entry = await inventory().ticketTypeInventory(probe.typeId);
      expect(entry?.reserved).toBe(0);
      expect(entry?.available).toBe(50);
      const row = await db
        .prepare('select status from orders where id = ?')
        .bind(created.orderId)
        .first<{ status: string }>();
      expect(row?.status).toBe('awaiting_payment');
    } finally {
      await cleanup(probe);
    }
  });

  // -- sweep -----------------------------------------------------------------

  it('sweeps due holds idempotently, leaving future and paid orders alone', async () => {
    const due = await makeProbe({ capacity: 50 });
    const future = await makeProbe({ capacity: 50 });
    const paid = await makeProbe({ capacity: 50 });
    try {
      const service = orders();
      const dueOrder = await service.createOrder(input(due, 2));
      await db
        .prepare("update orders set status = 'awaiting_payment', reservation_expires_at = ? where id = ?")
        .bind(new Date(FIXED_NOW.getTime() - 60_000).toISOString(), dueOrder.orderId)
        .run();

      const futureOrder = await service.createOrder(input(future, 2));
      await db
        .prepare("update orders set status = 'awaiting_payment', reservation_expires_at = ? where id = ?")
        .bind(new Date(FIXED_NOW.getTime() + 60_000).toISOString(), futureOrder.orderId)
        .run();

      const paidOrder = await createAndReserve(paid, 2);
      await paidOrder.service.confirmPayment(paidOrder.created.orderId, paidOrder.begun.checkoutId, provider());

      const first = await service.expireDueReservations(FIXED_NOW);
      // Seeded awaiting_payment rows may also be due; the probe order must be
      // among whatever the sweep expires.
      expect(first.expired).toBeGreaterThanOrEqual(1);

      const dueRow = await db
        .prepare('select status from orders where id = ?')
        .bind(dueOrder.orderId)
        .first<{ status: string }>();
      const futureRow = await db
        .prepare('select status from orders where id = ?')
        .bind(futureOrder.orderId)
        .first<{ status: string }>();
      const paidRow = await db
        .prepare('select status from orders where id = ?')
        .bind(paidOrder.created.orderId)
        .first<{ status: string }>();
      expect(dueRow?.status).toBe('expired');
      expect(futureRow?.status).toBe('awaiting_payment');
      expect(paidRow?.status).toBe('paid');

      const auditsFor = async (id: string) =>
        (await db
          .prepare("select count(*) as n from audit_log where entity_id = ? and action = 'order.expired'")
          .bind(id)
          .first<{ n: number }>())?.n;
      expect(await auditsFor(dueOrder.orderId)).toBe(1);
      expect(await auditsFor(futureOrder.orderId)).toBe(0);

      const second = await service.expireDueReservations(FIXED_NOW);
      expect(second.expired).toBe(0);
      expect(await auditsFor(dueOrder.orderId)).toBe(1);
    } finally {
      await cleanup(due);
      await cleanup(future);
      await cleanup(paid);
    }
  });

  // -- entrypoint / platform ------------------------------------------------

  it('wires the custom Worker entrypoint through the supported handler', () => {
    const wrangler = readFileSync(join(root, 'wrangler.jsonc'), 'utf8');
    expect(wrangler).toContain('"./src/worker/entry.ts"');
    expect(wrangler).toContain('"*/5 * * * *"');
    expect(wrangler).not.toContain('@astrojs/cloudflare/entrypoints/server');

    const entry = readFileSync(join(root, 'src', 'worker', 'entry.ts'), 'utf8');
    expect(entry).toContain("from '@astrojs/cloudflare/handler'");
    expect(entry).not.toContain('@astrojs/cloudflare/dist');
    expect(entry).not.toContain('entrypoints/server');
    expect(entry).toMatch(/fetch\s*\(/);
    expect(entry).toMatch(/scheduled\s*\(/);

    const scheduled = readFileSync(join(root, 'src', 'worker', 'scheduled.ts'), 'utf8');
    expect(scheduled).toContain('getReservationMaintenance');
    for (const file of [entry, scheduled]) {
      const code = file.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code).not.toMatch(/\bselect\s|\binsert\s+into|\bupdate\s+orders|\bdelete\s+from/i);
      expect(code).not.toMatch(/env\.DB/);
    }

    const astroConfig = readFileSync(join(root, 'astro.config.mjs'), 'utf8');
    expect(astroConfig).not.toMatch(/workerEntryPoint/);
  });

  it('adds only the authorised reservation-expiry index', async () => {
    const applied = await db
      .prepare("select name from schema_migrations where id = '0010'")
      .first<{ name: string }>();
    expect(applied?.name).toBe('0010_order_reservation_expiry.sql');

    const indexes = await db
      .prepare("select name from sqlite_master where type = 'index' and tbl_name = 'orders'")
      .all<{ name: string }>();
    const names = indexes.results.map((row) => row.name);
    expect(names).toContain('orders_status_reservation_expires_at_idx');
    expect(names).toContain('orders_reference_unique');
  });

  it('keeps the 06B0 commercial authority intact', async () => {
    const probe = await makeProbe({ capacity: 10 });
    try {
      const { service, created, begun } = await createAndReserve(probe, 2);
      await service.confirmPayment(created.orderId, begun.checkoutId, provider());
      expect((await inventory().ticketTypeInventory(probe.typeId))?.sold).toBe(2);

      await db
        .prepare("insert into tickets (id, order_id, event_id, ticket_type_id, reference, status, is_guest_list, issued_at) values (?, ?, ?, ?, 'AMP-06B-T', 'issued', 0, ?)")
        .bind(`tkt_res_${probe.typeId}`, created.orderId, probe.eventId, probe.typeId, FIXED_NOW.toISOString())
        .run();
      expect((await inventory().ticketTypeInventory(probe.typeId))?.sold).toBe(2);

      await db.prepare("update orders set status = 'partially_refunded' where id = ?").bind(created.orderId).run();
      expect((await inventory().ticketTypeInventory(probe.typeId))?.sold).toBe(2);
      await db.prepare("update orders set status = 'refunded' where id = ?").bind(created.orderId).run();
      expect((await inventory().ticketTypeInventory(probe.typeId))?.sold).toBe(0);
    } finally {
      await cleanup(probe);
    }
  });
});
