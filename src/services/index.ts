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
import { createD1DiscrepancyStore, type DiscrepancyStore } from './payments/discrepancies.ts';
import { createSumUpClient } from './payments/sumup/client.ts';
import { createSumUpPaymentProvider } from './payments/sumup/provider.ts';
import {
  createSumUpPaymentVerifier,
  type SumUpPaymentVerifier,
} from './payments/sumup/verification.ts';
import { PaymentConfigurationError } from './payments/sumup/types.ts';
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

/**
 * Read the server-side SumUp credentials (AMPED-07B).
 *
 * This is the ONLY place in the application that names these variables; the
 * adapter takes them as constructor input so that no component, page or client
 * script can reach them. Returns undefined when either is missing, which the
 * checkout seam turns into a controlled refusal rather than a mock fallback.
 */
async function boundSumUpConfig(): Promise<
  { apiKey: string; merchantCode: string; webhookUrl?: string } | undefined
> {
  try {
    const runtime = (await import('cloudflare:workers')) as unknown as {
      env?: {
        SUMUP_API_KEY?: string;
        SUMUP_MERCHANT_CODE?: string;
        SUMUP_WEBHOOK_URL?: string;
      };
    };
    const apiKey = runtime.env?.SUMUP_API_KEY;
    const merchantCode = runtime.env?.SUMUP_MERCHANT_CODE;
    // Both or neither: a half-configured integration is a misconfiguration,
    // not a degraded mode worth serving a customer.
    if (!apiKey || !merchantCode) return undefined;
    // The webhook URL is OPTIONAL and is not a credential. Unset means
    // `return_url` is omitted from checkout creation rather than defaulted to
    // something invented - a wrong callback is worse than no callback.
    const webhookUrl = runtime.env?.SUMUP_WEBHOOK_URL;
    return webhookUrl ? { apiKey, merchantCode, webhookUrl } : { apiKey, merchantCode };
  } catch {
    // Node/Vitest, or a Worker without the secrets bound.
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
const sumUpConfig = await boundSumUpConfig();

let cached: Services | null = null;
let cachedGigMutations: GigMutationService | null = null;
let cachedEntityMutations: {
  artists: ArtistMutationService;
  venues: VenueMutationService;
} | null = null;
let cachedMediaMutations: MediaMutationService | null = null;
let cachedSocial: (SocialMutationService & SocialService) | null = null;
let cachedOrderMutations: OrderMutationService | null = null;
let cachedPaymentProvider: PaymentProvider | null = null;
let cachedVerifier: SumUpPaymentVerifier | null = null;
let cachedDiscrepancyStore: DiscrepancyStore | null = null;

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
 * The order state machine alone, with no payment provider attached.
 *
 * Split out in AMPED-07B so that the reservation sweep keeps working on a
 * runtime where SumUp is not configured. Expiring a hold needs a database, not
 * a merchant account, and a missing credential must never stop stock being
 * released back on sale.
 */
function orderMutations(): OrderMutationService {
  if (!database) {
    throw new Error('The D1 binding "DB" is not available, so checkout cannot run.');
  }
  cachedOrderMutations ??= createD1OrderMutations(database);
  return cachedOrderMutations;
}

/**
 * The checkout seam: the order state machine plus the REAL payment provider.
 *
 * AMPED-07B makes SumUp the runtime provider. There is deliberately NO
 * fallback to `MockPaymentProvider` when the credentials are missing: a silent
 * fallback would send a paying customer to a fake checkout, which is far worse
 * than refusing to sell. A missing credential therefore fails closed with
 * `PaymentConfigurationError`, which the checkout routes map to a controlled
 * "checkout unavailable" response.
 *
 * Tests never reach this function: they construct `createD1OrderMutations()`
 * directly and pass an explicit provider into `beginPayment`, which is the
 * accepted injection seam.
 */
export function getCheckout(): {
  orders: OrderMutationService;
  provider: PaymentProvider;
} {
  const orders = orderMutations();
  if (!sumUpConfig) throw new PaymentConfigurationError();
  cachedPaymentProvider ??= createSumUpPaymentProvider(sumUpConfig);
  return { orders, provider: cachedPaymentProvider };
}

/**
 * The AMPED-07C1 webhook verification seam.
 *
 * Returns the authenticated SumUp verifier plus the order mutations, so the
 * public webhook route never touches a credential, a client or raw SQL. It
 * deliberately does NOT go through `PaymentProvider`: correlation needs the
 * checkout's reference, amount, currency and merchant code, and the accepted
 * contract's `confirm()` exposes only a status. Widening that contract to
 * suit one provider would have been the worse trade.
 *
 * Fails closed exactly like `getCheckout()`: no credentials, no verification.
 */
export function getSumUpVerification(): {
  orders: OrderMutationService;
  verifier: SumUpPaymentVerifier;
} {
  const orders = orderMutations();
  if (!sumUpConfig) throw new PaymentConfigurationError();
  cachedVerifier ??= createSumUpPaymentVerifier({
    client: createSumUpClient(sumUpConfig),
    merchantCode: sumUpConfig.merchantCode,
    orders,
  });
  return { orders, verifier: cachedVerifier };
}

/**
 * The AMPED-07D reconciliation seam.
 *
 * Deliberately the SAME pair the webhook route gets: one verifier, one
 * writer. Reconciliation is orchestration over the accepted 07C1 seam, not a
 * second way to confirm a payment.
 *
 * Throws `PaymentConfigurationError` when SumUp is unconfigured, which the
 * scheduled task treats as "skip reconciliation" rather than "fail the run" -
 * expiring holds must keep working on a runtime with no payment credentials.
 */
export function getPaymentReconciliation(): {
  orders: OrderMutationService;
  verifier: SumUpPaymentVerifier;
} {
  return getSumUpVerification();
}

/**
 * The AMPED-07D2-2 discrepancy-detection seam.
 *
 * Returns the durable discrepancy store plus the SAME verifier the webhook
 * and reconciler use. It deliberately does NOT expose order mutations: this
 * pass must be structurally incapable of writing an order, let alone paying
 * one.
 */
export function getPaymentDiscrepancyDetection(): {
  store: DiscrepancyStore;
  verifier: SumUpPaymentVerifier;
} {
  const { verifier } = getSumUpVerification();
  if (!database) {
    throw new Error('The D1 binding "DB" is not available, so detection cannot run.');
  }
  cachedDiscrepancyStore ??= createD1DiscrepancyStore(database);
  return { store: cachedDiscrepancyStore, verifier };
}

/**
 * The AMPED-07D2-3 operator seam for payment discrepancies.
 *
 * Reads and the manual-resolution transition only. Unlike the detection
 * seam it needs no SumUp credentials - an operator must be able to see and
 * resolve a financial exception even on a runtime where the payment
 * integration is unconfigured or broken, which is exactly when discrepancies
 * are most likely to exist.
 */
export function getPaymentDiscrepancies(): DiscrepancyStore {
  if (!database) {
    throw new Error(
      'The D1 binding "DB" is not available, so payment discrepancies cannot be read.',
    );
  }
  cachedDiscrepancyStore ??= createD1DiscrepancyStore(database);
  return cachedDiscrepancyStore;
}

/**
 * Reservation maintenance used by the scheduled sweep (AMPED-06B). The Worker
 * entry passes its platform time in; the SQL stays behind the service layer.
 */
export function getReservationMaintenance(): OrderMutationService {
  return orderMutations();
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
