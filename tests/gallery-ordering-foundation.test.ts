/**
 * AMPED-05B0 - gallery ordering representation.
 *
 * This slice adds `media_assets.gallery_position` and nothing else. The tests
 * prove the column exists with the right constraint, that existing media is
 * untouched and NULL, and - importantly - that nothing about ordering has
 * changed yet: gallery reads must still return exactly what they returned
 * before the column existed, even when a position is set.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { openEphemeralDatabase } from '../src/db/local.ts';
import { migrate, readAppliedMigrations } from '../src/db/migrations.ts';
import { applySeed } from '../src/db/seed.ts';
import { createD1MediaService } from '../src/services/d1/media.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe('AMPED-05B0 gallery ordering foundation', () => {
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

  it('applies 0008 after the accepted migrations', async () => {
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
      '0010',
    ]);
    expect(applied[applied.length - 1]?.name).toBe('0010_order_reservation_expiry.sql');
  });

  it('is a no-op when run again', async () => {
    const before = await readAppliedMigrations(db);
    const second = await migrate(db);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toHaveLength(10);
    expect(await readAppliedMigrations(db)).toEqual(before);
  });

  it('adds a nullable non-negative integer column', async () => {
    const columns = await db.prepare('pragma table_info(media_assets)').all<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>();
    const column = columns.results.find((entry) => entry.name === 'gallery_position');

    expect(column).toBeDefined();
    expect(column?.type).toBe('INTEGER');
    expect(column?.notnull).toBe(0);
    expect(column?.dflt_value).toBeNull();
  });

  it('migrated every existing media row with a NULL position and intact identity', async () => {
    const rows = await db
      .prepare(
        'select count(*) as total, sum(case when gallery_position is null then 1 else 0 end) as unset from media_assets',
      )
      .first<{ total: number; unset: number }>();

    expect(rows?.total).toBe(43);
    expect(rows?.unset).toBe(43);
  });

  it('accepts NULL, zero and positive integers, and refuses negatives or non-integers', async () => {
    const id = 'med_og_default';

    await db.prepare('update media_assets set gallery_position = null where id = ?').bind(id).run();
    await db.prepare('update media_assets set gallery_position = 0 where id = ?').bind(id).run();
    await db.prepare('update media_assets set gallery_position = 7 where id = ?').bind(id).run();

    const row = await db
      .prepare('select gallery_position from media_assets where id = ?')
      .bind(id)
      .first<{ gallery_position: number | null }>();
    expect(row?.gallery_position).toBe(7);

    await expect(
      db.prepare('update media_assets set gallery_position = -1 where id = ?').bind(id).run(),
    ).rejects.toThrow(/constraint/i);

    // STRICT table: a fractional value is not a lossless integer.
    await expect(
      db.prepare('update media_assets set gallery_position = 1.5 where id = ?').bind(id).run(),
    ).rejects.toThrow(/constraint|datatype/i);

    await db.prepare('update media_assets set gallery_position = null where id = ?').bind(id).run();
  });

  it('does not disturb identity, associations or pointers when a position is set', async () => {
    const target = 'med_gal_01';
    const before = await db
      .prepare('select * from media_assets where id = ?')
      .bind(target)
      .first<Record<string, unknown>>();
    const posterBefore = await db
      .prepare("select poster_asset_id, hero_asset_id from events where id = 'evt_hollow_coast_past'")
      .first<{ poster_asset_id: string | null; hero_asset_id: string | null }>();

    await db.prepare('update media_assets set gallery_position = 3 where id = ?').bind(target).run();

    const after = await db
      .prepare('select * from media_assets where id = ?')
      .bind(target)
      .first<Record<string, unknown>>();

    expect({ ...after, gallery_position: before?.gallery_position }).toEqual(before);
    expect(after?.id).toBe(before?.id);
    expect(after?.storage_key).toBe(before?.storage_key);
    expect(after?.url).toBe(before?.url);
    expect(after?.event_id).toBe(before?.event_id);
    expect(after?.artist_id).toBe(before?.artist_id);

    const posterAfter = await db
      .prepare("select poster_asset_id, hero_asset_id from events where id = 'evt_hollow_coast_past'")
      .first<{ poster_asset_id: string | null; hero_asset_id: string | null }>();
    expect(posterAfter).toEqual(posterBefore);

    // The pointer still resolves to a real asset.
    const poster = await db
      .prepare('select id from media_assets where id = ?')
      .bind(posterAfter?.poster_asset_id ?? '')
      .first();
    expect(poster).not.toBeNull();

    await db.prepare('update media_assets set gallery_position = null where id = ?').bind(target).run();
  });

  it('keeps the legacy order while every position is NULL', async () => {
    // AMPED-05B now honours gallery_position, so this foundation assertion is
    // about the NULL baseline only: with no explicit positions the read order
    // is exactly the id order the site always used.
    const media = createD1MediaService(db);
    await db.prepare('update media_assets set gallery_position = null').run();

    const baseline = await media.listGallery();
    expect(baseline.length).toBeGreaterThan(0);

    const perEvent = new Map<string, string[]>();
    for (const asset of baseline) {
      const key = asset.eventId ?? '';
      const list = perEvent.get(key) ?? [];
      list.push(asset.id);
      perEvent.set(key, list);
    }
    for (const ids of perEvent.values()) {
      expect(ids).toEqual([...ids].sort());
    }
  });

  it('orders a gallery by the persisted position once one is set', async () => {
    const media = createD1MediaService(db);
    await db
      .prepare("update media_assets set gallery_position = 2 where id = 'med_gal_01'")
      .run();
    await db
      .prepare("update media_assets set gallery_position = 0 where id = 'med_gal_02'")
      .run();

    const ordered = (await media.listGallery())
      .filter((asset) => asset.eventId === 'evt_hollow_coast_past')
      .map((asset) => asset.id);

    // Positioned rows come first in ascending order; the NULL row follows.
    expect(ordered[0]).toBe('med_gal_02');
    expect(ordered[1]).toBe('med_gal_01');
    expect(ordered).toContain('med_gal_03');

    await db
      .prepare("update media_assets set gallery_position = null where id in ('med_gal_01','med_gal_02')")
      .run();
  });
});
