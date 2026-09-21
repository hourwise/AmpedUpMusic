/**
 * D1-backed PublicEventService and the D1 event lookup ArtistService uses
 * (AMPED-02C).
 *
 * The projection itself lives in ./project.ts; this module is the loader. It
 * fetches the requested events, then the reference data they need, in a
 * bounded number of batched queries - never a query per event (R14 / N+1).
 * For any non-empty batch that is nine statements regardless of whether it
 * covers one event or a hundred:
 *
 *   1. the events themselves (draft/archived excluded in SQL)
 *   2. event_artists for the batch
 *   3. artists for those line-ups
 *   4. venues for those events
 *   5-7. public ticket types, sold and reserved, via ./tickets.ts (AMPED-02D)
 *   8. media referenced by id (posters, heroes, artist portraits)
 *   9. gallery media for those events
 *
 * Ticket-type and inventory arithmetic is not duplicated here: AMPED-02D owns
 * it in ./tickets.ts, and this module only consumes the public projection of
 * it. The nine-statement budget is unchanged because that service issues the
 * same three grouped statements this file used to.
 *
 * Rules held here:
 *  - draft and archived rows are excluded in SQL, never fetched-then-filtered;
 *  - past/upcoming comes from `hasFinished()` on the real timestamps, not from
 *    the status column (R9);
 *  - every statement names its columns and binds its values; the only dynamic
 *    part of any statement is the length of a JSON array, which is itself a
 *    bound parameter and never interpolated.
 */

import type {
  ArtistRow,
  EventArtistRow,
  EventRow,
  MediaAssetRow,
  VenueRow,
} from '@/db/schema.ts';
import { slugify } from '@/lib/text.ts';
import {
  assessReadiness,
  ConflictError,
  isAllowedTransition,
  NotFoundError,
  ValidationError,
  type ReadinessReport,
  type ValidatedGigInput,
} from '@/lib/validation.ts';
import type { EventStatus } from '@/types/domain.ts';
import type { EventView } from '@/types/view.ts';

import type { PublicEventService } from '../contracts.ts';
import { projectEvent, toEvent, type ProjectionData } from './project.ts';
import { createD1TicketInventoryService, type TicketInventoryService } from './tickets.ts';

/**
 * The statuses the public may see at all. Drafts and archives are absent, which
 * is the definition of the SQL guard rather than a TypeScript filter.
 */
const PUBLIC_STATUS_SQL = "status in ('published', 'postponed', 'cancelled', 'completed')";

const EVENT_COLUMNS = [
  'id',
  'title',
  'slug',
  'status',
  'strapline',
  'description',
  'venue_id',
  'doors_at',
  'starts_at',
  'ends_at',
  'age_restriction',
  'accessibility_notes',
  'poster_asset_id',
  'hero_asset_id',
  'link_instagram',
  'link_tiktok',
  'link_facebook',
  'link_youtube',
  'link_spotify',
  'link_bandcamp',
  'link_soundcloud',
  'link_website',
  'photography_credit',
  'photography_gallery_url',
  'photography_photographer_url',
  'internal_notes',
  'status_message',
  'rescheduled_to_event_id',
  'published_at',
  'created_at',
  'updated_at',
].join(', ');

const VENUE_COLUMNS = [
  'id',
  'name',
  'slug',
  'address_line1',
  'address_line2',
  'city',
  'postcode',
  'standard_notes',
  'accessibility_info',
  'capacity',
  'website_url',
  'map_url',
  'created_at',
  'updated_at',
].join(', ');

const ARTIST_COLUMNS = [
  'id',
  'name',
  'slug',
  'tagline',
  'biography',
  'genre',
  'based_in',
  'image_asset_id',
  'link_instagram',
  'link_tiktok',
  'link_facebook',
  'link_youtube',
  'link_spotify',
  'link_bandcamp',
  'link_soundcloud',
  'link_website',
  'created_at',
  'updated_at',
].join(', ');

const MEDIA_COLUMNS = [
  'id',
  'storage_key',
  'url',
  'role',
  'alt',
  'width',
  'height',
  'mime_type',
  'byte_size',
  'credit',
  'event_id',
  'artist_id',
  'uploaded_at',
].join(', ');

/** `json_each(?1)` turns a bound JSON array into an `in (...)` list, so the
 *  statement text itself never changes with the number of ids. */
const SELECT_PUBLIC_EVENTS_SQL =
  `select ${EVENT_COLUMNS} from events where ${PUBLIC_STATUS_SQL} order by starts_at, id`;
const SELECT_PUBLIC_EVENT_BY_SLUG_SQL =
  `select ${EVENT_COLUMNS} from events where slug = ?1 and ${PUBLIC_STATUS_SQL}`;
const SELECT_PUBLIC_EVENTS_BY_IDS_SQL =
  `select ${EVENT_COLUMNS} from events ` +
  `where id in (select value from json_each(?1)) and ${PUBLIC_STATUS_SQL} order by starts_at, id`;

/** Admin reads are deliberately unfiltered: drafts and archives are the job. */
const SELECT_ALL_EVENTS_SQL = `select ${EVENT_COLUMNS} from events order by starts_at, id`;
const SELECT_EVENT_BY_ID_SQL = `select ${EVENT_COLUMNS} from events where id = ?1`;

const SELECT_EVENT_IDS_FOR_ARTIST_SQL =
  'select event_id from event_artists where artist_id = ?1';

const SELECT_VENUES_BY_IDS_SQL =
  `select ${VENUE_COLUMNS} from venues where id in (select value from json_each(?1))`;
const SELECT_ARTISTS_BY_IDS_SQL =
  `select ${ARTIST_COLUMNS} from artists where id in (select value from json_each(?1))`;
const SELECT_MEDIA_BY_IDS_SQL =
  `select ${MEDIA_COLUMNS} from media_assets where id in (select value from json_each(?1))`;
const SELECT_GALLERY_FOR_EVENTS_SQL =
  `select ${MEDIA_COLUMNS} from media_assets ` +
  `where role = 'gallery' and event_id in (select value from json_each(?1)) ` +
  `order by event_id, id`;

const SELECT_LINEUP_FOR_EVENTS_SQL =
  'select event_id, artist_id, position, billing_note, set_time from event_artists ' +
  'where event_id in (select value from json_each(?1)) order by event_id, position, artist_id';

interface EventIdRow {
  event_id: string;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

const bySoonest = (a: EventView, b: EventView): number =>
  Date.parse(a.startsAt) - Date.parse(b.startsAt);
const byMostRecent = (a: EventView, b: EventView): number =>
  Date.parse(b.startsAt) - Date.parse(a.startsAt);

class D1EventRepository implements PublicEventService {
  private readonly tickets: TicketInventoryService;

  constructor(
    private readonly db: D1Database,
    /** Clock seam so date-boundary behaviour is testable without waiting. */
    private readonly clock: () => Date = () => new Date(),
  ) {
    // AMPED-02D owns ticket/inventory reads; this repository only consumes them.
    this.tickets = createD1TicketInventoryService(db, clock);
  }

  async listUpcoming(limit?: number): Promise<EventView[]> {
    const views = await this.project(await this.loadPublicEvents(), this.clock());
    const list = views.filter((event) => !event.isPast).sort(bySoonest);
    return limit === undefined ? list : list.slice(0, limit);
  }

  async nextEvent(): Promise<EventView | null> {
    const [next] = await this.listUpcoming(1);
    return next ?? null;
  }

  async listPast(limit?: number): Promise<EventView[]> {
    const views = await this.project(await this.loadPublicEvents(), this.clock());
    const list = views
      .filter((event) => event.isPast && event.status !== 'archived')
      .sort(byMostRecent);
    return limit === undefined ? list : list.slice(0, limit);
  }

  async getBySlug(slug: string): Promise<EventView | null> {
    const row = await this.db
      .prepare(SELECT_PUBLIC_EVENT_BY_SLUG_SQL)
      .bind(slug)
      .first<EventRow>();
    if (!row) return null;
    const [view] = await this.project([row], this.clock());
    return view ?? null;
  }

  async listPublicSlugs(): Promise<Array<{ slug: string; isPast: boolean }>> {
    const views = await this.project(await this.loadPublicEvents(), this.clock());
    return views.map((event) => ({ slug: event.slug, isPast: event.isPast }));
  }

  async listOnSale(): Promise<EventView[]> {
    const views = await this.project(await this.loadPublicEvents(), this.clock());
    return views
      .filter((event) => !event.isPast && event.ticketTypes.length > 0)
      .sort(bySoonest);
  }

  /**
   * Every public event this artist appeared on, most recent first. This is what
   * replaces the fixture lookup AMPED-02B left in ArtistService.eventsFor().
   */
  async eventsFor(artistId: string): Promise<EventView[]> {
    const { results } = await this.db
      .prepare(SELECT_EVENT_IDS_FOR_ARTIST_SQL)
      .bind(artistId)
      .all<EventIdRow>();
    const eventIds = unique(results.map((row) => row.event_id));
    if (eventIds.length === 0) return [];

    const rows = await this.loadPublicEventsByIds(eventIds);
    const views = await this.project(rows, this.clock());
    return views.sort(byMostRecent);
  }

  private async loadPublicEvents(): Promise<EventRow[]> {
    const { results } = await this.db.prepare(SELECT_PUBLIC_EVENTS_SQL).all<EventRow>();
    return results;
  }

  private async loadPublicEventsByIds(eventIds: readonly string[]): Promise<EventRow[]> {
    const { results } = await this.db
      .prepare(SELECT_PUBLIC_EVENTS_BY_IDS_SQL)
      .bind(JSON.stringify(eventIds))
      .all<EventRow>();
    return results;
  }

  private project(rows: EventRow[], now: Date): Promise<EventView[]> {
    return projectEventRows(this.db, this.tickets, rows, now);
  }
}

/**
 * Every event row, drafts and archives included, for the admin reads.
 * AMPED-03A moved this here so the admin service and the public service share
 * one projection rather than growing a second copy of it.
 */
export async function loadAllEvents(db: D1Database): Promise<EventRow[]> {
  const { results } = await db.prepare(SELECT_ALL_EVENTS_SQL).all<EventRow>();
  return results;
}

/** One event row at any status, or null. */
export async function loadEventById(db: D1Database, id: string): Promise<EventRow | null> {
  return db.prepare(SELECT_EVENT_BY_ID_SQL).bind(id).first<EventRow>();
}

/**
 * The bounded batch loader: at most nine statements for any non-empty set.
 * Shared by the public, admin and door event services.
 */
export async function projectEventRows(
  db: D1Database,
  tickets: TicketInventoryService,
  rows: EventRow[],
  now: Date,
): Promise<EventView[]> {
  if (rows.length === 0) return [];
  const eventIds = rows.map((row) => row.id);
  const eventIdJson = JSON.stringify(eventIds);

  const lineupRows = (
    await db.prepare(SELECT_LINEUP_FOR_EVENTS_SQL).bind(eventIdJson).all<EventArtistRow>()
  ).results;

  const lineupByEvent = new Map<string, EventArtistRow[]>();
  for (const entry of lineupRows) {
    const list = lineupByEvent.get(entry.event_id);
    if (list) list.push(entry);
    else lineupByEvent.set(entry.event_id, [entry]);
  }

  const artistIds = unique(lineupRows.map((entry) => entry.artist_id));
  const artists = new Map<string, ArtistRow>();
  if (artistIds.length > 0) {
    const { results } = await db
      .prepare(SELECT_ARTISTS_BY_IDS_SQL)
      .bind(JSON.stringify(artistIds))
      .all<ArtistRow>();
    for (const row of results) artists.set(row.id, row);
  }

  const venueIds = unique(rows.map((row) => row.venue_id));
  const venues = new Map<string, VenueRow>();
  if (venueIds.length > 0) {
    const { results } = await db
      .prepare(SELECT_VENUES_BY_IDS_SQL)
      .bind(JSON.stringify(venueIds))
      .all<VenueRow>();
    for (const row of results) venues.set(row.id, row);
  }

  // Public ticket types plus their sold/reserved counters, from the single
  // authoritative AMPED-02D inventory-read implementation.
  const { typesByEvent: ticketTypes, counters } = await tickets.publicInventory(eventIds);

  const mediaIds = unique([
    ...rows.flatMap((row) =>
      [row.poster_asset_id, row.hero_asset_id].filter((id): id is string => id !== null),
    ),
    ...[...artists.values()]
      .map((row) => row.image_asset_id)
      .filter((id): id is string => id !== null),
  ]);
  const media = new Map<string, MediaAssetRow>();
  if (mediaIds.length > 0) {
    const { results } = await db
      .prepare(SELECT_MEDIA_BY_IDS_SQL)
      .bind(JSON.stringify(mediaIds))
      .all<MediaAssetRow>();
    for (const row of results) media.set(row.id, row);
  }

  const galleryRows = (
    await db.prepare(SELECT_GALLERY_FOR_EVENTS_SQL).bind(eventIdJson).all<MediaAssetRow>()
  ).results;
  const gallery = new Map<string, MediaAssetRow[]>();
  for (const row of galleryRows) {
    if (row.event_id === null) continue;
    const list = gallery.get(row.event_id);
    if (list) list.push(row);
    else gallery.set(row.event_id, [row]);
  }

  const data: ProjectionData = {
    venues,
    artists,
    media,
    gallery,
    ticketTypes,
    counters,
  };

  return rows.map((row) =>
    projectEvent(toEvent(row, lineupByEvent.get(row.id) ?? []), data, now),
  );
}

/** Build the D1 event repository against a resolved binding. */
export function createD1EventRepository(
  db: D1Database,
  clock?: () => Date,
): PublicEventService & { eventsFor(artistId: string): Promise<EventView[]> } {
  return new D1EventRepository(db, clock);
}

// ---------------------------------------------------------------------------
// AMPED-04B - gig administration (writes)
// ---------------------------------------------------------------------------

/**
 * The write half of gig administration, used only by the protected
 * /api/admin/gigs routes. Kept out of `contracts.ts` deliberately: it is an
 * internal mutation seam, not a contract the public UI reads through. Domain
 * invariants are enforced here as well as in `src/lib/validation.ts`, so a
 * caller that bypasses the form still cannot corrupt the diary.
 *
 * Atomicity: each operation issues its statements through `db.batch`, which D1
 * runs as one transaction. Audit rows are part of the same batch, guarded by a
 * `where exists/not exists` on the event so a no-op update cannot record a
 * success it did not have.
 */

const AUDIT_INSERT_SQL =
  'insert into audit_log (id, actor_email, action, entity_type, entity_id, summary, occurred_at) ' +
  'values (?1, ?2, ?3, ?4, ?5, ?6, ?7)';

const SELECT_VENUE_EXISTS_SQL = 'select 1 as ok from venues where id = ?1';
const SELECT_ARTISTS_EXIST_SQL =
  'select id from artists where id in (select value from json_each(?1))';
const SELECT_EVENT_TICKET_TYPES_SQL =
  'select id, visibility, capacity from ticket_types where event_id = ?1';
const SELECT_EVENT_ROW_SQL = `select ${EVENT_COLUMNS} from events where id = ?1`;

// Duplicate Promotion (AMPED-04D) reads the source structure authoritatively.
const SELECT_SOURCE_VENUE_SQL = 'select archived_at from venues where id = ?1';
const SELECT_SOURCE_LINEUP_SQL =
  'select a.id as artist_id, a.archived_at as archived_at from event_artists ea ' +
  'join artists a on a.id = ea.artist_id where ea.event_id = ?1';
const SELECT_SOURCE_LINEUP_ORDER_SQL =
  'select artist_id, position, billing_note from event_artists ' +
  'where event_id = ?1 order by position, artist_id';
const SELECT_SOURCE_TICKET_TYPES_SQL =
  'select name, description, price_in_pence, capacity, max_per_order, visibility, position ' +
  'from ticket_types where event_id = ?1 order by position, id';

export interface GigOperator {
  email: string;
  sub?: string;
}

export interface GigMutationOptions {
  /** Test seam: deterministic id generation. */
  newId?: (prefix: string) => string;
}

type IdFactory = (prefix: string) => string;

const defaultId: IdFactory = (prefix) => `${prefix}_${crypto.randomUUID()}`;

interface GigMutationDeps {
  now: () => Date;
  newId: IdFactory;
}

// Timestamping is a per-instance monotonic sequence, not just the clock: two
// writes in the same millisecond must still be distinguishable, because the
// transition guard compares the row's `updated_at` against the value this write
// wrote. A test clock frozen at one instant would otherwise make a stale
// request look like it had succeeded.
function nextTimestamp(previous: number, now: Date): { iso: string; value: number } {
  const value = Math.max(now.getTime(), previous + 1);
  return { iso: new Date(value).toISOString(), value };
}

export interface GigMutationService {
  create(
    input: ValidatedGigInput,
    operator: GigOperator,
    options?: GigMutationOptions,
  ): Promise<{ id: string; slug: string }>;
  update(id: string, input: ValidatedGigInput, operator: GigOperator): Promise<{ slug: string }>;
  publish(id: string, operator: GigOperator): Promise<void>;
  transition(
    id: string,
    to: EventStatus,
    expectedFrom: EventStatus,
    operator: GigOperator,
    options?: { statusMessage?: string },
  ): Promise<void>;
  remove(id: string, operator: GigOperator): Promise<void>;
  readiness(id: string): Promise<ReadinessReport>;
  /**
   * Duplicate a promotion into a clean draft (AMPED-04D). Reusable structure is
   * copied from the source read in D1; the NEW doors/start times are supplied
   * by the operator and are never taken from the source.
   */
  duplicate(
    sourceId: string,
    dates: { doorsAt: string; startsAt: string },
    operator: GigOperator,
  ): Promise<{ id: string; slug: string }>;
}

class D1GigMutations implements GigMutationService {
  private readonly deps: GigMutationDeps;
  private readonly tickets: TicketInventoryService;
  private lastStamp = 0;

  constructor(
    private readonly db: D1Database,
    /** Clock seam so audit timestamps are testable. */
    now: () => Date = () => new Date(),
    newId: IdFactory = defaultId,
  ) {
    this.deps = { now, newId };
    this.tickets = createD1TicketInventoryService(db, now);
  }

  async create(
    input: ValidatedGigInput,
    operator: GigOperator,
    options: GigMutationOptions = {},
  ): Promise<{ id: string; slug: string }> {
    await this.assertVenue(input.venueId);
    await this.assertArtists(input.lineup);

    const newId = options.newId ?? this.deps.newId;
    const id = newId('evt');
    const slug = await this.uniqueSlug(slugify(input.title));
    const at = this.stamp();

    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `insert into events (
             id, title, slug, status, strapline, description, venue_id,
             doors_at, starts_at, ends_at, age_restriction, accessibility_notes,
             link_instagram, link_tiktok, link_facebook, link_youtube,
             photography_credit, photography_gallery_url, internal_notes,
             published_at, created_at, updated_at
           ) values (?1, ?2, ?3, 'draft', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, null, ?19, ?19)`,
        )
        .bind(
          id,
          input.title,
          slug,
          input.strapline ?? null,
          input.description,
          input.venueId,
          input.doorsAt,
          input.startsAt,
          input.endsAt ?? null,
          input.ageRestriction,
          input.accessibilityNotes ?? null,
          input.links.instagram ?? null,
          input.links.tiktok ?? null,
          input.links.facebook ?? null,
          input.links.youtube ?? null,
          input.photographyCredit ?? null,
          input.photographyGalleryUrl ?? null,
          input.internalNotes ?? null,
          at,
        ),
    ];

    for (const [position, artistId] of input.lineup.entries()) {
      statements.push(
        this.db
          .prepare(
            'insert into event_artists (event_id, artist_id, position, billing_note, set_time) values (?1, ?2, ?3, null, null)',
          )
          .bind(id, artistId, position),
      );
    }

    for (const [position, ticket] of input.ticketTypes.entries()) {
      statements.push(this.insertTicketType(newId('tt'), id, ticket, position));
    }

    if (input.guestList > 0) {
      statements.push(
        this.insertTicketType(
          newId('tt'),
          id,
          {
            name: 'Guest list',
            description: 'Comps and guest list places. Never shown on the website.',
            priceInPence: 0,
            capacity: input.guestList,
            visibility: 'hidden',
          },
          input.ticketTypes.length,
        ),
      );
    }

    statements.push(
      this.auditStatement(
        newId('aud'),
        operator.email,
        'event.created',
        id,
        `Created draft "${input.title}"`,
        at,
      ),
    );

    await this.db.batch(statements);
    return { id, slug };
  }

  async update(
    id: string,
    input: ValidatedGigInput,
    operator: GigOperator,
  ): Promise<{ slug: string }> {
    const row = await this.db.prepare(SELECT_EVENT_ROW_SQL).bind(id).first<EventRow>();
    if (!row) throw new NotFoundError('That gig does not exist.');
    await this.assertVenue(input.venueId);
    await this.assertArtists(input.lineup);

    // A published gig's public URL is immutable; a draft may still be renamed.
    const slug = row.status === 'draft' ? await this.uniqueSlug(slugify(input.title), id) : row.slug;
    const at = this.stamp();

    const committed = await this.committedByType(id);
    const existing = await this.db
      .prepare(SELECT_EVENT_TICKET_TYPES_SQL)
      .bind(id)
      .all<{ id: string; visibility: string; capacity: number }>();
    // The edit form manages public ticket types only. Hidden/guest-list types
    // are configured through the separate guestList field and are never
    // deleted here, so a public edit can never drop a guest allocation.
    const existingPublic = existing.results.filter((entry) => entry.visibility === 'public');
    const existingHidden = existing.results.filter((entry) => entry.visibility === 'hidden');
    const existingIds = new Set(existingPublic.map((entry) => entry.id));
    const submittedIds = new Set(input.ticketTypes.map((ticket) => ticket.id).filter(Boolean));

    for (const ticket of input.ticketTypes) {
      if (ticket.id && !existingIds.has(ticket.id)) {
        throw new ConflictError('That ticket type does not belong to this gig.');
      }
      const held = ticket.id ? (committed.get(ticket.id) ?? 0) : 0;
      if (ticket.capacity < held) {
        throw new ConflictError(
          `${ticket.name}: you cannot set the allocation below the ${held} already sold or held.`,
        );
      }
    }
    for (const existingId of existingIds) {
      if (submittedIds.has(existingId)) continue;
      const held = committed.get(existingId) ?? 0;
      if (held > 0) throw new ConflictError('A ticket type with sales against it cannot be removed.');
    }

    const guestType = existingHidden[0];
    const guestCommitted = guestType ? (committed.get(guestType.id) ?? 0) : 0;
    if (input.guestList < guestCommitted) {
      throw new ConflictError(
        `Guest list: you cannot set the allocation below the ${guestCommitted} already issued.`,
      );
    }

    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `update events set
             title = ?1, slug = ?2, strapline = ?3, description = ?4, venue_id = ?5,
             doors_at = ?6, starts_at = ?7, ends_at = ?8, age_restriction = ?9,
             accessibility_notes = ?10, link_instagram = ?11, link_tiktok = ?12,
             link_facebook = ?13, link_youtube = ?14, photography_credit = ?15,
             photography_gallery_url = ?16, internal_notes = ?17, updated_at = ?18
           where id = ?19`,
        )
        .bind(
          input.title,
          slug,
          input.strapline ?? null,
          input.description,
          input.venueId,
          input.doorsAt,
          input.startsAt,
          input.endsAt ?? null,
          input.ageRestriction,
          input.accessibilityNotes ?? null,
          input.links.instagram ?? null,
          input.links.tiktok ?? null,
          input.links.facebook ?? null,
          input.links.youtube ?? null,
          input.photographyCredit ?? null,
          input.photographyGalleryUrl ?? null,
          input.internalNotes ?? null,
          at,
          id,
        ),
      this.db.prepare('delete from event_artists where event_id = ?1').bind(id),
    ];

    for (const [position, artistId] of input.lineup.entries()) {
      statements.push(
        this.db
          .prepare(
            'insert into event_artists (event_id, artist_id, position, billing_note, set_time) values (?1, ?2, ?3, null, null)',
          )
          .bind(id, artistId, position),
      );
    }

    for (const existingId of existingIds) {
      if (submittedIds.has(existingId)) continue;
      statements.push(this.db.prepare('delete from ticket_types where id = ?1').bind(existingId));
    }

    for (const [position, ticket] of input.ticketTypes.entries()) {
      if (ticket.id) {
        statements.push(
          this.db
            .prepare(
              `update ticket_types set
                 name = ?1, description = ?2, price_in_pence = ?3, capacity = ?4,
                 max_per_order = ?5, sales_open_at = ?6, sales_close_at = ?7,
                 position = ?8, visibility = ?9
               where id = ?10 and event_id = ?11`,
            )
            .bind(
              ticket.name,
              ticket.description ?? null,
              ticket.priceInPence,
              ticket.capacity,
              ticket.maxPerOrder ?? null,
              ticket.salesOpenAt ?? null,
              ticket.salesCloseAt ?? null,
              position,
              ticket.visibility,
              ticket.id,
              id,
            ),
        );
      } else {
        statements.push(this.insertTicketType(this.deps.newId('tt'), id, ticket, position));
      }
    }

    if (guestType) {
      if (input.guestList === 0 && guestCommitted === 0) {
        statements.push(this.db.prepare('delete from ticket_types where id = ?1').bind(guestType.id));
      } else {
        statements.push(
          this.db
            .prepare('update ticket_types set capacity = ?1 where id = ?2 and event_id = ?3')
            .bind(input.guestList, guestType.id, id),
        );
      }
    } else if (input.guestList > 0) {
      statements.push(
        this.insertTicketType(
          this.deps.newId('tt'),
          id,
          {
            name: 'Guest list',
            description: 'Comps and guest list places. Never shown on the website.',
            priceInPence: 0,
            capacity: input.guestList,
            visibility: 'hidden',
          },
          input.ticketTypes.length,
        ),
      );
    }

    statements.push(
      this.auditStatement(
        this.deps.newId('aud'),
        operator.email,
        'event.updated',
        id,
        `Edited "${input.title}"`,
        at,
      ),
    );

    await this.db.batch(statements);
    return { slug };
  }

  async publish(id: string, operator: GigOperator): Promise<void> {
    const report = await this.readiness(id);
    if (!report.ready) {
      throw new ValidationError(Object.fromEntries(report.blockers.map((blocker) => [blocker, blocker])));
    }
    await this.transition(id, 'published', 'draft', operator);
  }

  async transition(
    id: string,
    to: EventStatus,
    expectedFrom: EventStatus,
    operator: GigOperator,
    options: { statusMessage?: string } = {},
  ): Promise<void> {
    if (!isAllowedTransition(expectedFrom, to)) {
      throw new ValidationError({ status: `A gig cannot move from ${expectedFrom} to ${to}.` });
    }

    const needsMessage = to === 'postponed' || to === 'cancelled';
    const statusMessage = (options.statusMessage ?? '').trim();
    if (needsMessage && statusMessage.length === 0) {
      throw new ValidationError({
        statusMessage: to === 'cancelled' ? 'Explain why the gig is cancelled.' : 'Explain the postponement.',
      });
    }

    const at = this.stamp();
    const newId = this.deps.newId;

    const update = this.db
      .prepare(
        `update events set
           status = ?1, status_message = ?2, updated_at = ?3,
           published_at = case when ?1 = 'published' and published_at is null then ?3 else published_at end
         where id = ?4 and status = ?5`,
      )
      .bind(to, statusMessage || null, at, id, expectedFrom);

    // The audit row only lands if the conditional update above actually moved
    // the event, so a stale concurrent request cannot record a false success.
    // `updated_at = ?9` ties the audit row to *this* update: a stale request
    // whose conditional update matched nothing leaves updated_at untouched, so
    // the guard fails and no false success is recorded.
    const audit = this.db
      .prepare(
        'insert into audit_log (id, actor_email, action, entity_type, entity_id, summary, occurred_at) ' +
          'select ?1, ?2, ?3, ?4, ?5, ?6, ?7 where exists (select 1 from events where id = ?5 and status = ?8 and updated_at = ?9)',
      )
      .bind(
        newId('aud'),
        operator.email,
        `event.${to}`,
        'event',
        id,
        `Moved "${id}" to ${to}`,
        at,
        to,
        at,
      );

    const results = await this.db.batch([update, audit]);
    const changed = (results[0]?.meta?.changes ?? 0) as number;
    if (changed === 0) {
      const row = await this.db.prepare(SELECT_EVENT_ROW_SQL).bind(id).first<EventRow>();
      if (!row) throw new NotFoundError('That gig does not exist.');
      throw new ConflictError('This gig has changed since the page was loaded. Reload and try again.');
    }
  }

  async remove(id: string, operator: GigOperator): Promise<void> {
    const at = this.stamp();
    const newId = this.deps.newId;

    const del = this.db
      .prepare(
        `delete from events where id = ?1 and status = 'draft'
           and not exists (select 1 from orders where event_id = ?1)`,
      )
      .bind(id);

    const audit = this.db
      .prepare(
        'insert into audit_log (id, actor_email, action, entity_type, entity_id, summary, occurred_at) ' +
          'select ?1, ?2, ?3, ?4, ?5, ?6, ?7 where not exists (select 1 from events where id = ?5)',
      )
      .bind(newId('aud'), operator.email, 'event.deleted', 'event', id, `Deleted draft "${id}"`, at);

    const results = await this.db.batch([del, audit]);
    const changed = (results[0]?.meta?.changes ?? 0) as number;
    if (changed === 0) {
      const row = await this.db.prepare(SELECT_EVENT_ROW_SQL).bind(id).first<EventRow>();
      if (!row) throw new NotFoundError('That gig does not exist.');
      if (row.status !== 'draft') {
        throw new ConflictError('Only a draft can be deleted. Archive this gig instead.');
      }
      throw new ConflictError('This gig has orders against it and can never be deleted.');
    }
  }

  async readiness(id: string): Promise<ReadinessReport> {
    const row = await this.db.prepare(SELECT_EVENT_ROW_SQL).bind(id).first<EventRow>();
    if (!row) throw new NotFoundError('That gig does not exist.');
    const [view] = await projectEventRows(this.db, this.tickets, [row], this.deps.now());
    if (!view) throw new NotFoundError('That gig does not exist.');
    return assessReadiness(view, view.venue.accessibilityInfo);
  }

  async duplicate(
    sourceId: string,
    dates: { doorsAt: string; startsAt: string },
    operator: GigOperator,
  ): Promise<{ id: string; slug: string }> {
    const source = await this.db
      .prepare(SELECT_EVENT_ROW_SQL)
      .bind(sourceId)
      .first<EventRow>();
    if (!source) throw new NotFoundError('That promotion does not exist.');

    // Supervisor archival rule: an archived venue or artist is historical and
    // must not be offered for new work. Fail before writing anything.
    const venue = await this.db
      .prepare(SELECT_SOURCE_VENUE_SQL)
      .bind(source.venue_id)
      .first<{ archived_at: string | null }>();
    if (!venue) throw new NotFoundError('That promotion references a venue that no longer exists.');
    if (venue.archived_at !== null) {
      throw new ConflictError(
        'This promotion uses an archived venue. Choose an active venue through a normal promotion edit before duplicating.',
      );
    }

    const lineup = (
      await this.db.prepare(SELECT_SOURCE_LINEUP_SQL).bind(sourceId).all<{
        artist_id: string;
        archived_at: string | null;
      }>()
    ).results;
    if (lineup.some((entry) => entry.archived_at !== null)) {
      throw new ConflictError(
        'A band on this bill is archived. Choose active replacements through a normal promotion edit before duplicating.',
      );
    }

    const runningOrder = (
      await this.db.prepare(SELECT_SOURCE_LINEUP_ORDER_SQL).bind(sourceId).all<{
        artist_id: string;
        position: number;
        billing_note: string | null;
      }>()
    ).results;

    const ticketRows = (
      await this.db.prepare(SELECT_SOURCE_TICKET_TYPES_SQL).bind(sourceId).all<{
        name: string;
        description: string | null;
        price_in_pence: number;
        capacity: number;
        max_per_order: number | null;
        visibility: string;
        position: number;
      }>()
    ).results;

    const id = this.deps.newId('evt');
    const slug = await this.uniqueSlug(slugify(source.title));
    const at = this.stamp();

    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `insert into events (
             id, title, slug, status, strapline, description, venue_id,
             doors_at, starts_at, ends_at, age_restriction, accessibility_notes,
             poster_asset_id, hero_asset_id,
             link_instagram, link_tiktok, link_facebook, link_youtube,
             link_spotify, link_bandcamp, link_soundcloud, link_website,
             photography_credit, photography_gallery_url, photography_photographer_url,
             internal_notes, status_message, rescheduled_to_event_id, published_at,
             created_at, updated_at
           ) values (?1, ?2, ?3, 'draft', ?4, ?5, ?6, ?7, ?8, null, ?9, ?10,
             ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24,
             null, null, null, ?25, ?25)`,
        )
        .bind(
          id,
          source.title,
          slug,
          source.strapline,
          source.description,
          source.venue_id,
          dates.doorsAt,
          dates.startsAt,
          source.age_restriction,
          source.accessibility_notes,
          source.poster_asset_id,
          source.hero_asset_id,
          source.link_instagram,
          source.link_tiktok,
          source.link_facebook,
          source.link_youtube,
          source.link_spotify,
          source.link_bandcamp,
          source.link_soundcloud,
          source.link_website,
          source.photography_credit,
          source.photography_gallery_url,
          source.photography_photographer_url,
          source.internal_notes,
          at,
        ),
    ];

    for (const entry of runningOrder) {
      // Running order/billing is reusable; the stage time belonged to the old
      // date, so it is reset rather than copied.
      statements.push(
        this.db
          .prepare(
            'insert into event_artists (event_id, artist_id, position, billing_note, set_time) values (?1, ?2, ?3, ?4, null)',
          )
          .bind(id, entry.artist_id, entry.position, entry.billing_note),
      );
    }

    for (const ticket of ticketRows) {
      // New identity, configuration only, sale windows reset to null.
      statements.push(
        this.db
          .prepare(
            `insert into ticket_types (
               id, event_id, name, description, price_in_pence, capacity, max_per_order,
               sales_open_at, sales_close_at, position, visibility
             ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, null, null, ?8, ?9)`,
          )
          .bind(
            this.deps.newId('tt'),
            id,
            ticket.name,
            ticket.description,
            ticket.price_in_pence,
            ticket.capacity,
            ticket.max_per_order,
            ticket.position,
            ticket.visibility,
          ),
      );
    }

    statements.push(
      this.auditStatement(
        this.deps.newId('aud'),
        operator.email,
        'event.duplicated',
        id,
        `Duplicated "${source.title}" from ${sourceId}`,
        at,
      ),
    );

    await this.db.batch(statements);
    return { id, slug };
  }

  // -- helpers -------------------------------------------------------------

  /** A strictly increasing audit/updated timestamp for this operation. */
  private stamp(): string {
    const next = nextTimestamp(this.lastStamp, this.deps.now());
    this.lastStamp = next.value;
    return next.iso;
  }

  private insertTicketType(
    id: string,
    eventId: string,
    ticket: ValidatedGigInput['ticketTypes'][number],
    position: number,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `insert into ticket_types (
           id, event_id, name, description, price_in_pence, capacity, max_per_order,
           sales_open_at, sales_close_at, position, visibility
         ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      )
      .bind(
        id,
        eventId,
        ticket.name,
        ticket.description ?? null,
        ticket.priceInPence,
        ticket.capacity,
        ticket.maxPerOrder ?? null,
        ticket.salesOpenAt ?? null,
        ticket.salesCloseAt ?? null,
        position,
        ticket.visibility,
      );
  }

  private auditStatement(
    id: string,
    actorEmail: string,
    action: string,
    eventId: string,
    summary: string,
    at: string,
  ): D1PreparedStatement {
    return this.db
      .prepare(AUDIT_INSERT_SQL)
      .bind(id, actorEmail, action, 'event', eventId, summary, at);
  }

  private async assertVenue(venueId: string): Promise<void> {
    const row = await this.db.prepare(SELECT_VENUE_EXISTS_SQL).bind(venueId).first<{ ok: number }>();
    if (!row) throw new ValidationError({ venueId: 'Choose a venue that exists.' });
  }

  private async assertArtists(artistIds: readonly string[]): Promise<void> {
    if (artistIds.length === 0) return;
    const { results } = await this.db
      .prepare(SELECT_ARTISTS_EXIST_SQL)
      .bind(JSON.stringify(artistIds))
      .all<{ id: string }>();
    const found = new Set(results.map((row) => row.id));
    if (artistIds.some((artistId) => !found.has(artistId))) {
      throw new ValidationError({ lineup: 'One of the acts does not exist.' });
    }
  }

  /** sold + genuinely held stock per ticket type, for the capacity floor. */
  private async committedByType(eventId: string): Promise<Map<string, number>> {
    const summary = await this.tickets.inventorySummary([eventId]);
    const committed = new Map<string, number>();
    for (const entry of summary.get(eventId)?.allTypes ?? []) {
      committed.set(entry.ticketType.id, entry.sold + entry.reserved);
    }
    return committed;
  }

  private async uniqueSlug(base: string, excludeId?: string): Promise<string> {
    const seed = base.length > 0 ? base : 'gig';
    let candidate = seed;
    for (let suffix = 2; suffix < 500; suffix += 1) {
      const row = await this.db
        .prepare('select id from events where slug = ?1')
        .bind(candidate)
        .first<{ id: string }>();
      if (!row || row.id === excludeId) return candidate;
      candidate = `${seed}-${suffix}`;
    }
    throw new ConflictError('Could not find an available URL for that title.');
  }
}

/** Build the D1 gig mutation service against a resolved binding. */
export function createD1GigMutations(
  db: D1Database,
  clock?: () => Date,
  newId?: IdFactory,
): GigMutationService {
  return new D1GigMutations(db, clock, newId);
}
