/**
 * Projection: fixture records -> view models.
 *
 * This is the only place in the mock layer that knows how to assemble an
 * EventView. When AMPED-03A swaps the fixtures for D1, this file is the
 * template for what the D1 repository has to produce - the joins, the derived
 * availability, the pre-formatted labels.
 */

import {
  AVAILABILITY_SHORT,
  deriveAvailability,
  inventoryFor,
  isPurchasable,
  rollUpAvailability,
} from '@/lib/availability.ts';
import { dateBlockParts, formatLongDate, formatShortDate, formatTime, hasFinished } from '@/lib/dates.ts';
import { formatPriceLabel } from '@/lib/money.ts';
import { AGE_RESTRICTION_LABEL, billingFor } from '@/lib/text.ts';
import type { Event, MediaAsset, TicketType } from '@/types/domain.ts';
import type { EventView, LineupEntryView, TicketTypeView } from '@/types/view.ts';

import { ARTISTS_BY_ID } from '@/data/fixtures/artists.ts';
import { SALES, TICKET_TYPES } from '@/data/fixtures/events.ts';
import { MEDIA_BY_ID, galleryForEvent } from '@/data/fixtures/media.ts';
import { VENUES_BY_ID } from '@/data/fixtures/venues.ts';

/** A status that means the public may still buy a ticket. */
function isSellableStatus(status: Event['status']): boolean {
  return status === 'published';
}

function mediaUrl(id: string | undefined): { url?: string; alt?: string } {
  if (!id) return {};
  const asset: MediaAsset | undefined = MEDIA_BY_ID.get(id);
  return asset ? { url: asset.url, alt: asset.alt } : {};
}

export function projectTicketType(ticketType: TicketType, sellable: boolean, now: Date): TicketTypeView {
  const counters = SALES[ticketType.id] ?? { sold: 0, reserved: 0 };
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

export function projectEvent(event: Event, now: Date = new Date()): EventView {
  const venue = VENUES_BY_ID.get(event.venueId);
  if (!venue) {
    // A fixture referencing a missing venue is a bug, not a runtime condition.
    throw new Error(`Event ${event.id} references unknown venue ${event.venueId}`);
  }

  const isPast = hasFinished(event.startsAt, event.endsAt, now);
  const sellable = isSellableStatus(event.status) && !isPast;

  const publicTypes = TICKET_TYPES.filter((t) => t.eventId === event.id && t.visibility === 'public').sort(
    (a, b) => a.position - b.position,
  );
  const ticketTypes = publicTypes.map((t) => projectTicketType(t, sellable, now));
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
      const artist = ARTISTS_BY_ID.get(entry.artistId);
      if (!artist) return [];
      return [
        {
          artist,
          position: entry.position,
          billingNote: entry.billingNote,
          setTime: entry.setTime,
          billing: billingFor(entry.position),
          imageUrl: mediaUrl(artist.imageAssetId).url,
        },
      ];
    });

  const poster = mediaUrl(event.posterAssetId);
  const hero = mediaUrl(event.heroAssetId);
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

    venue,
    lineup,
    ticketTypes,

    posterUrl: poster.url,
    posterAlt: poster.alt,
    heroUrl: hero.url ?? poster.url,
    heroAlt: hero.alt ?? poster.alt,
    gallery: galleryForEvent(event.id),

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

/** Short availability wording, re-exported so components import one thing. */
export { AVAILABILITY_SHORT };
