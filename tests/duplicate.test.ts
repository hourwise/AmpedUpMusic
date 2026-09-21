/**
 * AMPED-04D - Duplicate Promotion (revised: operator supplies the new dates).
 *
 * Duplication reuses promotional structure into a clean draft. It never copies
 * the source date, sale windows or any commercial history, and it refuses to
 * proceed when the source depends on an archived venue or artist.
 *
 * Runs against an isolated ephemeral D1 with a verified synthetic operator.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { openEphemeralDatabase } from '../src/db/local.ts';
import { migrate } from '../src/db/migrations.ts';
import { applySeed } from '../src/db/seed.ts';
import { createD1GigMutations } from '../src/services/d1/events.ts';
import {
  ConflictError,
  NotFoundError,
  parseDuplicateInput,
} from '../src/lib/validation.ts';
import { isProtectedPath } from '../src/lib/access.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const OPERATOR = { email: 'anya@ampedupmusicpromo.co.uk', sub: 'access-subject-1' };
const NEW_DOORS = '2027-06-01T19:00';
const NEW_STARTS = '2027-06-01T19:30';

/** The shapes of the reusable source data we snapshot for immutability. */
interface SourceSnapshot {
  event: Record<string, unknown> | null;
  lineup: unknown;
  tickets: unknown;
  audit: unknown;
}

describe('AMPED-04D duplicate input validation', () => {
  it('requires both new doors and start times', () => {
    const missingDoors = parseDuplicateInput({ sourceEventId: 'evt_x', newStartsAt: NEW_STARTS });
    expect(missingDoors.ok).toBe(false);
    if (!missingDoors.ok) expect(missingDoors.fields.newDoorsAt).toBeTruthy();

    const missingStarts = parseDuplicateInput({ sourceEventId: 'evt_x', newDoorsAt: NEW_DOORS });
    expect(missingStarts.ok).toBe(false);
    if (!missingStarts.ok) expect(missingStarts.fields.newStartsAt).toBeTruthy();
  });

  it('rejects unknown fields and malformed or DST-gap dates', () => {
    expect(parseDuplicateInput({ sourceEventId: 'evt_x', newDoorsAt: NEW_DOORS, newStartsAt: NEW_STARTS, status: 'published' }).ok).toBe(false);
    expect(parseDuplicateInput({ sourceEventId: 'evt_x', newDoorsAt: 'not a date', newStartsAt: NEW_STARTS }).ok).toBe(false);
    // 2026-03-29 01:30 does not exist in London.
    expect(parseDuplicateInput({ sourceEventId: 'evt_x', newDoorsAt: '2026-03-29T01:30', newStartsAt: '2026-03-29T02:30' }).ok).toBe(false);
  });

  it('converts Europe/London wall clock to canonical UTC (GMT and BST)', () => {
    const winter = parseDuplicateInput({ sourceEventId: 'evt_x', newDoorsAt: '2027-01-15T19:00', newStartsAt: '2027-01-15T19:30' });
    expect(winter.ok).toBe(true);
    if (winter.ok) {
      expect(winter.value.doorsAt).toBe('2027-01-15T19:00:00.000Z');
      expect(winter.value.startsAt).toBe('2027-01-15T19:30:00.000Z');
    }

    const summer = parseDuplicateInput({ sourceEventId: 'evt_x', newDoorsAt: '2027-06-15T19:00', newStartsAt: '2027-06-15T19:30' });
    expect(summer.ok).toBe(true);
    if (summer.ok) {
      expect(summer.value.doorsAt).toBe('2027-06-15T18:00:00.000Z');
      expect(summer.value.startsAt).toBe('2027-06-15T18:30:00.000Z');
    }
  });
});

describe('AMPED-04D duplication against D1', () => {
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

  function freshMutations() {
    return createD1GigMutations(db, () => new Date(), (prefix) => `${prefix}_d${++counter}`);
  }

  async function snapshotSource(sourceId: string): Promise<SourceSnapshot> {
    const event = await db
      .prepare('select * from events where id = ?')
      .bind(sourceId)
      .first<Record<string, unknown>>();
    const lineup = await db
      .prepare('select * from event_artists where event_id = ? order by artist_id')
      .bind(sourceId)
      .all();
    const tickets = await db
      .prepare('select * from ticket_types where event_id = ? order by id')
      .bind(sourceId)
      .all();
    const audit = await db
      .prepare('select * from audit_log where entity_id = ? order by id')
      .bind(sourceId)
      .all();
    return { event, lineup: lineup.results, tickets: tickets.results, audit: audit.results };
  }

  async function duplicate(sourceId: string) {
    return freshMutations().duplicate(
      sourceId,
      { doorsAt: '2027-06-01T18:00:00.000Z', startsAt: '2027-06-01T18:30:00.000Z' },
      OPERATOR,
    );
  }

  // -- basic ---------------------------------------------------------------

  it('duplicates published, completed and sold-out events into a draft', async () => {
    for (const sourceId of ['evt_glass_hearts_nov', 'evt_hollow_coast_past', 'evt_brass_tacks_nye']) {
      const created = await duplicate(sourceId);
      const row = await db
        .prepare('select status, published_at, status_message, ends_at from events where id = ?')
        .bind(created.id)
        .first<{ status: string; published_at: string | null; status_message: string | null; ends_at: string | null }>();
      expect(row?.status).toBe('draft');
      expect(row?.published_at).toBeNull();
      expect(row?.status_message).toBeNull();
      expect(row?.ends_at).toBeNull();
    }
  });

  it('stores the operator-supplied new dates, never the source dates', async () => {
    const created = await duplicate('evt_glass_hearts_nov');
    const source = await db
      .prepare('select doors_at, starts_at from events where id = ?')
      .bind('evt_glass_hearts_nov')
      .first<{ doors_at: string; starts_at: string }>();
    const copy = await db
      .prepare('select doors_at, starts_at from events where id = ?')
      .bind(created.id)
      .first<{ doors_at: string; starts_at: string }>();

    expect(copy?.doors_at).toBe('2027-06-01T18:00:00.000Z');
    expect(copy?.starts_at).toBe('2027-06-01T18:30:00.000Z');
    expect(copy?.doors_at).not.toBe(source?.doors_at);
    expect(copy?.starts_at).not.toBe(source?.starts_at);
  });

  it('leaves the source event completely unchanged', async () => {
    const before = await snapshotSource('evt_glass_hearts_nov');
    await duplicate('evt_glass_hearts_nov');
    const after = await snapshotSource('evt_glass_hearts_nov');
    expect(after).toEqual(before);
  });

  // -- copied structure ----------------------------------------------------

  it('copies the reusable structure and resets the instance-specific parts', async () => {
    const source = await db
      .prepare(
        'select title, strapline, description, venue_id, age_restriction, accessibility_notes, poster_asset_id, hero_asset_id, link_instagram, link_facebook, photography_credit, photography_gallery_url, photography_photographer_url, internal_notes from events where id = ?',
      )
      .bind('evt_glass_hearts_nov')
      .first<Record<string, unknown>>();

    const created = await duplicate('evt_glass_hearts_nov');
    const copy = await db
      .prepare(
        'select title, strapline, description, venue_id, age_restriction, accessibility_notes, poster_asset_id, hero_asset_id, link_instagram, link_facebook, photography_credit, photography_gallery_url, photography_photographer_url, internal_notes from events where id = ?',
      )
      .bind(created.id)
      .first<Record<string, unknown>>();

    expect(copy).toEqual(source);

    // Line-up copied with the running order preserved.
    const sourceLineup = await db
      .prepare('select artist_id, position, billing_note, set_time from event_artists where event_id = ? order by position')
      .bind('evt_glass_hearts_nov')
      .all<{ artist_id: string; position: number; billing_note: string | null; set_time: string | null }>();
    const copyLineup = await db
      .prepare('select artist_id, position, billing_note, set_time from event_artists where event_id = ? order by position')
      .bind(created.id)
      .all<{ artist_id: string; position: number; billing_note: string | null; set_time: string | null }>();

    expect(copyLineup.results.map((row) => row.artist_id)).toEqual(
      sourceLineup.results.map((row) => row.artist_id),
    );
    expect(copyLineup.results.map((row) => row.position)).toEqual(
      sourceLineup.results.map((row) => row.position),
    );
    // Stage times belonged to the old date and are reset.
    expect(copyLineup.results.every((row) => row.set_time === null)).toBe(true);

    // Ticket configuration copied; ids, sale windows and history are not.
    const sourceTypes = await db
      .prepare('select name, description, price_in_pence, capacity, max_per_order, visibility, position from ticket_types where event_id = ? order by position')
      .bind('evt_glass_hearts_nov')
      .all<Record<string, unknown>>();
    const copyTypes = await db
      .prepare('select name, description, price_in_pence, capacity, max_per_order, visibility, position, sales_open_at, sales_close_at, id from ticket_types where event_id = ? order by position')
      .bind(created.id)
      .all<Record<string, unknown>>();

    expect(copyTypes.results.map(({ id, sales_open_at, sales_close_at, ...rest }) => rest)).toEqual(
      sourceTypes.results,
    );
    expect(copyTypes.results.every((row) => row.sales_open_at === null && row.sales_close_at === null)).toBe(true);

    // Hidden guest-list configuration is copied; the new type has no history.
    const guest = copyTypes.results.find((row) => row.visibility === 'hidden');
    expect(guest).toBeDefined();
    const guestTickets = await db
      .prepare('select count(*) as n from tickets where ticket_type_id = ?')
      .bind(guest?.id as string)
      .first<{ n: number }>();
    expect(guestTickets?.n).toBe(0);
  });

  // -- commercial reset ----------------------------------------------------

  it('starts commercially clean and leaves no history attached', async () => {
    const created = await duplicate('evt_hollow_coast_past');

    for (const table of ['orders', 'tickets', 'checkins']) {
      const row = await db
        .prepare(`select count(*) as n from ${table} where event_id = ?`)
        .bind(created.id)
        .first<{ n: number }>();
      expect(row?.n, table).toBe(0);
    }

    const newTypeIds = await db
      .prepare('select id from ticket_types where event_id = ?')
      .bind(created.id)
      .all<{ id: string }>();
    for (const type of newTypeIds.results) {
      const orderItems = await db
        .prepare('select count(*) as n from order_items where ticket_type_id = ?')
        .bind(type.id)
        .first<{ n: number }>();
      expect(orderItems?.n).toBe(0);
    }

    const gallery = await db
      .prepare("select count(*) as n from media_assets where event_id = ? and role = 'gallery'")
      .bind(created.id)
      .first<{ n: number }>();
    expect(gallery?.n).toBe(0);

    const audit = await db
      .prepare('select action from audit_log where entity_id = ? order by id')
      .bind(created.id)
      .all<{ action: string }>();
    expect(audit.results).toEqual([{ action: 'event.duplicated' }]);
    expect((audit.results[0] as { action: string }).action).toBe('event.duplicated');
  });

  it('gives the duplicate a new id and a unique slug', async () => {
    const source = await db
      .prepare('select slug from events where id = ?')
      .bind('evt_glass_hearts_nov')
      .first<{ slug: string }>();
    const created = await duplicate('evt_glass_hearts_nov');

    expect(created.id).not.toBe('evt_glass_hearts_nov');
    expect(created.slug).not.toBe(source?.slug);
    const sourceStill = await db
      .prepare('select slug from events where id = ?')
      .bind('evt_glass_hearts_nov')
      .first<{ slug: string }>();
    expect(sourceStill?.slug).toBe(source?.slug);
  });

  // -- ticket identity -----------------------------------------------------

  it('creates new ticket-type identities without touching the source definitions', async () => {
    const sourceTypesBefore = await db
      .prepare('select id from ticket_types where event_id = ? order by id')
      .bind('evt_glass_hearts_nov')
      .all<{ id: string }>();
    const sourceOrderItems = await db
      .prepare("select count(*) as n from order_items where ticket_type_id in ('tt_gh_early','tt_gh_ga','tt_gh_guest')")
      .first<{ n: number }>();

    const created = await duplicate('evt_glass_hearts_nov');
    const copyTypes = await db
      .prepare('select id from ticket_types where event_id = ?')
      .bind(created.id)
      .all<{ id: string }>();

    const sourceIds = new Set(sourceTypesBefore.results.map((row) => row.id));
    expect(copyTypes.results.every((row) => !sourceIds.has(row.id))).toBe(true);

    const sourceTypesAfter = await db
      .prepare('select id from ticket_types where event_id = ? order by id')
      .bind('evt_glass_hearts_nov')
      .all<{ id: string }>();
    expect(sourceTypesAfter.results).toEqual(sourceTypesBefore.results);

    const sourceOrderItemsAfter = await db
      .prepare("select count(*) as n from order_items where ticket_type_id in ('tt_gh_early','tt_gh_ga','tt_gh_guest')")
      .first<{ n: number }>();
    expect(sourceOrderItemsAfter?.n).toBe(sourceOrderItems?.n);
  });

  // -- archived dependencies ----------------------------------------------

  it('refuses duplication when the source venue is archived', async () => {
    await db
      .prepare("update venues set archived_at = ? where id = 'ven_lomax'")
      .bind(new Date().toISOString())
      .run();
    const before = await db.prepare('select count(*) as n from events').first<{ n: number }>();

    try {
      await expect(duplicate('evt_glass_hearts_nov')).rejects.toBeInstanceOf(ConflictError);
      const after = await db.prepare('select count(*) as n from events').first<{ n: number }>();
      expect(after?.n).toBe(before?.n);
      const venue = await db
        .prepare("select archived_at from venues where id = 'ven_lomax'")
        .first<{ archived_at: string | null }>();
      expect(venue?.archived_at).not.toBeNull();
    } finally {
      await db.prepare("update venues set archived_at = null where id = 'ven_lomax'").run();
    }
  });

  it('refuses duplication when a billed artist is archived', async () => {
    await db
      .prepare("update artists set archived_at = ? where id = 'art_mara_veil'")
      .bind(new Date().toISOString())
      .run();
    const before = await db.prepare('select count(*) as n from events').first<{ n: number }>();

    try {
      await expect(duplicate('evt_glass_hearts_nov')).rejects.toBeInstanceOf(ConflictError);
      const after = await db.prepare('select count(*) as n from events').first<{ n: number }>();
      expect(after?.n).toBe(before?.n);
      const artist = await db
        .prepare("select archived_at from artists where id = 'art_mara_veil'")
        .first<{ archived_at: string | null }>();
      expect(artist?.archived_at).not.toBeNull();
    } finally {
      await db.prepare("update artists set archived_at = null where id = 'art_mara_veil'").run();
    }
  });

  it('reports a missing source without creating anything', async () => {
    const before = await db.prepare('select count(*) as n from events').first<{ n: number }>();
    await expect(duplicate('evt_does_not_exist')).rejects.toBeInstanceOf(NotFoundError);
    const after = await db.prepare('select count(*) as n from events').first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });

  // -- atomicity -----------------------------------------------------------

  it('rolls the whole duplicate back when a child insert fails', async () => {
    const before = await db.prepare('select count(*) as n from events').first<{ n: number }>();
    // A colliding id factory makes the second ticket-type insert violate the
    // primary key, so the D1 batch must roll the event back entirely.
    const colliding = createD1GigMutations(db, () => new Date(), (prefix) => `${prefix}_collide`);

    await expect(
      colliding.duplicate(
        'evt_glass_hearts_nov',
        { doorsAt: '2027-06-01T18:00:00.000Z', startsAt: '2027-06-01T18:30:00.000Z' },
        OPERATOR,
      ),
    ).rejects.toThrow();

    const after = await db.prepare('select count(*) as n from events').first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
    expect(await db.prepare("select id from events where id = 'evt_collide'").first()).toBeNull();
  });

  it('rolls back when the audit insert fails', async () => {
    const before = await db.prepare('select count(*) as n from events').first<{ n: number }>();
    await db
      .prepare(
        "insert into audit_log (id, actor_email, action, entity_type, entity_id, summary, occurred_at) values ('aud_auditclash', 'x@example.com', 'probe', 'probe', 'probe', 'probe', ?)",
      )
      .bind(new Date().toISOString())
      .run();

    let seq = 0;
    const failing = createD1GigMutations(db, () => new Date(), (prefix) =>
      prefix === 'aud' ? 'aud_auditclash' : `${prefix}_aud${++seq}`,
    );

    try {
      await expect(
        failing.duplicate(
          'evt_glass_hearts_nov',
          { doorsAt: '2027-06-01T18:00:00.000Z', startsAt: '2027-06-01T18:30:00.000Z' },
          OPERATOR,
        ),
      ).rejects.toThrow();
      const after = await db.prepare('select count(*) as n from events').first<{ n: number }>();
      expect(after?.n).toBe(before?.n);
    } finally {
      await db.prepare("delete from audit_log where id = 'aud_auditclash'").run();
    }
  });

  // -- concurrency ---------------------------------------------------------

  it('produces independent drafts for two requests', async () => {
    const first = await duplicate('evt_glass_hearts_nov');
    const second = await duplicate('evt_glass_hearts_nov');

    expect(first.id).not.toBe(second.id);
    expect(first.slug).not.toBe(second.slug);

    const firstTypes = await db
      .prepare('select id from ticket_types where event_id = ?')
      .bind(first.id)
      .all<{ id: string }>();
    const secondTypes = await db
      .prepare('select id from ticket_types where event_id = ?')
      .bind(second.id)
      .all<{ id: string }>();
    const overlap = firstTypes.results.filter((row) =>
      secondTypes.results.some((other) => other.id === row.id),
    );
    expect(overlap).toEqual([]);
  });

  // -- access --------------------------------------------------------------

  it('keeps the duplicate endpoint inside the protected namespace', () => {
    expect(isProtectedPath('/api/admin/gigs/duplicate')).toBe(true);
  });
});
