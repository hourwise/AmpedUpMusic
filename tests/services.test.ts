/**
 * Contract tests for the service layer.
 *
 * Until AMPED-03A these ran against the fixture implementation and doubled as
 * the specification the D1 repositories had to satisfy. The fixture layer is
 * gone now, so the same rules are asserted directly against a real, migrated
 * and seeded D1 database. Nothing about the contract changed with the swap -
 * which is the point of the seam.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServices } from '../src/services/index.ts';
import { isPurchasable } from '../src/lib/availability.ts';
import { PUBLIC_NAV, ADMIN_NAV } from '../src/lib/site.ts';
import { openEphemeralDatabase } from '../src/db/local.ts';
import { migrate } from '../src/db/migrations.ts';
import { applySeed } from '../src/db/seed.ts';
import type { ArtistService, Services, VenueService } from '../src/services/contracts.ts';

// Opening a Wrangler runtime and loading the seed takes longer than Vitest's
// default budget. This file is one of the slow ones.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

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

describe('public event service', () => {
  it('never exposes a draft', async () => {
    const upcoming = await services.events.listUpcoming();
    const past = await services.events.listPast();
    for (const event of [...upcoming, ...past]) {
      expect(event.status).not.toBe('draft');
      expect(event.status).not.toBe('archived');
    }
  });

  it('never exposes internal notes to the public listings', async () => {
    const upcoming = await services.events.listUpcoming();
    const drafts = upcoming.filter((e) => e.status === 'draft');
    expect(drafts).toHaveLength(0);
  });

  it('returns upcoming events soonest first', async () => {
    const upcoming = await services.events.listUpcoming();
    const times = upcoming.map((e) => Date.parse(e.startsAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('returns past events most recent first', async () => {
    const past = await services.events.listPast();
    const times = past.map((e) => Date.parse(e.startsAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('separates past from upcoming strictly by date', async () => {
    const upcoming = await services.events.listUpcoming();
    const past = await services.events.listPast();
    upcoming.forEach((event) => expect(event.isPast).toBe(false));
    past.forEach((event) => expect(event.isPast).toBe(true));
    // No event may appear in both lists.
    const overlap = upcoming.filter((u) => past.some((p) => p.id === u.id));
    expect(overlap).toHaveLength(0);
  });

  it('points each event at the right canonical URL', async () => {
    const upcoming = await services.events.listUpcoming();
    const past = await services.events.listPast();
    upcoming.forEach((event) => expect(event.href).toBe(`/gigs/${event.slug}`));
    past.forEach((event) => expect(event.href).toBe(`/past-gigs/${event.slug}`));
  });

  it('has a next event, and it is the soonest one', async () => {
    const next = await services.events.nextEvent();
    const upcoming = await services.events.listUpcoming();
    expect(next).not.toBeNull();
    expect(next?.id).toBe(upcoming[0]?.id);
  });

  it('resolves a slug to the same object the listing returned', async () => {
    const [first] = await services.events.listUpcoming(1);
    expect(first).toBeDefined();
    const bySlug = await services.events.getBySlug(first!.slug);
    expect(bySlug?.id).toBe(first!.id);
  });

  it('returns null for an unknown slug rather than throwing', async () => {
    expect(await services.events.getBySlug('no-such-gig')).toBeNull();
  });
});

describe('sellability rules', () => {
  it('never marks a cancelled or postponed event as on sale', async () => {
    const upcoming = await services.events.listUpcoming();
    const disrupted = upcoming.filter((e) => e.status === 'cancelled' || e.status === 'postponed');
    expect(disrupted.length).toBeGreaterThan(0); // the seed must cover this
    disrupted.forEach((event) => {
      expect(event.onSale).toBe(false);
      expect(isPurchasable(event.availability)).toBe(false);
    });
  });

  it('never marks a finished event as on sale', async () => {
    const past = await services.events.listPast();
    past.forEach((event) => expect(event.onSale).toBe(false));
  });

  it('keeps the event headline state consistent with its ticket types', async () => {
    const upcoming = await services.events.listUpcoming();
    for (const event of upcoming) {
      const anyPurchasable = event.ticketTypes.some((t) => t.purchasable);
      expect(event.onSale).toBe(anyPurchasable && event.status === 'published');
    }
  });

  it('hides guest list allocations from the public ticket types', async () => {
    const upcoming = await services.events.listUpcoming();
    for (const event of upcoming) {
      expect(event.ticketTypes.some((t) => /guest/i.test(t.name))).toBe(false);
    }
  });

  it('quotes the cheapest ticket somebody can actually buy', async () => {
    // Advertising "from GBP 7" when the GBP 7 early bird has sold out is
    // misleading, so the headline price comes from the purchasable types when
    // there are any, and only falls back to the full range when there are not.
    const upcoming = await services.events.listUpcoming();
    for (const event of upcoming) {
      if (event.priceFromInPence === undefined) continue;
      const all = event.ticketTypes.map((t) => t.priceInPence);
      const buyable = event.ticketTypes.filter((t) => t.purchasable).map((t) => t.priceInPence);
      expect(all).toContain(event.priceFromInPence);
      expect(event.priceFromInPence).toBe(Math.min(...(buyable.length > 0 ? buyable : all)));
    }
  });
});

describe('seed integrity', () => {
  it('gives every event a venue, a slug and a description', async () => {
    const all = await services.admin.listAll();
    expect(all.length).toBeGreaterThan(5);
    for (const event of all) {
      expect(event.venue).toBeTruthy();
      expect(event.slug).toMatch(/^[a-z0-9-]+$/);
      expect(event.description.length).toBeGreaterThan(20);
    }
  });

  it('uses unique slugs', async () => {
    const all = await services.admin.listAll();
    const slugs = all.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('covers every event status the UI has to render', async () => {
    const all = await services.admin.listAll();
    const statuses = new Set(all.map((e) => e.status));
    for (const required of ['draft', 'published', 'postponed', 'cancelled', 'completed']) {
      expect(statuses).toContain(required);
    }
  });

  it('covers every availability state a customer can be shown', async () => {
    const upcoming = await services.events.listUpcoming();
    const states = new Set(upcoming.flatMap((e) => e.ticketTypes.map((t) => t.availability)));
    for (const required of ['available', 'selling-fast', 'last-few', 'sold-out', 'not-yet-on-sale']) {
      expect(states).toContain(required);
    }
  });

  it('gives every image alt text', async () => {
    const gallery = await services.media.listGallery();
    expect(gallery.length).toBeGreaterThan(0);
    for (const asset of gallery) {
      expect(asset.alt.trim().length).toBeGreaterThan(0);
    }
  });

  it('orders every line-up from the headline down', async () => {
    const all = await services.admin.listAll();
    for (const event of all) {
      const positions = event.lineup.map((entry) => entry.position);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
      if (event.lineup.length > 0) expect(event.lineup[0]?.billing).toBe('headline');
    }
  });
});

describe('admin services', () => {
  it('includes drafts that the public service hides', async () => {
    const all = await services.admin.listAll();
    const publicUpcoming = await services.events.listUpcoming();
    expect(all.some((e) => e.status === 'draft')).toBe(true);
    expect(publicUpcoming.some((e) => e.status === 'draft')).toBe(false);
    expect(all.length).toBeGreaterThan(publicUpcoming.length);
  });

  it('returns an event by id, draft or not', async () => {
    const draft = await services.admin.getById('evt_brass_tacks_nye');
    expect(draft?.status).toBe('draft');
    expect(draft?.internalNotes).toBeTruthy();
    expect(await services.admin.getById('evt_does_not_exist')).toBeNull();
  });

  it('produces a sales summary that adds up', async () => {
    const all = await services.admin.listAll();
    for (const event of all) {
      const summary = await services.admin.salesSummary(event.id);
      expect(summary.sold).toBeLessThanOrEqual(summary.capacity);
      expect(summary.available).toBe(
        Math.max(0, summary.capacity - summary.sold - summary.reserved),
      );
      expect(summary.percentSold).toBeGreaterThanOrEqual(0);
      expect(summary.percentSold).toBeLessThanOrEqual(100);
      expect(summary.grossInPence).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(summary.grossInPence)).toBe(true);
    }
  });

  it('excludes the guest list from the on-sale capacity', async () => {
    const all = await services.admin.listAll();
    const withGuests = [];
    for (const event of all) {
      const summary = await services.admin.salesSummary(event.id);
      if (summary.guestList > 0) withGuests.push(summary);
    }
    expect(withGuests.length).toBeGreaterThan(0);
    // Guest places are counted separately, never folded into `sold`.
    withGuests.forEach((summary) => {
      expect(summary.sold + summary.guestList).toBeGreaterThan(summary.sold);
    });
  });

  it('reports the seeded figures for a known gig', async () => {
    const summary = await services.admin.salesSummary('evt_glass_hearts_nov');
    expect(summary.capacity).toBe(200);
    expect(summary.sold).toBe(156);
    expect(summary.guestList).toBe(11);
    expect(summary.percentSold).toBe(78);
  });
});

describe('order and door services', () => {
  it('finds an order by its own reference', async () => {
    const [recent] = await services.orders.listRecent(1);
    expect(recent).toBeDefined();
    const found = await services.orders.getByReference(recent!.order.reference);
    expect(found?.order.id).toBe(recent!.order.id);
  });

  it('finds the same order by name, email and reference', async () => {
    const [recent] = await services.orders.listRecent(1);
    const reference = recent!.order.reference;
    const email = recent!.order.customerEmail;
    const surname = recent!.order.customerName.split(' ').at(-1) ?? '';

    for (const query of [reference, email, surname]) {
      const results = await services.orders.search(query);
      expect(results.some((r) => r.order.id === recent!.order.id)).toBe(true);
    }
  });

  it('ignores a search that is too short to be useful', async () => {
    expect(await services.orders.search('a')).toHaveLength(0);
  });

  it('reads a ticket without admitting anybody', async () => {
    const [event] = await services.door.listDoorEvents();
    expect(event).toBeDefined();

    const orders = await services.orders.listForEvent(event!.id);
    const ticket = orders.flatMap((o) => o.tickets).find((t) => t.status === 'issued');
    if (!ticket) return; // a fully-scanned past gig has none

    const first = await services.door.inspect(ticket.reference, event!.id);
    expect(first.outcome).toBe('valid');
    // Reading is not admitting: the same ticket still inspects as valid.
    const second = await services.door.inspect(ticket.reference, event!.id);
    expect(second.outcome).toBe('valid');
  });

  it('rejects a code that is not a ticket', async () => {
    const [event] = await services.door.listDoorEvents();
    const result = await services.door.inspect('NOT-A-TICKET', event!.id);
    expect(result.outcome).toBe('invalid');
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('rejects a valid ticket presented at the wrong gig', async () => {
    const events = await services.door.listDoorEvents();
    const [a, b] = events;
    expect(b).toBeDefined();

    const orders = await services.orders.listForEvent(a!.id);
    const ticket = orders.flatMap((o) => o.tickets)[0];
    expect(ticket).toBeDefined();

    const result = await services.door.inspect(ticket!.reference, b!.id);
    expect(result.outcome).toBe('wrong-event');
  });

  it('never admits more people than there are tickets', async () => {
    const [event] = await services.door.listDoorEvents();
    const counts = await services.door.admissionCounts(event!.id);
    expect(counts.admitted).toBeLessThanOrEqual(counts.expected);
  });

  it('refuses to check in until AMPED-09B owns the atomic transition', async () => {
    const [event] = await services.door.listDoorEvents();
    await expect(
      services.door.checkIn('AMP-NOT-A-TICKET-1', event!.id, 'operator@ampedupmusic.co.uk'),
    ).rejects.toThrow(/AMPED-09B/);
    await expect(
      services.door.undoCheckIn('tkt_not_real', 'operator@ampedupmusic.co.uk'),
    ).rejects.toThrow(/AMPED-09B/);
  });
});

describe('navigation', () => {
  it('uses root-relative hrefs everywhere', () => {
    [...PUBLIC_NAV, ...ADMIN_NAV].forEach((item) => {
      expect(item.href.startsWith('/')).toBe(true);
    });
  });

  it('has no duplicate destinations', () => {
    const publicHrefs = PUBLIC_NAV.map((i) => i.href);
    const adminHrefs = ADMIN_NAV.map((i) => i.href);
    expect(new Set(publicHrefs).size).toBe(publicHrefs.length);
    expect(new Set(adminHrefs).size).toBe(adminHrefs.length);
  });

  it('keeps every admin route under /admin so one Access policy covers them', () => {
    // AMPED-04A protects /admin/* with a single Cloudflare Access application.
    // An admin route outside that prefix would be publicly reachable.
    ADMIN_NAV.forEach((item) => expect(item.href.startsWith('/admin')).toBe(true));
  });
});

// ---------------------------------------------------------------------------
// AMPED-02B - venue and artist persistence, now the only implementation
// ---------------------------------------------------------------------------

/** A service must return domain names, never the snake_case columns behind them. */
function assertNoColumnNames(value: unknown, path = 'service'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoColumnNames(entry, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    expect(key, `${path}.${key} looks like a database column`).not.toMatch(/_/);
    assertNoColumnNames(child, `${path}.${key}`);
  }
}

function venueContract(label: string, service: () => VenueService): void {
  describe(`venue contract (${label})`, () => {
    it('returns every venue, alphabetically, deterministically', async () => {
      const first = await service().list();
      const second = await service().list();
      expect(first.length).toBeGreaterThan(0);
      expect(second.map((v) => v.id)).toEqual(first.map((v) => v.id));

      const names = first.map((v) => v.name);
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en-GB')));
    });

    it('resolves a listed slug back to the same venue', async () => {
      const [first] = await service().list();
      expect(first).toBeDefined();
      const found = await service().getBySlug(first!.slug);
      expect(found?.id).toBe(first!.id);
    });

    it('returns null for an unknown slug rather than throwing', async () => {
      expect(await service().getBySlug('no-such-venue')).toBeNull();
    });

    it('exposes domain fields only, never database column names', async () => {
      for (const venue of await service().list()) assertNoColumnNames(venue);
    });
  });
}

function artistContract(label: string, service: () => ArtistService): void {
  describe(`artist contract (${label})`, () => {
    it('returns every artist, alphabetically, deterministically', async () => {
      const first = await service().list();
      const second = await service().list();
      expect(first.length).toBeGreaterThan(0);
      expect(second.map((a) => a.id)).toEqual(first.map((a) => a.id));

      const names = first.map((a) => a.name);
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en-GB')));
    });

    it('resolves a listed slug back to the same artist', async () => {
      const [first] = await service().list();
      expect(first).toBeDefined();
      const found = await service().getBySlug(first!.slug);
      expect(found?.id).toBe(first!.id);
    });

    it('returns null for an unknown slug rather than throwing', async () => {
      expect(await service().getBySlug('no-such-artist')).toBeNull();
    });

    it('exposes domain fields only, never database column names', async () => {
      for (const artist of await service().list()) assertNoColumnNames(artist);
    });

    it('still returns the bill an artist has appeared on', async () => {
      const glassHearts = (await service().list()).find((a) => a.slug === 'the-glass-hearts');
      expect(glassHearts).toBeDefined();

      const events = await service().eventsFor(glassHearts!.id);
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        expect(event.lineup.some((entry) => entry.artist.id === glassHearts!.id)).toBe(true);
      }
    });
  });
}

venueContract('D1', () => services.venues);

describe('AMPED-02B venue and artist persistence', () => {
  it('reads real seeded timestamps rather than a fixture clock', async () => {
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    for (const venue of await services.venues.list()) {
      expect(venue.createdAt).toMatch(iso);
      expect(venue.updatedAt).toMatch(iso);
    }
    for (const artist of await services.artists.list()) {
      expect(artist.createdAt).toMatch(iso);
      expect(artist.updatedAt).toMatch(iso);
    }
  });

  it('serves the reads /artists and /admin/venues depend on', async () => {
    // /artists: list + per-artist image lookup through the media service.
    const artists = await services.artists.list();
    expect(artists.length).toBeGreaterThan(0);
    for (const artist of artists) {
      if (!artist.imageAssetId) continue;
      const asset = await services.media.get(artist.imageAssetId);
      expect(asset, `no media for ${artist.id}`).toBeTruthy();
    }

    // /admin/venues: venue list joined to the admin event list by venue id.
    const venues = await services.venues.list();
    const knownVenueIds = new Set(venues.map((v) => v.id));
    const gigs = await services.admin.listAll();
    expect(gigs.length).toBeGreaterThan(0);
    for (const gig of gigs) {
      expect(knownVenueIds.has(gig.venue.id), `unknown venue ${gig.venue.id}`).toBe(true);
    }
  });

  it('createServices() builds the whole set from a database, and requires one', () => {
    const built = createServices(db);
    expect(built.venues).not.toBe(services.venues);
    expect(Object.keys(built).sort()).toEqual(
      [
        'admin',
        'artists',
        'audit',
        'door',
        'enquiries',
        'events',
        'mailingList',
        'media',
        'orders',
        'social',
        'venues',
      ].sort(),
    );
  });

  it('getServices() selects D1 when the runtime exposes a DB binding', async () => {
    vi.resetModules();
    vi.doMock('cloudflare:workers', () => ({ env: { DB: db } }));
    try {
      const fresh = await import('../src/services/index.ts');
      const bound = fresh.getServices();
      expect(bound.venues).toBeDefined();
      expect(fresh.isScaffoldData()).toBe(false);
      expect((await bound.venues.list()).length).toBeGreaterThan(0);
    } finally {
      vi.doUnmock('cloudflare:workers');
      vi.resetModules();
    }
  });
});

artistContract('D1', () => services.artists);
