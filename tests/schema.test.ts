/**
 * AMPED-02A — schema, migration and seed tests.
 *
 * These run against a real D1 database (the same runtime the Worker uses),
 * created in memory for each run, and they exercise the actual SQL: every
 * assertion below is either a query against the migrated database or a
 * statement the database is expected to refuse.
 *
 * The dataset assertions are the AMPED-01 fixture figures. If a number here
 * changes, the seeded data no longer reproduces the visual states the scaffold
 * demonstrates, which is the whole point of AMPED-02A's seed.
 *
 * Migration tests use throwaway directories under the OS temp directory where
 * they need a malformed or edited migration; nothing is written inside the
 * repository.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { listTables, openEphemeralDatabase } from '../src/db/local.ts';
import { loadMigrations, migrate, readAppliedMigrations } from '../src/db/migrations.ts';
import { V1_TABLES } from '../src/db/schema.ts';
import { applySeed, buildSeedBatches } from '../src/db/seed.ts';

// Starting a Wrangler runtime and writing ~4,400 seed rows takes longer than
// Vitest's default budget. This file is the slow one; the rest of the suite
// keeps the default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestDatabase {
  db: D1Database;
  dispose: () => Promise<void>;
}

const tableNames = (db: D1Database): Promise<string[]> => listTables(db);

/** Every non-internal schema object, so two schemas can be compared. */
async function schemaObjects(db: D1Database): Promise<string[]> {
  const result = await db
    .prepare(
      "select type, name from sqlite_master " +
        "where name not like 'sqlite_%' and name not like '_cf_%' order by type, name",
    )
    .all<{ type: string; name: string }>();
  return result.results.map((row) => `${row.type}:${row.name}`);
}

interface IndexRow {
  name: string;
  tbl_name: string;
  sql: string | null;
}

async function namedIndexes(db: D1Database): Promise<IndexRow[]> {
  const result = await db
    .prepare(
      "select name, tbl_name, sql from sqlite_master where type = 'index' and name not like 'sqlite_%' order by name",
    )
    .all<IndexRow>();
  return result.results;
}

/**
 * Drop every table children-first, so the RESTRICT foreign keys never block
 * the teardown. Used to prove the migrations rebuild the schema from empty.
 */
const DROP_ALL_SQL: readonly string[] = [
  'drop table if exists schema_migrations',
  'drop table if exists processed_webhooks',
  'drop table if exists audit_log',
  'drop table if exists mailing_list',
  'drop table if exists enquiries',
  'drop table if exists checkins',
  'drop table if exists tickets',
  'drop table if exists order_items',
  'drop table if exists orders',
  'drop table if exists ticket_types',
  'drop table if exists social_posts',
  'drop table if exists media_assets',
  'drop table if exists event_artists',
  'drop table if exists events',
  'drop table if exists artists',
  'drop table if exists venues',
];

async function dropEverything(db: D1Database): Promise<void> {
  for (const statement of DROP_ALL_SQL) {
    await db.prepare(statement).run();
  }
}

function makeTempMigrationsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'amped-migrations-'));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents, 'utf8');
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

describe('migration runner', () => {
  let database: TestDatabase;
  let db: D1Database;
  let scratch: TestDatabase;
  let scratchDb: D1Database;

  beforeAll(async () => {
    database = await openEphemeralDatabase();
    db = database.db;
    scratch = await openEphemeralDatabase();
    scratchDb = scratch.db;
  });

  afterAll(async () => {
    await database.dispose();
    await scratch.dispose();
  });

  it('migrates every migration, in order, into an empty database', async () => {
    expect(await tableNames(db)).toEqual([]);

    const result = await migrate(db);

    expect(result.applied.map((migration) => migration.id)).toEqual([
      '0001',
      '0002',
      '0003',
      '0004',
      '0005',
      '0006',
      '0007',
      '0008',
      '0009',
    ]);
    expect(result.alreadyApplied).toEqual([]);

    // Exactly the V1 tables, and nothing else.
    expect(await tableNames(db)).toEqual([...V1_TABLES].sort());
  });

  it('records one ledger row per migration, with a checksum', async () => {
    const applied = await readAppliedMigrations(db);
    const withChecksums = await db
      .prepare(
        'select id, name, checksum, applied_at from schema_migrations order by id',
      )
      .all<{ id: string; name: string; checksum: string; applied_at: string }>();

    expect(applied.length).toBe(9);
    expect(withChecksums.results.map((row) => row.name)).toEqual(
      loadMigrations().map((migration) => migration.name),
    );
    for (const row of withChecksums.results) {
      expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(row.applied_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  it('is a no-op when run again', async () => {
    const before = await readAppliedMigrations(db);

    const second = await migrate(db);

    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toHaveLength(9);

    // Not merely "no error": the ledger must be untouched, timestamps and all.
    expect(await readAppliedMigrations(db)).toEqual(before);
  });

  it('discovers migrations in numeric order, not filesystem order', async () => {
    const ids = loadMigrations().map((migration) => migration.id);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(9);
  });

  it('refuses to run if a migration that has already been applied is edited', async () => {
    const dir = makeTempMigrationsDir({
      '0001_first.sql': 'create table guard_a (id text primary key) strict;',
      '0002_second.sql': 'create table guard_b (id text primary key) strict;',
    });

    try {
      await migrate(scratchDb, { dir });

      // Rewriting history: the file changes after it has been applied.
      writeFileSync(
        join(dir, '0001_first.sql'),
        'create table guard_a (id text primary key, extra text) strict;',
        'utf8',
      );

      await expect(migrate(scratchDb, { dir })).rejects.toThrow(/forward-only/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('splits statements without being confused by comments or string literals', async () => {
    const dir = makeTempMigrationsDir({
      '0003_edges.sql': [
        '-- a comment containing a semicolon ; and a quote \'',
        'create table edge (id text primary key, note text not null) strict;',
        '',
        '/* a block comment; with punctuation */',
        "insert into edge (id, note) values ('a', 'semi;colon, -- not a comment');",
        '-- trailing comment with no statement after it',
      ].join('\n'),
    });

    try {
      const result = await migrate(scratchDb, { dir });
      expect(result.applied).toHaveLength(1);
      expect(result.applied[0]?.statements).toHaveLength(2);

      const rows = await scratchDb.prepare('select id, note from edge').all<{
        id: string;
        note: string;
      }>();
      expect(rows.results).toEqual([{ id: 'a', note: 'semi;colon, -- not a comment' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rebuilds an identical schema from a clean database', async () => {
    const expected = await schemaObjects(db);

    await dropEverything(db);
    expect(await tableNames(db)).toEqual([]);

    const rebuilt = await migrate(db);

    expect(rebuilt.applied).toHaveLength(9);
    expect(await schemaObjects(db)).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// Seed dataset
// ---------------------------------------------------------------------------

/**
 * The AMPED-01 fixture counts, table by table. `event_artists` and
 * `ticket_types` are the scaffold's real figures, not round numbers.
 */
const SEED_COUNT_SQL = `
  select
    (select count(*) from venues) as venues,
    (select count(*) from artists) as artists,
    (select count(*) from events) as events,
    (select count(*) from event_artists) as event_artists,
    (select count(*) from ticket_types) as ticket_types,
    (select count(*) from media_assets) as media_assets,
    (select count(*) from orders) as orders,
    (select count(*) from order_items) as order_items,
    (select count(*) from tickets) as tickets,
    (select count(*) from checkins) as checkins,
    (select count(*) from social_posts) as social_posts,
    (select count(*) from enquiries) as enquiries,
    (select count(*) from mailing_list) as mailing_list,
    (select count(*) from audit_log) as audit_log
`;

const EXPECTED_SEED_COUNTS = {
  venues: 4,
  artists: 10,
  events: 12,
  event_artists: 27,
  ticket_types: 22,
  media_assets: 43,
  orders: 746,
  order_items: 746,
  tickets: 1801,
  checkins: 969,
  social_posts: 6,
  enquiries: 6,
  mailing_list: 20,
  audit_log: 6,
} as const;

/**
 * The scaffold's `SALES` table, ticket type by ticket type. `sold` counts
 * tickets in `issued` or `checked_in`; `reserved` counts stock held by an
 * `awaiting_payment` order whose reservation has not expired.
 */
const SALES_PARITY_SQL = `
  select
    t.id as ticket_type_id,
    t.capacity as capacity,
    (select count(*) from tickets k
      where k.ticket_type_id = t.id and k.status in ('issued', 'checked_in')) as sold,
    (select coalesce(sum(i.quantity), 0) from order_items i
      join orders o on o.id = i.order_id
      where i.ticket_type_id = t.id
        and o.status = 'awaiting_payment'
        and julianday(o.reservation_expires_at) > julianday('now')) as reserved
  from ticket_types t
  order by t.id
`;

const EXPECTED_SALES: Record<string, { capacity: number; sold: number; reserved: number }> = {
  tt_gh_early: { capacity: 60, sold: 60, reserved: 0 },
  tt_gh_ga: { capacity: 140, sold: 96, reserved: 4 },
  tt_gh_guest: { capacity: 20, sold: 11, reserved: 0 },
  tt_led_ga: { capacity: 82, sold: 82, reserved: 0 },
  tt_led_guest: { capacity: 8, sold: 6, reserved: 0 },
  tt_ns_early: { capacity: 80, sold: 80, reserved: 0 },
  tt_ns_ga: { capacity: 240, sold: 64, reserved: 2 },
  tt_ns_guest: { capacity: 30, sold: 4, reserved: 0 },
  tt_sw_ga: { capacity: 300, sold: 118, reserved: 0 },
  tt_sw_seated: { capacity: 140, sold: 51, reserved: 0 },
  tt_va_ga: { capacity: 200, sold: 186, reserved: 1 },
  tt_va_guest: { capacity: 20, sold: 3, reserved: 0 },
  tt_wa_early: { capacity: 80, sold: 0, reserved: 0 },
  tt_wa_ga: { capacity: 250, sold: 0, reserved: 0 },
  tt_pl_ga: { capacity: 85, sold: 0, reserved: 0 },
  tt_bt_ga: { capacity: 380, sold: 0, reserved: 0 },
  tt_bt_seated: { capacity: 90, sold: 0, reserved: 0 },
  tt_hc_ga: { capacity: 330, sold: 330, reserved: 0 },
  tt_hc_seated: { capacity: 140, sold: 138, reserved: 0 },
  tt_bp_ga: { capacity: 330, sold: 291, reserved: 0 },
  tt_pp_ga: { capacity: 85, sold: 85, reserved: 0 },
  tt_ss_ga: { capacity: 200, sold: 194, reserved: 0 },
};

/**
 * One migrated, seeded database shared by the dataset and constraint suites.
 * Neither of them modifies a seeded row, and starting a Wrangler runtime is
 * the slowest thing in this file, so they share one.
 */
let sharedDatabase: TestDatabase | undefined;
let sharedDb: D1Database;

beforeAll(async () => {
  sharedDatabase = await openEphemeralDatabase();
  sharedDb = sharedDatabase.db;
  await migrate(sharedDb);
  await applySeed(sharedDb);
});

afterAll(async () => {
  await sharedDatabase?.dispose();
});

describe('seed dataset', () => {
  let db: D1Database;

  beforeAll(() => {
    db = sharedDb;
  });

  it('loads every row the fixture set represents', async () => {
    const counts = await db.prepare(SEED_COUNT_SQL).first<Record<string, number>>();
    expect(counts).toEqual(EXPECTED_SEED_COUNTS);
  });

  it('builds the same dataset without a database', () => {
    // `buildSeedBatches` is pure, so the shape of the dataset is checkable
    // without a D1 instance - and the row total must match what was written.
    const batches = buildSeedBatches(new Date());
    const labels = batches.map((seedBatch) => seedBatch.label);

    expect(labels).toContain('venues');
    expect(labels).toContain('media_assets');
    expect(labels.indexOf('media_assets')).toBeGreaterThan(labels.indexOf('events'));
    expect(labels).toContain('orders');
    expect(labels).toContain('tickets');

    const total = batches.reduce((sum, seedBatch) => sum + seedBatch.rows.length, 0);
    expect(total).toBe(4438);
  });

  it('lines every insert up with its row shape, column for column', () => {
    // The seed writes each table from one bound JSON payload, so the SELECT key
    // list and the INSERT column list have to agree exactly. This is the check
    // that stops a key written against the wrong column from silently writing
    // NULL into a nullable field.
    const inserts = buildSeedBatches(new Date()).filter((batch) => batch.mode === 'insert');
    expect(inserts).toHaveLength(14);

    for (const batch of inserts) {
      const [head, tail] = batch.sql.split(/\bselect\b/i);
      const columns = (head ?? '')
        .slice((head ?? '').indexOf('(') + 1, (head ?? '').lastIndexOf(')'))
        .split(',')
        .map((column) => column.trim())
        .filter((column) => column.length > 0);

      const keys = [...(tail ?? '').matchAll(/\$\.([a-z0-9_]+)/g)].map((match) => match[1]);

      expect(keys, batch.label).toEqual(columns);
      expect(new Set(keys), batch.label).toEqual(
        new Set(Object.keys(batch.rows[0] as Record<string, unknown>)),
      );

      for (const row of batch.rows) {
        expect(new Set(Object.keys(row as Record<string, unknown>)), batch.label).toEqual(
          new Set(keys),
        );
      }
    }
  });

  it('fills every nullable column the fixture set relies on', async () => {
    const result = await db
      .prepare(
        `select
           (select count(*) from venues
             where standard_notes is null or accessibility_info is null) as venues_incomplete,
           (select count(*) from artists
             where tagline is null or biography is null or genre is null
                or based_in is null or image_asset_id is null) as artists_incomplete,
           (select count(*) from events
             where strapline is null or ends_at is null or description = '') as events_incomplete,
           (select count(*) from events
             where status in ('cancelled', 'postponed')
               and (status_message is null or trim(status_message) = '')) as disrupted_without_notice,
           (select count(*) from media_assets
             where alt is null or trim(alt) = '' or width is null or height is null
                or url is null or mime_type is null) as media_incomplete,
           (select count(*) from media_assets m
             where m.event_id is null and m.artist_id is null and m.role <> 'og'
               and not exists (select 1 from social_posts s where s.thumbnail_asset_id = m.id))
             as media_unreferenced,
           (select count(*) from orders
             where customer_email is null or created_at is null
                or (status in ('paid', 'refunded')
                    and payment_reference is null and payment_provider <> 'comp')) as orders_incomplete,
           (select count(*) from tickets
             where reference is null or issued_at is null) as tickets_incomplete,
           (select count(*) from checkins
             where operator_email is null or scanned_at is null) as checkins_incomplete,
           (select count(*) from social_posts
             where url is null or caption is null) as social_incomplete,
           (select count(*) from enquiries
             where message is null or email is null) as enquiries_incomplete,
           (select count(*) from mailing_list
             where consent_at is null or consent_source is null) as subscribers_incomplete,
           (select count(*) from audit_log
             where actor_email is null or summary is null) as audit_incomplete,
           (select count(*) from ticket_types where description is not null) as types_with_description,
           (select count(distinct actor_email) from audit_log) as audit_actors`,
      )
      .first<Record<string, number>>();

    expect(result).toEqual({
      venues_incomplete: 0,
      artists_incomplete: 0,
      events_incomplete: 0,
      disrupted_without_notice: 0,
      media_incomplete: 0,
      media_unreferenced: 0,
      orders_incomplete: 0,
      tickets_incomplete: 0,
      checkins_incomplete: 0,
      social_incomplete: 0,
      enquiries_incomplete: 0,
      subscribers_incomplete: 0,
      audit_incomplete: 0,
      // Nine of the twenty-two types carry sales copy; the rest do not.
      types_with_description: 9,
      audit_actors: 2,
    });
  });

  it('writes the fixture values into the right columns', async () => {
    const venue = await db
      .prepare(
        'select name, slug, city, postcode, capacity, website_url, map_url from venues where id = ?',
      )
      .bind('ven_ironworks')
      .first();

    expect(venue).toEqual({
      name: 'Ironworks Social',
      slug: 'ironworks-social',
      city: 'Blackpool',
      postcode: 'FY2 0HA',
      capacity: 350,
      website_url: null,
      map_url: 'https://www.openstreetmap.org/search?query=Blackpool%20FY2',
    });

    const event = await db
      .prepare(
        'select title, slug, status, venue_id, age_restriction, doors_at, starts_at, ends_at, published_at from events where id = ?',
      )
      .bind('evt_glass_hearts_nov')
      .first<{
        title: string;
        slug: string;
        status: string;
        venue_id: string;
        age_restriction: string;
        doors_at: string;
        starts_at: string;
        ends_at: string;
        published_at: string | null;
      }>();

    expect(event).toMatchObject({
      title: 'The Glass Hearts',
      slug: 'the-glass-hearts-lomax-rooms',
      status: 'published',
      venue_id: 'ven_lomax',
      age_restriction: '16-plus',
    });
    // Doors, start and curfew are real ISO-8601 UTC instants in the right order.
    expect(Date.parse(event!.doors_at)).toBeLessThan(Date.parse(event!.starts_at));
    expect(Date.parse(event!.starts_at)).toBeLessThan(Date.parse(event!.ends_at));
    expect(event?.published_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const ticketType = await db
      .prepare(
        'select name, price_in_pence, capacity, max_per_order, position, visibility, sales_close_at from ticket_types where id = ?',
      )
      .bind('tt_gh_ga')
      .first();

    expect(ticketType).toMatchObject({
      name: 'General Admission',
      price_in_pence: 1000,
      capacity: 140,
      max_per_order: 6,
      position: 1,
      visibility: 'public',
      sales_close_at: null,
    });

    const draft = await db
      .prepare('select internal_notes, published_at, poster_asset_id from events where id = ?')
      .bind('evt_brass_tacks_nye')
      .first<Record<string, string | null>>();

    expect(draft?.internal_notes).toContain('late licence');
    expect(draft?.published_at).toBeNull();
    expect(draft?.poster_asset_id).toBeNull();
  });

  it('keeps orders, order items and tickets arithmetically consistent', async () => {
    const result = await db
      .prepare(
        `select
           (select count(*) from orders o
              join order_items i on i.order_id = o.id
             where o.total_in_pence <> i.unit_price_in_pence * i.quantity) as bad_totals,
           (select count(*) from orders o
              join order_items i on i.order_id = o.id
             where o.status = 'paid'
               and (select count(*) from tickets k where k.order_id = o.id) <> i.quantity) as bad_ticket_counts,
           (select count(*) from orders where reference not glob 'AMP-[0-9][0-9]-[0-9][0-9][0-9][0-9][0-9]') as bad_references,
           (select count(*) from tickets k
              join orders o on o.id = k.order_id
             where o.status <> 'paid' and k.status <> 'refunded') as tickets_on_unpaid_orders,
           (select count(*) from ticket_types t
             where t.visibility = 'hidden' and t.price_in_pence <> 0) as priced_guest_list`,
      )
      .first<Record<string, number>>();

    expect(result).toEqual({
      bad_totals: 0,
      bad_ticket_counts: 0,
      bad_references: 0,
      tickets_on_unpaid_orders: 0,
      priced_guest_list: 0,
    });
  });

  it('reproduces the AMPED-01 sold and reserved counters exactly', async () => {
    const rows = await db.prepare(SALES_PARITY_SQL).all<{
      ticket_type_id: string;
      capacity: number;
      sold: number;
      reserved: number;
    }>();

    expect(rows.results).toHaveLength(Object.keys(EXPECTED_SALES).length);

    const actual = Object.fromEntries(
      rows.results.map((row) => [
        row.ticket_type_id,
        { capacity: row.capacity, sold: row.sold, reserved: row.reserved },
      ]),
    );

    expect(actual).toEqual(EXPECTED_SALES);
  });

  it('reproduces the fixture checked-in totals for the four past events', async () => {
    const result = await db
      .prepare(
        "select event_id, count(*) as admitted from tickets where status = 'checked_in' group by event_id order by event_id",
      )
      .all<{ event_id: string; admitted: number }>();

    expect(result.results).toEqual([
      { event_id: 'evt_brass_tacks_past', admitted: 268 },
      { event_id: 'evt_hollow_coast_past', admitted: 441 },
      { event_id: 'evt_paper_lions_past', admitted: 79 },
      { event_id: 'evt_spring_session_past', admitted: 181 },
    ]);
  });

  it('covers every event status the UI renders', async () => {
    const result = await db
      .prepare('select status, count(*) as n from events group by status order by status')
      .all<{ status: string; n: number }>();

    expect(Object.fromEntries(result.results.map((row) => [row.status, row.n]))).toEqual({
      cancelled: 1,
      completed: 4,
      draft: 1,
      postponed: 1,
      published: 5,
    });
  });

  it('issues tickets only for orders that have taken money', async () => {
    const result = await db
      .prepare(
        `select o.status as order_status, count(k.id) as tickets
           from orders o
           left join tickets k on k.order_id = o.id
          group by o.status
          order by o.status`,
      )
      .all<{ order_status: string; tickets: number }>();

    expect(Object.fromEntries(result.results.map((row) => [row.order_status, row.tickets]))).toEqual({
      // Held stock is derived from order_items, never from ticket rows.
      awaiting_payment: 0,
      expired: 0,
      paid: 1799,
      refunded: 2,
    });
  });

  it('backs every guest-list admission with a hidden, zero-priced ticket type', async () => {
    const result = await db
      .prepare(
        `select t.name as type_name, t.visibility as visibility, t.price_in_pence as price, count(*) as n
           from tickets k
           join ticket_types t on t.id = k.ticket_type_id
          where k.is_guest_list = 1
          group by t.name, t.visibility, t.price_in_pence
          order by t.name`,
      )
      .all<{ type_name: string; visibility: string; price: number; n: number }>();

    expect(result.results).toEqual([
      { type_name: 'Guest list', visibility: 'hidden', price: 0, n: 24 },
    ]);
  });

  it('gives every ticket a check-in record exactly when it is marked checked in', async () => {
    const result = await db
      .prepare(
        `select
           (select count(*) from tickets where status = 'checked_in') as checked_in_tickets,
           (select count(*) from checkins) as checkins,
           (select count(*) from tickets k
              where k.status = 'checked_in'
                and not exists (select 1 from checkins c where c.ticket_id = k.id)) as missing,
           (select count(*) from checkins c
              join tickets k on k.id = c.ticket_id
              where k.status <> 'checked_in') as orphaned`,
      )
      .first<Record<string, number>>();

    expect(result).toEqual({
      checked_in_tickets: 969,
      checkins: 969,
      missing: 0,
      orphaned: 0,
    });
  });

  it('leaves exactly two events without artwork, including the artwork-less draft', async () => {
    const result = await db
      .prepare('select id from events where poster_asset_id is null order by id')
      .all<{ id: string }>();

    expect(result.results.map((row) => row.id)).toEqual([
      'evt_brass_tacks_nye',
      'evt_paper_lions_jan',
    ]);
  });

  it('breaks referential integrity nowhere', async () => {
    const result = await db
      .prepare(
        `select
           (select count(*) from orders o
              where not exists (select 1 from events e where e.id = o.event_id)) as orders_without_event,
           (select count(*) from tickets k
              where not exists (select 1 from orders o where o.id = k.order_id)) as tickets_without_order,
           (select count(*) from tickets k
              where not exists (select 1 from ticket_types t where t.id = k.ticket_type_id)) as tickets_without_type,
           (select count(*) from events e
              where not exists (select 1 from venues v where v.id = e.venue_id)) as events_without_venue,
           (select count(*) from event_artists ea
              where not exists (select 1 from artists a where a.id = ea.artist_id)) as lineup_without_artist,
           (select count(*) from media_assets m
              where m.storage_key is null or trim(m.alt) = '') as unusable_media`,
      )
      .first<Record<string, number>>();

    expect(result).toEqual({
      orders_without_event: 0,
      tickets_without_order: 0,
      tickets_without_type: 0,
      events_without_venue: 0,
      lineup_without_artist: 0,
      unusable_media: 0,
    });
  });

  it('refuses to run a second time against a database that already holds rows', async () => {
    await expect(applySeed(db)).rejects.toThrow(/already holds/i);
  });

  it('refuses to run before the schema exists', async () => {
    const empty = await openEphemeralDatabase();
    try {
      await expect(applySeed(empty.db)).rejects.toThrow(/db:migrate/i);
    } finally {
      await empty.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Integrity constraints
// ---------------------------------------------------------------------------

/**
 * One case per CHECK constraint over a status or enum column. Each lists the
 * TypeScript union its values must match, and the invalid value the database
 * must refuse.
 */
const CHECK_CASES: ReadonlyArray<{ label: string; sql: string; invalid: string }> = [
  {
    label: 'events.status',
    sql: "update events set status = ? where id = 'evt_glass_hearts_nov'",
    invalid: 'on-sale',
  },
  {
    label: 'events.age_restriction',
    sql: "update events set age_restriction = ? where id = 'evt_glass_hearts_nov'",
    invalid: '21-plus',
  },
  {
    label: 'ticket_types.visibility',
    sql: "update ticket_types set visibility = ? where id = 'tt_gh_ga'",
    invalid: 'private',
  },
  {
    label: 'orders.status',
    sql: 'update orders set status = ? where id = (select id from orders order by id limit 1)',
    invalid: 'captured',
  },
  {
    label: 'orders.payment_provider',
    sql: 'update orders set payment_provider = ? where id = (select id from orders order by id limit 1)',
    invalid: 'stripe',
  },
  {
    label: 'tickets.status',
    sql: 'update tickets set status = ? where id = (select id from tickets order by id limit 1)',
    invalid: 'scanned',
  },
  {
    label: 'checkins.method',
    sql: 'update checkins set method = ? where id = (select id from checkins order by id limit 1)',
    invalid: 'nfc',
  },
  {
    label: 'media_assets.role',
    sql: "update media_assets set role = ? where id = 'med_og_default'",
    invalid: 'banner',
  },
  {
    label: 'social_posts.network',
    sql: 'update social_posts set network = ? where id = (select id from social_posts order by id limit 1)',
    invalid: 'myspace',
  },
  {
    label: 'enquiries.kind',
    sql: 'update enquiries set kind = ? where id = (select id from enquiries order by id limit 1)',
    invalid: 'band',
  },
  {
    label: 'enquiries.status',
    sql: 'update enquiries set status = ? where id = (select id from enquiries order by id limit 1)',
    invalid: 'ignored',
  },
  {
    label: 'mailing_list.status',
    sql: 'update mailing_list set status = ? where id = (select id from mailing_list order by id limit 1)',
    invalid: 'deleted',
  },
];

describe('integrity constraints', () => {
  let db: D1Database;

  beforeAll(() => {
    db = sharedDb;
  });

  it('has foreign keys switched on and enforces them', async () => {
    const pragma = await db.prepare('pragma foreign_keys').all<{ foreign_keys: number }>();
    expect(pragma.results).toEqual([{ foreign_keys: 1 }]);

    await expect(
      db
        .prepare(
          'insert into tickets (id, order_id, event_id, ticket_type_id, reference, status, is_guest_list, issued_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind('tkt_fk_probe', 'ord_does_not_exist', 'evt_glass_hearts_nov', 'tt_gh_ga', 'AMP-FK-1', 'issued', 0, new Date().toISOString())
        .run(),
    ).rejects.toThrow(/foreign key/i);

    await expect(
      db
        .prepare(
          'insert into events (id, title, slug, status, description, venue_id, doors_at, starts_at, age_restriction, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind('evt_fk_probe', 'Probe', 'probe-event', 'draft', 'Probe', 'ven_does_not_exist', new Date().toISOString(), new Date().toISOString(), 'all-ages', new Date().toISOString(), new Date().toISOString())
        .run(),
    ).rejects.toThrow(/foreign key/i);
  });

  it.each(CHECK_CASES)('rejects an invalid $label', async ({ sql, invalid }) => {
    await expect(db.prepare(sql).bind(invalid).run()).rejects.toThrow(/constraint/i);
  });

  it('refuses to hard-delete an event that has orders', async () => {
    await expect(
      db.prepare('delete from events where id = ?').bind('evt_glass_hearts_nov').run(),
    ).rejects.toThrow(/foreign key|constraint/i);

    const still = await db
      .prepare('select count(*) as n from events where id = ?')
      .bind('evt_glass_hearts_nov')
      .first<{ n: number }>();
    expect(still?.n).toBe(1);
  });

  it('allows an event with no orders to be deleted, so RESTRICT is not blanket', async () => {
    const stamp = new Date().toISOString();
    const eventId = 'evt_restrict_probe';
    const orderId = 'ord_restrict_probe';

    await db
      .prepare(
        'insert into events (id, title, slug, status, description, venue_id, doors_at, starts_at, age_restriction, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(eventId, 'RESTRICT probe', 'restrict-probe', 'draft', 'Probe', 'ven_lomax', stamp, stamp, 'all-ages', stamp, stamp)
      .run();

    // A bare draft deletes cleanly - which is the sibling rule in R8.
    await db.prepare('delete from events where id = ?').bind(eventId).run();

    await db
      .prepare(
        'insert into events (id, title, slug, status, description, venue_id, doors_at, starts_at, age_restriction, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(eventId, 'RESTRICT probe', 'restrict-probe', 'draft', 'Probe', 'ven_lomax', stamp, stamp, 'all-ages', stamp, stamp)
      .run();

    await db
      .prepare(
        'insert into orders (id, reference, event_id, customer_name, customer_email, status, total_in_pence, fee_in_pence, marketing_opt_in, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(orderId, 'AMP-99-99001', eventId, 'Probe Buyer', 'probe@example.com', 'pending', 0, 0, 0, stamp, stamp)
      .run();

    await expect(
      db.prepare('delete from events where id = ?').bind(eventId).run(),
    ).rejects.toThrow(/foreign key|constraint/i);

    // Deleting the order releases the event, proving the refusal is the FK.
    await db.prepare('delete from orders where id = ?').bind(orderId).run();
    await db.prepare('delete from events where id = ?').bind(eventId).run();

    const remaining = await db
      .prepare('select count(*) as n from events where id = ?')
      .bind(eventId)
      .first<{ n: number }>();
    expect(remaining?.n).toBe(0);
  });

  it('rejects a duplicate event slug', async () => {
    const stamp = new Date().toISOString();
    await expect(
      db
        .prepare(
          'insert into events (id, title, slug, status, description, venue_id, doors_at, starts_at, age_restriction, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind('evt_slug_probe', 'Duplicate', 'the-glass-hearts-lomax-rooms', 'draft', 'Duplicate', 'ven_lomax', stamp, stamp, 'all-ages', stamp, stamp)
        .run(),
    ).rejects.toThrow(/unique/i);
  });

  it('rejects a duplicate order reference', async () => {
    const existing = await db
      .prepare('select reference from orders order by reference limit 1')
      .first<{ reference: string }>();
    expect(existing).not.toBeNull();

    const stamp = new Date().toISOString();
    await expect(
      db
        .prepare(
          'insert into orders (id, reference, event_id, customer_name, customer_email, status, total_in_pence, fee_in_pence, marketing_opt_in, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind('ord_reference_probe', existing!.reference, 'evt_glass_hearts_nov', 'Duplicate', 'dup@example.com', 'pending', 0, 0, 0, stamp, stamp)
        .run(),
    ).rejects.toThrow(/unique/i);
  });

  it('rejects a duplicate ticket reference', async () => {
    const existing = await db
      .prepare('select id, order_id, event_id, ticket_type_id, reference, issued_at from tickets order by reference limit 1')
      .first<{ order_id: string; event_id: string; ticket_type_id: string; reference: string; issued_at: string }>();
    expect(existing).not.toBeNull();

    await expect(
      db
        .prepare(
          'insert into tickets (id, order_id, event_id, ticket_type_id, reference, status, is_guest_list, issued_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind('tkt_reference_probe', existing!.order_id, existing!.event_id, existing!.ticket_type_id, existing!.reference, 'issued', 0, existing!.issued_at)
        .run(),
    ).rejects.toThrow(/unique/i);
  });

  it('rejects a second check-in for the same ticket', async () => {
    const existing = await db
      .prepare('select ticket_id, event_id, operator_email, scanned_at from checkins order by id limit 1')
      .first<{ ticket_id: string; event_id: string; operator_email: string; scanned_at: string }>();
    expect(existing).not.toBeNull();

    await expect(
      db
        .prepare(
          'insert into checkins (id, ticket_id, event_id, operator_email, method, scanned_at) values (?, ?, ?, ?, ?, ?)',
        )
        .bind('chk_duplicate_probe', existing!.ticket_id, existing!.event_id, existing!.operator_email, 'manual', existing!.scanned_at)
        .run(),
    ).rejects.toThrow(/unique/i);
  });

  it('stores money as integer pence and refuses a float', async () => {
    const types = await db
      .prepare("select count(*) as n from ticket_types where typeof(price_in_pence) <> 'integer'")
      .first<{ n: number }>();
    expect(types?.n).toBe(0);

    await expect(
      db.prepare('update ticket_types set price_in_pence = ? where id = ?').bind(7.5, 'tt_gh_ga').run(),
    ).rejects.toThrow(/constraint|integer/i);

    const orders = await db
      .prepare(
        "select count(*) as n from orders where typeof(total_in_pence) <> 'integer' or typeof(fee_in_pence) <> 'integer'",
      )
      .first<{ n: number }>();
    expect(orders?.n).toBe(0);
  });

  it('refuses a timestamp that is not canonical ISO-8601 UTC', async () => {
    await expect(
      db
        .prepare('update ticket_types set sales_open_at = ? where id = ?')
        .bind('2026-01-01T10:00:00Z', 'tt_gh_early')
        .run(),
    ).rejects.toThrow(/constraint/i);

    await expect(
      db
        .prepare('update events set starts_at = ? where id = ?')
        .bind('not a timestamp', 'evt_glass_hearts_nov')
        .run(),
    ).rejects.toThrow(/constraint/i);
  });

  it('refuses a boolean that is not 0 or 1', async () => {
    await expect(
      db
        .prepare('update tickets set is_guest_list = ? where id = (select id from tickets order by id limit 1)')
        .bind(2)
        .run(),
    ).rejects.toThrow(/constraint/i);
  });

  it('refuses a cancelled event with no customer-facing notice', async () => {
    await expect(
      db.prepare('update events set status = ? where id = ?').bind('cancelled', 'evt_glass_hearts_nov').run(),
    ).rejects.toThrow(/constraint/i);
  });

  it('refuses an image with blank alt text', async () => {
    await expect(
      db.prepare('update media_assets set alt = ? where id = ?').bind('   ', 'med_og_default').run(),
    ).rejects.toThrow(/constraint/i);
  });

  it('refuses a paid order with no payment time', async () => {
    await expect(
      db
        .prepare('update orders set paid_at = null where id = (select id from orders where status = ? order by id limit 1)')
        .bind('paid')
        .run(),
    ).rejects.toThrow(/constraint/i);
  });

  it('refuses an awaiting_payment order with no reservation window', async () => {
    await expect(
      db
        .prepare('update orders set reservation_expires_at = null where id = (select id from orders where status = ? order by id limit 1)')
        .bind('awaiting_payment')
        .run(),
    ).rejects.toThrow(/constraint/i);
  });

  it('refuses a ticket type whose sales close before they open', async () => {
    await expect(
      db
        .prepare('update ticket_types set sales_open_at = ?, sales_close_at = ? where id = ?')
        .bind('2026-06-01T10:00:00.000Z', '2026-05-01T10:00:00.000Z', 'tt_gh_ga')
        .run(),
    ).rejects.toThrow(/constraint/i);
  });

  it('enforces the schema_migrations ledger shape', async () => {
    const stamp = new Date().toISOString();

    // The id is the primary key: one ledger row per migration, for ever.
    await expect(
      db
        .prepare('insert into schema_migrations (id, name, checksum, applied_at) values (?, ?, ?, ?)')
        .bind('0001', 'duplicate', 'bogus', stamp)
        .run(),
    ).rejects.toThrow(/unique|constraint/i);

    // applied_at obeys the same ISO-8601 UTC rule as every other timestamp.
    await expect(
      db
        .prepare('insert into schema_migrations (id, name, checksum, applied_at) values (?, ?, ?, ?)')
        .bind('9000', 'bogus', 'bogus', '2026-01-01')
        .run(),
    ).rejects.toThrow(/constraint/i);

    const ledger = await db
      .prepare('select count(*) as n from schema_migrations')
      .first<{ n: number }>();
    expect(ledger?.n).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

/** The protections the build plan names, and the table each one covers. */
const REQUIRED_INDEXES: ReadonlyArray<{ name: string; table: string; unique: boolean }> = [
  { name: 'events_status_starts_at_idx', table: 'events', unique: false },
  { name: 'events_slug_unique', table: 'events', unique: true },
  { name: 'ticket_types_event_id_idx', table: 'ticket_types', unique: false },
  { name: 'orders_event_id_idx', table: 'orders', unique: false },
  { name: 'orders_reference_unique', table: 'orders', unique: true },
  { name: 'tickets_order_id_idx', table: 'tickets', unique: false },
  { name: 'tickets_reference_unique', table: 'tickets', unique: true },
  { name: 'checkins_ticket_id_unique', table: 'checkins', unique: true },
  { name: 'mailing_list_email_unique', table: 'mailing_list', unique: true },
];

describe('indexes', () => {
  let database: TestDatabase;
  let db: D1Database;

  beforeAll(async () => {
    database = await openEphemeralDatabase();
    db = database.db;
    await migrate(db);
  });

  afterAll(async () => {
    await database.dispose();
  });

  it.each(REQUIRED_INDEXES)('has $name on $table', async ({ name, table, unique }) => {
    const index = (await namedIndexes(db)).find((row) => row.name === name);

    expect(index, `missing index ${name}`).toBeDefined();
    expect(index?.tbl_name).toBe(table);
    if (unique) {
      expect(index?.sql?.toLowerCase()).toContain('unique index');
    }
  });

  it('indexes the columns later slices read, and nothing speculative', async () => {
    const indexes = (await namedIndexes(db)).map((row) => row.name);
    // 25 named indexes plus the ledger's primary key index. The list is
    // asserted in full so that a speculative index is a deliberate edit.
    expect(indexes).toEqual([
      'artists_slug_unique',
      'audit_log_occurred_at_idx',
      'checkins_event_id_idx',
      'checkins_ticket_id_unique',
      'enquiries_status_received_at_idx',
      'event_artists_artist_id_idx',
      'events_slug_unique',
      'events_status_starts_at_idx',
      'mailing_list_email_unique',
      'media_assets_artist_id_idx',
      'media_assets_event_id_idx',
      'media_assets_storage_key_unique',
      'order_items_order_id_idx',
      'order_items_ticket_type_id_idx',
      'orders_event_id_idx',
      'orders_reference_unique',
      'processed_webhooks_provider_event_unique',
      'social_posts_event_id_idx',
      'social_posts_featured_idx',
      'ticket_types_event_id_idx',
      'tickets_event_id_idx',
      'tickets_order_id_idx',
      'tickets_reference_unique',
      'tickets_ticket_type_status_idx',
      'venues_slug_unique',
    ]);
  });
});
