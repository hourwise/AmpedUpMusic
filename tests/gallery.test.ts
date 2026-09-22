/**
 * AMPED-05B - event galleries, ordering and photography links.
 *
 * Exercises the media service against real local R2 + D1: multi-file batches,
 * legacy normalisation, reorder, photography metadata and the compensation
 * paths. All images are tiny generated fixtures; no network, no large files.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getPlatformProxy } from 'wrangler';

import { migrate } from '../src/db/migrations.ts';
import { applySeed } from '../src/db/seed.ts';
import {
  createD1MediaMutations,
  createD1MediaService,
  createR2ObjectStore,
  isHttpUrl,
  MAX_FILES_PER_GALLERY_BATCH,
  MAX_TOTAL_BATCH_BYTES,
  type ObjectStore,
} from '../src/services/d1/media.ts';
import { validateUpload, UploadError, type ValidatedUpload } from '../src/lib/upload.ts';
import { ConflictError, ValidationError } from '../src/lib/validation.ts';
import { WRANGLER_CONFIG_PATH } from '../src/db/local.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const OPERATOR = { email: 'anya@ampedupmusicpromo.co.uk', sub: 'access-subject-1' };

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(8 + 8 + 13 + 12);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  bytes.set([0x49, 0x45, 0x4e, 0x44], 33);
  return bytes;
}

function fileFor(bytes: Uint8Array, name: string, type: string): File {
  return new File([bytes.buffer as ArrayBuffer], name, { type });
}

async function validated(alt: string, bytes = png(80, 60), credit?: string): Promise<ValidatedUpload> {
  return validateUpload({
    file: fileFor(bytes, 'photo.png', 'image/png'),
    alt,
    role: 'gallery',
    credit,
  });
}

describe('AMPED-05B gallery management', () => {
  let proxy: Awaited<ReturnType<typeof getPlatformProxy>>;
  let db: D1Database;
  let bucket: R2Bucket;
  let counter = 0;

  beforeAll(async () => {
    proxy = await getPlatformProxy({
      configPath: WRANGLER_CONFIG_PATH,
      persist: false,
      remoteBindings: false,
    });
    db = (proxy.env as { DB: D1Database }).DB;
    bucket = (proxy.env as { MEDIA: R2Bucket }).MEDIA;
    await migrate(db);
    await applySeed(db);
  });

  afterAll(async () => {
    await proxy.dispose();
  });

  function mutations() {
    return createD1MediaMutations(db, createR2ObjectStore(bucket), () => new Date(), (p) => `${p}_g${++counter}`);
  }

  async function galleryIds(eventId: string): Promise<string[]> {
    return (await createD1MediaService(db).listForEvent(eventId))
      .filter((asset) => asset.role === 'gallery')
      .map((asset) => asset.id);
  }

  async function positions(eventId: string): Promise<Array<number | null>> {
    const rows = await db
      .prepare(
        "select gallery_position from media_assets where role = 'gallery' and event_id = ? order by case when gallery_position is null then 1 else 0 end, gallery_position asc, id asc",
      )
      .bind(eventId)
      .all<{ gallery_position: number | null }>();
    return rows.results.map((row) => row.gallery_position);
  }

  it('uploads two gallery images in one action, in selection order', async () => {
    const eventId = 'evt_brass_tacks_nye'; // draft, no gallery
    const batch = [
      await validated('First photograph'),
      await validated('Second photograph', png(90, 70), 'AnyaParallax'),
    ];

    const created = await mutations().uploadGalleryBatch(eventId, batch, OPERATOR);
    expect(created.ids).toHaveLength(2);
    expect(new Set(created.ids).size).toBe(2);

    const rows = await db
      .prepare("select id, event_id, role, storage_key, alt, credit, gallery_position from media_assets where event_id = ? and role = 'gallery' order by gallery_position")
      .bind(eventId)
      .all<Record<string, unknown>>();

    expect(rows.results.map((row) => row.id)).toEqual(created.ids);
    expect(rows.results.map((row) => row.role)).toEqual(['gallery', 'gallery']);
    expect(rows.results.map((row) => row.event_id)).toEqual([eventId, eventId]);
    expect(rows.results.map((row) => row.alt)).toEqual(['First photograph', 'Second photograph']);
    expect(rows.results.map((row) => row.credit)).toEqual([null, 'AnyaParallax']);
    expect(rows.results.map((row) => row.gallery_position)).toEqual([0, 1]);
    expect(new Set(rows.results.map((row) => row.storage_key)).size).toBe(2);

    // Objects really exist in R2.
    for (const id of created.ids) {
      expect(await bucket.get(`media/${id}.png`)).not.toBeNull();
    }
  });

  it('requires per-file alt text and rejects a count mismatch before writing', async () => {
    const before = await db.prepare('select count(*) as n from media_assets').first<{ n: number }>();
    await expect(validated('')).rejects.toBeInstanceOf(UploadError);
    const after = await db.prepare('select count(*) as n from media_assets').first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });

  it('enforces the batch file and byte limits', async () => {
    const items = await Promise.all(
      Array.from({ length: MAX_FILES_PER_GALLERY_BATCH }, (_, index) => validated(`Photo ${index}`)),
    );
    await expect(
      mutations().uploadGalleryBatch('evt_brass_tacks_nye', [...items, items[0]!], OPERATOR),
    ).rejects.toBeInstanceOf(ValidationError);

    const heavy = items.map((item) => ({ ...item, byteSize: 8 * 1024 * 1024 }));
    expect(heavy.reduce((sum, item) => sum + item.byteSize, 0)).toBeGreaterThan(MAX_TOTAL_BATCH_BYTES);
    await expect(
      mutations().uploadGalleryBatch('evt_brass_tacks_nye', heavy, OPERATOR),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects the whole batch when one file fails 05A validation', async () => {
    const before = await db.prepare('select count(*) as n from media_assets').first<{ n: number }>();
    const badGif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0]);

    await expect(
      (async () => {
        await validated('ok');
        await validateUpload({
          file: fileFor(badGif, 'bad.png', 'image/png'),
          alt: 'bad',
          role: 'gallery',
        });
      })(),
    ).rejects.toBeInstanceOf(UploadError);

    const after = await db.prepare('select count(*) as n from media_assets').first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });

  it('compensates every written object when a later R2 put fails', async () => {
    const map = new Map<string, Uint8Array>();
    let puts = 0;
    const flaky: ObjectStore = {
      put: async (key, bytes) => {
        puts += 1;
        if (puts === 2) throw new Error('R2 put failed');
        map.set(key, bytes);
      },
      getBytes: async (key) => map.get(key) ?? null,
      getStream: async () => null,
      delete: async (key) => void map.delete(key),
    };
    const instance = createD1MediaMutations(db, flaky, () => new Date(), (p) => `${p}_put${++counter}`);
    const before = await db.prepare('select count(*) as n from media_assets').first<{ n: number }>();

    await expect(
      instance.uploadGalleryBatch('evt_brass_tacks_nye', [await validated('a'), await validated('b')], OPERATOR),
    ).rejects.toThrow(/R2 put failed/);

    expect(map.size).toBe(0);
    const after = await db.prepare('select count(*) as n from media_assets').first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });

  it('compensates every object when the D1 batch fails', async () => {
    const written = new Map<string, Uint8Array>();
    const store: ObjectStore = {
      put: async (key, bytes) => void written.set(key, bytes),
      getBytes: async (key) => written.get(key) ?? null,
      getStream: async () => null,
      delete: async (key) => void written.delete(key),
    };
    let seq = 0;
    const instance = createD1MediaMutations(db, store, () => new Date(), (p) =>
      p === 'aud' ? 'aud_galleryclash' : `${p}_d1${++seq}`,
    );
    await db
      .prepare(
        "insert into audit_log (id, actor_email, action, entity_type, entity_id, summary, occurred_at) values ('aud_galleryclash', 'x@example.com', 'probe', 'probe', 'probe', 'probe', ?)",
      )
      .bind(new Date().toISOString())
      .run();

    const before = await db.prepare('select count(*) as n from media_assets').first<{ n: number }>();
    await expect(
      instance.uploadGalleryBatch('evt_brass_tacks_nye', [await validated('a'), await validated('b')], OPERATOR),
    ).rejects.toThrow();

    expect(written.size).toBe(0);
    const after = await db.prepare('select count(*) as n from media_assets').first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
    await db.prepare("delete from audit_log where id = 'aud_galleryclash'").run();
  });

  it('normalises legacy NULL positions on the first managed operation', async () => {
    const eventId = 'evt_hollow_coast_past'; // seeded gallery med_gal_01..03, all NULL
    const legacy = await galleryIds(eventId);
    expect(legacy).toEqual(['med_gal_01', 'med_gal_02', 'med_gal_03']);
    expect(await positions(eventId)).toEqual([null, null, null]);

    const created = await mutations().uploadGalleryBatch(eventId, [await validated('New shot')], OPERATOR);

    // Existing rows keep their display order and become 0..2; the new one is 3.
    expect(await positions(eventId)).toEqual([0, 1, 2, 3]);
    expect(await galleryIds(eventId)).toEqual([...legacy, created.ids[0]]);
  });

  it('reorders a gallery and rejects stale, duplicate or foreign requests', async () => {
    const eventId = 'evt_hollow_coast_past';
    const current = await galleryIds(eventId);
    expect(current.length).toBe(4);

    const reversed = [...current].reverse();
    await mutations().reorderGallery(eventId, reversed, OPERATOR);
    expect(await galleryIds(eventId)).toEqual(reversed);
    expect(await positions(eventId)).toEqual([0, 1, 2, 3]);

    await expect(
      mutations().reorderGallery(eventId, [current[0]!, current[0]!, ...current.slice(2)], OPERATOR),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      mutations().reorderGallery(eventId, current.slice(1), OPERATOR),
    ).rejects.toBeInstanceOf(ConflictError);

    await expect(
      mutations().reorderGallery(eventId, [...current.slice(0, 3), 'med_not_real'], OPERATOR),
    ).rejects.toBeInstanceOf(ConflictError);

    await expect(
      mutations().reorderGallery(eventId, [...current.slice(0, 3), 'med_og_default'], OPERATOR),
    ).rejects.toBeInstanceOf(ConflictError);

    // Another event's gallery is untouched.
    expect(await galleryIds('evt_brass_tacks_nye')).toEqual(
      (await galleryIds('evt_brass_tacks_nye')),
    );
  });

  it('keeps relative order after a delete leaves a gap', async () => {
    const eventId = 'evt_hollow_coast_past';
    const before = await galleryIds(eventId);
    await mutations().remove(before[1]!, OPERATOR);
    const after = await galleryIds(eventId);
    expect(after).toEqual([before[0], ...before.slice(2)]);
  });

  it('updates only the event photography columns and audits the write', async () => {
    const eventId = 'evt_hollow_coast_past';
    const before = await db
      .prepare('select title, status, venue_id, starts_at from events where id = ?')
      .bind(eventId)
      .first<Record<string, unknown>>();

    await mutations().updatePhotography(
      eventId,
      {
        credit: 'AnyaParallax',
        galleryUrl: 'https://example.com/galleries/hollow-coast',
        photographerUrl: 'https://example.com/anyaparallax',
      },
      OPERATOR,
    );

    const after = await db
      .prepare(
        'select title, status, venue_id, starts_at, photography_credit, photography_gallery_url, photography_photographer_url from events where id = ?',
      )
      .bind(eventId)
      .first<Record<string, unknown>>();

    expect(after).toMatchObject(before!);
    expect(after?.photography_credit).toBe('AnyaParallax');
    expect(after?.photography_gallery_url).toBe('https://example.com/galleries/hollow-coast');
    expect(after?.photography_photographer_url).toBe('https://example.com/anyaparallax');

    const audit = await db
      .prepare("select action, actor_email from audit_log where entity_id = ? and action = 'event.photography_updated'")
      .bind(eventId)
      .all<{ action: string; actor_email: string }>();
    expect(audit.results).toEqual([
      { action: 'event.photography_updated', actor_email: OPERATOR.email },
    ]);
  });

  it('accepts only real http(s) links', () => {
    expect(isHttpUrl('https://example.com/x')).toBe(true);
    expect(isHttpUrl('http://example.com/x')).toBe(true);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('data:text/html,<script>')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
  });

  it('groups several events\u2019 galleries in one bounded read', async () => {
    const instance = mutations();
    const grouped = await instance.listGalleryForEvents(['evt_hollow_coast_past', 'evt_brass_tacks_nye']);
    expect(grouped.get('evt_hollow_coast_past')?.every((asset) => asset.role === 'gallery')).toBe(true);
    expect(grouped.get('evt_does_not_exist')).toBeUndefined();
    expect((await instance.listGalleryForEvents([])).size).toBe(0);
  });
});
