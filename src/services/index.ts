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
 * modules with:
 *
 *     import { env } from 'cloudflare:workers';
 *
 * That is strictly better for this project than threading `env` through every
 * page: when AMPED-02A/03A land, this file is the only one that changes.
 * The intended shape at that point is:
 *
 *     import { env } from 'cloudflare:workers';
 *     export function getServices(): Services {
 *       return env.DB ? createD1Services(env.DB) : createMockServices();
 *     }
 *
 * The `Services` object is cached per isolate. That is safe for read-only
 * repositories. Anything holding request-scoped state must NOT be cached here.
 */

import type { Services } from './contracts.ts';
import { createMockServices } from './mock/index.ts';

let cached: Services | null = null;

export function getServices(): Services {
  cached ??= createMockServices();
  return cached;
}

/**
 * True while the application is running on fixtures rather than a database.
 * Used by the admin shell to show an unmistakable scaffold banner, so nobody
 * mistakes the demo for the real thing.
 */
export function isScaffoldData(): boolean {
  return true;
}

export type { Services } from './contracts.ts';
export * from './contracts.ts';
