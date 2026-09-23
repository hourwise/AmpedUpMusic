/**
 * AMPED-04C0 - artist/venue archival representation.
 *
 * This slice adds the *state* only. It proves the schema can carry `archived_at`
 * with the same canonical-UTC integrity as every other timestamp, that existing
 * rows are untouched and active, and that archiving an entity severs nothing:
 * the events and line-ups that reference it keep working exactly as before.
 *
 * No behavioural filtering is asserted here on purpose - AMPED-04C owns the use
 * of the field. An archived artist is still returned by the current read
 * services, which is what makes the zero-behaviour-change claim checkable.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { openEphemeralDatabase } from '../src/db/local.ts';
import { migrate, readAppliedMigrations } from '../src/db/migrations.ts';
import { applySeed } from '../src/db/seed.ts';
import { createServices } from '../src/services/index.ts';
import type { Artist, Venue } from '../src/types/domain.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const CANONICAL = '2026-09-21T09:30:00.000Z';

interface ColumnRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

describe('AMPED-04C0 artist and venue archival state', () => {
  let database: Awaited<ReturnType<typeof openEphemeralDatabase>>;
  let db: D1Database;

  beforeAll(async () => {
    database = await openEphemeralDatabase();
    db = database.db;
    await migrate(db);
    await applySeed(db);
  });

  afterAll(async () => {
    await database.dispose();
  });

  async function columns(table: 'artists' | 'venues'): Promise<ColumnRow[]> {
    const result = await db.prepare(`pragma table_info(${table})`).all<ColumnRow>();
    return result.results;
  }

  // -- migration -------------------------------------------------------------

  it('applies 0007 after the accepted migrations and records it', async () => {
    const applied = await readAppliedMigrations(db);
    expect(applied.map((row) => row.id)).toEqual([
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
    expect(applied[applied.length - 1]?.name).toBe('0009_social_featured_ordering.sql');
  });

  it('is a no-op when run again', async () => {
    const before = await readAppliedMigrations(db);
    const second = await migrate(db);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toHaveLength(9);
    expect(await readAppliedMigrations(db)).toEqual(before);
  });

  it('adds a nullable canonical-timestamp archived_at to both entities', async () => {
    for (const table of ['artists', 'venues'] as const) {
      const column = (await columns(table)).find((entry) => entry.name === 'archived_at');
      expect(column, `${table}.archived_at`).toBeDefined();
      expect(column?.type).toBe('TEXT');
      expect(column?.notnull).toBe(0);
      expect(column?.dflt_value).toBeNull();
    }
  });

  // -- existing data ---------------------------------------------------------

  it('leaves existing data intact and active', async () => {
    const counts = await db
      .prepare(
        `select
           (select count(*) from venues) as venues,
           (select count(*) from artists) as artists,
           (select count(*) from events) as events,
           (select count(*) from event_artists) as event_artists,
           (select count(*) from venues where archived_at is not null) as archived_venues,
           (select count(*) from artists where archived_at is not null) as archived_artists`,
      )
      .first<Record<string, number>>();

    expect(counts).toEqual({
      venues: 4,
      artists: 10,
      events: 12,
      event_artists: 27,
      archived_venues: 0,
      archived_artists: 0,
    });
  });

  // -- timestamp integrity ---------------------------------------------------

  it('accepts a canonical UTC archive timestamp for an artist', async () => {
    await db
      .prepare('update artists set archived_at = ? where id = ?')
      .bind(CANONICAL, 'art_glass_hearts')
      .run();
    const row = await db
      .prepare('select archived_at from artists where id = ?')
      .bind('art_glass_hearts')
      .first<{ archived_at: string }>();
    expect(row?.archived_at).toBe(CANONICAL);
  });

  it('accepts a canonical UTC archive timestamp for a venue', async () => {
    await db
      .prepare('update venues set archived_at = ? where id = ?')
      .bind(CANONICAL, 'ven_lomax')
      .run();
    const row = await db
      .prepare('select archived_at from venues where id = ?')
      .bind('ven_lomax')
      .first<{ archived_at: string }>();
    expect(row?.archived_at).toBe(CANONICAL);
  });

  it('rejects a noncanonical archive timestamp', async () => {
    for (const bad of ['2026-09-21', '2026-09-21T09:30:00Z', 'not a timestamp']) {
      await expect(
        db
          .prepare('update artists set archived_at = ? where id = ?')
          .bind(bad, 'art_mara_veil')
          .run(),
        bad,
      ).rejects.toThrow(/constraint/i);
      await expect(
        db
          .prepare('update venues set archived_at = ? where id = ?')
          .bind(bad, 'ven_ironworks')
          .run(),
        bad,
      ).rejects.toThrow(/constraint/i);
    }
  });

  // -- historical integrity --------------------------------------------------

  it('keeps every event and line-up reference when an artist is archived', async () => {
    const lineupCount = await db
      .prepare('select count(*) as n from event_artists where artist_id = ?')
      .bind('art_glass_hearts')
      .first<{ n: number }>();
    expect(lineupCount?.n).toBeGreaterThan(0);

    const stillReferenced = await db
      .prepare(
        'select count(*) as n from event_artists ea join artists a on a.id = ea.artist_id where a.id = ? and a.archived_at is not null',
      )
      .bind('art_glass_hearts')
      .first<{ n: number }>();
    expect(stillReferenced?.n).toBe(lineupCount?.n);
  });

  it('keeps every event reference when a venue is archived', async () => {
    const referencing = await db
      .prepare('select count(*) as n from events where venue_id = ?')
      .bind('ven_lomax')
      .first<{ n: number }>();
    expect(referencing?.n).toBeGreaterThan(0);

    const events = await db
      .prepare('select id from events where venue_id = ? order by id limit 1')
      .bind('ven_lomax')
      .first<{ id: string }>();
    expect(events).not.toBeNull();
  });

  it('breaks no foreign key after archiving', async () => {
    const check = await db.prepare('pragma foreign_key_check').all();
    expect(check.results).toEqual([]);
  });

  it('still renders historical events that reference archived entities', async () => {
    const services = createServices(db);
    const event = await services.events.getBySlug('the-glass-hearts-lomax-rooms');

    expect(event).not.toBeNull();
    expect(event?.venue.id).toBe('ven_lomax');
    expect(event?.lineup.some((entry) => entry.artist.id === 'art_glass_hearts')).toBe(true);
    // No filtering has been added yet: the archived artist is still listed.
    expect((await services.artists.list()).some((artist) => artist.id === 'art_glass_hearts')).toBe(
      true,
    );
  });

  // -- referential rules unchanged -------------------------------------------

  it('still refuses to hard-delete a referenced archived artist or venue', async () => {
    await expect(
      db.prepare('delete from artists where id = ?').bind('art_glass_hearts').run(),
    ).rejects.toThrow(/foreign key|constraint/i);
    await expect(
      db.prepare('delete from venues where id = ?').bind('ven_lomax').run(),
    ).rejects.toThrow(/foreign key|constraint/i);
  });

  it('still allows an unreferenced record to be deleted', async () => {
    const stamp = new Date().toISOString();
    await db
      .prepare(
        'insert into artists (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)',
      )
      .bind('art_probe_unreferenced', 'Probe Unreferenced', 'probe-unreferenced', stamp, stamp)
      .run();

    await db.prepare('delete from artists where id = ?').bind('art_probe_unreferenced').run();
    const gone = await db
      .prepare('select id from artists where id = ?')
      .bind('art_probe_unreferenced')
      .first();
    expect(gone).toBeNull();
  });

  // -- domain representation -------------------------------------------------

  it('lets the Artist and Venue types express archive state', () => {
    const artist: Artist = {
      id: 'art_type_probe',
      name: 'Type Probe',
      slug: 'type-probe',
      links: {},
      archivedAt: CANONICAL,
      createdAt: CANONICAL,
      updatedAt: CANONICAL,
    };
    const venue: Venue = {
      id: 'ven_type_probe',
      name: 'Type Probe Rooms',
      slug: 'type-probe-rooms',
      addressLine1: '1 Probe Street',
      city: 'Preston',
      postcode: 'PR1 1AA',
      archivedAt: CANONICAL,
      createdAt: CANONICAL,
      updatedAt: CANONICAL,
    };

    expect(artist.archivedAt).toBe(CANONICAL);
    expect(venue.archivedAt).toBe(CANONICAL);

    // Active entities simply omit the field, as the fixtures do.
    const activeVenue: Venue = { ...venue, archivedAt: undefined };
    expect(activeVenue.archivedAt).toBeUndefined();
  });
});
