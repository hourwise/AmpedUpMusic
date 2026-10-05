/**
 * AMPED-CF-00A - admin mutation origin defence, and pre-staging hygiene.
 *
 * Cloudflare Access answers "who is this?". It cannot answer "did they mean
 * to send this?" - the operator's credential is ambient, so a hostile page
 * can make their browser act. Before this application goes onto the public
 * internet, every state-changing admin request must prove it came from here.
 *
 * These tests drive the ONE shared guard against the real route inventory,
 * rather than checking four endpoints by hand: the twenty-third admin route
 * must be protected on the day it is written, not on the day someone
 * remembers to add a check to it.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  evaluateRequestOrigin,
  guardAdminMutation,
  isProtectedPath,
} from '../src/lib/access.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://staging.ampedupmusicpromo.co.uk';
const HOSTILE = 'https://evil.example';

/** Every admin API route file, with the HTTP methods it exports. */
function adminRoutes(): Array<{ route: string; methods: string[] }> {
  const base = join(root, 'src', 'pages', 'api', 'admin');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts') && !entry.startsWith('_')) files.push(full);
    }
  };
  walk(base);

  return files.map((file) => {
    const methods = [
      ...(readFileSync(file, 'utf8').matchAll(/export const (GET|POST|PUT|PATCH|DELETE):/g)),
    ].map((match) => match[1]!);
    const route =
      '/api/admin/' +
      relative(base, file)
        .replaceAll('\\', '/')
        .replace(/\.ts$/, '')
        .replace(/\/index$/, '')
        .replace(/\[([^\]]+)\]/g, 'x');
    return { route, methods };
  });
}

function request(
  url: string,
  init: { method?: string; origin?: string | null; secFetchSite?: string | null } = {},
): Request {
  const headers = new Headers();
  if (init.origin) headers.set('Origin', init.origin);
  if (init.secFetchSite) headers.set('Sec-Fetch-Site', init.secFetchSite);
  return new Request(url, { method: init.method ?? 'POST', headers });
}

describe('AMPED-CF-00A admin mutation origin defence', () => {
  const routes = adminRoutes();

  it('found the whole admin surface, and it is all mutations', () => {
    expect(routes.length).toBeGreaterThanOrEqual(20);
    for (const { route, methods } of routes) {
      expect(methods.length, route).toBeGreaterThan(0);
      // Every /api/admin route changes state. There is no safe-method
      // admin API to carve an exception for.
      expect(methods, route).not.toContain('GET');
    }
  });

  it('protects EVERY admin mutation route against a hostile origin', () => {
    for (const { route, methods } of routes) {
      for (const method of methods) {
        const blocked = guardAdminMutation(
          request(`${ORIGIN}${route}`, { method, origin: HOSTILE }),
        );
        expect(blocked?.status, `${method} ${route}`).toBe(403);
      }
    }
  });

  it('protects EVERY admin mutation route against cross-site fetch metadata', () => {
    for (const { route, methods } of routes) {
      for (const method of methods) {
        const blocked = guardAdminMutation(
          request(`${ORIGIN}${route}`, { method, secFetchSite: 'cross-site' }),
        );
        expect(blocked?.status, `${method} ${route}`).toBe(403);
      }
    }
  });

  it('lets EVERY admin mutation route through from the admin UI itself', () => {
    for (const { route, methods } of routes) {
      for (const method of methods) {
        // What the real admin pages send: same-origin fetch.
        expect(
          guardAdminMutation(
            request(`${ORIGIN}${route}`, { method, origin: ORIGIN, secFetchSite: 'same-origin' }),
          ),
          `${method} ${route}`,
        ).toBeNull();
      }
    }
  });

  // -- the named representatives, spelled out ------------------------------

  describe.each([
    ['discrepancy resolve', '/api/admin/discrepancies/pdx_1/resolve'],
    ['discrepancy reopen', '/api/admin/discrepancies/pdx_1/reopen'],
    ['gig lifecycle', '/api/admin/gigs/evt_1/lifecycle'],
    ['gig publish', '/api/admin/gigs/evt_1/publish'],
    ['artist archive', '/api/admin/artists/art_1/archive'],
    ['venue archive', '/api/admin/venues/ven_1/archive'],
  ])('%s', (_label, path) => {
    const url = `${ORIGIN}${path}`;

    it('succeeds same-origin', () => {
      expect(
        guardAdminMutation(request(url, { origin: ORIGIN, secFetchSite: 'same-origin' })),
      ).toBeNull();
    });

    it('is rejected with a foreign Origin', () => {
      expect(guardAdminMutation(request(url, { origin: HOSTILE }))?.status).toBe(403);
    });

    it('is rejected on Sec-Fetch-Site: cross-site', () => {
      expect(guardAdminMutation(request(url, { secFetchSite: 'cross-site' }))?.status).toBe(403);
    });

    it('is rejected even when the hostile page fakes a same-origin-looking body', () => {
      // A cross-site form POST can set any body it likes; it cannot set
      // Origin, and it cannot suppress Sec-Fetch-Site.
      const forged = new Request(url, {
        method: 'POST',
        headers: {
          Origin: HOSTILE,
          'Sec-Fetch-Site': 'cross-site',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'orderId=ord_1&state=resolved_manually',
      });
      expect(guardAdminMutation(forged)?.status).toBe(403);
    });
  });

  // -- the rule itself ------------------------------------------------------

  describe('the rule', () => {
    it('believes Sec-Fetch-Site over Origin when both are present', () => {
      // A same-origin Origin cannot rescue a cross-site request: the browser
      // sets Sec-Fetch-Site and script cannot forge it.
      expect(
        evaluateRequestOrigin({
          method: 'POST',
          url: `${ORIGIN}/api/admin/gigs`,
          secFetchSite: 'cross-site',
          origin: ORIGIN,
        }),
      ).toBe('reject-cross-site');
    });

    it('rejects same-site as well as cross-site', () => {
      // Admin and storefront share ONE hostname by design, so a sibling
      // subdomain posting here is not a flow this application has.
      expect(
        evaluateRequestOrigin({
          method: 'POST',
          url: `${ORIGIN}/api/admin/gigs`,
          secFetchSite: 'same-site',
          origin: null,
        }),
      ).toBe('reject-cross-site');
    });

    it('allows a non-browser client that sends neither header', () => {
      // Documented compatibility policy: a browser mounting a cross-origin
      // POST always sends Origin. A request with neither signal is a
      // server-to-server or CLI client, which has no ambient session to
      // hijack and therefore cannot be a confused deputy.
      expect(
        evaluateRequestOrigin({
          method: 'POST',
          url: `${ORIGIN}/api/admin/gigs`,
          secFetchSite: null,
          origin: null,
        }),
      ).toBe('allow');
    });

    it('falls back to Origin when fetch metadata is absent', () => {
      expect(
        evaluateRequestOrigin({
          method: 'POST',
          url: `${ORIGIN}/api/admin/gigs`,
          secFetchSite: null,
          origin: ORIGIN,
        }),
      ).toBe('allow');
      expect(
        evaluateRequestOrigin({
          method: 'POST',
          url: `${ORIGIN}/api/admin/gigs`,
          secFetchSite: null,
          origin: HOSTILE,
        }),
      ).toBe('reject-foreign-origin');
    });

    it('compares against the request, not a hard-coded hostname', () => {
      // The same code must be correct on localhost, workers.dev and the real
      // domain without anyone maintaining a list.
      for (const host of [
        'http://127.0.0.1:8787',
        'https://ampedup-staging.workers.dev',
        'https://staging.ampedupmusicpromo.co.uk',
        'https://ampedupmusicpromo.co.uk',
      ]) {
        expect(
          evaluateRequestOrigin({
            method: 'POST',
            url: `${host}/api/admin/gigs`,
            secFetchSite: null,
            origin: host,
          }),
          host,
        ).toBe('allow');
        expect(
          evaluateRequestOrigin({
            method: 'POST',
            url: `${host}/api/admin/gigs`,
            secFetchSite: null,
            origin: HOSTILE,
          }),
          host,
        ).toBe('reject-foreign-origin');
      }
      const source = readFileSync(join(root, 'src', 'lib', 'access.ts'), 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code).not.toContain('localhost');
      expect(code).not.toContain('ampedupmusicpromo');
    });

    it.each(['GET', 'HEAD', 'OPTIONS'])('leaves %s alone', (method) => {
      expect(
        guardAdminMutation(request(`${ORIGIN}/admin/orders`, { method, origin: HOSTILE })),
      ).toBeNull();
    });
  });

  // -- everything outside /api/admin is untouched ---------------------------

  describe('scope', () => {
    it.each([
      ['webhook', '/api/webhooks/sumup'],
      ['checkout orders', '/api/checkout/orders'],
      ['checkout confirm', '/api/checkout/confirm'],
      ['public page', '/gigs/some-gig'],
      ['media', '/media/med_1'],
    ])('does not touch %s', (_label, path) => {
      // SumUp's servers send no Origin and no fetch metadata, and the webhook
      // is unauthenticated by design with zero payment authority - guarding
      // it would break delivery and protect nothing.
      expect(guardAdminMutation(request(`${ORIGIN}${path}`, { origin: HOSTILE }))).toBeNull();
      expect(
        guardAdminMutation(request(`${ORIGIN}${path}`, { secFetchSite: 'cross-site' })),
      ).toBeNull();
      expect(isProtectedPath(path)).toBe(false);
    });
  });

  describe('wiring', () => {
    it('runs in middleware, after identity and before any handler', () => {
      const source = readFileSync(join(root, 'src', 'middleware.ts'), 'utf8');
      const identity = source.indexOf("if (decision.action !== 'allow') return accessDeniedResponse();");
      const guard = source.indexOf('guardAdminMutation(context.request)');
      // The FIRST `return next()` is the public-path passthrough at the top;
      // the admin one is last.
      const proceed = source.lastIndexOf('return next();');

      expect(identity).toBeGreaterThan(-1);
      expect(guard).toBeGreaterThan(identity);
      expect(guard).toBeLessThan(proceed);
    });

    it('introduces no CSRF token system', () => {
      const source = readFileSync(join(root, 'src', 'lib', 'access.ts'), 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code).not.toMatch(/csrfToken|_csrf|xsrf/i);
    });
  });
});

describe('AMPED-CF-00A pre-staging hygiene', () => {
  describe('Astro sessions', () => {
    it('has no consumer anywhere in the application', () => {
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          if (statSync(full).isDirectory()) walk(full);
          else if (/\.(ts|astro)$/.test(entry)) files.push(full);
        }
      };
      walk(join(root, 'src'));

      for (const file of files) {
        const code = readFileSync(file, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        expect(code, file).not.toMatch(/Astro\.session|context\.session|locals\.session/);
      }
    });

    it('is switched off, so deployment needs no placeholder KV namespace', () => {
      expect(readFileSync(join(root, 'astro.config.mjs'), 'utf8')).toMatch(/session:\s*false/);
    });

    it('leaves no unresolved SESSION binding in the generated deploy config', () => {
      // The build emits the config wrangler actually deploys. A KV binding
      // with no namespace id would be rejected at deploy time.
      const generated = JSON.parse(
        readFileSync(join(root, 'dist', 'server', 'wrangler.json'), 'utf8'),
      ) as { kv_namespaces?: Array<{ binding: string; id?: string }> };
      const unresolved = (generated.kv_namespaces ?? []).filter((kv) => !kv.id);
      expect(unresolved).toEqual([]);
    });
  });

  describe('site identity', () => {
    const site = readFileSync(join(root, 'src', 'lib', 'site.ts'), 'utf8');
    const config = readFileSync(join(root, 'astro.config.mjs'), 'utf8');
    const seo = readFileSync(join(root, 'src', 'lib', 'seo.ts'), 'utf8');

    it('agrees on one canonical origin', () => {
      expect(seo).toContain("CANONICAL_ORIGIN = 'https://ampedupmusicpromo.co.uk'");
      expect(site).toContain("url: 'https://ampedupmusicpromo.co.uk'");
      expect(config).toContain("site: 'https://ampedupmusicpromo.co.uk'");
    });

    it('uses provisioned inbound addresses', () => {
      expect(site).toContain("email: 'hello@ampedupmusicpromo.co.uk'");
      expect(site).toContain("ticketsEmail: 'tickets@ampedupmusicpromo.co.uk'");
    });

    it('never tells a customer to write to the unregistered domain', () => {
      // `ampedupmusic.co.uk` (no "promo") was a typo and was never
      // registered. Fabricated audit-actor names in the seed may keep it -
      // they name nobody real and instruct nobody - but anything a customer
      // is told to contact must resolve.
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          if (statSync(full).isDirectory()) walk(full);
          else if (/\.(ts|astro)$/.test(entry)) files.push(full);
        }
      };
      walk(join(root, 'src'));

      for (const file of files) {
        const contents = readFileSync(file, 'utf8');
        expect(contents, file).not.toMatch(/(hello|tickets|info|support)@ampedupmusic\.co\.uk/);
        expect(contents, file).not.toMatch(/https:\/\/(www\.)?ampedupmusic\.co\.uk/);
      }
    });
  });

  describe('staging must not advertise itself', () => {
    it('only treats an explicitly-production build as indexable', () => {
      const env = readFileSync(join(root, 'src', 'lib', 'environment.ts'), 'utf8');
      expect(env).toContain("DEPLOY_ENV === 'production'");
      // Opt-in, so a forgotten flag fails safe rather than publishing a
      // duplicate of the real site under the brand's own name.
      expect(env).toContain("?? 'development'");
    });

    it('suppresses indexing site-wide off production', () => {
      const layout = readFileSync(join(root, 'src', 'layouts', 'BaseLayout.astro'), 'utf8');
      expect(layout).toContain('const blockIndexing = noindex || !IS_INDEXABLE;');
      expect(layout).toContain('{blockIndexing && <meta name="robots" content="noindex, nofollow" />}');
    });
  });

  describe('wrangler configuration', () => {
    const wrangler = readFileSync(join(root, 'wrangler.jsonc'), 'utf8');

    it('names the directory the build actually serves', () => {
      expect(wrangler).toContain('"directory": "./dist/client"');
      expect(wrangler).not.toMatch(/"directory":\s*"\.\/dist"/);
    });

    it('declares a staging environment with the certified five-minute cron', () => {
      expect(wrangler).toContain('"ampedup-staging"');
      expect(wrangler).toContain('"AMPED_ENV": "staging"');
      const staging = wrangler.split('"staging": {')[1];
      expect(staging).toMatch(/"triggers":\s*\{\s*"crons":\s*\["\*\/5 \* \* \* \*"\]/);
    });

    it('keeps the default environment cron unchanged', () => {
      expect(wrangler).toContain('"crons": ["*/5 * * * *"]');
    });

    it('carries no secret values', () => {
      expect(wrangler).not.toMatch(/sup_sk|SUMUP_API_KEY"\s*:/);
    });
  });
});
