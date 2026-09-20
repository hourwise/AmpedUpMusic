/**
 * /sitemap.xml (AMPED-03C).
 *
 * Generated from the same D1-backed services the site renders from, so the
 * sitemap is always the current truth: a finished event appears once at its
 * /past-gigs URL, never alongside a stale /gigs URL, and drafts, archived
 * events and /admin never appear at all.
 *
 * Server-rendered (the route is not prerendered) because event lifecycles move
 * with time. A short shared-cache TTL is enough: the sitemap does not need to
 * change the second a gig ends.
 */

import type { APIRoute } from 'astro';
import { buildSitemapXml } from '@/lib/seo.ts';
import { getServices } from '@/services/index.ts';

export const GET: APIRoute = async () => {
  const services = getServices();
  const [events, artists] = await Promise.all([
    services.events.listPublicSlugs(),
    services.artists.list(),
  ]);

  const xml = buildSitemapXml({
    events,
    artistSlugs: artists.map((artist) => artist.slug),
  });

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=600',
    },
  });
};
