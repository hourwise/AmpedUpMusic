/**
 * Shared public-rendering policy for the event routes (AMPED-03B).
 *
 * Astro ignores files in src/pages that begin with an underscore, so this is a
 * module, not a route. It holds the two decisions that every public event page
 * has to make identically:
 *
 *  1. which of /gigs/[slug] and /past-gigs/[slug] is the canonical URL for an
 *     event, given only its time state;
 *  2. how long a CDN may serve the page before revalidating.
 *
 * Both are pure functions of the event view, which keeps the pages thin and
 * makes the behaviour testable without rendering Astro.
 */

export type EventLifecycle = 'upcoming' | 'past';

/** A permanent redirect: an event's canonical URL only ever changes once. */
export const LIFECYCLE_REDIRECT_STATUS = 301 as const;

export interface LifecycleTarget {
  slug: string;
  /** Derived from hasFinished(), never from the status column. */
  isPast: boolean;
}

/**
 * The canonical URL for an event is decided entirely by time:
 *  - a finished event lives at /past-gigs/<slug>;
 *  - an unfinished event lives at /gigs/<slug>.
 *
 * Returns the redirect the page should issue, or null when the requested URL
 * is already canonical or the event does not exist (unknown slugs must 404,
 * not bounce somewhere arbitrary).
 */
export function canonicalEventRedirect(
  event: LifecycleTarget | null,
  requested: EventLifecycle,
): { location: string; status: 301 } | null {
  if (!event) return null;
  if (requested === 'upcoming' && event.isPast) {
    return { location: `/past-gigs/${event.slug}`, status: LIFECYCLE_REDIRECT_STATUS };
  }
  if (requested === 'past' && !event.isPast) {
    return { location: `/gigs/${event.slug}`, status: LIFECYCLE_REDIRECT_STATUS };
  }
  return null;
}

/**
 * Cache-Control per route category.
 *
 * Every public route is server-rendered from D1, and the content is
 * time-sensitive (the homepage's "next gig" changes the moment a show
 * finishes; ticket availability moves with real sales). The policy is a short
 * shared-cache TTL with stale-while-revalidate so a CDN absorbs traffic bursts
 * without letting sold-out or cancelled state go materially stale:
 *
 *  - `listing`  : homepage, /gigs, /past-gigs, /gallery, /artists. Changes only
 *                 when an operator edits data or a boundary passes, so a
 *                 minute of edge cache is safe.
 *  - `live`     : /tickets, both event detail routes, /artists/[slug]. Ticket
 *                 inventory and lifecycle are the point of the page, so the
 *                 TTL is halved.
 *
 * `max-age=0` keeps browsers revalidating rather than serving a stale copy from
 * their own cache; the shared-cache TTL is what does the work.
 */
export const PUBLIC_CACHE_POLICY = {
  listing: 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
  live: 'public, max-age=0, s-maxage=30, stale-while-revalidate=60',
} as const;

export type PublicCacheKind = keyof typeof PUBLIC_CACHE_POLICY;

export function applyPublicCache(
  target: { headers: Headers },
  kind: PublicCacheKind,
): void {
  target.headers.set('Cache-Control', PUBLIC_CACHE_POLICY[kind]);
}
