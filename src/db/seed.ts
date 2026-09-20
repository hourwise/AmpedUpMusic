/**
 * The local seed: rows equivalent to the AMPED-01 scaffold fixtures.
 *
 * Order matters, and it is the order in this file rather than something the
 * database works out:
 *
 *   1. venues, artists, events, line-ups and ticket types - the diary. Artists
 *      and events are written without their artwork columns, because the media
 *      rows do not exist yet.
 *   2. media_assets - which reference the events and artists from step 1.
 *   3. the artwork columns, now that they can be satisfied.
 *   4. orders, order items, tickets and check-ins - tickets exist only for paid
 *      orders, so `sold` (issued + checked_in) and `reserved` (held by an
 *      unexpired awaiting_payment order) never double count.
 *   5. social posts, enquiries, the mailing list and the audit log.
 *
 * `buildSeedBatches` is a pure function of a timestamp, so the dataset can be
 * inspected and asserted without touching a database; `applySeed` is the only
 * part that writes, and it writes one bound JSON payload per table (see
 * ./seed-sql.ts for why).
 *
 * The seed refuses to run against a database that already holds seeded rows.
 * It is not idempotent by design: half-updating a promotional diary in place is
 * a worse outcome than being told to reset. `npm run db:reset` then
 * `npm run db:seed` is the supported path.
 */

import { listTables } from './local.ts';
import {
  buildArtistImageLinks,
  buildAuditLogRows,
  buildEnquiryRows,
  buildEventArtwork,
  buildMediaRows,
  buildSocialPostRows,
  buildSubscriberRows,
} from './seed-content.ts';
import { buildOrderRows } from './seed-orders.ts';
import { buildReferenceRows } from './seed-reference.ts';
import {
  INSERT_ARTIST,
  INSERT_AUDIT_LOG,
  INSERT_CHECKIN,
  INSERT_ENQUIRY,
  INSERT_EVENT,
  INSERT_EVENT_ARTIST,
  INSERT_MAILING_LIST,
  INSERT_MEDIA_ASSET,
  INSERT_ORDER,
  INSERT_ORDER_ITEM,
  INSERT_SOCIAL_POST,
  INSERT_TICKET,
  INSERT_TICKET_TYPE,
  INSERT_VENUE,
  UPDATE_ARTIST_IMAGE,
  UPDATE_EVENT_ARTWORK,
  type BulkStatement,
} from './seed-sql.ts';

/** One table's worth of rows and the statement that writes them. */
export interface SeedBatch {
  /** Human-readable label for the CLI output, e.g. "media_assets". */
  label: string;
  /** Inserts are column-aligned against a row shape; updates are not. */
  mode: 'insert' | 'update';
  sql: string;
  rows: readonly unknown[];
}

/** Rows seeded per table, for reporting and for the tests. */
export type SeedCounts = Record<string, number>;

export interface SeedResult {
  counts: SeedCounts;
  totalRows: number;
  statements: number;
}

function batch<T>(
  label: string,
  mode: SeedBatch['mode'],
  spec: BulkStatement<T>,
  rows: T[],
): SeedBatch {
  return { label, mode, sql: spec.sql, rows: spec.rows(rows) };
}

/**
 * Every seeded row, in dependency order. Pure: no database, no clock reads.
 */
export function buildSeedBatches(now: Date): SeedBatch[] {
  const epoch = now.toISOString();
  const reference = buildReferenceRows(now);
  const { orders, orderItems, tickets, checkins } = buildOrderRows(now, reference.ticketTypes);

  return [
    batch('venues', 'insert', INSERT_VENUE, reference.venues),
    batch('artists', 'insert', INSERT_ARTIST, reference.artists),
    batch('events', 'insert', INSERT_EVENT, reference.events),
    batch('event_artists', 'insert', INSERT_EVENT_ARTIST, reference.eventArtists),
    batch('ticket_types', 'insert', INSERT_TICKET_TYPE, reference.ticketTypes),
    batch('media_assets', 'insert', INSERT_MEDIA_ASSET, buildMediaRows(epoch)),
    batch('artists.image_asset_id', 'update', UPDATE_ARTIST_IMAGE, buildArtistImageLinks()),
    batch('events.poster_asset_id', 'update', UPDATE_EVENT_ARTWORK, buildEventArtwork()),
    batch('orders', 'insert', INSERT_ORDER, orders),
    batch('order_items', 'insert', INSERT_ORDER_ITEM, orderItems),
    batch('tickets', 'insert', INSERT_TICKET, tickets),
    batch('checkins', 'insert', INSERT_CHECKIN, checkins),
    batch('social_posts', 'insert', INSERT_SOCIAL_POST, buildSocialPostRows(now)),
    batch('enquiries', 'insert', INSERT_ENQUIRY, buildEnquiryRows(now)),
    batch('mailing_list', 'insert', INSERT_MAILING_LIST, buildSubscriberRows(now)),
    batch('audit_log', 'insert', INSERT_AUDIT_LOG, buildAuditLogRows(now)),
  ];
}

/** Total seeded rows across every table the seed writes to. */
const COUNT_SEEDED_ROWS_SQL = `
  select
    (select count(*) from venues) +
    (select count(*) from artists) +
    (select count(*) from events) +
    (select count(*) from event_artists) +
    (select count(*) from ticket_types) +
    (select count(*) from media_assets) +
    (select count(*) from orders) +
    (select count(*) from order_items) +
    (select count(*) from tickets) +
    (select count(*) from checkins) +
    (select count(*) from social_posts) +
    (select count(*) from enquiries) +
    (select count(*) from mailing_list) +
    (select count(*) from audit_log) as total
`;

/** Tables the seed writes to; used to tell "not migrated" from "not seeded". */
const SEEDED_TABLES = [
  'venues',
  'artists',
  'events',
  'event_artists',
  'ticket_types',
  'media_assets',
  'orders',
  'order_items',
  'tickets',
  'checkins',
  'social_posts',
  'enquiries',
  'mailing_list',
  'audit_log',
] as const;

export interface SeedOptions {
  /**
   * Rows per bound payload. The whole dataset fits in one payload per table in
   * practice; the cap only exists so that a much larger seed cannot post an
   * unreasonably large statement.
   */
  chunkSize?: number;
  /** Clock injection, so a test can seed a fixed day. */
  now?: Date;
}

/**
 * Write the seed data.
 *
 * Throws if the schema is missing, or if the database already holds seeded
 * rows - see the file header for why that is deliberate.
 */
export async function applySeed(db: D1Database, options: SeedOptions = {}): Promise<SeedResult> {
  const { chunkSize = 2_000, now = new Date() } = options;

  const tables = await listTables(db);
  const missing = SEEDED_TABLES.filter((table) => !tables.includes(table));
  if (missing.length > 0) {
    throw new Error(
      `The database is missing ${missing.join(', ')}. Run "npm run db:migrate" first.`,
    );
  }

  const existing = await db.prepare(COUNT_SEEDED_ROWS_SQL).all<{ total: number }>();
  const total = existing.results[0]?.total ?? 0;
  if (total > 0) {
    throw new Error(
      `The database already holds ${total} seeded rows. ` +
        'Run "npm run db:reset" and "npm run db:migrate" first if you want a fresh copy.',
    );
  }

  const batches = buildSeedBatches(now);
  const counts: SeedCounts = {};
  let statements = 0;

  for (const seedBatch of batches) {
    counts[seedBatch.label] = seedBatch.rows.length;

    for (let start = 0; start < seedBatch.rows.length; start += chunkSize) {
      const slice = seedBatch.rows.slice(start, start + chunkSize);
      await db.prepare(seedBatch.sql).bind(JSON.stringify(slice)).run();
      statements += 1;
    }
  }

  return { counts, totalRows: Object.values(counts).reduce((sum, n) => sum + n, 0), statements };
}
