/**
 * AMPED-02C - D1 event and line-up persistence.
 *
 * tests/services.test.ts is the protected contract file and is deliberately
 * untouched; this file carries the persistence-specific evidence:
 *
 *  - the D1 EventView is field-for-field the mock EventView;
 *  - drafts and archived rows cannot leave the public service (enforced in
 *    SQL, with the statement text asserted);
 *  - past/upcoming follows hasFinished()/curfew semantics, not the status;
 *  - line-up order is the operator's running order, never alphabetical;
 *  - the projection is batched, so query count does not scale with events;
 *  - ArtistService.eventsFor() is D1-backed when DB is bound;
 *  - getServices() selection and caching behave for the bound and unbound
 *    cases without wedging a module instance.
 *
 * Everything here runs against a throwaway, migrated and seeded local D1
 * database. No developer database and no remote resource is touched.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { applySeed } from '../src/db/seed.ts';
import { migrate } from '../src/db/migrations.ts';
import { openEphemeralDatabase } from '../src/db/local.ts';
import { createServices, getServices } from '../src/services/index.ts';
import { createD1EventRepository } from '../src/services/d1/events.ts';
import { createD1ArtistService } from '../src/services/d1/artists.ts';
import { createD1VenueService } from '../src/services/d1/venues.ts';
import type {
  ArtistService,
  PublicEventService,
  VenueService,
} from '../src/services/contracts.ts';
import type { EventView } from '../src/types/view.ts';

// Migrating and seeding a Wrangler runtime takes longer than the default budget.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const services = getServices();

/**
 * Drop the timestamp fields that the fixture clock and the seed read
 * independently ("now" at two different moments). Everything else must match.
 */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'createdAt' || key === 'updatedAt' || key === 'uploadedAt') continue;
    out[key] = normalize(child);
  }
  return out;
}

/** A D1Database that records the SQL text of every prepared statement. */
function instrument(db: D1Database): { db: D1Database; queries: string[] } {
  const queries: string[] = [];
  const wrapped = new Proxy(db as unknown as Record<string | symbol, unknown>, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) => {
          queries.push(sql);
          return db.prepare(sql);
        };
      }
      const value = target[property];
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(db)
        : value;
    },
  }) as unknown as D1Database;
  return { db: wrapped, queries };
}

type ProbeStatus = 'draft' | 'published' | 'postponed' | 'cancelled' | 'completed' | 'archived';

describe('AMPED-02C event and line-up persistence', () => {
  let database: Awaited<ReturnType<typeof openEphemeralDatabase>>;
  let db: D1Database;
  let repository: PublicEventService & { eventsFor(artistId: string): Promise<EventView[]> };
  let d1Artists: ArtistService;
  let d1Venues: VenueService;
  let probeCounter = 0;

  beforeAll(async () => {
    database = await openEphemeralDatabase();
    db = database.db;
    await migrate(db);
    await applySeed(db);

    repository = createD1EventRepository(db);
    d1Artists = createD1ArtistService(db, repository);
    d1Venues = createD1VenueService(db);
  });

  afterAll(async () => {
    await database.dispose();
  });

  async function insertProbeEvent(input: {
    status?: ProbeStatus;
    startsAt: string;
    endsAt?: string | null;
    venueId?: string;
    posterAssetId?: string | null;
    heroAssetId?: string | null;
    photographyCredit?: string | null;
    statusMessage?: string | null;
    internalNotes?: string | null;
  }): Promise<{ id: string; slug: string }> {
    probeCounter += 1;
    const id = `evt_02c_probe_${probeCounter}`;
    const slug = `02c-probe-${probeCounter}`;
    const stamp = '2026-01-01T00:00:00.000Z';

    await db
      .prepare(
        `insert into events (
           id, title, slug, status, strapline, description, venue_id,
           doors_at, starts_at, ends_at, age_restriction, accessibility_notes,
           poster_asset_id, hero_asset_id, photography_credit,
           photography_gallery_url, photography_photographer_url,
           internal_notes, status_message, rescheduled_to_event_id,
           published_at, created_at, updated_at
         ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        `Probe Event ${probeCounter}`,
        slug,
        input.status ?? 'published',
        null,
        'A temporary event inserted by the AMPED-02C tests to prove a boundary.',
        input.venueId ?? 'ven_lomax',
        input.startsAt,
        input.startsAt,
        input.endsAt ?? null,
        'all-ages',
        null,
        input.posterAssetId ?? null,
        input.heroAssetId ?? null,
        input.photographyCredit ?? null,
        null,
        null,
        input.internalNotes ?? null,
        input.statusMessage ?? null,
        null,
        null,
        stamp,
        stamp,
      )
      .run();

    return { id, slug };
  }

  async function deleteProbeEvent(id: string): Promise<void> {
    await db.prepare('delete from events where id = ?').bind(id).run();
  }

  async function insertLineup(
    eventId: string,
    entries: ReadonlyArray<{ artistId: string; position: number; billingNote?: string }>,
  ): Promise<void> {
    for (const entry of entries) {
      await db
        .prepare(
          'insert into event_artists (event_id, artist_id, position, billing_note, set_time) values (?, ?, ?, ?, ?)',
        )
        .bind(eventId, entry.artistId, entry.position, entry.billingNote ?? null, null)
        .run();
    }
  }

  // -------------------------------------------------------------------------
  // Projection parity
  // -------------------------------------------------------------------------

  it('projects the upcoming list exactly like the mock EventView', async () => {
    const fromD1 = await repository.listUpcoming();
    const mock = await services.events.listUpcoming();

    expect(fromD1.map((e) => e.id)).toEqual(mock.map((e) => e.id));
    expect(normalize(fromD1)).toEqual(normalize(mock));
  });

  it('projects the past list exactly like the mock EventView', async () => {
    const fromD1 = await repository.listPast();
    const mock = await services.events.listPast();

    expect(fromD1.map((e) => e.id)).toEqual(mock.map((e) => e.id));
    expect(normalize(fromD1)).toEqual(normalize(mock));
  });

  it('projects the on-sale list and next event exactly like the mock', async () => {
    expect(normalize(await repository.listOnSale())).toEqual(
      normalize(await services.events.listOnSale()),
    );
    expect(normalize(await repository.nextEvent())).toEqual(
      normalize(await services.events.nextEvent()),
    );
  });

  it('projects getBySlug exactly like the mock for every public slug', async () => {
    const slugs = (await services.events.listPublicSlugs()).map((entry) => entry.slug);
    expect(slugs.length).toBeGreaterThan(0);

    for (const slug of slugs) {
      const fromD1 = await repository.getBySlug(slug);
      const mock = await services.events.getBySlug(slug);
      expect(fromD1, slug).not.toBeNull();
      expect(normalize(fromD1), slug).toEqual(normalize(mock));
    }

    expect(new Set((await repository.listPublicSlugs()).map((entry) => entry.slug))).toEqual(
      new Set(slugs),
    );
  });

  it('returns null for an unknown slug rather than throwing', async () => {
    expect(await repository.getBySlug('no-such-gig')).toBeNull();
  });

  it('returns no database column names from the projection', async () => {
    const json = JSON.stringify(await repository.listUpcoming());
    expect(json).not.toMatch(/"(venue_id|starts_at|doors_at|poster_asset_id|link_instagram)"/);
  });

  // -------------------------------------------------------------------------
  // Public visibility, enforced in SQL
  // -------------------------------------------------------------------------

  it('never returns a draft from any public query', async () => {
    const draftSlug = 'brass-tacks-new-year-social';
    const draftId = 'evt_brass_tacks_nye';

    expect((await repository.listUpcoming()).some((e) => e.id === draftId)).toBe(false);
    expect((await repository.listPast()).some((e) => e.id === draftId)).toBe(false);
    expect((await repository.listOnSale()).some((e) => e.id === draftId)).toBe(false);
    expect(
      (await repository.listPublicSlugs()).some((entry) => entry.slug === draftSlug),
    ).toBe(false);
    expect(await repository.getBySlug(draftSlug)).toBeNull();
  });

  it('never returns an archived event from any public query', async () => {
    const { id, slug } = await insertProbeEvent({
      status: 'archived',
      startsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    });

    try {
      expect((await repository.listUpcoming()).some((e) => e.id === id)).toBe(false);
      expect((await repository.listPast()).some((e) => e.id === id)).toBe(false);
      expect((await repository.listOnSale()).some((e) => e.id === id)).toBe(false);
      expect((await repository.listPublicSlugs()).some((entry) => entry.slug === slug)).toBe(false);
      expect(await repository.getBySlug(slug)).toBeNull();
    } finally {
      await deleteProbeEvent(id);
    }
  });

  it('excludes draft and archived in SQL, not after fetching', async () => {
    const { db: counted, queries } = instrument(db);
    const instrumented = createD1EventRepository(counted);

    await instrumented.listUpcoming();
    await instrumented.getBySlug('the-glass-hearts-lomax-rooms');

    const eventsQueries = queries.filter((sql) => /from events\b/.test(sql));
    expect(eventsQueries.length).toBeGreaterThan(0);
    for (const sql of eventsQueries) {
      expect(sql).toMatch(
        /status in \('published', 'postponed', 'cancelled', 'completed'\)/,
      );
    }
  });

  it('keeps cancelled and postponed events publicly visible, and off sale', async () => {
    const upcoming = await repository.listUpcoming();
    const cancelled = upcoming.find((e) => e.slug === 'paper-lions-the-cellar');
    const postponed = upcoming.find((e) => e.slug === 'saltwater-parade-parr-street-hall');

    expect(cancelled?.status).toBe('cancelled');
    expect(postponed?.status).toBe('postponed');
    expect(cancelled?.onSale).toBe(false);
    expect(postponed?.onSale).toBe(false);
    expect(cancelled?.statusMessage).toBeTruthy();
    expect(postponed?.statusMessage).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Date semantics
  // -------------------------------------------------------------------------

  it('derives past/upcoming from hasFinished(), never from status', async () => {
    const pastStamp = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const futureStamp = new Date(Date.now() + 10 * 86_400_000).toISOString();

    const pastPublished = await insertProbeEvent({
      status: 'published',
      startsAt: pastStamp,
      endsAt: new Date(Date.parse(pastStamp) + 3 * 3_600_000).toISOString(),
    });
    const futureCompleted = await insertProbeEvent({
      status: 'completed',
      startsAt: futureStamp,
      endsAt: new Date(Date.parse(futureStamp) + 3 * 3_600_000).toISOString(),
    });

    try {
      const pastView = await repository.getBySlug(pastPublished.slug);
      const futureView = await repository.getBySlug(futureCompleted.slug);

      expect(pastView?.status).toBe('published');
      expect(pastView?.isPast).toBe(true);
      expect(futureView?.status).toBe('completed');
      expect(futureView?.isPast).toBe(false);

      const upcomingIds = (await repository.listUpcoming()).map((e) => e.id);
      const pastIds = (await repository.listPast()).map((e) => e.id);
      expect(upcomingIds).toContain(futureCompleted.id);
      expect(upcomingIds).not.toContain(pastPublished.id);
      expect(pastIds).toContain(pastPublished.id);
      expect(pastIds).not.toContain(futureCompleted.id);
    } finally {
      await deleteProbeEvent(pastPublished.id);
      await deleteProbeEvent(futureCompleted.id);
    }
  });

  it('uses the curfew, falling back to start + 4 hours, at the exact boundary', async () => {
    const now = new Date('2026-07-01T20:00:00.000Z');
    const at = (offsetMs: number): string => new Date(now.getTime() + offsetMs).toISOString();
    const fixed = createD1EventRepository(db, () => now);

    const justFinished = await insertProbeEvent({
      startsAt: at(-5 * 3_600_000),
      endsAt: at(-1),
    });
    const notYetFinished = await insertProbeEvent({
      startsAt: at(-5 * 3_600_000),
      endsAt: at(1),
    });
    const noCurfewFinished = await insertProbeEvent({
      startsAt: at(-4 * 3_600_000 - 1),
      endsAt: null,
    });
    const noCurfewRunning = await insertProbeEvent({
      startsAt: at(-4 * 3_600_000 + 1),
      endsAt: null,
    });

    try {
      expect((await fixed.getBySlug(justFinished.slug))?.isPast).toBe(true);
      expect((await fixed.getBySlug(notYetFinished.slug))?.isPast).toBe(false);
      expect((await fixed.getBySlug(noCurfewFinished.slug))?.isPast).toBe(true);
      expect((await fixed.getBySlug(noCurfewRunning.slug))?.isPast).toBe(false);
    } finally {
      await deleteProbeEvent(justFinished.id);
      await deleteProbeEvent(notYetFinished.id);
      await deleteProbeEvent(noCurfewFinished.id);
      await deleteProbeEvent(noCurfewRunning.id);
    }
  });

  it('formats a British Summer Time instant in Europe/London', async () => {
    const now = new Date('2026-07-01T20:00:00.000Z');
    const fixed = createD1EventRepository(db, () => now);
    const probe = await insertProbeEvent({ startsAt: now.toISOString(), endsAt: at(now, 3 * 3_600_000) });

    try {
      const view = await fixed.getBySlug(probe.slug);
      // 20:00 UTC on 1 July 2026 is 21:00 in London (BST).
      expect(view?.startsLabel).toBe('21:00');
      expect(view?.doorsLabel).toBe('21:00');
      expect(view?.dateLabel).toContain('July');
    } finally {
      await deleteProbeEvent(probe.id);
    }
  });

  // -------------------------------------------------------------------------
  // Projection detail
  // -------------------------------------------------------------------------

  it('preserves the operator-defined line-up order, not alphabetical order', async () => {
    // paper-lions-the-cellar-summer is Paper Lions (0) then LEDGER (1);
    // alphabetically LEDGER comes first, so this order is only correct if the
    // position column is honoured.
    const view = await repository.getBySlug('paper-lions-the-cellar-summer');
    expect(view?.lineup.map((entry) => entry.artist.id)).toEqual(['art_paper_lions', 'art_ledger']);
    expect(view?.lineup.map((entry) => entry.position)).toEqual([0, 1]);
    expect(view?.lineup.map((entry) => entry.billing)).toEqual(['headline', 'support']);
  });

  it('orders a line-up by position however the rows were inserted', async () => {
    const startsAt = new Date(Date.now() + 8 * 86_400_000).toISOString();
    const probe = await insertProbeEvent({ startsAt });
    await insertLineup(probe.id, [
      { artistId: 'art_ledger', position: 2, billingNote: 'Opener' },
      { artistId: 'art_glass_hearts', position: 0 },
      { artistId: 'art_mara_veil', position: 1, billingNote: 'Solo set' },
    ]);

    try {
      const view = await repository.getBySlug(probe.slug);
      expect(view?.lineup.map((entry) => entry.position)).toEqual([0, 1, 2]);
      expect(view?.lineup.map((entry) => entry.artist.id)).toEqual([
        'art_glass_hearts',
        'art_mara_veil',
        'art_ledger',
      ]);
      expect(view?.lineup.map((entry) => entry.billing)).toEqual([
        'headline',
        'support',
        'opener',
      ]);
      expect(view?.lineup[1]?.billingNote).toBe('Solo set');
    } finally {
      await deleteProbeEvent(probe.id);
    }
  });

  it('projects the venue, line-up artists, ticket types and media', async () => {
    const view = await repository.getBySlug('the-glass-hearts-lomax-rooms');
    expect(view).not.toBeNull();

    expect(view?.venue.name).toBe('The Lomax Rooms');
    expect(view?.venue.city).toBe('Preston');
    expect(view?.venue.capacity).toBe(220);
    expect(view?.venue.accessibilityInfo).toBeTruthy();

    expect(view?.lineup.map((entry) => entry.artist.name)).toEqual([
      'The Glass Hearts',
      'Mara Veil',
      'Second City Sound',
    ]);
    expect(view?.lineup[0]?.imageUrl).toBe('/media/artist-glass-hearts.svg');
    expect(view?.lineup[0]?.artist.links.instagram).toContain('instagram');

    // Hidden guest-list types must not reach the public projection.
    expect(view?.ticketTypes.map((t) => t.id)).toEqual(['tt_gh_early', 'tt_gh_ga']);
    expect(view?.ticketTypes.map((t) => t.priceLabel)).toEqual(['£7', '£10']);
    expect(view?.ticketTypes.every((t) => t.maxPerOrder === 6)).toBe(true);
    expect(view?.ticketTypes[0]?.availability).toBe('sold-out');
    expect(view?.ticketTypes[1]?.availability).toBe('selling-fast');

    expect(view?.posterUrl).toBe('/media/poster-glass-hearts.svg');
    expect(view?.heroUrl).toBe('/media/hero-glass-hearts.svg');
    expect(view?.heroAlt).toBeTruthy();
    expect(view?.links).toEqual({
      instagram: 'https://example.com/instagram/ampedup/glasshearts',
      facebook: 'https://example.com/facebook/events/glasshearts',
    });
    expect(view?.photography?.credit).toBe('AnyaParallax');
  });

  it('falls back from hero to poster and carries galleries only where they exist', async () => {
    const noHero = await repository.getBySlug('saltwater-parade-parr-street-hall');
    expect(noHero?.posterUrl).toBe('/media/poster-saltwater.svg');
    expect(noHero?.heroUrl).toBe(noHero?.posterUrl);
    expect(noHero?.heroAlt).toBe(noHero?.posterAlt);
    expect(noHero?.gallery).toEqual([]);

    const gallery = await repository.getBySlug('hollow-coast-parr-street-hall');
    expect(gallery?.gallery.map((asset) => asset.id)).toEqual([
      'med_gal_01',
      'med_gal_02',
      'med_gal_03',
    ]);
    expect(gallery?.gallery.every((asset) => asset.alt.length > 0)).toBe(true);
  });

  it('presents absent optionals the way the mock EventView does', async () => {
    const view = await repository.getBySlug('paper-lions-the-cellar');
    expect(view).not.toBeNull();

    // Keys are present with an undefined value, exactly as the mock produces.
    expect('photography' in (view as object)).toBe(true);
    expect(view?.photography).toBeUndefined();
    expect('heroUrl' in (view as object)).toBe(true);
    expect(view?.heroUrl).toBeUndefined();
    expect(view?.posterUrl).toBeUndefined();
    expect(view?.accessibilityNotes).toBeUndefined();
    expect(view?.statusMessage).toBeTruthy();
    expect(view?.ticketTypes).toHaveLength(1);
  });

  it('keeps empty collections empty rather than absent', async () => {
    const startsAt = new Date(Date.now() + 9 * 86_400_000).toISOString();
    const probe = await insertProbeEvent({ startsAt });

    try {
      const view = await repository.getBySlug(probe.slug);
      expect(view?.ticketTypes).toEqual([]);
      expect(view?.lineup).toEqual([]);
      expect(view?.gallery).toEqual([]);
      expect(view?.availability).toBe('unavailable');
      expect(view?.onSale).toBe(false);
      expect(view?.priceFromInPence).toBeUndefined();
    } finally {
      await deleteProbeEvent(probe.id);
    }
  });

  it('does not expose internal notes through the public service', async () => {
    expect(await repository.getBySlug('brass-tacks-new-year-social')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // N+1
  // -------------------------------------------------------------------------

  it('loads a whole listing in a bounded number of queries', async () => {
    const { db: counted, queries } = instrument(db);
    const instrumented = createD1EventRepository(counted);

    const many = await instrumented.listUpcoming();
    const manyCount = queries.length;
    expect(many.length).toBeGreaterThan(1);

    queries.length = 0;
    const one = await instrumented.getBySlug('the-glass-hearts-lomax-rooms');
    expect(one).not.toBeNull();
    const oneCount = queries.length;

    // Same statement count for one event or the whole diary: batched, not N+1.
    const publicCount = (await repository.listPublicSlugs()).length;
    expect(manyCount).toBe(oneCount);
    expect(manyCount).toBeLessThanOrEqual(10);
    expect(manyCount).toBeLessThan(publicCount);
  });

  // -------------------------------------------------------------------------
  // Service selection
  // -------------------------------------------------------------------------

  it('keeps ArtistService.eventsFor() on the D1 event data when DB is bound', async () => {
    const d1Events = await d1Artists.eventsFor('art_mara_veil');
    const mockEvents = await services.artists.eventsFor('art_mara_veil');

    expect(d1Events.length).toBeGreaterThan(0);
    expect(normalize(d1Events)).toEqual(normalize(mockEvents));

    // A new D1 event with Mara Veil on the bill is visible through eventsFor(),
    // which fixture data cannot be.
    const startsAt = new Date(Date.now() + 11 * 86_400_000).toISOString();
    const probe = await insertProbeEvent({ startsAt });
    await insertLineup(probe.id, [{ artistId: 'art_mara_veil', position: 0 }]);

    try {
      const withProbe = await d1Artists.eventsFor('art_mara_veil');
      expect(withProbe.some((event) => event.id === probe.id)).toBe(true);
      expect(mockEvents.some((event) => event.id === probe.id)).toBe(false);
    } finally {
      await deleteProbeEvent(probe.id);
    }
  });

  it('keeps the accepted VenueService and ArtistService D1-backed', async () => {
    expect((await d1Venues.getBySlug('the-lomax-rooms'))?.name).toBe('The Lomax Rooms');
    expect((await d1Artists.list()).length).toBe((await services.artists.list()).length);
    expect((await d1Artists.getBySlug('the-glass-hearts'))?.id).toBe('art_glass_hearts');
  });

  it('selects D1 events and leaves unrelated services mocked', async () => {
    const bound = createServices(db);
    const unbound = createServices(undefined);

    expect((await bound.events.listUpcoming()).map((e) => e.id)).toEqual(
      (await unbound.events.listUpcoming()).map((e) => e.id),
    );

    // The event service is D1-backed: a probe event exists only in D1.
    const startsAt = new Date(Date.now() + 12 * 86_400_000).toISOString();
    const probe = await insertProbeEvent({ startsAt });
    try {
      expect((await bound.events.listUpcoming()).some((e) => e.id === probe.id)).toBe(true);
      expect((await unbound.events.listUpcoming()).some((e) => e.id === probe.id)).toBe(false);
    } finally {
      await deleteProbeEvent(probe.id);
    }

    expect((await bound.admin.listAll()).map((e) => e.id)).toEqual(
      (await unbound.admin.listAll()).map((e) => e.id),
    );
    expect((await bound.media.get('med_og_default'))?.url).toBe(
      (await unbound.media.get('med_og_default'))?.url,
    );
    expect((await bound.social.listFeatured()).map((s) => s.post.id)).toEqual(
      (await unbound.social.listFeatured()).map((s) => s.post.id),
    );
    expect((await bound.orders.listRecent(5)).map((o) => o.order.id)).toEqual(
      (await unbound.orders.listRecent(5)).map((o) => o.order.id),
    );
    expect((await bound.enquiries.list()).map((e) => e.enquiry.id)).toEqual(
      (await unbound.enquiries.list()).map((e) => e.enquiry.id),
    );
    expect(await bound.mailingList.counts()).toEqual(await unbound.mailingList.counts());
    expect((await bound.audit.listRecent(3)).map((a) => a.action)).toEqual(
      (await unbound.audit.listRecent(3)).map((a) => a.action),
    );
  });

  it('getServices() picks D1 events when the runtime exposes DB, and caches per module instance', async () => {
    // Unbound module instance (ordinary Node/Vitest) is the fixture set.
    expect(services.events).toBeDefined();

    vi.resetModules();
    vi.doMock('cloudflare:workers', () => ({ env: { DB: db } }));
    try {
      const fresh = await import('../src/services/index.ts');
      const bound = fresh.getServices();
      // Cached: the same instance is returned on a second call.
      expect(fresh.getServices()).toBe(bound);

      const startsAt = new Date(Date.now() + 13 * 86_400_000).toISOString();
      const probe = await insertProbeEvent({ startsAt });
      try {
        expect((await bound.events.listUpcoming()).some((e) => e.id === probe.id)).toBe(true);
        expect((await services.events.listUpcoming()).some((e) => e.id === probe.id)).toBe(false);
      } finally {
        await deleteProbeEvent(probe.id);
      }
    } finally {
      vi.doUnmock('cloudflare:workers');
      vi.resetModules();
    }
  });
});

/** Small helper kept local to this file; mirrors the fixture's +offset clock. */
function at(base: Date, offsetMs: number): string {
  return new Date(base.getTime() + offsetMs).toISOString();
}
