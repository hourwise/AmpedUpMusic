/**
 * View models - the joined, presentation-ready shapes that pages and
 * components actually consume.
 *
 * Why these exist: components must never reach into a data source themselves.
 * A page asks a service for an `EventView` and passes it down. When AMPED-03A
 * replaces the fixture services with D1-backed repositories, every component
 * in src/components keeps working unchanged because it only ever saw these
 * types.
 *
 * Rule for later slices: if a component needs another field, add it here and
 * populate it in the service. Do not pass raw rows into components.
 */

import type {
  AgeRestriction,
  Artist,
  AvailabilityState,
  Enquiry,
  Event,
  EventStatus,
  IsoDateTime,
  MailingListSubscriber,
  MediaAsset,
  Order,
  Pence,
  PhotographyCredit,
  SocialLinks,
  SocialPost,
  Ticket,
  TicketInventory,
  TicketType,
  Uuid,
  Venue,
} from './domain.ts';

/** A ticket type joined with its live inventory and the state we show a customer. */
export interface TicketTypeView {
  id: Uuid;
  name: string;
  description?: string;
  priceInPence: Pence;
  /** Pre-formatted, e.g. "GBP 10.00" rendered as "£10.00". */
  priceLabel: string;
  maxPerOrder: number;
  salesOpenAt?: IsoDateTime;
  salesCloseAt?: IsoDateTime;
  inventory: TicketInventory;
  availability: AvailabilityState;
  /** True when this type can be added to a basket right now. */
  purchasable: boolean;
}

/** One act on the bill, joined to the artist record. */
export interface LineupEntryView {
  artist: Artist;
  position: number;
  billingNote?: string;
  setTime?: IsoDateTime;
  /** Derived from position: headline / support / opener. */
  billing: 'headline' | 'support' | 'opener';
  imageUrl?: string;
}

/**
 * The single object the event page, event cards and admin gig rows are built
 * from. Everything about one night lives here.
 */
export interface EventView {
  id: Uuid;
  title: string;
  slug: string;
  status: EventStatus;
  strapline?: string;
  description: string;
  doorsAt: IsoDateTime;
  startsAt: IsoDateTime;
  endsAt?: IsoDateTime;
  ageRestriction: AgeRestriction;
  ageRestrictionLabel: string;
  accessibilityNotes?: string;
  statusMessage?: string;
  /** Admin-only. Never rendered on a public page. */
  internalNotes?: string;
  links: SocialLinks;
  photography?: PhotographyCredit;

  venue: Venue;
  lineup: LineupEntryView[];
  ticketTypes: TicketTypeView[];

  posterUrl?: string;
  posterAlt?: string;
  heroUrl?: string;
  heroAlt?: string;
  gallery: MediaAsset[];

  /** Overall availability across every public ticket type. */
  availability: AvailabilityState;
  /** Cheapest purchasable ticket, for "from £8" style copy. */
  priceFromInPence?: Pence;
  priceFromLabel?: string;

  /** Derived from startsAt/endsAt against the current time. */
  isPast: boolean;
  /** True when a customer could complete a purchase right now. */
  onSale: boolean;

  /** Canonical path, e.g. /gigs/the-glass-hearts-lomax or /past-gigs/... */
  href: string;

  /** Pre-formatted for display. See src/lib/dates.ts. */
  dateLabel: string;
  shortDateLabel: string;
  dayLabel: string;
  doorsLabel: string;
  startsLabel: string;
}

/** Aggregate sales figures for the admin dashboard and gig list. */
export interface EventSalesSummary {
  eventId: Uuid;
  capacity: number;
  sold: number;
  reserved: number;
  available: number;
  /** Guest list tickets, counted separately from paid admissions. */
  guestList: number;
  grossInPence: Pence;
  grossLabel: string;
  /** 0-100, rounded. */
  percentSold: number;
  checkedIn: number;
}

/** An order as the admin orders table and door lookup show it. */
export interface OrderView {
  order: Order;
  eventTitle: string;
  eventSlug: string;
  totalLabel: string;
  ticketCount: number;
  checkedInCount: number;
  statusLabel: string;
  placedLabel: string;
  tickets: Ticket[];
}

/** A social post joined to its thumbnail, ready for the homepage strip. */
export interface SocialPostView {
  post: SocialPost;
  thumbnailUrl?: string;
  thumbnailAlt?: string;
  eventTitle?: string;
  networkLabel: string;
}

/** An enquiry row for the admin inbox. */
export interface EnquiryView {
  enquiry: Enquiry;
  kindLabel: string;
  receivedLabel: string;
}

/** A mailing list row for the admin list. */
export interface SubscriberView {
  subscriber: MailingListSubscriber;
  joinedLabel: string;
}

/** Re-exported so pages can import both model families from one place. */
export type { Event, Artist, Venue, TicketType, MediaAsset };
