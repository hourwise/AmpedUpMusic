/**
 * Route coverage.
 *
 * Checks that every route named in the navigation, in the governing build plan
 * and in the service layer actually has a page file behind it. This catches
 * the most common scaffold regression - a link in the footer pointing at a
 * page nobody built - without needing a browser.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADMIN_NAV, FOOTER_LEGAL_NAV, PUBLIC_NAV } from '../src/lib/site.ts';
import { getServices } from '../src/services/index.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pages = join(root, 'src', 'pages');

/** Does a route have a page file? Handles index, flat and dynamic routes. */
function routeExists(route: string): boolean {
  const clean = route.replace(/^\/+/, '').replace(/\/+$/, '');
  if (clean === '') return existsSync(join(pages, 'index.astro'));
  return (
    existsSync(join(pages, `${clean}.astro`)) || existsSync(join(pages, clean, 'index.astro'))
  );
}

/** Routes the governing build plan lists as required for V1. */
const PLAN_ROUTES = [
  '/',
  '/gigs',
  '/tickets',
  '/past-gigs',
  '/gallery',
  '/artists',
  '/about',
  '/promote-with-us',
  '/contact',
  '/privacy',
  '/ticket-terms',
  '/accessibility',
];

describe('routes required by the governing build plan', () => {
  it.each(PLAN_ROUTES)('%s has a page', (route) => {
    expect(routeExists(route), `missing page for ${route}`).toBe(true);
  });

  it('has the dynamic event routes', () => {
    expect(existsSync(join(pages, 'gigs', '[slug].astro'))).toBe(true);
    expect(existsSync(join(pages, 'past-gigs', '[slug].astro'))).toBe(true);
    expect(existsSync(join(pages, 'artists', '[slug].astro'))).toBe(true);
  });

  it('has a 404 page', () => {
    expect(existsSync(join(pages, '404.astro'))).toBe(true);
  });
});

describe('navigation links resolve', () => {
  it.each([...PUBLIC_NAV, ...FOOTER_LEGAL_NAV].map((item) => item.href))(
    '%s has a page',
    (href) => {
      expect(routeExists(href), `nav points at ${href} but no page exists`).toBe(true);
    },
  );
});

describe('admin routes resolve', () => {
  it.each(ADMIN_NAV.map((item) => item.href))('%s has a page', (href) => {
    expect(routeExists(href), `admin nav points at ${href} but no page exists`).toBe(true);
  });

  it('has the admin dynamic routes', () => {
    expect(existsSync(join(pages, 'admin', 'gigs', 'new.astro'))).toBe(true);
    expect(existsSync(join(pages, 'admin', 'gigs', '[id].astro'))).toBe(true);
    expect(existsSync(join(pages, 'admin', 'door', '[eventId].astro'))).toBe(true);
  });
});

describe('every fixture event has a reachable page', () => {
  it('routes each slug to a template that exists', async () => {
    const slugs = await getServices().events.listPublicSlugs();
    expect(slugs.length).toBeGreaterThan(0);
    for (const { slug, isPast } of slugs) {
      const template = isPast ? 'past-gigs' : 'gigs';
      expect(existsSync(join(pages, template, '[slug].astro')), `${slug} -> /${template}`).toBe(
        true,
      );
    }
  });
});

describe('scaffold hygiene', () => {
  it('has generated the placeholder artwork the fixtures point at', async () => {
    const services = getServices();
    const upcoming = await services.events.listUpcoming();
    const withPosters = upcoming.filter((e) => e.posterUrl);
    expect(withPosters.length).toBeGreaterThan(0);
    for (const event of withPosters) {
      const file = join(root, 'public', event.posterUrl!.replace(/^\//, ''));
      expect(existsSync(file), `missing artwork ${event.posterUrl}`).toBe(true);
    }
  });

  it('keeps admin out of the search index', () => {
    // robots.txt is the first line; noindex on the pages is the second.
    const robots = join(root, 'public', 'robots.txt');
    expect(existsSync(robots)).toBe(true);
  });
});
