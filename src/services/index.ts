/**
 * Service locator.
 *
 * Every page does:
 *
 *     const services = getServices();
 *     const gigs = await services.events.listUpcoming();
 *
 * and never imports from src/data.
 *
 * WHY THERE IS NO `env` PARAMETER
 * The Cloudflare adapter used here (@astrojs/cloudflare 14, Astro 7) has
 * removed `Astro.locals.runtime.env`. Bindings are read inside server-only
 * modules from:
 *
 *     import { env } from 'cloudflare:workers';
 *
 * That is still the module used here. It is imported dynamically and guarded
 * rather than declared statically for one concrete reason: `cloudflare:workers`
 * only exists inside the Worker runtime. The Vitest suite runs in Node and
 * imports this module, and a static import would make the whole suite fail to
 * load. The dynamic form resolves to the real binding in `astro dev`, in
 * `wrangler dev` and in a deployed Worker, and falls back to `undefined` under
 * test - which is exactly the "no database in this mode" path below.
 *
 * SELECTION (AMPED-02C)
 * When `env.DB` is bound, venues, artists and events read from D1. The artist
 * service's `eventsFor()` is satisfied by the same D1 event repository, so no
 * fixture event data is reachable through it any more. Media, social, admin,
 * orders, door, enquiries, mailing list and audit stay on the AMPED-01
 * fixtures until their own slices replace them. AMPED-03A removes the fixture
 * fallback entirely and makes an unbound binding in production fail loudly;
 * that rule is deliberately NOT implemented here.
 *
 * The `Services` object is cached per isolate. That is safe for read-only
 * repositories. Anything holding request-scoped state must NOT be cached here.
 */

import type { Services } from './contracts.ts';
import { createD1ArtistService } from './d1/artists.ts';
import { createD1EventRepository } from './d1/events.ts';
import { createD1VenueService } from './d1/venues.ts';
import { createMockServices } from './mock/index.ts';

/**
 * Assemble the service set for a database binding, or the fixture set when
 * there is none. Exported so the DB-bound path can be proved directly in tests
 * without stubbing the runtime module.
 */
export function createServices(db: D1Database | undefined): Services {
  const services = createMockServices();
  if (!db) return services;

  const venues = createD1VenueService(db);
  const events = createD1EventRepository(db);
  // The artist service keeps reading artists from D1, but its `eventsFor()` now
  // asks the D1 event repository rather than the fixture one.
  const artists = createD1ArtistService(db, events);

  return {
    ...services,
    venues,
    artists,
    events,
  };
}

/**
 * Read the `DB` binding from the Worker runtime.
 *
 * The import is a literal so bundlers treat `cloudflare:workers` as external,
 * and it is guarded so a non-Worker runtime (Vitest, a plain Node script)
 * degrades to the fixture path instead of crashing on import.
 */
async function boundDatabase(): Promise<D1Database | undefined> {
  try {
    const runtime = (await import('cloudflare:workers')) as unknown as {
      env?: { DB?: D1Database };
    };
    return runtime.env?.DB;
  } catch {
    return undefined;
  }
}

const database = await boundDatabase();

let cached: Services | null = null;

export function getServices(): Services {
  cached ??= createServices(database);
  return cached;
}

/**
 * True while the application is running on fixtures rather than a database.
 * Used by the admin shell to show an unmistakable scaffold banner, so nobody
 * mistakes the demo for the real thing.
 *
 * AMPED-02C swaps venues, artists and public events, but the admin event
 * screens, orders and door are still fixtures, so the banner stays up.
 * AMPED-03A owns the rule that flips this to false once the database is bound.
 */
export function isScaffoldData(): boolean {
  return true;
}

export type { Services } from './contracts.ts';
export * from './contracts.ts';
