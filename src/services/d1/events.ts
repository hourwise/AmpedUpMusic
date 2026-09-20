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
 *   5. public ticket types for those events
 *   6. tickets sold, grouped by ticket type
 *   7. stock reserved by live awaiting_payment orders, grouped the same way
 *   8. media referenced by id (posters, heroes, artist portraits)
 *   9. gallery media for those events
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
  TicketTypeRow,
  VenueRow,
} from '@/db/schema.ts';
import type { EventView } from '@/types/view.ts';

import type { PublicEventService } from '../contracts.ts';
import { projectEvent, toEvent, type ProjectionData } from './project.ts';

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

const TICKET_TYPE_COLUMNS = [
  'id',
  'event_id',
  'name',
  'description',
  'price_in_pence',
  'capacity',
  'max_per_order',
  'sales_open_at',
  'sales_close_at',
  'position',
  'visibility',
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

const SELECT_PUBLIC_TICKET_TYPES_SQL =
  `select ${TICKET_TYPE_COLUMNS} from ticket_types ` +
  `where event_id in (select value from json_each(?1)) and visibility = 'public' ` +
  `order by event_id, position`;

const SELECT_SOLD_SQL =
  'select ticket_type_id, count(*) as sold from tickets ' +
  "where ticket_type_id in (select value from json_each(?1)) " +
  "and status in ('issued', 'checked_in') group by ticket_type_id";

const SELECT_RESERVED_SQL =
  'select i.ticket_type_id as ticket_type_id, coalesce(sum(i.quantity), 0) as reserved ' +
  'from order_items i join orders o on o.id = i.order_id ' +
  'where i.ticket_type_id in (select value from json_each(?1)) ' +
  "and o.status = 'awaiting_payment' and o.reservation_expires_at > ?2 " +
  'group by i.ticket_type_id';

interface SoldRow {
  ticket_type_id: string;
  sold: number;
}
interface ReservedRow {
  ticket_type_id: string;
  reserved: number;
}
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
  constructor(
    private readonly db: D1Database,
    /** Clock seam so date-boundary behaviour is testable without waiting. */
    private readonly clock: () => Date = () => new Date(),
  ) {}

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

  /** The bounded batch loader: at most nine statements for any non-empty set. */
  private async project(rows: EventRow[], now: Date): Promise<EventView[]> {
    if (rows.length === 0) return [];
    const eventIds = rows.map((row) => row.id);
    const eventIdJson = JSON.stringify(eventIds);

    const lineupRows = (
      await this.db.prepare(SELECT_LINEUP_FOR_EVENTS_SQL).bind(eventIdJson).all<EventArtistRow>()
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
      const { results } = await this.db
        .prepare(SELECT_ARTISTS_BY_IDS_SQL)
        .bind(JSON.stringify(artistIds))
        .all<ArtistRow>();
      for (const row of results) artists.set(row.id, row);
    }

    const venueIds = unique(rows.map((row) => row.venue_id));
    const venues = new Map<string, VenueRow>();
    if (venueIds.length > 0) {
      const { results } = await this.db
        .prepare(SELECT_VENUES_BY_IDS_SQL)
        .bind(JSON.stringify(venueIds))
        .all<VenueRow>();
      for (const row of results) venues.set(row.id, row);
    }

    const ticketTypeRows = (
      await this.db
        .prepare(SELECT_PUBLIC_TICKET_TYPES_SQL)
        .bind(eventIdJson)
        .all<TicketTypeRow>()
    ).results;

    const ticketTypes = new Map<string, TicketTypeRow[]>();
    for (const row of ticketTypeRows) {
      const list = ticketTypes.get(row.event_id);
      if (list) list.push(row);
      else ticketTypes.set(row.event_id, [row]);
    }

    const counters = new Map<string, { sold: number; reserved: number }>();
    for (const row of ticketTypeRows) counters.set(row.id, { sold: 0, reserved: 0 });

    const ticketTypeIds = ticketTypeRows.map((row) => row.id);
    if (ticketTypeIds.length > 0) {
      const ticketTypeIdJson = JSON.stringify(ticketTypeIds);

      const soldRows = (
        await this.db.prepare(SELECT_SOLD_SQL).bind(ticketTypeIdJson).all<SoldRow>()
      ).results;
      for (const row of soldRows) {
        const counter = counters.get(row.ticket_type_id);
        if (counter) counter.sold = row.sold;
      }

      const reservedRows = (
        await this.db
          .prepare(SELECT_RESERVED_SQL)
          .bind(ticketTypeIdJson, now.toISOString())
          .all<ReservedRow>()
      ).results;
      for (const row of reservedRows) {
        const counter = counters.get(row.ticket_type_id);
        if (counter) counter.reserved = row.reserved;
      }
    }

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
      const { results } = await this.db
        .prepare(SELECT_MEDIA_BY_IDS_SQL)
        .bind(JSON.stringify(mediaIds))
        .all<MediaAssetRow>();
      for (const row of results) media.set(row.id, row);
    }

    const galleryRows = (
      await this.db.prepare(SELECT_GALLERY_FOR_EVENTS_SQL).bind(eventIdJson).all<MediaAssetRow>()
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
}

/** Build the D1 event repository against a resolved binding. */
export function createD1EventRepository(
  db: D1Database,
  clock?: () => Date,
): PublicEventService & { eventsFor(artistId: string): Promise<EventView[]> } {
  return new D1EventRepository(db, clock);
}
