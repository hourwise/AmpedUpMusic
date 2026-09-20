/**
 * SEO and social preview helpers.
 *
 * AMPED-03C owns the finished implementation. What is here is the shape:
 * a single place that produces schema.org MusicEvent JSON-LD and OpenGraph
 * metadata from an EventView, so no page hand-rolls its own meta tags.
 */

import type { EventView } from '@/types/view.ts';
import { SITE } from './site.ts';

export interface PageMeta {
  /** Page title without the site suffix. Omit on the homepage. */
  title?: string;
  description: string;
  /** Absolute or root-relative image for OpenGraph / Twitter cards. */
  image?: string;
  imageAlt?: string;
  canonical?: string;
  type?: 'website' | 'article' | 'event';
  /** Set on admin routes and anything that must never be indexed. */
  noindex?: boolean;
}

export function absoluteUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return new URL(path, SITE.url).toString();
}

export function pageTitle(title?: string): string {
  return title ? `${title} | ${SITE.name}` : `${SITE.name} | ${SITE.tagline}`;
}

/**
 * schema.org availability vocabulary, mapped from our own states.
 * Search engines understand these four; our seven states do not map 1:1, so
 * the mapping is explicit rather than inferred.
 */
function schemaAvailability(event: EventView): string {
  switch (event.availability) {
    case 'available':
    case 'selling-fast':
      return 'https://schema.org/InStock';
    case 'last-few':
      return 'https://schema.org/LimitedAvailability';
    case 'sold-out':
      return 'https://schema.org/SoldOut';
    case 'not-yet-on-sale':
      return 'https://schema.org/PreOrder';
    default:
      return 'https://schema.org/OutOfStock';
  }
}

function schemaStatus(event: EventView): string {
  switch (event.status) {
    case 'cancelled':
      return 'https://schema.org/EventCancelled';
    case 'postponed':
      return 'https://schema.org/EventPostponed';
    default:
      return 'https://schema.org/EventScheduled';
  }
}

/** schema.org MusicEvent for an event page. Returned as a plain object. */
export function musicEventJsonLd(event: EventView): Record<string, unknown> {
  const offers = event.ticketTypes.map((t) => ({
    '@type': 'Offer',
    name: t.name,
    price: (t.priceInPence / 100).toFixed(2),
    priceCurrency: 'GBP',
    availability: schemaAvailability(event),
    url: absoluteUrl(event.href),
    validFrom: t.salesOpenAt,
  }));

  return {
    '@context': 'https://schema.org',
    '@type': 'MusicEvent',
    name: event.title,
    description: event.description.slice(0, 500),
    startDate: event.startsAt,
    endDate: event.endsAt,
    doorTime: event.doorsAt,
    eventStatus: schemaStatus(event),
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    url: absoluteUrl(event.href),
    image: event.posterUrl ? [absoluteUrl(event.posterUrl)] : undefined,
    location: {
      '@type': 'MusicVenue',
      name: event.venue.name,
      address: {
        '@type': 'PostalAddress',
        streetAddress: [event.venue.addressLine1, event.venue.addressLine2].filter(Boolean).join(', '),
        addressLocality: event.venue.city,
        postalCode: event.venue.postcode,
        addressCountry: 'GB',
      },
    },
    performer: event.lineup.map((entry) => ({
      '@type': 'MusicGroup',
      name: entry.artist.name,
      url: absoluteUrl(`/artists/${entry.artist.slug}`),
    })),
    organizer: {
      '@type': 'Organization',
      name: SITE.name,
      url: SITE.url,
    },
    offers: offers.length > 0 ? offers : undefined,
  };
}

/** schema.org Organization for the homepage. */
export function organizationJsonLd(): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: SITE.name,
    alternateName: SITE.shortName,
    url: SITE.url,
    email: SITE.email,
    description: SITE.description,
    sameAs: Object.values(SITE.social),
  };
}

/** Breadcrumb JSON-LD. Pass [label, href] pairs in order. */
export function breadcrumbJsonLd(trail: ReadonlyArray<{ label: string; href: string }>): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.label,
      item: absoluteUrl(item.href),
    })),
  };
}
