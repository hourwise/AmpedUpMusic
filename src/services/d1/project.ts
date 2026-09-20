/**
 * D1 row projection - the D1 counterpart of src/services/mock/project.ts.
 *
 * This module is pure: it never touches a database. `src/services/d1/events.ts`
 * loads rows in batched queries, hands them here as indexed maps, and this file
 * turns them into the exact `EventView` shape the pages and components already
 * consume. The mock projector is the reference implementation; where the two
 * differ, the mock is right.
 *
 * Shape discipline, matching the fixtures rather than the schema:
 *  - `EventView` keys are always present, `undefined` when the column is NULL,
 *    because that is what the mock projector produces;
 *  - optional keys on `Venue`, `Artist` and `MediaAsset` are ABSENT when the
 *    column is NULL, because that is what the fixture literals do;
 *  - a raw `*Row` never leaves the D1 service layer.
 *
 * `toVenue` and `toArtist` intentionally mirror src/services/d1/venues.ts and
 * src/services/d1/artists.ts. Those accepted AMPED-02B modules are deliberately
 * left untouched (the slice brief forbids editing them), so the event
 * projection carries its own copy of the small row mapper rather than the two
 * accepted services being refactored mid-flight.
 */

import {
  deriveAvailability,
  inventoryFor,
  isPurchasable,
  rollUpAvailability,
} from '@/lib/availability.ts';
import { billingFor, AGE_RESTRICTION_LABEL } from '@/lib/text.ts';
import { dateBlockParts, formatLongDate, formatShortDate, formatTime, hasFinished } from '@/lib/dates.ts';
import { formatPriceLabel } from '@/lib/money.ts';
import type {
  ArtistRow,
  EventArtistRow,
  EventRow,
  MediaAssetRow,
  TicketTypeRow,
  VenueRow,
} from '@/db/schema.ts';
import type {
  Artist,
  Event,
  MediaAsset,
  SocialLinks,
  TicketType,
  Venue,
} from '@/types/domain.ts';
import type { EventView, LineupEntryView, TicketTypeView } from '@/types/view.ts';

/** Preloaded, indexed rows for one batch of events. Built by ./events.ts. */
export interface ProjectionData {
  venues: ReadonlyMap<string, VenueRow>;
  artists: ReadonlyMap<string, ArtistRow>;
  media: ReadonlyMap<string, MediaAssetRow>;
  gallery: ReadonlyMap<string, readonly MediaAssetRow[]>;
  ticketTypes: ReadonlyMap<string, readonly TicketTypeRow[]>;
  counters: ReadonlyMap<string, { sold: number; reserved: number }>;
}

/** The eight stored link columns, shared by events and artists. */
const LINK_COLUMNS = [
  ['instagram', 'link_instagram'],
  ['tiktok', 'link_tiktok'],
  ['facebook', 'link_facebook'],
  ['youtube', 'link_youtube'],
  ['spotify', 'link_spotify'],
  ['bandcamp', 'link_bandcamp'],
  ['soundcloud', 'link_soundcloud'],
  ['website', 'link_website'],
] as const;

function toLinks(row: EventRow | ArtistRow): SocialLinks {
  const links: SocialLinks = {};
  for (const [network, column] of LINK_COLUMNS) {
    const url = row[column];
    if (typeof url === 'string' && url.length > 0) links[network] = url;
  }
  return links;
}

export function toVenue(row: VenueRow): Venue {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    addressLine1: row.address_line1,
    city: row.city,
    postcode: row.postcode,
    ...(row.address_line2 !== null ? { addressLine2: row.address_line2 } : {}),
    ...(row.standard_notes !== null ? { standardNotes: row.standard_notes } : {}),
    ...(row.accessibility_info !== null ? { accessibilityInfo: row.accessibility_info } : {}),
    ...(row.capacity !== null ? { capacity: row.capacity } : {}),
    ...(row.website_url !== null ? { websiteUrl: row.website_url } : {}),
    ...(row.map_url !== null ? { mapUrl: row.map_url } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toArtist(row: ArtistRow): Artist {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    ...(row.tagline !== null ? { tagline: row.tagline } : {}),
    ...(row.biography !== null ? { biography: row.biography } : {}),
    ...(row.genre !== null ? { genre: row.genre } : {}),
    ...(row.based_in !== null ? { basedIn: row.based_in } : {}),
    ...(row.image_asset_id !== null ? { imageAssetId: row.image_asset_id } : {}),
    links: toLinks(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toMediaAsset(row: MediaAssetRow): MediaAsset {
  return {
    id: row.id,
    storageKey: row.storage_key,
    url: row.url,
    role: row.role,
    alt: row.alt,
    ...(row.width !== null ? { width: row.width } : {}),
    ...(row.height !== null ? { height: row.height } : {}),
    mimeType: row.mime_type,
    ...(row.byte_size !== null ? { byteSize: row.byte_size } : {}),
    ...(row.credit !== null ? { credit: row.credit } : {}),
    ...(row.event_id !== null ? { eventId: row.event_id } : {}),
    ...(row.artist_id !== null ? { artistId: row.artist_id } : {}),
    uploadedAt: row.uploaded_at,
  };
}

export function toTicketType(row: TicketTypeRow): TicketType {
  return {
    id: row.id,
    eventId: row.event_id,
    name: row.name,
    ...(row.description !== null ? { description: row.description } : {}),
    priceInPence: row.price_in_pence,
    capacity: row.capacity,
    ...(row.max_per_order !== null ? { maxPerOrder: row.max_per_order } : {}),
    ...(row.sales_open_at !== null ? { salesOpenAt: row.sales_open_at } : {}),
    ...(row.sales_close_at !== null ? { salesCloseAt: row.sales_close_at } : {}),
    position: row.position,
    visibility: row.visibility,
  };
}

/** Event row plus its line-up rows -> the storage-agnostic `Event`. */
export function toEvent(row: EventRow, lineup: readonly EventArtistRow[]): Event {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    status: row.status,
    ...(row.strapline !== null ? { strapline: row.strapline } : {}),
    description: row.description,
    venueId: row.venue_id,
    doorsAt: row.doors_at,
    startsAt: row.starts_at,
    ...(row.ends_at !== null ? { endsAt: row.ends_at } : {}),
    ageRestriction: row.age_restriction,
    ...(row.accessibility_notes !== null ? { accessibilityNotes: row.accessibility_notes } : {}),
    ...(row.poster_asset_id !== null ? { posterAssetId: row.poster_asset_id } : {}),
    ...(row.hero_asset_id !== null ? { heroAssetId: row.hero_asset_id } : {}),
    lineup: lineup.map((entry) => ({
      artistId: entry.artist_id,
      position: entry.position,
      ...(entry.billing_note !== null ? { billingNote: entry.billing_note } : {}),
      ...(entry.set_time !== null ? { setTime: entry.set_time } : {}),
    })),
    links: toLinks(row),
    ...(row.photography_credit !== null
      ? {
          photography: {
            credit: row.photography_credit,
            ...(row.photography_gallery_url !== null
              ? { galleryUrl: row.photography_gallery_url }
              : {}),
            ...(row.photography_photographer_url !== null
              ? { photographerUrl: row.photography_photographer_url }
              : {}),
          },
        }
      : {}),
    ...(row.internal_notes !== null ? { internalNotes: row.internal_notes } : {}),
    ...(row.status_message !== null ? { statusMessage: row.status_message } : {}),
    ...(row.rescheduled_to_event_id !== null
      ? { rescheduledToEventId: row.rescheduled_to_event_id }
      : {}),
    ...(row.published_at !== null ? { publishedAt: row.published_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * One ticket type plus its live counters -> `TicketTypeView`.
 * Mirrors `projectTicketType` in the mock projector; availability arithmetic
 * still comes from src/lib/availability.ts, never reimplemented here.
 */
export function projectTicketType(
  ticketType: TicketType,
  counters: { sold: number; reserved: number },
  sellable: boolean,
  now: Date,
): TicketTypeView {
  const inventory = inventoryFor(ticketType, counters.sold, counters.reserved);
  const availability = deriveAvailability(
    {
      inventory,
      salesOpenAt: ticketType.salesOpenAt,
      salesCloseAt: ticketType.salesCloseAt,
      eventSellable: sellable,
    },
    now,
  );

  return {
    id: ticketType.id,
    name: ticketType.name,
    description: ticketType.description,
    priceInPence: ticketType.priceInPence,
    priceLabel: formatPriceLabel(ticketType.priceInPence),
    maxPerOrder: ticketType.maxPerOrder ?? 6,
    salesOpenAt: ticketType.salesOpenAt,
    salesCloseAt: ticketType.salesCloseAt,
    inventory,
    availability,
    purchasable: isPurchasable(availability),
  };
}

function mediaUrl(
  id: string | undefined,
  data: ProjectionData,
): { url?: string; alt?: string } {
  if (!id) return {};
  const asset = data.media.get(id);
  return asset ? { url: asset.url, alt: asset.alt } : {};
}

/**
 * Assemble one `EventView`. Deliberately key-for-key with the mock projector,
 * including keys that hold `undefined`, so the swap is invisible to consumers.
 */
export function projectEvent(event: Event, data: ProjectionData, now: Date): EventView {
  const venueRow = data.venues.get(event.venueId);
  if (!venueRow) {
    // A row referencing a missing venue is a data bug, not a runtime condition.
    throw new Error(`Event ${event.id} references unknown venue ${event.venueId}`);
  }

  const isPast = hasFinished(event.startsAt, event.endsAt, now);
  const sellable = event.status === 'published' && !isPast;

  const publicTypes = (data.ticketTypes.get(event.id) ?? [])
    .slice()
    .sort((a, b) => a.position - b.position);
  const ticketTypes = publicTypes.map((row) =>
    projectTicketType(
      toTicketType(row),
      data.counters.get(row.id) ?? { sold: 0, reserved: 0 },
      sellable,
      now,
    ),
  );
  const availability = rollUpAvailability(ticketTypes.map((t) => t.availability));

  const purchasable = ticketTypes.filter((t) => t.purchasable);
  const priceFromInPence =
    purchasable.length > 0
      ? Math.min(...purchasable.map((t) => t.priceInPence))
      : ticketTypes.length > 0
        ? Math.min(...ticketTypes.map((t) => t.priceInPence))
        : undefined;

  const lineup: LineupEntryView[] = event.lineup
    .slice()
    .sort((a, b) => a.position - b.position)
    .flatMap((entry) => {
      const artistRow = data.artists.get(entry.artistId);
      if (!artistRow) return [];
      const artist = toArtist(artistRow);
      return [
        {
          artist,
          position: entry.position,
          billingNote: entry.billingNote,
          setTime: entry.setTime,
          billing: billingFor(entry.position),
          imageUrl: mediaUrl(artist.imageAssetId, data).url,
        },
      ];
    });

  const poster = mediaUrl(event.posterAssetId, data);
  const hero = mediaUrl(event.heroAssetId, data);
  const parts = dateBlockParts(event.startsAt);

  return {
    id: event.id,
    title: event.title,
    slug: event.slug,
    status: event.status,
    strapline: event.strapline,
    description: event.description,
    doorsAt: event.doorsAt,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    ageRestriction: event.ageRestriction,
    ageRestrictionLabel: AGE_RESTRICTION_LABEL[event.ageRestriction],
    accessibilityNotes: event.accessibilityNotes,
    statusMessage: event.statusMessage,
    internalNotes: event.internalNotes,
    links: event.links,
    photography: event.photography,

    venue: toVenue(venueRow),
    lineup,
    ticketTypes,

    posterUrl: poster.url,
    posterAlt: poster.alt,
    heroUrl: hero.url ?? poster.url,
    heroAlt: hero.alt ?? poster.alt,
    gallery: (data.gallery.get(event.id) ?? []).map(toMediaAsset),

    availability,
    priceFromInPence,
    priceFromLabel: priceFromInPence === undefined ? undefined : formatPriceLabel(priceFromInPence),

    isPast,
    onSale: sellable && isPurchasable(availability),

    href: isPast ? `/past-gigs/${event.slug}` : `/gigs/${event.slug}`,

    dateLabel: formatLongDate(event.startsAt),
    shortDateLabel: formatShortDate(event.startsAt),
    dayLabel: `${parts.weekday} ${parts.day} ${parts.month}`,
    doorsLabel: formatTime(event.doorsAt),
    startsLabel: formatTime(event.startsAt),
  };
}
