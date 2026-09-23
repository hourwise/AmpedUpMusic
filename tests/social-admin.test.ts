/**
 * AMPED-05C - curated social post management.
 *
 * Service-level tests against an isolated seeded D1: legacy featured
 * normalisation, create/edit/delete, feature/unfeature, explicit reorder,
 * thumbnail and event association, audit, and the privacy rule that a draft
 * event's title never enriches the public featured read. Payload validation and
 * the no-network guarantee are checked directly.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { openEphemeralDatabase } from '../src/db/local.ts';
import { migrate } from '../src/db/migrations.ts';
import { applySeed } from '../src/db/seed.ts';
import { createD1SocialMutations, createD1SocialService, parseSocialPayload } from '../src/services/d1/social.ts';
import { ConflictError, NotFoundError, ValidationError } from '../src/lib/validation.ts';
import { isProtectedPath } from '../src/lib/access.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OPERATOR = { email: 'anya@ampedupmusicpromo.co.uk', sub: 'access-subject-1' };

describe('AMPED-05C social payload validation', () => {
  it('requires a real http(s) URL and a known network', () => {
    expect(parseSocialPayload({ url: '', network: 'instagram' }).ok).toBe(false);
    expect(parseSocialPayload({ url: 'not a url', network: 'instagram' }).ok).toBe(false);
    expect(parseSocialPayload({ url: 'javascript:alert(1)', network: 'instagram' }).ok).toBe(false);
    expect(parseSocialPayload({ url: 'data:text/html,<script>', network: 'instagram' }).ok).toBe(false);
    expect(parseSocialPayload({ url: 'https://example.com/x', network: 'myspace' }).ok).toBe(false);
    expect(parseSocialPayload({ url: 'https://example.com/x', network: 'instagram' }).ok).toBe(true);
  });

  it('rejects unknown fields and over-long captions', () => {
    const unknown = parseSocialPayload({
      url: 'https://example.com/x',
      network: 'instagram',
      featuredPosition: 3,
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.fields.featuredPosition).toBe('Unsupported field.');

    const long = parseSocialPayload({
      url: 'https://example.com/x',
      network: 'instagram',
      caption: 'x'.repeat(501),
    });
    expect(long.ok).toBe(false);
  });
});

describe('AMPED-05C social curation against D1', () => {
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

  function mutations() {
    return createD1SocialMutations(db, () => new Date(), (p) => `${p}_s${++counter}`);
  }

  function social() {
    return createD1SocialService(db);
  }

  async function featuredIds(): Promise<string[]> {
    return (await social().listFeatured(50)).map((view) => view.post.id);
  }

  async function featuredPositions(): Promise<Array<number | null>> {
    const rows = await db
      .prepare(
        'select featured_position from social_posts where featured = 1 order by case when featured_position is null then 1 else 0 end, featured_position asc, id asc',
      )
      .all<{ featured_position: number | null }>();
    return rows.results.map((row) => row.featured_position);
  }

  function input(overrides: Record<string, unknown> = {}) {
    return {
      url: 'https://example.com/post/1',
      network: 'instagram' as const,
      featured: false,
      ...overrides,
    };
  }

  it('preserves the legacy id order for seeded featured rows', async () => {
    const ids = await featuredIds();
    expect(ids.length).toBeGreaterThan(0);
    expect(await featuredPositions()).toEqual(ids.map(() => null));
    // Legacy visible order is the id order.
    expect(ids).toEqual([...ids].sort());
  });

  it('normalises legacy rows on the first featured mutation, preserving order', async () => {
    const before = await featuredIds();
    const instance = mutations();
    const created = await instance.create(input({ featured: true, url: 'https://example.com/newest' }), OPERATOR);

    expect(await featuredIds()).toEqual([...before, created.id]);
    expect(await featuredPositions()).toEqual(before.map((_, index) => index).concat(before.length));

    const audit = await db
      .prepare('select action, actor_email from audit_log where entity_id = ?')
      .bind(created.id)
      .all<{ action: string; actor_email: string }>();
    expect(audit.results.map((row) => row.action).sort()).toEqual(['social.created', 'social.featured']);
    expect(audit.results.every((row) => row.actor_email === OPERATOR.email)).toBe(true);

    await instance.remove(created.id, OPERATOR);
  });

  it('creates non-featured and featured posts correctly', async () => {
    const instance = mutations();
    const hidden = await instance.create(input({ caption: 'Not on the homepage' }), OPERATOR);
    expect(await featuredIds()).not.toContain(hidden.id);

    const shown = await instance.create(input({ featured: true, caption: 'On the homepage' }), OPERATOR);
    expect((await featuredIds()).at(-1)).toBe(shown.id);
    const view = (await social().listFeatured(50)).find((entry) => entry.post.id === shown.id);
    expect(view?.post.caption).toBe('On the homepage');

    await instance.remove(hidden.id, OPERATOR);
    await instance.remove(shown.id, OPERATOR);
  });

  it('edits every mutable field and clears optional associations', async () => {
    const instance = mutations();
    const created = await instance.create(
      input({ caption: 'Original', eventId: 'evt_brass_tacks_nye', thumbnailAssetId: 'med_gal_01' }),
      OPERATOR,
    );

    await instance.update(
      created.id,
      {
        url: 'https://example.com/post/edited',
        network: 'bandcamp',
        caption: 'Edited',
        featured: false,
      },
      OPERATOR,
    );

    let row = await db
      .prepare('select url, network, caption, event_id, thumbnail_asset_id, featured from social_posts where id = ?')
      .bind(created.id)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      url: 'https://example.com/post/edited',
      network: 'bandcamp',
      caption: 'Edited',
      featured: 0,
    });

    // Clear caption/associations.
    await instance.update(
      created.id,
      { url: 'https://example.com/post/edited', network: 'bandcamp', featured: false },
      OPERATOR,
    );
    row = await db
      .prepare('select caption, event_id, thumbnail_asset_id from social_posts where id = ?')
      .bind(created.id)
      .first<Record<string, unknown>>();
    expect(row).toEqual({ caption: null, event_id: null, thumbnail_asset_id: null });

    await instance.remove(created.id, OPERATOR);
  });

  it('features and unfEatures with compaction and audit', async () => {
    const instance = mutations();
    const a = await instance.create(input({ featured: true, url: 'https://example.com/a' }), OPERATOR);
    const b = await instance.create(input({ featured: true, url: 'https://example.com/b' }), OPERATOR);

    expect((await featuredIds()).slice(-2)).toEqual([a.id, b.id]);

    await instance.update(
      b.id,
      { url: 'https://example.com/b', network: 'instagram', featured: false },
      OPERATOR,
    );
    const positions = await featuredPositions();
    expect((await featuredIds()).at(-1)).toBe(a.id);
    expect(positions).toEqual(positions.map((_, index) => index));

    const audit = await db
      .prepare("select action from audit_log where entity_id = ? and action in ('social.featured','social.unfeatured')")
      .bind(b.id)
      .all<{ action: string }>();
    expect(audit.results.map((row) => row.action).sort()).toEqual(['social.featured', 'social.unfeatured']);

    await instance.remove(a.id, OPERATOR);
    await instance.remove(b.id, OPERATOR);
  });

  it('reorders the featured set explicitly and atomically', async () => {
    const instance = mutations();
    const first = await instance.create(input({ featured: true, url: 'https://example.com/r1' }), OPERATOR);
    const second = await instance.create(input({ featured: true, url: 'https://example.com/r2' }), OPERATOR);

    const before = await featuredIds();
    const reversed = [...before].reverse();
    await instance.reorder(reversed, OPERATOR);

    expect(await featuredIds()).toEqual(reversed);
    expect(await featuredPositions()).toEqual(reversed.map((_, index) => index));

    const audit = await db
      .prepare("select count(*) as n from audit_log where action = 'social.reordered'")
      .first<{ n: number }>();
    expect(audit?.n).toBeGreaterThan(0);

    // Rejections do not move anything.
    const snapshot = await featuredIds();
    await expect(instance.reorder([snapshot[0]!, snapshot[0]!], OPERATOR)).rejects.toBeInstanceOf(ValidationError);
    await expect(instance.reorder(snapshot.slice(1), OPERATOR)).rejects.toBeInstanceOf(ConflictError);
    await expect(instance.reorder([...snapshot.slice(0, -1), 'soc_not_real'], OPERATOR)).rejects.toBeInstanceOf(ConflictError);
    expect(await featuredIds()).toEqual(snapshot);

    await instance.remove(first.id, OPERATOR);
    await instance.remove(second.id, OPERATOR);
  });

  it('deletes a featured post, compacts the order and leaves the event and media alone', async () => {
    const instance = mutations();
    const created = await instance.create(
      input({ featured: true, eventId: 'evt_brass_tacks_nye', thumbnailAssetId: 'med_gal_01' }),
      OPERATOR,
    );
    const eventBefore = await db
      .prepare('select id from events where id = ?')
      .bind('evt_brass_tacks_nye')
      .first();
    const mediaBefore = await db.prepare('select id from media_assets where id = ?').bind('med_gal_01').first();

    await instance.remove(created.id, OPERATOR);
    expect(await featuredIds()).not.toContain(created.id);
    const positions = await featuredPositions();
    expect(positions).toEqual(positions.map((_, index) => index));

    expect(await db.prepare('select id from events where id = ?').bind('evt_brass_tacks_nye').first()).toEqual(eventBefore);
    expect(await db.prepare('select id from media_assets where id = ?').bind('med_gal_01').first()).toEqual(mediaBefore);
    const audit = await db
      .prepare("select count(*) as n from audit_log where entity_id = ? and action = 'social.deleted'")
      .bind(created.id)
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });

  it('refuses unknown posts and unknown references', async () => {
    const instance = mutations();
    await expect(
      instance.update('soc_missing', input(), OPERATOR),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(instance.remove('soc_missing', OPERATOR)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      instance.create(input({ eventId: 'evt_not_real' }), OPERATOR),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      instance.create(input({ thumbnailAssetId: 'med_not_real' }), OPERATOR),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('only enriches public featured reads with public event titles', async () => {
    const instance = mutations();
    const draftPost = await instance.create(
      input({ featured: true, eventId: 'evt_brass_tacks_nye', url: 'https://example.com/draft' }),
      OPERATOR,
    );
    const publicPost = await instance.create(
      input({ featured: true, eventId: 'evt_glass_hearts_nov', url: 'https://example.com/public' }),
      OPERATOR,
    );

    const views = await social().listFeatured(50);
    const draftView = views.find((entry) => entry.post.id === draftPost.id);
    const publicView = views.find((entry) => entry.post.id === publicPost.id);

    expect(draftView?.eventTitle).toBeUndefined();
    expect(publicView?.eventTitle).toBeTruthy();

    await instance.remove(draftPost.id, OPERATOR);
    await instance.remove(publicPost.id, OPERATOR);
  });

  it('resolves thumbnails through the accepted media URL and copes without one', async () => {
    const instance = mutations();
    const created = await instance.create(
      input({ featured: true, thumbnailAssetId: 'med_gal_01', url: 'https://example.com/thumb' }),
      OPERATOR,
    );
    const withThumb = (await social().listFeatured(50)).find((entry) => entry.post.id === created.id);
    expect(withThumb?.thumbnailUrl).toBe('/media/gallery-01.svg');

    const plain = await instance.create(input({ featured: true, url: 'https://example.com/plain' }), OPERATOR);
    const withoutThumb = (await social().listFeatured(50)).find((entry) => entry.post.id === plain.id);
    expect(withoutThumb?.thumbnailUrl).toBeUndefined();

    await instance.remove(created.id, OPERATOR);
    await instance.remove(plain.id, OPERATOR);
  });
});

describe('AMPED-05C no-network guarantee and access', () => {
  it('contains no remote social fetching in the social service or routes', () => {
    const files = [
      join(root, 'src', 'services', 'd1', 'social.ts'),
      join(root, 'src', 'pages', 'api', 'admin', 'social', 'index.ts'),
      join(root, 'src', 'pages', 'api', 'admin', 'social', '[id].ts'),
      join(root, 'src', 'pages', 'api', 'admin', 'social', 'reorder.ts'),
    ];
    for (const file of files) {
      // Strip comments first: the code deliberately documents that it performs
      // no fetching, and that prose must not satisfy the assertion.
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/\bfetch\s*\(/);
      expect(code, file).not.toMatch(/oembed/i);
      expect(code, file).not.toMatch(/graph\.facebook|api\.instagram|tiktok\.com\/api/i);
    }
  });

  it('keeps every social route inside the protected namespace', () => {
    const dir = join(root, 'src', 'pages', 'api', 'admin', 'social');
    const files: string[] = [];
    const walk = (current: string) => {
      for (const entry of readdirSync(current)) {
        const full = join(current, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|astro)$/.test(entry)) files.push(full);
      }
    };
    walk(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const route = file
        .slice(join(root, 'src', 'pages').length)
        .replace(/\\/g, '/')
        .replace(/\.(ts|astro)$/, '')
        .replace(/\/index$/, '')
        .replace(/\[([^\]]+)\]/g, ':$1');
      expect(route.startsWith('/api/admin/')).toBe(true);
      expect(isProtectedPath(route)).toBe(true);
    }
  });
});
