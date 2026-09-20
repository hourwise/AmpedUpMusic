/**
 * Amped Up Music Promotions - core domain model.
 *
 * These are the shared, storage-agnostic shapes used by both the public site
 * and the admin application. They are deliberately plain data: nothing here
 * knows about D1, R2, SumUp or Astro.
 *
 * Conventions that later slices MUST preserve:
 *  - All money is an integer number of PENCE. Never a float, never a string.
 *  - All timestamps are ISO-8601 strings in UTC (e.g. 2026-11-14T19:30:00.000Z).
 *  - All human-facing dates/times are formatted through src/lib/dates.ts in
 *    Europe/London, so British Summer Time is handled in exactly one place.
 *  - Every record carries a stable opaque `id`. Slugs are for URLs and may change.
 */

/** Integer pence. 1000 === GBP 10.00 */
export type Pence = number;

/** ISO-8601 UTC instant, e.g. "2026-11-14T19:30:00.000Z" */
export type IsoDateTime = string;

/** ISO-8601 calendar date, e.g. "2026-11-14" */
export type IsoDate = string;

export type Uuid = string;

// ---------------------------------------------------------------------------
// Venues
// ---------------------------------------------------------------------------

export interface Venue {
  id: Uuid;
  name: string;
  slug: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  postcode: string;
  /** Anything true of the room every time; shown on every event at that venue. */
  standardNotes?: string;
  /** Step-free access, accessible toilets, assistance dog policy, and so on. */
  accessibilityInfo?: string;
  capacity?: number;
  websiteUrl?: string;
  /** Deep link to a map provider. Stored, not derived, so a bad pin can be fixed. */
  mapUrl?: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

// ---------------------------------------------------------------------------
// Artists
// ---------------------------------------------------------------------------

export type SocialNetwork =
  | 'instagram'
  | 'tiktok'
  | 'facebook'
  | 'youtube'
  | 'spotify'
  | 'bandcamp'
  | 'soundcloud'
  | 'website';

export type SocialLinks = Partial<Record<SocialNetwork, string>>;

export interface Artist {
  id: Uuid;
  name: string;
  slug: string;
  /** One-line hook used on cards and in lineup lists. */
  tagline?: string;
  biography?: string;
  genre?: string;
  /** Home town or base, e.g. "Sheffield". */
  basedIn?: string;
  imageAssetId?: Uuid;
  links: SocialLinks;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** An artist as they appear on one specific bill. */
export interface EventLineupEntry {
  artistId: Uuid;
  /** 0 = headline, 1 = main support, 2 = opener, and so on. */
  position: number;
  /** Per-night override, e.g. "acoustic set" or "DJ set". */
  billingNote?: string;
  /** Stage time, if the promoter has published a running order. */
  setTime?: IsoDateTime;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Lifecycle statuses.
 *
 * Past/future presentation is derived from the DATE, not from the status: an
 * event does not have to be marked `completed` before it appears in Past Gigs.
 * `completed` and `archived` exist so an operator can deliberately retire
 * something early or hide it from the public archive.
 */
export type EventStatus =
  | 'draft'
  | 'published'
  | 'postponed'
  | 'cancelled'
  | 'completed'
  | 'archived';

export type AgeRestriction = 'all-ages' | '14-plus' | '16-plus' | '18-plus';

export interface PhotographyCredit {
  /** e.g. "AnyaParallax" */
  credit: string;
  galleryUrl?: string;
  photographerUrl?: string;
}

export interface Event {
  id: Uuid;
  title: string;
  slug: string;
  status: EventStatus;
  /** Short line above the title, e.g. "Amped Up presents". */
  strapline?: string;
  description: string;
  venueId: Uuid;
  /** When doors open to the public. */
  doorsAt: IsoDateTime;
  /** First act on stage. */
  startsAt: IsoDateTime;
  /** Curfew. Drives "expected finish" and the automatic move into Past Gigs. */
  endsAt?: IsoDateTime;
  ageRestriction: AgeRestriction;
  /** Supplements the venue standing accessibility notes for this night only. */
  accessibilityNotes?: string;
  posterAssetId?: Uuid;
  heroAssetId?: Uuid;
  lineup: EventLineupEntry[];
  links: SocialLinks;
  /** Photography credit and gallery. Modelled, never hard-coded into a page. */
  photography?: PhotographyCredit;
  /** Operator-facing note. Never rendered publicly. */
  internalNotes?: string;
  /** Required when status is `cancelled` or `postponed`. Shown prominently. */
  statusMessage?: string;
  /** If postponed and the replacement date already exists as its own event. */
  rescheduledToEventId?: Uuid;
  publishedAt?: IsoDateTime;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

// ---------------------------------------------------------------------------
// Ticketing
// ---------------------------------------------------------------------------

export interface TicketType {
  id: Uuid;
  eventId: Uuid;
  name: string;
  description?: string;
  priceInPence: Pence;
  /** Allocation for this type. Event capacity is the sum of its public types. */
  capacity: number;
  /** Hard limit per order, so one buyer cannot take the whole room. */
  maxPerOrder?: number;
  salesOpenAt?: IsoDateTime;
  salesCloseAt?: IsoDateTime;
  /** Display order in the ticket panel. */
  position: number;
  /** Hidden types back guest list and comp allocations. */
  visibility: 'public' | 'hidden';
}

/**
 * Live inventory for one ticket type.
 *
 * AMPED-01 supplies this from fixtures. AMPED-06B computes it from D1 and
 * AMPED-06C makes the reserve/sell transition atomic. No UI code should ever
 * compute `capacity - sold` itself: always read this shape.
 */
export interface TicketInventory {
  ticketTypeId: Uuid;
  capacity: number;
  sold: number;
  /** Held by an in-flight checkout that has neither paid nor expired. */
  reserved: number;
  /** capacity - sold - reserved, floored at 0. */
  available: number;
}

/**
 * What a customer is told about availability.
 *
 * Deliberately coarse. Publishing exact remaining counts creates pressure
 * selling, invites scraping, and tells competitors how the night is going.
 */
export type AvailabilityState =
  | 'available'
  | 'selling-fast'
  | 'last-few'
  | 'sold-out'
  | 'not-yet-on-sale'
  | 'sales-closed'
  | 'unavailable';

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

/**
 * Order state machine (implemented for real in AMPED-06A).
 *
 *   pending --reserve--> awaiting_payment --verified--> paid --> refunded
 *      |                        |
 *      +--abandoned--> cancelled +--expired/failed--> expired
 *
 * `paid` is the ONLY state that may issue tickets, and it may only be entered
 * as the result of a server-side confirmation read back from SumUp. A browser
 * redirect carrying `?payment=success` is never sufficient evidence.
 */
export type OrderStatus =
  | 'pending'
  | 'awaiting_payment'
  | 'paid'
  | 'cancelled'
  | 'expired'
  | 'refunded'
  | 'partially_refunded';

export interface OrderItem {
  id: Uuid;
  orderId: Uuid;
  ticketTypeId: Uuid;
  quantity: number;
  /** Immutable price at purchase time. Never re-read from the TicketType. */
  unitPriceInPence: Pence;
  /** Immutable name, so a later rename does not rewrite history. */
  ticketTypeName: string;
}

export interface Order {
  id: Uuid;
  /** Human-quotable reference printed on tickets and emails, e.g. AMP-26-00814. */
  reference: string;
  eventId: Uuid;
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  status: OrderStatus;
  totalInPence: Pence;
  /** Per-order booking fee, should the promoter ever charge one. 0 for V1. */
  feeInPence: Pence;
  items: OrderItem[];
  /** Opaque SumUp checkout id. No card data is ever stored. */
  paymentReference?: string;
  paymentProvider?: 'sumup' | 'mock' | 'cash' | 'comp';
  /** Written from the verified provider confirmation, not the browser return. */
  paidAt?: IsoDateTime;
  /** Reservation expiry. SumUp hosted checkout sessions last 30 minutes. */
  reservationExpiresAt?: IsoDateTime;
  marketingOptIn: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

// ---------------------------------------------------------------------------
// Tickets and admission
// ---------------------------------------------------------------------------

export type TicketStatus = 'issued' | 'checked_in' | 'void' | 'refunded';

export interface Ticket {
  id: Uuid;
  orderId: Uuid;
  eventId: Uuid;
  ticketTypeId: Uuid;
  /** Short reference for manual door lookup, e.g. AMP-26-00814-2. */
  reference: string;
  /**
   * Opaque admission credential encoded in the QR. Contains NO customer PII.
   * Generated in AMPED-08B; only a hash of it is ever persisted.
   */
  tokenHash?: string;
  status: TicketStatus;
  attendeeName?: string;
  /** Guest list entries are ordinary tickets backed by a comp order. */
  isGuestList: boolean;
  issuedAt: IsoDateTime;
  checkedInAt?: IsoDateTime;
}

export interface CheckIn {
  id: Uuid;
  ticketId: Uuid;
  eventId: Uuid;
  /** Cloudflare Access identity of the operator who scanned. */
  operatorEmail: string;
  method: 'qr' | 'manual' | 'guest-list';
  scannedAt: IsoDateTime;
}

/** The result Door Mode renders. Deliberately a closed union. */
export type ScanOutcome = 'valid' | 'already-used' | 'invalid' | 'wrong-event' | 'void';

export interface ScanResult {
  outcome: ScanOutcome;
  ticket?: Ticket;
  order?: Pick<Order, 'reference' | 'customerName'>;
  ticketTypeName?: string;
  /** Un-checked-in tickets left on the same order, so a group can be admitted. */
  remainingOnOrder?: number;
  previousCheckInAt?: IsoDateTime;
  message: string;
}

// ---------------------------------------------------------------------------
// Media and social
// ---------------------------------------------------------------------------

export type MediaRole = 'poster' | 'hero' | 'gallery' | 'artist' | 'venue' | 'og';

export interface MediaAsset {
  id: Uuid;
  /** R2 object key once AMPED-05A lands; a /media/... path during AMPED-01. */
  storageKey: string;
  url: string;
  role: MediaRole;
  /** Required, not optional. An image without alt text should not be publishable. */
  alt: string;
  width?: number;
  height?: number;
  mimeType: string;
  byteSize?: number;
  credit?: string;
  eventId?: Uuid;
  artistId?: Uuid;
  uploadedAt: IsoDateTime;
}

export interface SocialPost {
  id: Uuid;
  eventId?: Uuid;
  network: SocialNetwork;
  url: string;
  caption?: string;
  thumbnailAssetId?: Uuid;
  postedAt?: IsoDateTime;
  /** The operator chooses what reaches the homepage. No crawler in V1. */
  featured: boolean;
}

// ---------------------------------------------------------------------------
// Enquiries and mailing list
// ---------------------------------------------------------------------------

export type EnquiryKind = 'artist' | 'venue' | 'promoter' | 'general' | 'press';
export type EnquiryStatus = 'new' | 'read' | 'replied' | 'archived' | 'spam';

export interface Enquiry {
  id: Uuid;
  kind: EnquiryKind;
  name: string;
  email: string;
  phone?: string;
  /** Band name, venue name, whatever the form asked for. */
  subject?: string;
  message: string;
  links?: string;
  status: EnquiryStatus;
  /** Evidence the Turnstile token was verified server-side (AMPED-10A). */
  botCheckPassed: boolean;
  receivedAt: IsoDateTime;
}

export type SubscriberStatus = 'subscribed' | 'unsubscribed' | 'bounced' | 'pending';

export interface MailingListSubscriber {
  id: Uuid;
  email: string;
  name?: string;
  status: SubscriberStatus;
  /** Where consent was given, e.g. "homepage-footer" or "checkout". */
  consentSource: string;
  consentAt: IsoDateTime;
  unsubscribedAt?: IsoDateTime;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface AuditLogEntry {
  id: Uuid;
  /** Cloudflare Access identity. Never a shared login. */
  actorEmail: string;
  action: string;
  entityType: string;
  entityId: Uuid;
  summary: string;
  occurredAt: IsoDateTime;
}
