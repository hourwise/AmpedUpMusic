/**
 * Service locator - the single seam between the UI and the database.
 *
 * Every page does:
 *
 *     const services = getServices();
 *     const gigs = await services.events.listUpcoming();
 *
 * and never imports from a data source directly.
 *
 * WHERE THE DATA COMES FROM (AMPED-03A)
 * The AMPED-01 fixture layer is gone: src/data no longer exists and neither
 * does src/services/mock. When `env.DB` is bound, every service below reads D1.
 * There is no fixture fallback to fall back to, by design - the scaffold must
 * never quietly show invented commercial data as if it were real.
 *
 * WHY THERE IS NO FALLBACK, AND WHAT HAPPENS WITHOUT A BINDING
 * `getServices()` throws when it cannot obtain the `DB` binding. In a Worker
 * that means a misconfigured production or preview deployment fails loudly
 * instead of rendering sample data. The only supported way to get a service
 * set without a runtime binding is `createServices(db)` with a real
 * `D1Database` - which is exactly what the test suite passes in, using an
 * ephemeral D1 and the accepted seed. That is the deliberate test seam:
 * explicit, typed, and impossible to reach from a page.
 *
 * WHY THE BINDING IMPORT IS DYNAMIC
 * The @astrojs/cloudflare adapter used here removed `Astro.locals.runtime.env`;
 * bindings are read from `cloudflare:workers`. That module only exists inside
 * the Worker runtime, and the Vitest suite runs in Node, so the import is done
 * inside a guard: it resolves to the real binding in `astro dev`, `wrangler dev`
 * and a deployed Worker, and rejects harmlessly under test. No second
 * dependency-injection framework is introduced.
 *
 * The `Services` object is cached per isolate. That is safe for read-only
 * repositories. The cache is only written after a binding is in hand, so a
 * missing binding can never poison it, and a bound runtime can never observe a
 * cached fixture service because none exists.
 */

import type { Services, SocialService } from './contracts.ts';
import { createD1AdminEventService } from './d1/admin.ts';
import { createD1ArtistMutations, createD1ArtistService, type ArtistMutationService } from './d1/artists.ts';
import { createD1AuditService } from './d1/audit.ts';
import { createD1DoorService } from './d1/door.ts';
import { createD1EnquiryService } from './d1/enquiries.ts';
import { createD1EventRepository, createD1GigMutations, type GigMutationService } from './d1/events.ts';
import { createD1MailingListService } from './d1/mailing-list.ts';
import {
  createD1MediaMutations,
  createD1MediaService,
  createR2ObjectStore,
  type MediaMutationService,
} from './d1/media.ts';
import { createD1OrderService } from './d1/orders.ts';
import {
  createD1SocialMutations,
  createD1SocialService,
  type SocialMutationService,
} from './d1/social.ts';
import { createD1OrderMutations, type OrderMutationService } from './orders/service.ts';
import { createMockPaymentProvider } from './payments/mock.ts';
import type { PaymentProvider } from './contracts.ts';
import { createD1VenueMutations, createD1VenueService, type VenueMutationService } from './d1/venues.ts';

/**
 * Assemble the full D1-backed service set for a resolved binding.
 *
 * Exported so tests (and any future non-Worker entry point) can supply a real
 * database explicitly rather than reaching for a global. There is no
 * `undefined` case: a caller without a database cannot build a service set.
 */
export function createServices(db: D1Database): Services {
  const venues = createD1VenueService(db);
  const events = createD1EventRepository(db);
  // The artist service reads artists from D1 and asks the same D1 event
  // repository for `eventsFor()`, so no fixture event data is reachable.
  const artists = createD1ArtistService(db, events);

  return {
    events,
    artists,
    venues,
    media: createD1MediaService(db),
    social: createD1SocialService(db),
    admin: createD1AdminEventService(db),
    orders: createD1OrderService(db),
    door: createD1DoorService(db),
    enquiries: createD1EnquiryService(db),
    mailingList: createD1MailingListService(db),
    audit: createD1AuditService(db),
  };
}

/** Read the `DB` binding from the Worker runtime, or undefined outside it. */
async function boundDatabase(): Promise<D1Database | undefined> {
  try {
    const runtime = (await import('cloudflare:workers')) as unknown as {
      env?: { DB?: D1Database };
    };
    return runtime.env?.DB;
  } catch {
    // Node/Vitest, or a Worker with no binding: no database is available.
    return undefined;
  }
}

/** Read the private `MEDIA` R2 binding. Never a public bucket. */
async function boundMediaBucket(): Promise<R2Bucket | undefined> {
  try {
    const runtime = (await import('cloudflare:workers')) as unknown as {
      env?: { MEDIA?: R2Bucket };
    };
    return runtime.env?.MEDIA;
  } catch {
    return undefined;
  }
}

const database = await boundDatabase();
const mediaBucket = await boundMediaBucket();

let cached: Services | null = null;
let cachedGigMutations: GigMutationService | null = null;
let cachedEntityMutations: {
  artists: ArtistMutationService;
  venues: VenueMutationService;
} | null = null;
let cachedMediaMutations: MediaMutationService | null = null;
let cachedSocial: (SocialMutationService & SocialService) | null = null;
let cachedCheckout: { orders: OrderMutationService; provider: PaymentProvider } | null = null;

/**
 * The service set for this isolate. Throws when `DB` is not bound: serving the
 * application from scaffold data is no longer a supported mode.
 */
export function getServices(): Services {
  if (!database) {
    throw new Error(
      'The D1 binding "DB" is not available. The Amped Up application reads all ' +
        'of its data from D1 and no longer ships a fixture fallback, so refusing ' +
        'to render is deliberate. Bind DB (wrangler.jsonc / the Cloudflare ' +
        'dashboard) or pass a database to createServices() in tests.',
    );
  }
  cached ??= createServices(database);
  return cached;
}

/**
 * True only when no database is bound at all. With a binding the banner is
 * gone - there is no scaffold data left to warn about. A runtime that reaches
 * a page without a binding will have failed in getServices() first.
 */
export function isScaffoldData(): boolean {
  return database === undefined;
}

/**
 * The AMPED-04B admin gig mutation seam.
 *
 * Only the protected /api/admin/gigs routes may use this. It is deliberately
 * NOT part of the `Services` read object - it writes - and it resolves its D1
 * binding here, inside src/services, so API routes never import
 * `cloudflare:workers` or read env.DB directly. Fails loudly with no binding.
 */
/**
 * The AMPED-04C artist/venue mutation seam, used only by the protected
 * /api/admin/artists and /api/admin/venues routes. Same rules as the gig
 * mutations: it resolves its own binding here, fails loudly without one, and is
 * not part of the public `Services` read object.
 */
export function getAdminEntityMutations(): {
  artists: ArtistMutationService;
  venues: VenueMutationService;
} {
  if (!database) {
    throw new Error(
      'The D1 binding "DB" is not available, so admin artist/venue writes cannot run. ' +
        'An unbound runtime must not accept administrative changes.',
    );
  }
  cachedEntityMutations ??= {
    artists: createD1ArtistMutations(database),
    venues: createD1VenueMutations(database),
  };
  return cachedEntityMutations;
}

/**
 * The AMPED-05A media mutation seam (upload / attach / delete), used by the
 * protected /api/admin/media routes. Resolves the private R2 `MEDIA` binding
 * here in the service layer; no route imports `cloudflare:workers`.
 */
export function getAdminMediaMutations(): MediaMutationService {
  if (!database || !mediaBucket) {
    throw new Error(
      'The DB and MEDIA bindings are required for media writes. ' +
        'An unbound runtime must not accept uploads.',
    );
  }
  cachedMediaMutations ??= createD1MediaMutations(
    database,
    createR2ObjectStore(mediaBucket),
  );
  return cachedMediaMutations;
}

/**
 * Public object delivery for /media/<id>. The route only knows the asset id;
 * the R2 key stays inside the service layer.
 */
export function getPublicMediaObject(
  id: string,
): Promise<{ body: ReadableStream; mime: string; byteSize: number } | null> {
  return getAdminMediaMutations().getObject(id);
}

/**
 * AMPED-05B gallery reads for pages that need several events' galleries in one
 * bounded query (the global /gallery page). Same bindings, same media service.
 */
export function getGalleryReads(): Pick<MediaMutationService, 'listGalleryForEvents'> {
  return getAdminMediaMutations();
}

/**
 * The AMPED-05C social curation seam, used only by the protected
 * /api/admin/social routes and the admin page. Resolves its own binding.
 */
export function getAdminSocial(): SocialMutationService & SocialService {
  if (!database) {
    throw new Error(
      'The D1 binding "DB" is not available, so social curation cannot run.',
    );
  }
  cachedSocial ??= {
    ...createD1SocialMutations(database),
    ...createD1SocialService(database),
  };
  return cachedSocial;
}

/**
 * The AMPED-06A checkout seam: the order state machine plus the mock payment
 * provider. Public checkout routes use this; the provider is swappable for the
 * SumUp adapter in AMPED-07A without changing callers.
 */
export function getCheckout(): {
  orders: OrderMutationService;
  provider: PaymentProvider;
} {
  if (!database) {
    throw new Error('The D1 binding "DB" is not available, so checkout cannot run.');
  }
  cachedCheckout ??= {
    orders: createD1OrderMutations(database),
    provider: createMockPaymentProvider(),
  };
  return cachedCheckout;
}

/**
 * Reservation maintenance used by the scheduled sweep (AMPED-06B). The Worker
 * entry passes its platform time in; the SQL stays behind the service layer.
 */
export function getReservationMaintenance(): OrderMutationService {
  return getCheckout().orders;
}

export function getAdminGigMutations(): GigMutationService {
  if (!database) {
    throw new Error(
      'The D1 binding "DB" is not available, so admin gig writes cannot run. ' +
        'This is deliberate: an unbound runtime must not accept administrative changes.',
    );
  }
  cachedGigMutations ??= createD1GigMutations(database);
  return cachedGigMutations;
}

export type { Services } from './contracts.ts';
export * from './contracts.ts';
export type { PhotographyFields, MediaMutationService } from './d1/media.ts';
