/**
 * AMPED-03A - the fixture data layer is retired.
 *
 * Proves the two things the slice is for:
 *
 *  1. src/data and src/services/mock are gone, and nothing in the application
 *     imports a fixture path any more;
 *  2. every service the scaffold uses reads D1, and a runtime without the DB
 *     binding fails loudly instead of falling back to sample data.
 *
 * The import scan reads the source tree directly, so a future `import` of a
 * deleted fixture module fails here rather than at runtime.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { openEphemeralDatabase } from '../src/db/local.ts';
import { migrate } from '../src/db/migrations.ts';
import { applySeed } from '../src/db/seed.ts';
import { createServices, getServices, isScaffoldData } from '../src/services/index.ts';
import type { Services } from '../src/services/contracts.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every source file the bundler could include, fixtures or not. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|js|mjs|astro)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('fixture data layer is gone', () => {
  it('has no src/data directory', () => {
    expect(existsSync(join(root, 'src', 'data'))).toBe(false);
  });

  it('has no src/services/mock directory', () => {
    expect(existsSync(join(root, 'src', 'services', 'mock'))).toBe(false);
  });

  it('has no application file importing a fixture module', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(root, 'src'))) {
      const source = readFileSync(file, 'utf8');
      if (/from\s+['"][^'"]*(?:@\/data|\/data\/fixtures|services\/mock)[^'"]*['"]/.test(source)) {
        offenders.push(file.replace(`${root}\\`, ''));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('a missing database binding fails loudly', () => {
  it('does not hand back a fixture service set', () => {
    // The Vitest runtime has no Cloudflare binding, which is exactly the
    // "production without DB" case the slice must refuse.
    expect(() => getServices()).toThrow(/DB/);
    expect(isScaffoldData()).toBe(true);
  });
});

describe('every service reads D1', () => {
  let database: Awaited<ReturnType<typeof openEphemeralDatabase>>;
  let db: D1Database;
  let services: Services;
  let counter = 0;

  beforeAll(async () => {
    database = await openEphemeralDatabase();
    db = database.db;
    await migrate(db);
    await applySeed(db);
    services = createServices(db);
  });

  afterAll(async () => {
    await database.dispose();
  });

  it('reads media metadata and galleries', async () => {
    const og = await services.media.get('med_og_default');
    expect(og?.url).toBe('/media/og-default.svg');
    expect(await services.media.get('med_does_not_exist')).toBeNull();

    const gallery = await services.media.listGallery();
    expect(gallery.length).toBe(12);
    expect(gallery.every((asset) => asset.role === 'gallery' && asset.eventId)).toBe(true);

    const forEvent = await services.media.listForEvent('evt_hollow_coast_past');
    expect(forEvent.map((asset) => asset.id)).toEqual([
      'med_poster_hollow_coast',
      'med_hero_hollow_coast',
      'med_gal_01',
      'med_gal_02',
      'med_gal_03',
    ]);
  });

  it('reads social posts with their thumbnails and event titles', async () => {
    const featured = await services.social.listFeatured();
    expect(featured.map((view) => view.post.id)).toEqual(['soc_01', 'soc_02', 'soc_03', 'soc_04']);
    expect(featured[0]?.thumbnailUrl).toBeTruthy();
    expect(featured[0]?.eventTitle).toBe('The Glass Hearts');
    expect(featured[0]?.networkLabel).toBe('Instagram');

    const forEvent = await services.social.listForEvent('evt_glass_hearts_nov');
    expect(forEvent.map((view) => view.post.id)).toEqual(['soc_01']);
  });

  it('reads the admin event list, single event and sales summary', async () => {
    const all = await services.admin.listAll();
    expect(all.length).toBe(12);
    expect(all.some((event) => event.status === 'draft')).toBe(true);

    const draft = await services.admin.getById('evt_brass_tacks_nye');
    expect(draft?.internalNotes).toContain('late licence');

    const summary = await services.admin.salesSummary('evt_glass_hearts_nov');
    expect(summary.capacity).toBe(200);
    expect(summary.sold).toBe(156);
    expect(summary.guestList).toBe(11);

    expect(await services.admin.nextEvent()).not.toBeNull();
  });

  it('reads orders, and finds one by reference and by search', async () => {
    const recent = await services.orders.listRecent(5);
    expect(recent.length).toBe(5);

    const first = recent[0]!;
    const found = await services.orders.getByReference(first.order.reference);
    expect(found?.order.id).toBe(first.order.id);
    expect(found?.order.items[0]?.ticketTypeName).toBeTruthy();

    const matches = await services.orders.search(first.order.customerEmail);
    expect(matches.some((view) => view.order.id === first.order.id)).toBe(true);
  });

  it('reads enquiries from D1', async () => {
    expect(await services.enquiries.list()).toHaveLength(6);
    expect(await services.enquiries.countNew()).toBe(2);

    counter += 1;
    const id = `enq_03a_${counter}`;
    await db
      .prepare(
        `insert into enquiries (id, kind, name, email, message, status, bot_check_passed, received_at)
         values (?, 'general', 'Probe', 'probe@example.com', 'Probe message', 'new', 1, ?)`,
      )
      .bind(id, new Date().toISOString())
      .run();

    try {
      expect((await services.enquiries.list()).some((view) => view.enquiry.id === id)).toBe(true);
      expect(await services.enquiries.countNew()).toBe(3);
    } finally {
      await db.prepare('delete from enquiries where id = ?').bind(id).run();
    }
  });

  it('reads the mailing list, its counts and its growth', async () => {
    const counts = await services.mailingList.counts();
    expect(counts).toEqual({ subscribed: 18, unsubscribed: 1, bounced: 1 });
    expect(await services.mailingList.list()).toHaveLength(20);

    const growth = await services.mailingList.growth();
    expect(growth.length).toBeGreaterThan(0);
    expect(growth.every((point) => point.count > 0 && point.label.length > 0)).toBe(true);
  });

  it('reads the audit log from D1', async () => {
    const recent = await services.audit.listRecent(3);
    expect(recent).toHaveLength(3);
    expect(recent[0]?.action).toBe('event.published');

    counter += 1;
    const id = `aud_03a_${counter}`;
    await db
      .prepare(
        `insert into audit_log (id, actor_email, action, entity_type, entity_id, summary, occurred_at)
         values (?, 'probe@ampedupmusic.co.uk', 'probe.created', 'probe', 'probe_1', 'Probe entry', ?)`,
      )
      .bind(id, new Date(Date.now() + 60_000).toISOString())
      .run();

    try {
      expect((await services.audit.listRecent(1))[0]?.id).toBe(id);
    } finally {
      await db.prepare('delete from audit_log where id = ?').bind(id).run();
    }
  });

  it('reads Door Mode presentation data, but never admits anybody', async () => {
    const events = await services.door.listDoorEvents();
    expect(events.length).toBeGreaterThan(0);

    const counts = await services.door.admissionCounts('evt_hollow_coast_past');
    expect(counts.expected).toBe(468);
    expect(counts.admitted).toBe(441);

    const guests = await services.door.listGuestList('evt_glass_hearts_nov');
    expect(guests).toHaveLength(11);
    expect(guests.every((ticket) => ticket.isGuestList)).toBe(true);

    const issued = await db
      .prepare(
        "select reference from tickets where event_id = 'evt_glass_hearts_nov' and status = 'issued' limit 1",
      )
      .first<{ reference: string }>();
    expect(issued).not.toBeNull();
    const result = await services.door.inspect(issued!.reference, 'evt_glass_hearts_nov');
    expect(result.outcome).toBe('valid');

    await expect(
      services.door.checkIn(issued!.reference, 'evt_glass_hearts_nov', 'x@example.com'),
    ).rejects.toThrow(/AMPED-09B/);
  });
});

describe('service cache safety', () => {
  it('returns one cached D1 set per bound module instance and never a fixture set', async () => {
    const shared = await openEphemeralDatabase();
    try {
      await migrate(shared.db);
      await applySeed(shared.db);

      vi.resetModules();
      vi.doMock('cloudflare:workers', () => ({ env: { DB: shared.db } }));
      try {
        const fresh = await import('../src/services/index.ts');
        const first = fresh.getServices();
        expect(fresh.getServices()).toBe(first);
        expect(fresh.isScaffoldData()).toBe(false);
        expect(await first.venues.list()).toHaveLength(4);
      } finally {
        vi.doUnmock('cloudflare:workers');
        vi.resetModules();
      }

      // A fresh module instance with no binding throws rather than reusing the
      // cached one: environments cannot poison each other.
      const unbound = await import('../src/services/index.ts');
      expect(() => unbound.getServices()).toThrow(/DB/);
    } finally {
      await shared.dispose();
    }
  });
});
