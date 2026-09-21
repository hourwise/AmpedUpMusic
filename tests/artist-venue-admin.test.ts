/**
 * AMPED-04C - artist and venue administration.
 *
 * Covers create/edit/archive/delete for both entities, the active-vs-historical
 * split that AMPED-04C0 made possible, the inline "+ Add artist" flow, the
 * explicit AMPED-04B ticket-identity regression, and route protection.
 *
 * Everything runs against an isolated ephemeral D1 with a verified synthetic
 * operator. No Access credentials are involved.
 */

import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { openEphemeralDatabase } from '../src/db/local.ts';
import { migrate } from '../src/db/migrations.ts';
import { applySeed } from '../src/db/seed.ts';
import { createServices } from '../src/services/index.ts';
import { createD1ArtistMutations, createD1ArtistService } from '../src/services/d1/artists.ts';
import { createD1VenueMutations, createD1VenueService } from '../src/services/d1/venues.ts';
import { createD1GigMutations, createD1EventRepository } from '../src/services/d1/events.ts';
import {
  parseArtistInput,
  parseVenueInput,
  parseGigInput,
  ConflictError,
  NotFoundError,
  type ValidatedGigInput,
} from '../src/lib/validation.ts';
import { isProtectedPath } from '../src/lib/access.ts';
import type { Services } from '../src/services/contracts.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXED_NOW = new Date('2026-09-21T10:00:00.000Z');
const OPERATOR = { email: 'anya@ampedupmusicpromo.co.uk', sub: 'access-subject-1' };
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function artistPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Probe Band',
    tagline: 'Loud probe rock',
    biography: 'A band inserted by the AMPED-04C tests, safe to remove.',
    genre: 'Rock',
    basedIn: 'Preston',
    links: { instagram: 'https://example.com/ig' },
    ...overrides,
  };
}

function venuePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Probe Rooms',
    addressLine1: '1 Probe Street',
    city: 'Preston',
    postcode: 'PR1 1AA',
    accessibilityInfo: 'Step-free entrance and an accessible toilet.',
    capacity: '120',
    ...overrides,
  };
}

function parseArtist(payload: Record<string, unknown>) {
  const parsed = parseArtistInput(payload);
  if (!parsed.ok) throw new Error(`unexpected invalid artist: ${JSON.stringify(parsed.fields)}`);
  return parsed.value;
}

function parseVenue(payload: Record<string, unknown>) {
  const parsed = parseVenueInput(payload);
  if (!parsed.ok) throw new Error(`unexpected invalid venue: ${JSON.stringify(parsed.fields)}`);
  return parsed.value;
}

describe('AMPED-04C validation', () => {
  it('rejects a blank artist name and unknown artist fields', () => {
    const blank = parseArtistInput(artistPayload({ name: '   ' }));
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.fields.name).toBeTruthy();

    const unknown = parseArtistInput(artistPayload({ nickname: 'nope' }));
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.fields.nickname).toBe('Unsupported field.');

    const unknownLink = parseArtistInput(artistPayload({ links: { myspace: 'https://x.test' } }));
    expect(unknownLink.ok).toBe(false);
  });

  it('requires valid venue accessibility information', () => {
    expect(parseVenueInput(venuePayload({ accessibilityInfo: undefined })).ok).toBe(false);
    expect(parseVenueInput(venuePayload({ accessibilityInfo: '' })).ok).toBe(false);
    expect(parseVenueInput(venuePayload({ accessibilityInfo: '   ' })).ok).toBe(false);
    expect(parseVenueInput(venuePayload()).ok).toBe(true);
  });

  it('rejects unknown venue fields and bad URLs', () => {
    const unknown = parseVenueInput(venuePayload({ parking: 'yes' }));
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.fields.parking).toBe('Unsupported field.');

    const badUrl = parseVenueInput(venuePayload({ websiteUrl: 'not-a-url' }));
    expect(badUrl.ok).toBe(false);
    if (!badUrl.ok) expect(badUrl.fields.websiteUrl).toBeTruthy();
  });
});

describe('AMPED-04C artist and venue administration', () => {
  let database: Awaited<ReturnType<typeof openEphemeralDatabase>>;
  let db: D1Database;
  let services: Services;
  let artists: ReturnType<typeof createD1ArtistService>;
  let venues: ReturnType<typeof createD1VenueService>;
  let artistMutations: ReturnType<typeof createD1ArtistMutations>;
  let venueMutations: ReturnType<typeof createD1VenueMutations>;
  let counter = 0;

  beforeAll(async () => {
    database = await openEphemeralDatabase();
    db = database.db;
    await migrate(db);
    await applySeed(db);

    services = createServices(db);
    artists = createD1ArtistService(db, createD1EventRepository(db));
    venues = createD1VenueService(db);
    artistMutations = createD1ArtistMutations(db, () => FIXED_NOW, (p) => `${p}_probe${++counter}`);
    venueMutations = createD1VenueMutations(db, () => FIXED_NOW, (p) => `${p}_probe${++counter}`);
  });

  afterAll(async () => {
    await database.dispose();
  });

  async function auditFor(entityId: string) {
    const { results } = await db
      .prepare('select action, actor_email from audit_log where entity_id = ? order by occurred_at')
      .bind(entityId)
      .all<{ action: string; actor_email: string }>();
    return results;
  }

  // -- artists ---------------------------------------------------------------

  it('creates an artist with a generated unique slug and an audit row', async () => {
    const created = await artistMutations.create(parseArtist(artistPayload()), OPERATOR);
    const row = await db
      .prepare('select slug, archived_at from artists where id = ?')
      .bind(created.id)
      .first<{ slug: string; archived_at: string | null }>();

    expect(created.slug).toBe('probe-band');
    expect(row?.slug).toBe('probe-band');
    expect(row?.archived_at).toBeNull();

    const audit = await auditFor(created.id);
    expect(audit).toEqual([{ action: 'artist.created', actor_email: OPERATOR.email }]);
  });

  it('resolves a slug collision deterministically', async () => {
    const first = await artistMutations.create(parseArtist(artistPayload({ name: 'Collision Act' })), OPERATOR);
    const second = await artistMutations.create(parseArtist(artistPayload({ name: 'Collision Act' })), OPERATOR);
    expect(first.slug).toBe('collision-act');
    expect(second.slug).toBe('collision-act-2');
  });

  it('edits an artist and preserves the existing slug', async () => {
    const created = await artistMutations.create(parseArtist(artistPayload({ name: 'Edit Me' })), OPERATOR);
    const result = await artistMutations.update(
      created.id,
      parseArtist(artistPayload({ name: 'Edit Me Renamed', genre: 'Folk' })),
      OPERATOR,
    );

    expect(result.slug).toBe('edit-me');
    const row = await db
      .prepare('select name, slug, genre from artists where id = ?')
      .bind(created.id)
      .first<{ name: string; slug: string; genre: string }>();
    expect(row).toEqual({ name: 'Edit Me Renamed', slug: 'edit-me', genre: 'Folk' });
  });

  it('archives an artist with a server timestamp and refuses a repeat', async () => {
    const created = await artistMutations.create(parseArtist(artistPayload({ name: 'Archive Me' })), OPERATOR);
    await artistMutations.archive(created.id, OPERATOR);

    const row = await db
      .prepare('select archived_at from artists where id = ?')
      .bind(created.id)
      .first<{ archived_at: string }>();
    expect(row?.archived_at).toMatch(ISO);
    expect(Date.parse(row!.archived_at)).toBeGreaterThanOrEqual(FIXED_NOW.getTime());

    await expect(artistMutations.archive(created.id, OPERATOR)).rejects.toBeInstanceOf(ConflictError);

    const audit = await auditFor(created.id);
    expect(audit.some((entry) => entry.action === 'artist.archived')).toBe(true);

    // An archived artist cannot be edited (no silent revival).
    await expect(
      artistMutations.update(created.id, parseArtist(artistPayload()), OPERATOR),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('maps archivedAt through the read service', async () => {
    const created = await artistMutations.create(parseArtist(artistPayload({ name: 'Mapped Archive' })), OPERATOR);
    await artistMutations.archive(created.id, OPERATOR);

    const listed = (await artists.list()).find((artist) => artist.id === created.id);
    expect(listed?.archivedAt).toMatch(ISO);
    expect((await artists.getBySlug('mapped-archive'))?.archivedAt).toMatch(ISO);
  });

  it('separates active selection from historical reads', async () => {
    const created = await artistMutations.create(parseArtist(artistPayload({ name: 'Picker Split' })), OPERATOR);
    expect((await artists.listActive()).some((artist) => artist.id === created.id)).toBe(true);

    await artistMutations.archive(created.id, OPERATOR);

    expect((await artists.listActive()).some((artist) => artist.id === created.id)).toBe(false);
    // Historical read still resolves it.
    expect((await artists.list()).some((artist) => artist.id === created.id)).toBe(true);
  });

  it('refuses to hard-delete a referenced artist and allows an unreferenced one', async () => {
    await expect(artistMutations.remove('art_glass_hearts', OPERATOR)).rejects.toBeInstanceOf(
      ConflictError,
    );
    const still = await db
      .prepare('select id from artists where id = ?')
      .bind('art_glass_hearts')
      .first();
    expect(still).not.toBeNull();

    const bare = await artistMutations.create(parseArtist(artistPayload({ name: 'Delete Me' })), OPERATOR);
    await artistMutations.remove(bare.id, OPERATOR);
    expect(await db.prepare('select id from artists where id = ?').bind(bare.id).first()).toBeNull();
    expect((await auditFor(bare.id)).some((entry) => entry.action === 'artist.deleted')).toBe(true);
  });

  // -- venues ----------------------------------------------------------------

  it('creates a venue and keeps its identity stable through an edit', async () => {
    const created = await venueMutations.create(parseVenue(venuePayload()), OPERATOR);
    expect(created.slug).toBe('probe-rooms');

    const result = await venueMutations.update(
      created.id,
      parseVenue(venuePayload({ name: 'Probe Rooms Renamed', capacity: '150' })),
      OPERATOR,
    );
    expect(result.slug).toBe('probe-rooms');

    const row = await db
      .prepare('select name, slug, capacity, accessibility_info from venues where id = ?')
      .bind(created.id)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      name: 'Probe Rooms Renamed',
      slug: 'probe-rooms',
      capacity: 150,
    });
    expect((await auditFor(created.id)).some((entry) => entry.action === 'venue.updated')).toBe(true);
  });

  it('archives a venue, maps archivedAt and refuses a repeat', async () => {
    const created = await venueMutations.create(parseVenue(venuePayload({ name: 'Archive Rooms' })), OPERATOR);
    await venueMutations.archive(created.id, OPERATOR);

    const row = await db
      .prepare('select archived_at from venues where id = ?')
      .bind(created.id)
      .first<{ archived_at: string }>();
    expect(row?.archived_at).toMatch(ISO);

    await expect(venueMutations.archive(created.id, OPERATOR)).rejects.toBeInstanceOf(ConflictError);
    expect((await auditFor(created.id)).some((entry) => entry.action === 'venue.archived')).toBe(true);

    const listed = (await venues.list()).find((venue) => venue.id === created.id);
    expect(listed?.archivedAt).toMatch(ISO);
    expect((await venues.listActive()).some((venue) => venue.id === created.id)).toBe(false);

    await expect(
      venueMutations.update(created.id, parseVenue(venuePayload()), OPERATOR),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses to hard-delete a referenced venue and allows an unreferenced one', async () => {
    await expect(venueMutations.remove('ven_lomax', OPERATOR)).rejects.toBeInstanceOf(ConflictError);
    expect(await db.prepare('select id from venues where id = ?').bind('ven_lomax').first()).not.toBeNull();

    const bare = await venueMutations.create(parseVenue(venuePayload({ name: 'Delete Rooms' })), OPERATOR);
    await venueMutations.remove(bare.id, OPERATOR);
    expect(await db.prepare('select id from venues where id = ?').bind(bare.id).first()).toBeNull();
  });

  // -- historical resolution -------------------------------------------------

  it('keeps an archived referenced artist and venue in historical event rendering', async () => {
    // Archive both entities the seeded Glass Hearts gig depends on.
    await db
      .prepare('update artists set archived_at = ? where id = ?')
      .bind(FIXED_NOW.toISOString(), 'art_glass_hearts')
      .run();
    await db
      .prepare('update venues set archived_at = ? where id = ?')
      .bind(FIXED_NOW.toISOString(), 'ven_lomax')
      .run();

    const event = await services.events.getBySlug('the-glass-hearts-lomax-rooms');
    expect(event?.venue.id).toBe('ven_lomax');
    expect(event?.lineup.some((entry) => entry.artist.id === 'art_glass_hearts')).toBe(true);

    // ...while neither is offered for new promotions.
    expect((await artists.listActive()).some((artist) => artist.id === 'art_glass_hearts')).toBe(false);
    expect((await venues.listActive()).some((venue) => venue.id === 'ven_lomax')).toBe(false);

    // Restore, so later assertions see the accepted seed state.
    await db.prepare('update artists set archived_at = null where id = ?').bind('art_glass_hearts').run();
    await db.prepare('update venues set archived_at = null where id = ?').bind('ven_lomax').run();
  });

  // -- inline + Add artist ---------------------------------------------------

  it('creates and attaches an artist to a gig in one action', async () => {
    const eventId = 'evt_brass_tacks_nye'; // draft: no orders, safe to attach to
    const before = await db
      .prepare('select coalesce(max(position), -1) + 1 as next from event_artists where event_id = ?')
      .bind(eventId)
      .first<{ next: number }>();

    const created = await artistMutations.createAndAttachToEvent(
      parseArtist(artistPayload({ name: 'Inline Act' })),
      eventId,
      OPERATOR,
    );

    const join = await db
      .prepare('select position from event_artists where event_id = ? and artist_id = ?')
      .bind(eventId, created.id)
      .first<{ position: number }>();
    expect(join?.position).toBe(before?.next);

    const audit = await auditFor(created.id);
    expect(audit.map((entry) => entry.action).sort()).toEqual([
      'artist.attached_to_event',
      'artist.created',
    ]);

    // Cleanup so the seeded line-up is untouched for other suites.
    await db.prepare('delete from event_artists where artist_id = ?').bind(created.id).run();
    await db.prepare('delete from audit_log where entity_id = ?').bind(created.id).run();
    await db.prepare('delete from artists where id = ?').bind(created.id).run();
  });

  it('keeps the existing bill order and appends deterministically', async () => {
    const eventId = 'evt_brass_tacks_nye';
    const existing = await db
      .prepare('select artist_id, position from event_artists where event_id = ? order by position')
      .bind(eventId)
      .all<{ artist_id: string; position: number }>();
    const orderBefore = existing.results.map((row) => row.position);

    const first = await artistMutations.createAndAttachToEvent(
      parseArtist(artistPayload({ name: 'Append One' })),
      eventId,
      OPERATOR,
    );
    const second = await artistMutations.createAndAttachToEvent(
      parseArtist(artistPayload({ name: 'Append Two' })),
      eventId,
      OPERATOR,
    );

    const after = await db
      .prepare('select artist_id, position from event_artists where event_id = ? order by position')
      .bind(eventId)
      .all<{ artist_id: string; position: number }>();

    // Existing positions are unchanged and the headliner still sits at 0.
    expect(after.results.slice(0, orderBefore.length).map((row) => row.position)).toEqual(orderBefore);
    expect(after.results[0]?.position).toBe(0);
    expect(second.position).toBe(first.position + 1);

    // A duplicate join for the same artist/event is refused by the primary key.
    await expect(
      db
        .prepare('insert into event_artists (event_id, artist_id, position) values (?, ?, ?)')
        .bind(eventId, first.id, 99)
        .run(),
    ).rejects.toThrow(/unique|constraint/i);

    for (const id of [first.id, second.id]) {
      await db.prepare('delete from event_artists where artist_id = ?').bind(id).run();
      await db.prepare('delete from audit_log where entity_id = ?').bind(id).run();
      await db.prepare('delete from artists where id = ?').bind(id).run();
    }
  });

  it('does not revive an archived artist when a similar name is submitted', async () => {
    const original = await artistMutations.create(
      parseArtist(artistPayload({ name: 'Ghost Act' })),
      OPERATOR,
    );
    await artistMutations.archive(original.id, OPERATOR);

    const created = await artistMutations.createAndAttachToEvent(
      parseArtist(artistPayload({ name: 'Ghost Act' })),
      'evt_brass_tacks_nye',
      OPERATOR,
    );

    expect(created.id).not.toBe(original.id);
    expect(created.slug).toBe('ghost-act-2');
    const revived = await db
      .prepare('select archived_at from artists where id = ?')
      .bind(original.id)
      .first<{ archived_at: string | null }>();
    expect(revived?.archived_at).not.toBeNull();

    await db.prepare('delete from event_artists where artist_id = ?').bind(created.id).run();
    await db.prepare('delete from audit_log where entity_id = ?').bind(created.id).run();
    await db.prepare('delete from artists where id = ?').bind(created.id).run();
  });

  it('rolls the whole inline action back when the gig does not exist', async () => {
    const before = await db.prepare('select count(*) as n from artists').first<{ n: number }>();
    await expect(
      artistMutations.createAndAttachToEvent(
        parseArtist(artistPayload({ name: 'No Gig Act' })),
        'evt_does_not_exist',
        OPERATOR,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    const after = await db.prepare('select count(*) as n from artists').first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });
});

// ---------------------------------------------------------------------------
// AMPED-04B ticket-identity regression (explicitly required by 04C)
// ---------------------------------------------------------------------------

describe('04B ticket identity regression', () => {
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

  function toLocalInput(iso: string): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/London',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(iso));
    const get = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((part) => part.type === type)?.value ?? '';
    const hour = get('hour') === '24' ? '00' : get('hour');
    return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`;
  }

  it('edits a referenced ticket type in place without changing its identity', async () => {
    const services = createServices(db);
    const event = await services.admin.getById('evt_glass_hearts_nov');
    expect(event).not.toBeNull();

    const before = await db
      .prepare(
        "select unit_price_in_pence, ticket_type_name from order_items where ticket_type_id = 'tt_gh_ga' limit 1",
      )
      .first<{ unit_price_in_pence: number; ticket_type_name: string }>();
    const ticketsBefore = await db
      .prepare("select count(*) as n from tickets where ticket_type_id = 'tt_gh_ga'")
      .first<{ n: number }>();

    const mutations = createD1GigMutations(db);
    const input = parseGigInput({
      title: event!.title,
      description: event!.description,
      venueId: event!.venue.id,
      doorsAt: toLocalInput(event!.doorsAt),
      startsAt: toLocalInput(event!.startsAt),
      endsAt: event!.endsAt ? toLocalInput(event!.endsAt) : undefined,
      ageRestriction: event!.ageRestriction,
      guestList: '11',
      lineup: event!.lineup.map((entry) => entry.artist.id),
      ticketTypes: event!.ticketTypes.map((ticket) => ({
        id: ticket.id,
        name: ticket.id === 'tt_gh_ga' ? 'General Admission (revised)' : ticket.name,
        price: ticket.id === 'tt_gh_ga' ? '12.50' : (ticket.priceInPence / 100).toFixed(2),
        capacity: String(ticket.inventory.capacity),
        max: String(ticket.maxPerOrder),
      })),
    });
    expect(input.ok).toBe(true);
    if (!input.ok) return;

    await mutations.update('evt_glass_hearts_nov', input.value as ValidatedGigInput, OPERATOR);

    // Identity preserved.
    const row = await db
      .prepare('select id, name, price_in_pence from ticket_types where id = ?')
      .bind('tt_gh_ga')
      .first<{ id: string; name: string; price_in_pence: number }>();
    expect(row?.id).toBe('tt_gh_ga');
    expect(row?.name).toBe('General Admission (revised)');
    expect(row?.price_in_pence).toBe(1250);

    // Historical references still point at the same logical type.
    const orderItems = await db
      .prepare("select count(*) as n from order_items where ticket_type_id = 'tt_gh_ga'")
      .first<{ n: number }>();
    expect(orderItems?.n).toBeGreaterThan(0);
    const ticketsAfter = await db
      .prepare("select count(*) as n from tickets where ticket_type_id = 'tt_gh_ga'")
      .first<{ n: number }>();
    expect(ticketsAfter?.n).toBe(ticketsBefore?.n);

    // Captured order-item values are immutable.
    const after = await db
      .prepare(
        "select unit_price_in_pence, ticket_type_name from order_items where ticket_type_id = 'tt_gh_ga' limit 1",
      )
      .first<{ unit_price_in_pence: number; ticket_type_name: string }>();
    expect(after).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Route protection
// ---------------------------------------------------------------------------

describe('04C API route protection', () => {
  function files(dir: string): string[] {
    if (!statSync(dir, { throwIfNoEntry: false })) return [];
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return files(full);
      return /\.(ts|astro)$/.test(entry) && !entry.startsWith('_') ? [full] : [];
    });
  }

  function toRoutePath(file: string): string {
    return file
      .slice(join(root, 'src', 'pages').length)
      .replace(/\\/g, '/')
      .replace(/\.(ts|astro)$/, '')
      .replace(/\/index$/, '')
      .replace(/\[([^\]]+)\]/g, ':$1');
  }

  it('places every artist/venue API route inside the protected namespace', () => {
    const all = files(join(root, 'src', 'pages', 'api'));
    expect(all.length).toBeGreaterThan(0);
    for (const file of all) {
      const route = toRoutePath(file);
      expect(route.startsWith('/api/admin/'), `${file} -> ${route}`).toBe(true);
      expect(isProtectedPath(route), `${file} -> ${route}`).toBe(true);
    }
  });
});
