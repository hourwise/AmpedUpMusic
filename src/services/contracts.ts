/**
 * Service contracts - the seam between the UI and whatever stores the data.
 *
 * Every page and component in this project reads data through one of these
 * interfaces. During AMPED-01 they are implemented against in-memory fixtures
 * (src/services/mock). From AMPED-03A they are implemented against D1. The
 * pages must not need to change when that happens.
 *
 * Rules for later slices:
 *  - Widen an interface rather than reaching around it.
 *  - Every method is async even where the fixture implementation is not, so
 *    the signatures survive the move to a real database unchanged.
 *  - Read methods live here. Write methods for admin CRUD are added in
 *    AMPED-04B/04C and payment methods in AMPED-06A/07A, each in their own
 *    interface, so that a slice can be given exactly the surface it needs.
 */

import type {
  Artist,
  AuditLogEntry,
  Enquiry,
  MediaAsset,
  Order,
  ScanResult,
  Ticket,
  Venue,
} from '@/types/domain.ts';
import type {
  EnquiryView,
  EventSalesSummary,
  EventView,
  OrderView,
  SocialPostView,
  SubscriberView,
} from '@/types/view.ts';

/** What the public site can read. Never exposes drafts or internal notes. */
export interface PublicEventService {
  /** Published, not yet finished, soonest first. */
  listUpcoming(limit?: number): Promise<EventView[]>;
  /** The soonest upcoming event, or null when the diary is empty. */
  nextEvent(): Promise<EventView | null>;
  /** Finished events, most recent first. */
  listPast(limit?: number): Promise<EventView[]>;
  /** Published events only. Returns null for drafts, so a leaked slug 404s. */
  getBySlug(slug: string): Promise<EventView | null>;
  /** Every slug the public router should generate a page for. */
  listPublicSlugs(): Promise<Array<{ slug: string; isPast: boolean }>>;
  /** Upcoming events with at least one public ticket type, for /tickets. */
  listOnSale(): Promise<EventView[]>;
}

export interface ArtistService {
  list(): Promise<Artist[]>;
  getBySlug(slug: string): Promise<Artist | null>;
  /** Every event this artist has appeared on, upcoming and past. */
  eventsFor(artistId: string): Promise<EventView[]>;
}

export interface VenueService {
  list(): Promise<Venue[]>;
  getBySlug(slug: string): Promise<Venue | null>;
}

export interface MediaService {
  /** All gallery images, newest event first, for /gallery. */
  listGallery(limit?: number): Promise<MediaAsset[]>;
  listForEvent(eventId: string): Promise<MediaAsset[]>;
  get(id: string): Promise<MediaAsset | null>;
}

export interface SocialService {
  listFeatured(limit?: number): Promise<SocialPostView[]>;
  listForEvent(eventId: string): Promise<SocialPostView[]>;
}

/**
 * What the admin application can read. Includes drafts, internal notes,
 * customer details and money. Every implementation of this interface must be
 * behind the Cloudflare Access boundary established in AMPED-04A.
 */
export interface AdminEventService {
  /** Everything, including drafts and archived, soonest first. */
  listAll(): Promise<EventView[]>;
  getById(id: string): Promise<EventView | null>;
  salesSummary(eventId: string): Promise<EventSalesSummary>;
  /** The event an operator is most likely to be working on right now. */
  nextEvent(): Promise<EventView | null>;
}

export interface OrderService {
  listForEvent(eventId: string): Promise<OrderView[]>;
  listRecent(limit?: number): Promise<OrderView[]>;
  getByReference(reference: string): Promise<OrderView | null>;
  /**
   * Manual door lookup: matches on name, email, order reference or ticket
   * reference. Deliberately one method, because door staff have one search box
   * and should not have to know which kind of thing they are holding.
   */
  search(query: string, eventId?: string): Promise<OrderView[]>;
}

/**
 * Door Mode.
 *
 * `checkIn` MUST be atomic in the real implementation (AMPED-09B): two phones
 * scanning the same code at the same instant must produce exactly one `valid`
 * and one `already-used`. The fixture implementation is not atomic and says so
 * in its own doc comment; it exists only to drive the UX.
 */
export interface DoorService {
  /** Events an operator could plausibly be working tonight. */
  listDoorEvents(): Promise<EventView[]>;
  /** Look up without admitting. Used by the manual search results list. */
  inspect(token: string, eventId: string): Promise<ScanResult>;
  /** Admit. Idempotent per ticket: the second call returns `already-used`. */
  checkIn(token: string, eventId: string, operatorEmail: string): Promise<ScanResult>;
  /** Undo an accidental scan. Always audited. */
  undoCheckIn(ticketId: string, operatorEmail: string): Promise<ScanResult>;
  listGuestList(eventId: string): Promise<Ticket[]>;
  /** Live admission counters for the door header. */
  admissionCounts(eventId: string): Promise<{ admitted: number; expected: number; guestList: number }>;
}

export interface EnquiryService {
  list(status?: Enquiry['status']): Promise<EnquiryView[]>;
  countNew(): Promise<number>;
}

export interface MailingListService {
  list(): Promise<SubscriberView[]>;
  counts(): Promise<{ subscribed: number; unsubscribed: number; bounced: number }>;
  growth(): Promise<ReadonlyArray<{ label: string; count: number }>>;
}

export interface AuditService {
  listRecent(limit?: number): Promise<AuditLogEntry[]>;
}

/**
 * Payment provider boundary (implemented in AMPED-07A).
 *
 * Declared here during AMPED-01 so the checkout UI can be written against a
 * shape that will not change when SumUp arrives. No implementation of this
 * interface exists yet and none should be written outside AMPED-07.
 */
export interface PaymentProvider {
  readonly name: 'sumup' | 'mock';
  /**
   * Creates a hosted checkout server-side and returns the URL to redirect to.
   * Credentials never reach the browser.
   */
  createCheckout(input: {
    orderId: string;
    reference: string;
    amountInPence: number;
    currency: 'GBP';
    customerEmail: string;
    returnUrl: string;
  }): Promise<{ checkoutId: string; redirectUrl: string; expiresAt: string }>;
  /**
   * Reads the authoritative payment state back from the provider.
   * This - not the browser return URL - is what may move an order to `paid`.
   */
  confirm(checkoutId: string): Promise<{ status: 'paid' | 'pending' | 'failed'; paidAt?: string }>;
  /** Verifies a webhook signature. Returns the checkout id, or null if invalid. */
  verifyWebhook(request: Request): Promise<{ checkoutId: string } | null>;
}

/**
 * Transactional email boundary (implemented in AMPED-08C).
 *
 * Named after the build plan TicketEmailProvider so that swapping Resend for
 * something else later is a one-file change.
 */
export interface TicketEmailProvider {
  readonly name: string;
  sendOrderConfirmation(input: {
    order: Order;
    tickets: Ticket[];
    /** Idempotency key. Sending twice with the same key must send one email. */
    idempotencyKey: string;
  }): Promise<{ messageId: string; deduplicated: boolean }>;
  sendEventNotice(input: {
    order: Order;
    kind: 'cancelled' | 'postponed' | 'venue-change';
    message: string;
    idempotencyKey: string;
  }): Promise<{ messageId: string; deduplicated: boolean }>;
}

/** Everything the application can read, assembled in src/services/index.ts. */
export interface Services {
  events: PublicEventService;
  artists: ArtistService;
  venues: VenueService;
  media: MediaService;
  social: SocialService;
  admin: AdminEventService;
  orders: OrderService;
  door: DoorService;
  enquiries: EnquiryService;
  mailingList: MailingListService;
  audit: AuditService;
}
