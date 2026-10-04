/**
 * robots.txt (AMPED-CF-00A).
 *
 * Was a static file in `public/`, which meant staging would have shipped
 * `Allow: /` and advertised the PRODUCTION sitemap from a non-production
 * host. Now it is generated, so a staging build tells crawlers to stay away
 * and never points at a sitemap that is not its own.
 *
 * Prerendered: the content depends only on the build environment, so there is
 * no reason to compute it per request.
 *
 * This is a courtesy to well-behaved crawlers and nothing more. Cloudflare
 * Access is what actually keeps staging private, and /admin is disallowed
 * here for tidiness only - robots.txt has never been a security boundary.
 */
import { CANONICAL_ORIGIN } from '@/lib/seo.ts';
import { IS_INDEXABLE } from '@/lib/environment.ts';

export const prerender = true;

const PRODUCTION = `# Amped Up Music Promotions
User-agent: *
Allow: /

Disallow: /admin
Disallow: /admin/

Sitemap: ${CANONICAL_ORIGIN}/sitemap.xml
`;

const NON_PRODUCTION = `# Amped Up Music Promotions - NON-PRODUCTION BUILD
#
# This is not the live site. Nothing here should be crawled or indexed; the
# canonical site is ${CANONICAL_ORIGIN}.
User-agent: *
Disallow: /
`;

export function GET(): Response {
  return new Response(IS_INDEXABLE ? PRODUCTION : NON_PRODUCTION, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
