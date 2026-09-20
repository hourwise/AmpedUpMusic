/**
 * Fixture-backed implementations of every service contract.
 *
 * AMPED-01 ONLY. Each class here is replaced by a D1-backed repository in a
 * later slice; the slice that replaces one is named in its doc comment. The
 * async signatures are honoured even though nothing here actually awaits, so
 * the swap is a change of implementation and not a change of call site.
 *
 * Nothing in this file may be imported by a component. Pages call
 * `getServices()` from src/services/index.ts and pass view models down.
 */

import { formatPence } from '@/lib/money.ts';
import { formatDateTime, formatShortDate } from '@/lib/dates.ts';
import { ENQUIRY_KIND_LABEL, ORDER_STATUS_LABEL, SOCIAL_LABEL } from '@/lib/text.ts';
import type {
  AdminEventService,
  ArtistService,
  AuditService,
  DoorService,
  EnquiryService,
  MailingListService,
  MediaService,
  OrderService,
  PublicEventService,
  Services,
  SocialService,
  VenueService,
} from '../contracts.ts';
import type {
  Artist,
  AuditLogEntry,
  Enquiry,
  MediaAsset,
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

import { ARTISTS, ARTISTS_BY_ID } from '@/data/fixtures/artists.ts';
import { ENQUIRIES, SOCIAL_POSTS, SUBSCRIBERS, SUBSCRIBER_GROWTH } from '@/data/fixtures/community.ts';
import { EVENTS, EVENTS_BY_ID, SALES, TICKET_TYPES, TICKET_TYPES_BY_ID } from '@/data/fixtures/events.ts';
import { MEDIA, MEDIA_BY_ID } from '@/data/fixtures/media.ts';
import { ORDERS, TICKETS, TICKETS_BY_ORDER } from '@/data/fixtures/orders.ts';
import { VENUES } from '@/data/fixtures/venues.ts';
import { projectEvent } from './project.ts';

/** Statuses the public may see at all. Drafts and archives never leak. */
const PUBLIC_STATUSES = new Set(['published', 'postponed', 'cancelled', 'completed']);

function allViews(now = new Date()): EventView[] {
  return EVENTS.map((e) => projectEvent(e, now));
}

function publicViews(now = new Date()): EventView[] {
  return EVENTS.filter((e) => PUBLIC_STATUSES.has(e.status)).map((e) => projectEvent(e, now));
}

const bySoonest = (a: EventView, b: EventView) => Date.parse(a.startsAt) - Date.parse(b.startsAt);
const byMostRecent = (a: EventView, b: EventView) => Date.parse(b.startsAt) - Date.parse(a.startsAt);

// ---------------------------------------------------------------------------

/** Replaced by a D1 repository in AMPED-03A. */
class MockPublicEventService implements PublicEventService {
  async listUpcoming(limit?: number): Promise<EventView[]> {
    const list = publicViews().filter((e) => !e.isPast).sort(bySoonest);
    return limit === undefined ? list : list.slice(0, limit);
  }

  async nextEvent(): Promise<EventView | null> {
    // A cancelled show is still the next thing in the diary and customers who
    // have tickets need to see the notice, so it is not filtered out here.
    const [next] = await this.listUpcoming(1);
    return next ?? null;
  }

  async listPast(limit?: number): Promise<EventView[]> {
    const list = publicViews()
      .filter((e) => e.isPast && e.status !== 'archived')
      .sort(byMostRecent);
    return limit === undefined ? list : list.slice(0, limit);
  }

  async getBySlug(slug: string): Promise<EventView | null> {
    return publicViews().find((e) => e.slug === slug) ?? null;
  }

  async listPublicSlugs(): Promise<Array<{ slug: string; isPast: boolean }>> {
    return publicViews().map((e) => ({ slug: e.slug, isPast: e.isPast }));
  }

  async listOnSale(): Promise<EventView[]> {
    return publicViews()
      .filter((e) => !e.isPast && e.ticketTypes.length > 0)
      .sort(bySoonest);
  }
}

/** Replaced in AMPED-02B / AMPED-04C. */
class MockArtistService implements ArtistService {
  async list(): Promise<Artist[]> {
    return ARTISTS.slice().sort((a, b) => a.name.localeCompare(b.name, 'en-GB'));
  }

  async getBySlug(slug: string): Promise<Artist | null> {
    return ARTISTS.find((a) => a.slug === slug) ?? null;
  }

  async eventsFor(artistId: string): Promise<EventView[]> {
    return publicViews()
      .filter((e) => e.lineup.some((entry) => entry.artist.id === artistId))
      .sort(byMostRecent);
  }
}

/** Replaced in AMPED-02B / AMPED-04C. */
class MockVenueService implements VenueService {
  async list(): Promise<Venue[]> {
    return VENUES.slice().sort((a, b) => a.name.localeCompare(b.name, 'en-GB'));
  }

  async getBySlug(slug: string): Promise<Venue | null> {
    return VENUES.find((v) => v.slug === slug) ?? null;
  }
}

/** Replaced by R2-backed storage in AMPED-05A/05B. */
class MockMediaService implements MediaService {
  async listGallery(limit?: number): Promise<MediaAsset[]> {
    // Ordered by the event they belong to, most recent event first, so the
    // gallery page reads as a reverse-chronological archive rather than a pile.
    const eventOrder = new Map(
      allViews()
        .sort(byMostRecent)
        .map((e, index) => [e.id, index] as const),
    );
    const list = MEDIA.filter((m) => m.role === 'gallery' && m.eventId).sort(
      (a, b) => (eventOrder.get(a.eventId!) ?? 99) - (eventOrder.get(b.eventId!) ?? 99),
    );
    return limit === undefined ? list : list.slice(0, limit);
  }

  async listForEvent(eventId: string): Promise<MediaAsset[]> {
    return MEDIA.filter((m) => m.eventId === eventId);
  }

  async get(id: string): Promise<MediaAsset | null> {
    return MEDIA_BY_ID.get(id) ?? null;
  }
}

/** Replaced in AMPED-05C. Manual curation by design - no crawler in V1. */
class MockSocialService implements SocialService {
  private toView(postId: string): SocialPostView | null {
    const post = SOCIAL_POSTS.find((p) => p.id === postId);
    if (!post) return null;
    const thumbnail = post.thumbnailAssetId ? MEDIA_BY_ID.get(post.thumbnailAssetId) : undefined;
    const event = post.eventId ? EVENTS_BY_ID.get(post.eventId) : undefined;
    return {
      post,
      thumbnailUrl: thumbnail?.url,
      thumbnailAlt: thumbnail?.alt,
      eventTitle: event?.title,
      networkLabel: SOCIAL_LABEL[post.network],
    };
  }

  async listFeatured(limit = 4): Promise<SocialPostView[]> {
    return SOCIAL_POSTS.filter((p) => p.featured)
      .slice(0, limit)
      .flatMap((p) => {
        const view = this.toView(p.id);
        return view ? [view] : [];
      });
  }

  async listForEvent(eventId: string): Promise<SocialPostView[]> {
    return SOCIAL_POSTS.filter((p) => p.eventId === eventId).flatMap((p) => {
      const view = this.toView(p.id);
      return view ? [view] : [];
    });
  }
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

function salesSummaryFor(eventId: string): EventSalesSummary {
  const types = TICKET_TYPES.filter((t) => t.eventId === eventId);
  let capacity = 0;
  let sold = 0;
  let reserved = 0;
  let guestList = 0;
  let grossInPence = 0;

  for (const type of types) {
    const counters = SALES[type.id] ?? { sold: 0, reserved: 0 };
    if (type.visibility === 'public') {
      capacity += type.capacity;
      sold += counters.sold;
      reserved += counters.reserved;
      grossInPence += counters.sold * type.priceInPence;
    } else {
      guestList += counters.sold;
    }
  }

  const checkedIn = TICKETS.filter((t) => t.eventId === eventId && t.status === 'checked_in').length;

  return {
    eventId,
    capacity,
    sold,
    reserved,
    available: Math.max(0, capacity - sold - reserved),
    guestList,
    grossInPence,
    grossLabel: formatPence(grossInPence),
    percentSold: capacity === 0 ? 0 : Math.round((sold / capacity) * 100),
    checkedIn,
  };
}

/** Replaced in AMPED-04B. Must sit behind Cloudflare Access (AMPED-04A). */
class MockAdminEventService implements AdminEventService {
  async listAll(): Promise<EventView[]> {
    return allViews().sort(bySoonest);
  }

  async getById(id: string): Promise<EventView | null> {
    const event = EVENTS_BY_ID.get(id);
    return event ? projectEvent(event) : null;
  }

  async salesSummary(eventId: string): Promise<EventSalesSummary> {
    return salesSummaryFor(eventId);
  }

  async nextEvent(): Promise<EventView | null> {
    const upcoming = allViews()
      .filter((e) => !e.isPast && e.status !== 'draft' && e.status !== 'archived')
      .sort(bySoonest);
    return upcoming[0] ?? null;
  }
}

function orderView(orderId: string): OrderView | null {
  const order = ORDERS.find((o) => o.id === orderId);
  if (!order) return null;
  const event = EVENTS_BY_ID.get(order.eventId);
  const tickets = TICKETS_BY_ORDER.get(order.id) ?? [];
  return {
    order,
    eventTitle: event?.title ?? 'Unknown event',
    eventSlug: event?.slug ?? '',
    totalLabel: formatPence(order.totalInPence),
    ticketCount: tickets.length,
    checkedInCount: tickets.filter((t) => t.status === 'checked_in').length,
    statusLabel: ORDER_STATUS_LABEL[order.status],
    placedLabel: formatDateTime(order.createdAt),
    tickets,
  };
}

/** Replaced in AMPED-06A. */
class MockOrderService implements OrderService {
  async listForEvent(eventId: string): Promise<OrderView[]> {
    return ORDERS.filter((o) => o.eventId === eventId).flatMap((o) => {
      const view = orderView(o.id);
      return view ? [view] : [];
    });
  }

  async listRecent(limit = 12): Promise<OrderView[]> {
    return ORDERS.slice(0, limit).flatMap((o) => {
      const view = orderView(o.id);
      return view ? [view] : [];
    });
  }

  async getByReference(reference: string): Promise<OrderView | null> {
    const order = ORDERS.find((o) => o.reference.toLowerCase() === reference.toLowerCase());
    return order ? orderView(order.id) : null;
  }

  async search(query: string, eventId?: string): Promise<OrderView[]> {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];

    const matchedByTicket = new Set(
      TICKETS.filter((t) => t.reference.toLowerCase().includes(q)).map((t) => t.orderId),
    );

    return ORDERS.filter((o) => {
      if (eventId && o.eventId !== eventId) return false;
      return (
        o.customerName.toLowerCase().includes(q) ||
        o.customerEmail.toLowerCase().includes(q) ||
        o.reference.toLowerCase().includes(q) ||
        matchedByTicket.has(o.id)
      );
    })
      .slice(0, 25)
      .flatMap((o) => {
        const view = orderView(o.id);
        return view ? [view] : [];
      });
  }
}

/**
 * Replaced in AMPED-09B.
 *
 * NOT ATOMIC and not persistent: check-ins are held in a module-level Set that
 * disappears on the next isolate. This is a UX driver for AMPED-01 only. The
 * real implementation must make the issued -> checked_in transition a single
 * conditional UPDATE so that two phones scanning the same ticket at the same
 * moment produce exactly one `valid`.
 */
class MockDoorService implements DoorService {
  private readonly scanned = new Set<string>();

  async listDoorEvents(): Promise<EventView[]> {
    return allViews()
      .filter((e) => e.status === 'published' || e.status === 'completed')
      .sort((a, b) => Math.abs(Date.parse(a.startsAt) - Date.now()) - Math.abs(Date.parse(b.startsAt) - Date.now()))
      .slice(0, 6);
  }

  private resolve(token: string, eventId: string): { ticket?: Ticket; outcome: ScanResult['outcome'] } {
    const ticket =
      TICKETS.find((t) => t.reference.toLowerCase() === token.toLowerCase()) ??
      TICKETS.find((t) => t.id === token);
    if (!ticket) return { outcome: 'invalid' };
    if (ticket.eventId !== eventId) return { ticket, outcome: 'wrong-event' };
    if (ticket.status === 'void' || ticket.status === 'refunded') return { ticket, outcome: 'void' };
    if (ticket.status === 'checked_in' || this.scanned.has(ticket.id)) {
      return { ticket, outcome: 'already-used' };
    }
    return { ticket, outcome: 'valid' };
  }

  private describe(ticket: Ticket | undefined, outcome: ScanResult['outcome']): ScanResult {
    if (!ticket) {
      return { outcome: 'invalid', message: 'This code is not an Amped Up ticket.' };
    }
    const order = ORDERS.find((o) => o.id === ticket.orderId);
    const ticketType = TICKET_TYPES_BY_ID.get(ticket.ticketTypeId);
    const siblings = TICKETS_BY_ORDER.get(ticket.orderId) ?? [];
    const remainingOnOrder = siblings.filter(
      (t) => t.status !== 'checked_in' && !this.scanned.has(t.id),
    ).length;

    const messages: Record<ScanResult['outcome'], string> = {
      valid: 'Admit.',
      'already-used': 'This ticket has already been scanned.',
      invalid: 'This code is not an Amped Up ticket.',
      'wrong-event': 'This ticket is for a different Amped Up show.',
      void: 'This ticket has been refunded or cancelled.',
    };

    return {
      outcome,
      ticket,
      order: order ? { reference: order.reference, customerName: order.customerName } : undefined,
      ticketTypeName: ticketType?.name,
      remainingOnOrder,
      previousCheckInAt: ticket.checkedInAt,
      message: messages[outcome],
    };
  }

  async inspect(token: string, eventId: string): Promise<ScanResult> {
    const { ticket, outcome } = this.resolve(token, eventId);
    return this.describe(ticket, outcome);
  }

  async checkIn(token: string, eventId: string, _operatorEmail: string): Promise<ScanResult> {
    const { ticket, outcome } = this.resolve(token, eventId);
    if (ticket && outcome === 'valid') this.scanned.add(ticket.id);
    return this.describe(ticket, outcome);
  }

  async undoCheckIn(ticketId: string, _operatorEmail: string): Promise<ScanResult> {
    this.scanned.delete(ticketId);
    const ticket = TICKETS.find((t) => t.id === ticketId);
    return this.describe(ticket, ticket ? 'valid' : 'invalid');
  }

  async listGuestList(eventId: string): Promise<Ticket[]> {
    return TICKETS.filter((t) => t.eventId === eventId && t.isGuestList);
  }

  async admissionCounts(eventId: string): Promise<{ admitted: number; expected: number; guestList: number }> {
    const forEvent = TICKETS.filter((t) => t.eventId === eventId);
    return {
      admitted: forEvent.filter((t) => t.status === 'checked_in' || this.scanned.has(t.id)).length,
      expected: forEvent.length,
      guestList: forEvent.filter((t) => t.isGuestList).length,
    };
  }
}

/** Replaced in AMPED-10A. */
class MockEnquiryService implements EnquiryService {
  async list(status?: Enquiry['status']): Promise<EnquiryView[]> {
    return ENQUIRIES.filter((e) => (status ? e.status === status : true))
      .slice()
      .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))
      .map((enquiry) => ({
        enquiry,
        kindLabel: ENQUIRY_KIND_LABEL[enquiry.kind],
        receivedLabel: formatDateTime(enquiry.receivedAt),
      }));
  }

  async countNew(): Promise<number> {
    return ENQUIRIES.filter((e) => e.status === 'new').length;
  }
}

/** Replaced in AMPED-10B. */
class MockMailingListService implements MailingListService {
  async list(): Promise<SubscriberView[]> {
    return SUBSCRIBERS.slice()
      .sort((a, b) => Date.parse(b.consentAt) - Date.parse(a.consentAt))
      .map((subscriber) => ({ subscriber, joinedLabel: formatShortDate(subscriber.consentAt) }));
  }

  async counts(): Promise<{ subscribed: number; unsubscribed: number; bounced: number }> {
    return {
      subscribed: SUBSCRIBERS.filter((s) => s.status === 'subscribed').length,
      unsubscribed: SUBSCRIBERS.filter((s) => s.status === 'unsubscribed').length,
      bounced: SUBSCRIBERS.filter((s) => s.status === 'bounced').length,
    };
  }

  async growth(): Promise<ReadonlyArray<{ label: string; count: number }>> {
    return SUBSCRIBER_GROWTH;
  }
}

/** Replaced in AMPED-04B, where real admin writes start being recorded. */
class MockAuditService implements AuditService {
  async listRecent(limit = 8): Promise<AuditLogEntry[]> {
    const now = Date.now();
    const entries: Array<Omit<AuditLogEntry, 'id' | 'occurredAt'> & { agoMinutes: number }> = [
      { actorEmail: 'anya@ampedupmusic.co.uk', action: 'event.published', entityType: 'event', entityId: 'evt_velvet_antler_dec', summary: 'Published Velvet Antler at The Lomax Rooms', agoMinutes: 95 },
      { actorEmail: 'anya@ampedupmusic.co.uk', action: 'media.uploaded', entityType: 'media', entityId: 'med_gal_03', summary: 'Added 3 photographs to Hollow Coast', agoMinutes: 260 },
      { actorEmail: 'jay@ampedupmusic.co.uk', action: 'event.postponed', entityType: 'event', entityId: 'evt_saltwater_nov', summary: 'Marked Saltwater Parade as postponed and notified 169 ticket holders', agoMinutes: 1_450 },
      { actorEmail: 'anya@ampedupmusic.co.uk', action: 'ticket_type.created', entityType: 'ticket_type', entityId: 'tt_wa_early', summary: 'Added Early Bird to Winter All-Dayer', agoMinutes: 2_880 },
      { actorEmail: 'jay@ampedupmusic.co.uk', action: 'event.duplicated', entityType: 'event', entityId: 'evt_brass_tacks_nye', summary: 'Duplicated Brass Tacks Soul Revue as a new draft', agoMinutes: 4_320 },
      { actorEmail: 'anya@ampedupmusic.co.uk', action: 'artist.created', entityType: 'artist', entityId: 'art_mara_veil', summary: 'Added Mara Veil to the artist directory', agoMinutes: 7_200 },
    ];

    return entries.slice(0, limit).map((entry, index) => ({
      id: `aud_${index.toString().padStart(3, '0')}`,
      actorEmail: entry.actorEmail,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      summary: entry.summary,
      occurredAt: new Date(now - entry.agoMinutes * 60_000).toISOString(),
    }));
  }
}

// ---------------------------------------------------------------------------

export function createMockServices(): Services {
  return {
    events: new MockPublicEventService(),
    artists: new MockArtistService(),
    venues: new MockVenueService(),
    media: new MockMediaService(),
    social: new MockSocialService(),
    admin: new MockAdminEventService(),
    orders: new MockOrderService(),
    door: new MockDoorService(),
    enquiries: new MockEnquiryService(),
    mailingList: new MockMailingListService(),
    audit: new MockAuditService(),
  };
}

/** Exported for tests and for the admin artist/venue pages. */
export { ARTISTS_BY_ID, salesSummaryFor };
