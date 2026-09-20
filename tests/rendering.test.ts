/**
 * AMPED-03B - public rendering completeness.
 *
 * Behavioural, not visual. Proves the public lifecycle is driven by D1 and by
 * time, that the two event detail routes agree on one canonical URL, that
 * /tickets reflects real public availability, that a legitimate empty database
 * produces empty results rather than failures, and that the cache policy the
 * pages apply is the documented one.
 *
 * Time boundaries are exercised with controlled timestamps and an injected
 * clock. Nothing here sleeps or depends on the wall clock advancing.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { openEphemeralDatabase } from '../src/db/local.ts';
import { migrate } from '../src/db/migrations.ts';
import { applySeed } from '../src/db/seed.ts';
import { createServices } from '../src/services/index.ts';
import { createD1EventRepository } from '../src/services/d1/events.ts';
import {
  applyPublicCache,
  canonicalEventRedirect,
  LIFECYCLE_REDIRECT_STATUS,
  PUBLIC_CACHE_POLICY,
} from '../src/pages/gigs/_rendering.ts';
import type { Services } from '../src/services/contracts.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe('canonical event routing', () => {
  it('redirects a finished event away from /gigs/[slug] with a 301', () => {
    expect(canonicalEventRedirect({ slug: 'old-show', isPast: true }, 'upcoming')).toEqual({
      location: '/past-gigs/old-show',
      status: 301,
    });
    expect(LIFECYCLE_REDIRECT_STATUS).toBe(301);
  });

  it('redirects an unfinished event away from /past-gigs/[slug] with a 301', () => {
    expect(canonicalEventRedirect({ slug: 'new-show', isPast: false }, 'past')).toEqual({
      location: '/gigs/new-show',
      status: 301,
    });
  });

  it('does not redirect when the requested URL is already canonical', () => {
    expect(canonicalEventRedirect({ slug: 'new-show', isPast: false }, 'upcoming')).toBeNull();
    expect(canonicalEventRedirect({ slug: 'old-show', isPast: true }, 'past')).toBeNull();
  });

  it('never redirects an unknown slug', () => {
    expect(canonicalEventRedirect(null, 'upcoming')).toBeNull();
    expect(canonicalEventRedirect(null, 'past')).toBeNull();
  });
});

describe('cache policy', () => {
  it('publishes a short shared-cache TTL with revalidation', () => {
    expect(PUBLIC_CACHE_POLICY.listing).toContain('s-maxage=60');
    expect(PUBLIC_CACHE_POLICY.listing).toContain('stale-while-revalidate=300');
    expect(PUBLIC_CACHE_POLICY.live).toContain('s-maxage=30');
    expect(PUBLIC_CACHE_POLICY.live).toContain('stale-while-revalidate=60');
    // Browsers must revalidate rather than pin a stale copy.
    expect(PUBLIC_CACHE_POLICY.listing).toContain('max-age=0');
    expect(PUBLIC_CACHE_POLICY.live).toContain('max-age=0');
  });

  it('applies the policy to a response-like object', () => {
    const headers = new Headers();
    applyPublicCache({ headers }, 'live');
    expect(headers.get('Cache-Control')).toBe(PUBLIC_CACHE_POLICY.live);
  });
});

describe('public event lifecycle', () => {
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

  async function insertEvent(options: {
    startsAt: string;
    endsAt?: string | null;
    status?: 'draft' | 'published' | 'postponed' | 'cancelled' | 'completed' | 'archived';
    venueId?: string;
  }): Promise<{ id: string; slug: string }> {
    counter += 1;
    const id = `evt_03b_${counter}`;
    const slug = `03b-probe-${counter}`;
    const stamp = '2026-01-01T00:00:00.000Z';
    await db
      .prepare(
        `insert into events (id, title, slug, status, description, venue_id, doors_at, starts_at, ends_at, age_restriction, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        `Probe 03B ${counter}`,
        slug,
        options.status ?? 'published',
        'A temporary event inserted by the AMPED-03B tests.',
        options.venueId ?? 'ven_lomax',
        options.startsAt,
        options.startsAt,
        options.endsAt ?? null,
        'all-ages',
        stamp,
        stamp,
      )
      .run();
    return { id, slug };
  }

  async function deleteEvent(eventId: string): Promise<void> {
    await db.prepare('delete from tickets where event_id = ?').bind(eventId).run();
    await db.prepare('delete from orders where event_id = ?').bind(eventId).run();
    await db.prepare('delete from ticket_types where event_id = ?').bind(eventId).run();
    await db.prepare('delete from events where id = ?').bind(eventId).run();
  }

  it('rolls the next event over as the current one finishes', async () => {
    const now = new Date('2026-06-15T18:00:00.000Z');
    const at = (offsetMs: number): string => new Date(now.getTime() + offsetMs).toISOString();

    const current = await insertEvent({
      startsAt: at(-1 * 3_600_000),
      endsAt: at(1 * 3_600_000),
    });
    const later = await insertEvent({
      startsAt: at(3 * 3_600_000),
      endsAt: at(4 * 3_600_000),
    });

    try {
      const before = createD1EventRepository(db, () => now);
      expect((await before.nextEvent())?.id).toBe(current.id);

      // Two hours pass; the first show has finished.
      const after = createD1EventRepository(db, () => new Date(now.getTime() + 2 * 3_600_000));
      expect((await after.nextEvent())?.id).toBe(later.id);

      const upcomingIds = (await after.listUpcoming()).map((event) => event.id);
      const pastIds = (await after.listPast()).map((event) => event.id);
      expect(upcomingIds).not.toContain(current.id);
      expect(pastIds).toContain(current.id);
    } finally {
      await deleteEvent(current.id);
      await deleteEvent(later.id);
    }
  });

  it('places an event in exactly one of upcoming and past', async () => {
    const now = new Date('2026-06-15T18:00:00.000Z');
    const repo = createD1EventRepository(db, () => now);

    const upcoming = await repo.listUpcoming();
    const past = await repo.listPast();
    const pastIds = new Set(past.map((event) => event.id));

    for (const event of upcoming) {
      expect(pastIds.has(event.id)).toBe(false);
      expect(event.isPast).toBe(false);
    }
    for (const event of past) expect(event.isPast).toBe(true);
  });

  it('uses the curfew boundary, not the status, to place an event', async () => {
    const now = new Date('2026-07-01T20:00:00.000Z');
    const at = (offsetMs: number): string => new Date(now.getTime() + offsetMs).toISOString();
    const repo = createD1EventRepository(db, () => now);

    const justFinished = await insertEvent({
      startsAt: at(-5 * 3_600_000),
      endsAt: at(-1),
      status: 'published',
    });
    const notYetFinished = await insertEvent({
      startsAt: at(-5 * 3_600_000),
      endsAt: at(1),
      status: 'published',
    });
    const noEndFinished = await insertEvent({
      startsAt: at(-4 * 3_600_000 - 1),
      endsAt: null,
      status: 'published',
    });
    const noEndRunning = await insertEvent({
      startsAt: at(-4 * 3_600_000 + 1),
      endsAt: null,
      status: 'published',
    });
    const futureCompleted = await insertEvent({
      startsAt: at(3 * 3_600_000),
      endsAt: at(4 * 3_600_000),
      status: 'completed',
    });

    try {
      expect((await repo.getBySlug(justFinished.slug))?.isPast).toBe(true);
      expect((await repo.getBySlug(notYetFinished.slug))?.isPast).toBe(false);
      // No explicit end: the accepted start + 4 hours fallback decides.
      expect((await repo.getBySlug(noEndFinished.slug))?.isPast).toBe(true);
      expect((await repo.getBySlug(noEndRunning.slug))?.isPast).toBe(false);
      // A completed status does not make a future event past.
      expect((await repo.getBySlug(futureCompleted.slug))?.isPast).toBe(false);

      const upcomingIds = (await repo.listUpcoming()).map((event) => event.id);
      expect(upcomingIds).toContain(futureCompleted.id);
      expect(upcomingIds).not.toContain(justFinished.id);
    } finally {
      for (const probe of [justFinished, notYetFinished, noEndFinished, noEndRunning, futureCompleted]) {
        await deleteEvent(probe.id);
      }
    }
  });

  it('never routes a draft, archived or unknown slug to a public page', async () => {
    const draft = await insertEvent({
      startsAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      status: 'draft',
    });
    const archived = await insertEvent({
      startsAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      status: 'archived',
    });

    try {
      expect(await services.events.getBySlug(draft.slug)).toBeNull();
      expect(await services.events.getBySlug(archived.slug)).toBeNull();
      expect(await services.events.getBySlug('no-such-event-03b')).toBeNull();
    } finally {
      await deleteEvent(draft.id);
      await deleteEvent(archived.id);
    }
  });
});

describe('/tickets completeness', () => {
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

  async function insertEvent(options: {
    startsAt: string;
    endsAt?: string | null;
    status?: 'published' | 'completed';
  }): Promise<{ id: string; slug: string }> {
    counter += 1;
    const id = `evt_03b_tickets_${counter}`;
    const slug = `03b-tickets-${counter}`;
    const stamp = '2026-01-01T00:00:00.000Z';
    await db
      .prepare(
        `insert into events (id, title, slug, status, description, venue_id, doors_at, starts_at, ends_at, age_restriction, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        `Tickets probe ${counter}`,
        slug,
        options.status ?? 'published',
        'A temporary ticket probe.',
        'ven_lomax',
        options.startsAt,
        options.startsAt,
        options.endsAt ?? null,
        'all-ages',
        stamp,
        stamp,
      )
      .run();
    return { id, slug };
  }

  async function insertType(eventId: string, visibility: 'public' | 'hidden'): Promise<void> {
    counter += 1;
    await db
      .prepare(
        `insert into ticket_types (id, event_id, name, description, price_in_pence, capacity, max_per_order, position, visibility)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(`tt_03b_tickets_${counter}`, eventId, `Type ${counter}`, null, 1200, 40, 4, 0, visibility)
      .run();
  }

  async function remove(eventId: string): Promise<void> {
    await db.prepare('delete from ticket_types where event_id = ?').bind(eventId).run();
    await db.prepare('delete from events where id = ?').bind(eventId).run();
  }

  it('includes upcoming events with a public ticket type', async () => {
    const { id } = await insertEvent({
      startsAt: new Date(Date.now() + 6 * 86_400_000).toISOString(),
    });
    await insertType(id, 'public');
    try {
      const onSale = await services.events.listOnSale();
      expect(onSale.some((event) => event.id === id)).toBe(true);
    } finally {
      await remove(id);
    }
  });

  it('excludes an event whose only ticket type is hidden', async () => {
    const { id, slug } = await insertEvent({
      startsAt: new Date(Date.now() + 6 * 86_400_000).toISOString(),
    });
    await insertType(id, 'hidden');
    try {
      const onSale = await services.events.listOnSale();
      expect(onSale.some((event) => event.id === id)).toBe(false);

      const view = await services.events.getBySlug(slug);
      expect(view?.ticketTypes).toEqual([]);
    } finally {
      await remove(id);
    }
  });

  it('excludes finished events even when they have public ticket types', async () => {
    const { id } = await insertEvent({
      startsAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
      endsAt: new Date(Date.now() - 9 * 86_400_000).toISOString(),
    });
    await insertType(id, 'public');
    try {
      const onSale = await services.events.listOnSale();
      expect(onSale.some((event) => event.id === id)).toBe(false);
    } finally {
      await remove(id);
    }
  });

  it('exposes no hidden guest-list type through the public service', async () => {
    const upcoming = await services.events.listUpcoming();
    for (const event of upcoming) {
      expect(event.ticketTypes.some((type) => type.id.endsWith('_guest'))).toBe(false);
    }
  });
});

describe('dynamic D1 changes propagate across public views', () => {
  let database: Awaited<ReturnType<typeof openEphemeralDatabase>>;
  let db: D1Database;
  let services: Services;

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

  it('moves one row across the boundary and every view follows', async () => {
    const id = 'evt_03b_propagation';
    const slug = '03b-propagation';
    const stamp = '2026-01-01T00:00:00.000Z';
    const futureStart = new Date(Date.now() + 10 * 86_400_000).toISOString();
    const futureEnd = new Date(Date.now() + 10 * 86_400_000 + 3 * 3_600_000).toISOString();

    await db
      .prepare(
        `insert into events (id, title, slug, status, description, venue_id, doors_at, starts_at, ends_at, age_restriction, created_at, updated_at)
         values (?, 'Propagation Probe', ?, 'published', 'A temporary event used to prove propagation.', 'ven_lomax', ?, ?, ?, 'all-ages', ?, ?)`,
      )
      .bind(id, slug, futureStart, futureStart, futureEnd, stamp, stamp)
      .run();
    await db
      .prepare(
        `insert into ticket_types (id, event_id, name, description, price_in_pence, capacity, max_per_order, position, visibility)
         values ('tt_03b_propagation', ?, 'Propagation ticket', null, 900, 30, 4, 0, 'public')`,
      )
      .bind(id)
      .run();

    try {
      // Future: upcoming, on sale, canonical /gigs.
      expect((await services.events.getBySlug(slug))?.isPast).toBe(false);
      expect((await services.events.getBySlug(slug))?.href).toBe(`/gigs/${slug}`);
      expect((await services.events.listUpcoming()).some((e) => e.id === id)).toBe(true);
      expect((await services.events.listOnSale()).some((e) => e.id === id)).toBe(true);
      expect((await services.events.listPast()).some((e) => e.id === id)).toBe(false);

      // Move the gig into the past without touching an operator workflow.
      const pastStart = new Date(Date.now() - 10 * 86_400_000).toISOString();
      const pastEnd = new Date(Date.now() - 10 * 86_400_000 + 3 * 3_600_000).toISOString();
      await db
        .prepare('update events set starts_at = ?, ends_at = ?, doors_at = ? where id = ?')
        .bind(pastStart, pastEnd, pastStart, id)
        .run();

      expect((await services.events.getBySlug(slug))?.isPast).toBe(true);
      expect((await services.events.getBySlug(slug))?.href).toBe(`/past-gigs/${slug}`);
      expect((await services.events.listUpcoming()).some((e) => e.id === id)).toBe(false);
      expect((await services.events.listPast()).some((e) => e.id === id)).toBe(true);
      expect((await services.events.listOnSale()).some((e) => e.id === id)).toBe(false);
    } finally {
      await db.prepare('delete from ticket_types where event_id = ?').bind(id).run();
      await db.prepare('delete from events where id = ?').bind(id).run();
    }
  });
});

describe('a legitimate empty database', () => {
  let database: Awaited<ReturnType<typeof openEphemeralDatabase>>;
  let db: D1Database;
  let services: Services;

  beforeAll(async () => {
    database = await openEphemeralDatabase();
    db = database.db;
    await migrate(db);
    // Deliberately NOT seeded: an empty but valid schema.
    services = createServices(db);
  });

  afterAll(async () => {
    await database.dispose();
  });

  it('returns empty collections rather than throwing', async () => {
    await expect(services.events.listUpcoming()).resolves.toEqual([]);
    await expect(services.events.listPast()).resolves.toEqual([]);
    await expect(services.events.listOnSale()).resolves.toEqual([]);
    await expect(services.events.listPublicSlugs()).resolves.toEqual([]);
    await expect(services.events.nextEvent()).resolves.toBeNull();
    await expect(services.events.getBySlug('nothing')).resolves.toBeNull();
    await expect(services.artists.list()).resolves.toEqual([]);
    await expect(services.venues.list()).resolves.toEqual([]);
    await expect(services.media.listGallery()).resolves.toEqual([]);
    await expect(services.social.listFeatured()).resolves.toEqual([]);
    await expect(services.admin.listAll()).resolves.toEqual([]);
    await expect(services.admin.nextEvent()).resolves.toBeNull();
    await expect(services.door.listDoorEvents()).resolves.toEqual([]);
  });

  it('gives the admin a zeroed sales summary rather than an error', async () => {
    const summary = await services.admin.salesSummary('evt_does_not_exist');
    expect(summary).toMatchObject({ capacity: 0, sold: 0, reserved: 0, available: 0, guestList: 0 });
  });
});
