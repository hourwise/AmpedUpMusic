/**
 * AMPED-05C0 - social featured ordering representation.
 *
 * Adds `social_posts.featured_position` and nothing else. These tests prove the
 * column exists with the right constraint, that existing curated posts are
 * untouched and NULL, that both foreign keys still work, and that nothing about
 * the current social reads or homepage order has changed yet.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { openEphemeralDatabase } from '../src/db/local.ts';
import { migrate, readAppliedMigrations } from '../src/db/migrations.ts';
import { applySeed } from '../src/db/seed.ts';
import { createD1SocialService } from '../src/services/d1/social.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe('AMPED-05C0 social featured ordering foundation', () => {
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

  it('applies 0009 after the accepted migrations', async () => {
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

  it('adds a nullable non-negative integer column', async () => {
    const columns = await db.prepare('pragma table_info(social_posts)').all<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>();
    const column = columns.results.find((entry) => entry.name === 'featured_position');

    expect(column).toBeDefined();
    expect(column?.type).toBe('INTEGER');
    expect(column?.notnull).toBe(0);
    expect(column?.dflt_value).toBeNull();
  });

  it('migrates every existing social post with a NULL position and intact data', async () => {
    const rows = await db
      .prepare(
        'select count(*) as total, sum(case when featured_position is null then 1 else 0 end) as unset from social_posts',
      )
      .first<{ total: number; unset: number }>();
    expect(rows?.total).toBe(6);
    expect(rows?.unset).toBe(6);
  });

  it('accepts NULL, zero and positive integers, and refuses negatives or non-integers', async () => {
    const id = (await db.prepare('select id from social_posts order by id limit 1').first<{ id: string }>())!.id;

    await db.prepare('update social_posts set featured_position = null where id = ?').bind(id).run();
    await db.prepare('update social_posts set featured_position = 0 where id = ?').bind(id).run();
    await db.prepare('update social_posts set featured_position = 4 where id = ?').bind(id).run();

    const row = await db
      .prepare('select featured_position from social_posts where id = ?')
      .bind(id)
      .first<{ featured_position: number | null }>();
    expect(row?.featured_position).toBe(4);

    await expect(
      db.prepare('update social_posts set featured_position = -1 where id = ?').bind(id).run(),
    ).rejects.toThrow(/constraint/i);

    await expect(
      db.prepare('update social_posts set featured_position = 2.5 where id = ?').bind(id).run(),
    ).rejects.toThrow(/constraint|datatype/i);

    await db.prepare('update social_posts set featured_position = null where id = ?').bind(id).run();
  });

  it('does not disturb identity, curated fields or associations when a position is set', async () => {
    const target = (await db
      .prepare("select id from social_posts where event_id is not null and thumbnail_asset_id is not null order by id limit 1")
      .first<{ id: string }>())!.id;

    const before = await db
      .prepare('select * from social_posts where id = ?')
      .bind(target)
      .first<Record<string, unknown>>();
    expect(before?.event_id).not.toBeNull();
    expect(before?.thumbnail_asset_id).not.toBeNull();

    await db.prepare('update social_posts set featured_position = 3 where id = ?').bind(target).run();

    const after = await db
      .prepare('select * from social_posts where id = ?')
      .bind(target)
      .first<Record<string, unknown>>();

    expect({ ...after, featured_position: before?.featured_position }).toEqual(before);
    expect(after?.id).toBe(before?.id);
    expect(after?.url).toBe(before?.url);
    expect(after?.network).toBe(before?.network);
    expect(after?.caption).toBe(before?.caption);
    expect(after?.featured).toBe(before?.featured);
    expect(after?.event_id).toBe(before?.event_id);
    expect(after?.thumbnail_asset_id).toBe(before?.thumbnail_asset_id);

    await db.prepare('update social_posts set featured_position = null where id = ?').bind(target).run();
  });

  it('keeps both foreign keys functional', async () => {
    const id = (await db.prepare('select id from social_posts order by id limit 1').first<{ id: string }>())!.id;

    // Existing event and thumbnail references still resolve.
    const linked = await db
      .prepare(
        `select
           (select count(*) from events e where e.id = s.event_id) as event_ok,
           (select count(*) from media_assets m where m.id = s.thumbnail_asset_id) as thumb_ok
         from social_posts s where s.id = ?`,
      )
      .bind(id)
      .first<{ event_ok: number; thumb_ok: number }>();
    expect(linked?.event_ok).toBeGreaterThan(0);
    expect(linked?.thumb_ok).toBeGreaterThan(0);

    // Unknown references are still refused.
    await expect(
      db.prepare('update social_posts set event_id = ? where id = ?').bind('evt_not_real', id).run(),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      db.prepare('update social_posts set thumbnail_asset_id = ? where id = ?').bind('med_not_real', id).run(),
    ).rejects.toThrow(/foreign key/i);
  });

  it('leaves the current featured read order exactly as it was', async () => {
    const social = createD1SocialService(db);
    const baseline = (await social.listFeatured()).map((view) => view.post.id);
    expect(baseline.length).toBeGreaterThan(0);

    // Setting positions must not change today's id-ordered read.
    await db.prepare("update social_posts set featured_position = 99 where id = ?").bind(baseline[0]!).run();
    const after = (await social.listFeatured()).map((view) => view.post.id);
    expect(after).toEqual(baseline);

    await db.prepare('update social_posts set featured_position = null where id = ?').bind(baseline[0]!).run();
  });
});
