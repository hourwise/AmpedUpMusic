/**
 * SEO, structured data and social preview helpers (AMPED-03C).
 *
 * One place produces schema.org MusicEvent JSON-LD, canonical/OpenGraph
 * metadata and the sitemap, so no page hand-rolls its own meta tags. The
 * canonical origin is fixed here rather than read from SITE.url, because the
 * approved public origin is https://ampedupmusicpromo.co.uk and everything
 * machine-readable must agree on it (see the slice notes in the final report).
 *
 * JSON-LD is data, not markup: it is serialised with `serializeJsonLd`, which
 * escapes the characters that could otherwise break out of the <script>
 * element, and emitted through BaseLayout's `set:html`.
 */

import type { AvailabilityState } from '@/types/domain.ts';
import type { EventView } from '@/types/view.ts';
import { FOOTER_LEGAL_NAV, PUBLIC_NAV, SITE } from './site.ts';

/**
 * The approved public origin. The .com domain will later redirect here; no
 * canonical or structured-data URL may use .com or a localhost origin.
 */
export const CANONICAL_ORIGIN = 'https://ampedupmusicpromo.co.uk';

/** The site's fallback social image, used when an event has no artwork. */
export const DEFAULT_SOCIAL_IMAGE = '/media/og-default.svg';

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

/**
 * Absolute URL on the canonical origin. Query strings and fragments are
 * stripped: a canonical URL must not carry them.
 */
export function absoluteUrl(path: string): string {
  const url = new URL(path, CANONICAL_ORIGIN);
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** Event artwork when it exists, otherwise the site's default social image. */
export function resolveSocialImage(image?: string): string {
  return image && image.trim().length > 0 ? image : DEFAULT_SOCIAL_IMAGE;
}

export function pageTitle(title?: string): string {
  return title ? `${title} | ${SITE.name}` : `${SITE.name} | ${SITE.tagline}`;
}

/**
 * Safely serialise a JSON-LD object for a <script> element.
 *
 * `<` is the character that lets `</script>` (or an HTML comment) escape the
 * element, so it is escaped along with `>`, `&` and the two JavaScript line
 * separators. The result is still valid JSON.
 */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// ---------------------------------------------------------------------------
// schema.org
// ---------------------------------------------------------------------------

/**
 * schema.org availability for one ticket type, mapped explicitly from our own
 * availability states rather than inferred.
 */
function schemaAvailability(availability: AvailabilityState): string {
  switch (availability) {
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

/**
 * Event status. A sold-out show is still scheduled - sold-out is an Offer
 * availability, never an EventStatus. A finished event keeps EventScheduled:
 * it happened when it said it would.
 */
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
  const url = absoluteUrl(event.href);

  // Public ticket types only: EventView already excludes hidden/guest types.
  const offers = event.ticketTypes.map((ticket) => ({
    '@type': 'Offer',
    name: ticket.name,
    price: (ticket.priceInPence / 100).toFixed(2),
    priceCurrency: 'GBP',
    availability: schemaAvailability(ticket.availability),
    url,
    ...(ticket.salesOpenAt ? { validFrom: ticket.salesOpenAt } : {}),
    ...(ticket.salesCloseAt ? { priceValidUntil: ticket.salesCloseAt } : {}),
  }));

  const images = [event.posterUrl, event.heroUrl]
    .filter((image): image is string => Boolean(image))
    .filter((image, index, all) => all.indexOf(image) === index)
    .map(absoluteUrl);

  return {
    '@context': 'https://schema.org',
    '@type': 'MusicEvent',
    name: event.title,
    description: event.description.slice(0, 500),
    startDate: event.startsAt,
    ...(event.endsAt ? { endDate: event.endsAt } : {}),
    doorTime: event.doorsAt,
    eventStatus: schemaStatus(event),
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    url,
    ...(images.length > 0 ? { image: images } : {}),
    location: {
      '@type': 'MusicVenue',
      name: event.venue.name,
      address: {
        '@type': 'PostalAddress',
        streetAddress: [event.venue.addressLine1, event.venue.addressLine2]
          .filter(Boolean)
          .join(', '),
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
      url: CANONICAL_ORIGIN,
    },
    ...(offers.length > 0 ? { offers } : {}),
  };
}

/**
 * schema.org Organization for the homepage.
 * No contact email is emitted: the only address the application holds is on a
 * different domain from the approved canonical origin, and inventing one is
 * worse than omitting it.
 */
export function organizationJsonLd(): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: SITE.name,
    alternateName: SITE.shortName,
    url: CANONICAL_ORIGIN,
    description: SITE.description,
    sameAs: Object.values(SITE.social),
  };
}

/** Breadcrumb JSON-LD. Pass [label, href] pairs in order. */
export function breadcrumbJsonLd(
  trail: ReadonlyArray<{ label: string; href: string }>,
): Record<string, unknown> {
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

// ---------------------------------------------------------------------------
// Sitemap
// ---------------------------------------------------------------------------

export interface SitemapInput {
  /** Every public event slug with the lifecycle its time state implies. */
  events: ReadonlyArray<{ slug: string; isPast: boolean }>;
  /** Public artist slugs. */
  artistSlugs: ReadonlyArray<string>;
}

/**
 * The indexable public URLs, in a stable order and de-duplicated.
 * Public /venues is deliberately absent: it is V1.1, not V1.
 */
export function sitemapPaths(input: SitemapInput): string[] {
  const paths = [
    '/',
    ...PUBLIC_NAV.map((item) => item.href),
    ...FOOTER_LEGAL_NAV.map((item) => item.href),
    // One URL per event: the lifecycle decides which, never both.
    ...input.events.map((event) => (event.isPast ? `/past-gigs/${event.slug}` : `/gigs/${event.slug}`)),
    ...input.artistSlugs.map((slug) => `/artists/${slug}`),
  ];
  return [...new Set(paths)];
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** The sitemap document. URLs are canonical .co.uk absolute URLs. */
export function buildSitemapXml(input: SitemapInput): string {
  const entries = sitemapPaths(input)
    .map((path) => `  <url><loc>${escapeXml(absoluteUrl(path))}</loc></url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}
