/**
 * AMPED-05A - R2 media storage.
 *
 * Validation runs against the pure inspector; storage runs against a real local
 * R2 binding (the same workerd/ Miniflare path the application uses), with a
 * small injected ObjectStore seam for the explicit failure-compensation cases.
 * All binary fixtures are generated here - no large files, no network.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getPlatformProxy } from 'wrangler';

import { migrate } from '../src/db/migrations.ts';
import { applySeed } from '../src/db/seed.ts';
import {
  createD1MediaMutations,
  createR2ObjectStore,
  type ObjectStore,
} from '../src/services/d1/media.ts';
import {
  inspectImage,
  storageKeyFor,
  UploadError,
  validateUpload,
  MAX_UPLOAD_BYTES,
  type AllowedMime,
} from '../src/lib/upload.ts';
import { WRANGLER_CONFIG_PATH } from '../src/db/local.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const OPERATOR = { email: 'anya@ampedupmusicpromo.co.uk', sub: 'access-subject-1' };

// ---------------------------------------------------------------------------
// Tiny deterministic image fixtures
// ---------------------------------------------------------------------------

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(8 + 8 + 13 + 12);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24); // bit depth, colour type, etc.
  bytes.set([0x49, 0x45, 0x4e, 0x44], 33); // IEND
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(2 + 2 + 2 + 15 + 2);
  bytes.set([0xff, 0xd8], 0);
  bytes.set([0xff, 0xc0, 0x00, 0x11, 0x08], 2); // SOF0, length 17, precision
  bytes[7] = (height >> 8) & 0xff;
  bytes[8] = height & 0xff;
  bytes[9] = (width >> 8) & 0xff;
  bytes[10] = width & 0xff;
  bytes.set([0xff, 0xd9], bytes.length - 2);
  return bytes;
}

function webp(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(12 + 8 + 10);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  bytes.set([0x56, 0x50, 0x38, 0x58], 12); // VP8X
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 10, true);
  const w = width - 1;
  const h = height - 1;
  bytes[24] = w & 0xff;
  bytes[25] = (w >> 8) & 0xff;
  bytes[26] = (w >> 16) & 0xff;
  bytes[27] = h & 0xff;
  bytes[28] = (h >> 8) & 0xff;
  bytes[29] = (h >> 16) & 0xff;
  return bytes;
}

function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}

function avif(width: number, height: number): Uint8Array {
  const ftyp = box('ftyp', new Uint8Array([0x61, 0x76, 0x69, 0x66, 0, 0, 0, 0, 0x61, 0x76, 0x69, 0x66]));
  const ispePayload = new Uint8Array(12);
  const view = new DataView(ispePayload.buffer);
  view.setUint32(4, width);
  view.setUint32(8, height);
  const ispe = box('ispe', ispePayload);
  const ipco = box('ipco', ispe);
  const iprp = box('iprp', ipco);
  const meta = box('meta', (() => {
    const full = new Uint8Array(4 + iprp.length);
    full.set(iprp, 4);
    return full;
  })());
  const out = new Uint8Array(ftyp.length + meta.length);
  out.set(ftyp, 0);
  out.set(meta, ftyp.length);
  return out;
}

function fileFor(bytes: Uint8Array, name: string, type: string): File {
  return new File([bytes.buffer as ArrayBuffer], name, { type });
}

async function expectUploadError(promise: Promise<unknown>, status: number): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(UploadError);
  try {
    await promise;
  } catch (error) {
    expect((error as UploadError).status).toBe(status);
  }
}

// ---------------------------------------------------------------------------

describe('AMPED-05A image validation', () => {
  it('accepts JPEG, PNG, WebP and AVIF with matching declared types', async () => {
    const cases: Array<[Uint8Array, AllowedMime, string]> = [
      [jpeg(1200, 800), 'image/jpeg', 'poster.jpg'],
      [png(1200, 800), 'image/png', 'poster.png'],
      [webp(1200, 800), 'image/webp', 'poster.webp'],
      [avif(1200, 800), 'image/avif', 'poster.avif'],
    ];
    for (const [bytes, mime, name] of cases) {
      const result = await validateUpload({ file: fileFor(bytes, name, mime), alt: 'A test image', role: 'poster' });
      expect(result.mime).toBe(mime);
      expect(result.width).toBe(1200);
      expect(result.height).toBe(800);
    }
  });

  it('rejects SVG, GIF and unsupported binaries', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    await expectUploadError(
      validateUpload({ file: fileFor(svg, 'x.svg', 'image/svg+xml'), alt: 'x', role: 'poster' }),
      400,
    );
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0]);
    await expectUploadError(
      validateUpload({ file: fileFor(gif, 'x.gif', 'image/gif'), alt: 'x', role: 'poster' }),
      400,
    );
    const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await expectUploadError(
      validateUpload({ file: fileFor(junk, 'x.jpg', 'image/jpeg'), alt: 'x', role: 'poster' }),
      400,
    );
  });

  it('enforces the 8 MiB limit', async () => {
    const oversize = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    oversize.set(png(10, 10), 0);
    await expectUploadError(
      validateUpload({ file: fileFor(oversize, 'big.png', 'image/png'), alt: 'x', role: 'poster' }),
      413,
    );
  });

  it('requires meaningful alt text and a known role', async () => {
    await expectUploadError(
      validateUpload({ file: fileFor(png(10, 10), 'a.png', 'image/png'), alt: undefined, role: 'poster' }),
      400,
    );
    await expectUploadError(
      validateUpload({ file: fileFor(png(10, 10), 'a.png', 'image/png'), alt: '   ', role: 'poster' }),
      400,
    );
    await expectUploadError(
      validateUpload({ file: fileFor(png(10, 10), 'a.png', 'image/png'), alt: 'ok', role: 'favourite' }),
      400,
    );
  });

  it('rejects a declared type that does not match the bytes', async () => {
    await expectUploadError(
      validateUpload({ file: fileFor(png(10, 10), 'poster.jpg', 'image/jpeg'), alt: 'x', role: 'poster' }),
      400,
    );
    await expectUploadError(
      validateUpload({ file: fileFor(jpeg(10, 10), 'poster.png', 'image/png'), alt: 'x', role: 'poster' }),
      400,
    );
    // A misleading extension cannot make invalid content valid.
    await expectUploadError(
      validateUpload({ file: fileFor(new Uint8Array([0, 1, 2, 3]), 'photo.png', 'image/png'), alt: 'x', role: 'poster' }),
      400,
    );
  });

  it('detects dimensions from bytes, not from client input', () => {
    expect(inspectImage(png(321, 123))).toMatchObject({ width: 321, height: 123 });
    expect(inspectImage(jpeg(640, 480))).toMatchObject({ width: 640, height: 480 });
    expect(inspectImage(webp(800, 600))).toMatchObject({ width: 800, height: 600 });
    expect(inspectImage(avif(1024, 768))).toMatchObject({ width: 1024, height: 768 });
  });

  it('rejects pathological dimensions and pixel areas', async () => {
    await expectUploadError(
      validateUpload({ file: fileFor(png(12_001, 10), 'wide.png', 'image/png'), alt: 'x', role: 'poster' }),
      400,
    );
    await expectUploadError(
      validateUpload({ file: fileFor(png(10, 12_001), 'tall.png', 'image/png'), alt: 'x', role: 'poster' }),
      400,
    );
    // 12,000 x 12,000 = 144 MP, over the 80 MP area limit but within each side.
    await expectUploadError(
      validateUpload({ file: fileFor(png(12_000, 12_000), 'bomb.png', 'image/png'), alt: 'x', role: 'poster' }),
      400,
    );
  });

  it('generates keys from server id and detected MIME only', () => {
    expect(storageKeyFor('med_abc', 'image/jpeg')).toBe('media/med_abc.jpg');
    expect(storageKeyFor('med_abc', 'image/avif')).toBe('media/med_abc.avif');
    for (const name of ['../../evil.jpg', '..\\..\\evil.jpg', 'C:\\fakepath\\poster.jpg']) {
      expect(storageKeyFor('med_safe', 'image/png')).toBe('media/med_safe.png');
      expect(name).not.toContain('med_safe');
    }
  });
});

// ---------------------------------------------------------------------------
// Storage against real local R2
// ---------------------------------------------------------------------------

describe('AMPED-05A R2 storage', () => {
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
    return createD1MediaMutations(db, createR2ObjectStore(bucket), () => new Date(), (p) => `${p}_m${++counter}`);
  }

  async function upload(overrides: Record<string, unknown> = {}) {
    const validated = await validateUpload({
      file: fileFor(png(800, 600), 'poster.png', 'image/png'),
      alt: 'A test poster',
      role: 'poster',
      ...overrides,
    });
    return mutations().upload(validated, OPERATOR);
  }

  it('writes the object to R2 and the metadata to D1', async () => {
    const created = await upload();
    const row = await db
      .prepare('select storage_key, url, mime_type, width, height, alt, byte_size, role from media_assets where id = ?')
      .bind(created.id)
      .first<Record<string, unknown>>();

    expect(row?.url).toBe(`/media/${created.id}`);
    expect(row?.storage_key).toBe(`media/${created.id}.png`);
    expect(row).toMatchObject({
      mime_type: 'image/png',
      width: 800,
      height: 600,
      alt: 'A test poster',
      byte_size: png(800, 600).byteLength,
      role: 'poster',
    });

    const object = await bucket.get(`media/${created.id}.png`);
    expect(object).not.toBeNull();
    expect(object?.httpMetadata?.contentType).toBe('image/png');
  });

  it('serves the stored bytes and MIME through the service', async () => {
    const created = await upload();
    const object = await mutations().getObject(created.id);
    expect(object?.mime).toBe('image/png');
    const bytes = new Uint8Array(await new Response(object!.body).arrayBuffer());
    expect(bytes).toEqual(png(800, 600));
    expect(await mutations().getObject('med_does_not_exist')).toBeNull();
  });

  it('attaches a poster to an existing promotion atomically', async () => {
    const created = await upload({ role: 'poster', eventId: 'evt_brass_tacks_nye' });
    const event = await db
      .prepare('select poster_asset_id from events where id = ?')
      .bind('evt_brass_tacks_nye')
      .first<{ poster_asset_id: string | null }>();
    expect(event?.poster_asset_id).toBe(created.id);
  });

  it('deletes the object and the row together, with audit', async () => {
    const created = await upload();
    const mutationsInstance = mutations();
    await mutationsInstance.remove(created.id, OPERATOR);

    expect(await db.prepare('select id from media_assets where id = ?').bind(created.id).first()).toBeNull();
    expect(await bucket.get(`media/${created.id}.png`)).toBeNull();
    const audit = await db
      .prepare('select action from audit_log where entity_id = ?')
      .bind(created.id)
      .all<{ action: string }>();
    expect(audit.results.map((row) => row.action)).toContain('media.deleted');
  });

  it('leaves no R2 object when the D1 write fails', async () => {
    const instance = createD1MediaMutations(db, createR2ObjectStore(bucket), () => new Date(), () => 'med_preclash');
    // Pre-existing row with the id the factory will produce makes the insert clash.
    await db
      .prepare(
        "insert into media_assets (id, storage_key, url, role, alt, mime_type, uploaded_at) values ('med_preclash', 'seed/other', '/media/other', 'og', 'seed', 'image/png', ?)",
      )
      .bind(new Date().toISOString())
      .run();

    const validated = await validateUpload({
      file: fileFor(png(100, 100), 'a.png', 'image/png'),
      alt: 'Clash image',
      role: 'gallery',
    });

    await expect(instance.upload(validated, OPERATOR)).rejects.toThrow();

    const object = await bucket.get('media/med_preclash.png');
    expect(object).toBeNull();

    await db.prepare("delete from media_assets where id = 'med_preclash'").run();
  });

  it('creates no D1 row when the R2 put fails', async () => {
    const failing: ObjectStore = {
      put: async () => {
        throw new Error('R2 unavailable');
      },
      getBytes: async () => null,
      getStream: async () => null,
      delete: async () => {},
    };
    const instance = createD1MediaMutations(db, failing, () => new Date(), (p) => `${p}_fail${++counter}`);
    const validated = await validateUpload({
      file: fileFor(png(100, 100), 'a.png', 'image/png'),
      alt: 'Failing image',
      role: 'gallery',
    });

    const before = await db.prepare('select count(*) as n from media_assets').first<{ n: number }>();
    await expect(instance.upload(validated, OPERATOR)).rejects.toThrow(/R2 unavailable/);
    const after = await db.prepare('select count(*) as n from media_assets').first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });

  it('restores the object when the D1 delete fails', async () => {
    const map = new Map<string, Uint8Array>();
    let failDelete = false;
    const seam: ObjectStore = {
      put: async (key, bytes) => void map.set(key, bytes),
      getBytes: async (key) => map.get(key) ?? null,
      getStream: async (key) => {
        const bytes = map.get(key);
        return bytes
          ? { body: new Response(bytes.buffer as ArrayBuffer).body!, size: bytes.byteLength }
          : null;
      },
      delete: async (key) => {
        if (failDelete) throw new Error('R2 delete failed');
        map.delete(key);
      },
    };
    const instance = createD1MediaMutations(db, seam, () => new Date(), (p) => `${p}_restore${++counter}`);
    const validated = await validateUpload({
      file: fileFor(png(50, 50), 'a.png', 'image/png'),
      alt: 'Restore image',
      role: 'gallery',
    });
    const created = await instance.upload(validated, OPERATOR);

    // R2 delete fails: D1 must be untouched.
    failDelete = true;
    await expect(instance.remove(created.id, OPERATOR)).rejects.toThrow(/R2 delete failed/);
    expect(await db.prepare('select id from media_assets where id = ?').bind(created.id).first()).not.toBeNull();

    // D1 failure after the R2 delete: the object is restored.
    failDelete = false;
    const clash = createD1MediaMutations(db, seam, () => new Date(), (p) => (p === 'aud' ? 'aud_dupdelete' : `${p}_x${++counter}`));
    await db
      .prepare(
        "insert into audit_log (id, actor_email, action, entity_type, entity_id, summary, occurred_at) values ('aud_dupdelete', 'x@example.com', 'probe', 'probe', 'probe', 'probe', ?)",
      )
      .bind(new Date().toISOString())
      .run();
    await expect(clash.remove(created.id, OPERATOR)).rejects.toThrow();
    expect(map.has(`media/${created.id}.png`)).toBe(true);
    expect(await db.prepare('select id from media_assets where id = ?').bind(created.id).first()).not.toBeNull();

    await db.prepare("delete from audit_log where id = 'aud_dupdelete'").run();
    await db.prepare('delete from media_assets where id = ?').bind(created.id).run();
  });

  it('generates distinct keys for two uploads of the same bytes', async () => {
    const first = await upload();
    const second = await upload();
    expect(first.id).not.toBe(second.id);
    expect(await bucket.get(`media/${first.id}.png`)).not.toBeNull();
    expect(await bucket.get(`media/${second.id}.png`)).not.toBeNull();
  });
});
