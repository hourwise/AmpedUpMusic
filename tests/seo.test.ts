/**
 * AMPED-03C - SEO, structured data and social previews.
 *
 * Exercises the seo.ts seam directly against a real, seeded D1 database, plus
 * static checks over the document shell and the admin routes. It proves the
 * canonical origin, the MusicEvent/Offer semantics for every event state, the
 * lifecycle-aware sitemap, robots policy, admin noindex and JSON-LD escaping.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { openEphemeralDatabase } from '../src/db/local.ts';
import { migrate } from '../src/db/migrations.ts';
import { applySeed } from '../src/db/seed.ts';
import { createServices } from '../src/services/index.ts';
import {
  absoluteUrl,
  buildSitemapXml,
  CANONICAL_ORIGIN,
  DEFAULT_SOCIAL_IMAGE,
  musicEventJsonLd,
  resolveSocialImage,
  serializeJsonLd,
  sitemapPaths,
} from '../src/lib/seo.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string, extension = '.astro'): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full, extension));
    else if (entry.endsWith(extension)) out.push(full);
  }
  return out;
}

describe('canonical origin', () => {
  it('is the approved .co.uk domain', () => {
    expect(CANONICAL_ORIGIN).toBe('https://ampedupmusicpromo.co.uk');
  });

  it('builds HTTPS .co.uk absolute URLs and strips queries', () => {
    expect(absoluteUrl('/')).toBe('https://ampedupmusicpromo.co.uk/');
    expect(absoluteUrl('/gigs/example')).toBe('https://ampedupmusicpromo.co.uk/gigs/example');
    expect(absoluteUrl('/gigs/example?utm=1#x')).toBe(
      'https://ampedupmusicpromo.co.uk/gigs/example',
    );
  });

  it('never emits .com or localhost', () => {
    for (const path of ['/', '/gigs', '/past-gigs/x', '/artists/y', '/tickets']) {
      const url = absoluteUrl(path);
      expect(url).toContain('https://');
      expect(url).not.toContain('.com');
      expect(url).not.toContain('localhost');
    }
  });

  it('falls back to the default social image only when there is no artwork', () => {
    expect(resolveSocialImage(undefined)).toBe(DEFAULT_SOCIAL_IMAGE);
    expect(resolveSocialImage('')).toBe(DEFAULT_SOCIAL_IMAGE);
    expect(resolveSocialImage('/media/poster-glass-hearts.svg')).toBe(
      '/media/poster-glass-hearts.svg',
    );
    expect(absoluteUrl(DEFAULT_SOCIAL_IMAGE)).toBe(
      'https://ampedupmusicpromo.co.uk/media/og-default.svg',
    );
  });
});

describe('JSON-LD safety', () => {
  it('cannot be broken out of by hostile metadata', () => {
    const hostile = '</script><script>alert(1)</script><!--';
    const serialized = serializeJsonLd({ name: hostile, note: 'a & b > c' });

    expect(serialized).not.toContain('</script>');
    expect(serialized).not.toContain('<script>');
    expect(serialized).not.toContain('<');
    expect(serialized).toContain('\\u003c');
    // Still valid JSON, and the hostile text survives as data.
    expect(JSON.parse(serialized)).toEqual({ name: hostile, note: 'a & b > c' });
  });
});

describe('admin noindex', () => {
  it('routes every admin page through a layout that sets noindex', () => {
    const files = sourceFiles(join(root, 'src', 'pages', 'admin'));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(
        /AdminLayout|DoorLayout/.test(source),
        `${file} does not use an admin/door layout`,
      ).toBe(true);
    }

    for (const layout of ['AdminLayout.astro', 'DoorLayout.astro']) {
      const source = readFileSync(join(root, 'src', 'layouts', layout), 'utf8');
      expect(source, `${layout} must pass noindex`).toMatch(/\bnoindex\b/);
    }

    const base = readFileSync(join(root, 'src', 'layouts', 'BaseLayout.astro'), 'utf8');
    expect(base).toContain('noindex');
    expect(base).toContain('noindex, nofollow');
  });
});

describe('robots.txt', () => {
  // AMPED-CF-00A turned this into a generated route, because a static file
  // would have shipped `Allow: /` and the PRODUCTION sitemap from staging.
  const source = readFileSync(join(root, 'src', 'pages', 'robots.txt.ts'), 'utf8');
  const production = source.slice(source.indexOf('const PRODUCTION'), source.indexOf('const NON_PRODUCTION'));
  const nonProduction = source.slice(source.indexOf('const NON_PRODUCTION'), source.indexOf('export function GET'));

  it('advertises the .co.uk sitemap in production', () => {
    expect(production).toContain('${CANONICAL_ORIGIN}/sitemap.xml');
  });

  it('allows the public site and disallows admin in production', () => {
    expect(production).toContain('Allow: /');
    expect(production).toContain('Disallow: /admin');
  });

  it('disallows everything, and advertises no sitemap, off production', () => {
    expect(nonProduction).toContain('Disallow: /');
    expect(nonProduction).not.toContain('Allow: /');
    expect(nonProduction).not.toContain('Sitemap:');
  });

  it('chooses between them on the build environment, not a hostname', () => {
    expect(source).toContain('IS_INDEXABLE ? PRODUCTION : NON_PRODUCTION');
  });
});

describe('sitemap', () => {
  it('uses the canonical origin and excludes admin and /venues', () => {
    const xml = buildSitemapXml({
      events: [{ slug: 'example-gig', isPast: false }],
      artistSlugs: ['example-artist'],
    });

    expect(xml).toContain('https://ampedupmusicpromo.co.uk/');
    expect(xml).not.toContain('.com');
    expect(xml).not.toContain('localhost');
    expect(xml).not.toContain('/admin');
    expect(xml).not.toContain('/venues');
  });

  it('lists exactly one lifecycle URL per event', () => {
    const events = [
      { slug: 'future-gig', isPast: false },
      { slug: 'old-gig', isPast: true },
    ];
    const paths = sitemapPaths({ events, artistSlugs: [] });

    expect(paths).toContain('/gigs/future-gig');
    expect(paths).not.toContain('/past-gigs/future-gig');
    expect(paths).toContain('/past-gigs/old-gig');
    expect(paths).not.toContain('/gigs/old-gig');
  });

  it('moves an event to its current canonical URL across the boundary', () => {
    const before = sitemapPaths({ events: [{ slug: 'rolling', isPast: false }], artistSlugs: [] });
    expect(before).toContain('/gigs/rolling');

    const after = sitemapPaths({ events: [{ slug: 'rolling', isPast: true }], artistSlugs: [] });
    expect(after).toContain('/past-gigs/rolling');
    expect(after).not.toContain('/gigs/rolling');
  });
});

describe('MusicEvent structured data', () => {
  let database: Awaited<ReturnType<typeof openEphemeralDatabase>>;
  let services: ReturnType<typeof createServices>;

  beforeAll(async () => {
    database = await openEphemeralDatabase();
    await migrate(database.db);
    await applySeed(database.db);
    services = createServices(database.db);
  });

  afterAll(async () => {
    await database.dispose();
  });

  async function eventFor(slug: string) {
    const event = await services.events.getBySlug(slug);
    expect(event, slug).not.toBeNull();
    return event!;
  }

  it('describes a normal upcoming gig', async () => {
    const event = await eventFor('the-glass-hearts-lomax-rooms');
    const json = musicEventJsonLd(event);

    expect(json['@context']).toBe('https://schema.org');
    expect(json['@type']).toBe('MusicEvent');
    expect(json.name).toBe('The Glass Hearts');
    expect(json.startDate).toBe(event.startsAt);
    expect(json.eventStatus).toBe('https://schema.org/EventScheduled');
    expect(json.url).toBe('https://ampedupmusicpromo.co.uk/gigs/the-glass-hearts-lomax-rooms');

    const location = json.location as Record<string, unknown>;
    expect(location['@type']).toBe('MusicVenue');
    expect(location.name).toBe('The Lomax Rooms');
    expect((location.address as Record<string, unknown>).addressLocality).toBe('Preston');
    expect((location.address as Record<string, unknown>).addressCountry).toBe('GB');

    const performers = json.performer as Array<Record<string, unknown>>;
    expect(performers.map((p) => p.name)).toEqual([
      'The Glass Hearts',
      'Mara Veil',
      'Second City Sound',
    ]);
    expect(performers[0]?.url).toBe('https://ampedupmusicpromo.co.uk/artists/the-glass-hearts');

    expect(json.image).toEqual([
      'https://ampedupmusicpromo.co.uk/media/poster-glass-hearts.svg',
      'https://ampedupmusicpromo.co.uk/media/hero-glass-hearts.svg',
    ]);
  });

  it('marks a postponed gig as postponed and a cancelled gig as cancelled', async () => {
    const postponed = musicEventJsonLd(await eventFor('saltwater-parade-parr-street-hall'));
    const cancelled = musicEventJsonLd(await eventFor('paper-lions-the-cellar'));

    expect(postponed.eventStatus).toBe('https://schema.org/EventPostponed');
    expect(cancelled.eventStatus).toBe('https://schema.org/EventCancelled');
  });

  it('keeps a sold-out gig scheduled and marks the offer sold out', async () => {
    const event = await eventFor('the-glass-hearts-lomax-rooms');
    expect(event.availability).toBe('selling-fast');

    const json = musicEventJsonLd(event);
    expect(json.eventStatus).toBe('https://schema.org/EventScheduled');

    const offers = json.offers as Array<Record<string, unknown>>;
    const early = offers.find((offer) => offer.name === 'Early Bird');
    expect(early?.availability).toBe('https://schema.org/SoldOut');

    const ga = offers.find((offer) => offer.name === 'General Admission');
    expect(ga?.availability).toBe('https://schema.org/InStock');
  });

  it('keeps a completed past gig semantically scheduled', async () => {
    const [completed] = await services.events.listPast();
    const json = musicEventJsonLd(completed!);
    expect(json.eventStatus).toBe('https://schema.org/EventScheduled');
    expect(json.url).toBe(`https://ampedupmusicpromo.co.uk/past-gigs/${completed!.slug}`);
  });

  it('converts pence to a decimal GBP price', async () => {
    const event = await eventFor('the-glass-hearts-lomax-rooms');
    const offers = musicEventJsonLd(event).offers as Array<Record<string, unknown>>;
    const early = offers.find((offer) => offer.name === 'Early Bird');

    expect(early?.price).toBe('7.00');
    expect(early?.priceCurrency).toBe('GBP');
    expect(early?.url).toBe('https://ampedupmusicpromo.co.uk/gigs/the-glass-hearts-lomax-rooms');
  });

  it('never exposes hidden guest-list ticket types in offers', async () => {
    const event = await eventFor('the-glass-hearts-lomax-rooms');
    const json = musicEventJsonLd(event);
    const serialized = JSON.stringify(json);

    expect(event.ticketTypes.some((type) => type.id === 'tt_gh_guest')).toBe(false);
    expect(serialized).not.toMatch(/guest/i);
  });

  it('does not repeat the unapproved "no booking fees" claim', async () => {
    const json = musicEventJsonLd(await eventFor('the-glass-hearts-lomax-rooms'));
    expect(JSON.stringify(json)).not.toMatch(/booking fee/i);
  });

  it('omits imagery for an event that has none, leaving the default to the layout', async () => {
    const event = await eventFor('paper-lions-the-cellar');
    expect(event.posterUrl).toBeUndefined();
    expect(event.heroUrl).toBeUndefined();

    const json = musicEventJsonLd(event);
    expect('image' in json).toBe(false);
    expect(resolveSocialImage(event.posterUrl ?? event.heroUrl)).toBe(DEFAULT_SOCIAL_IMAGE);
  });
});
