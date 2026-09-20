/**
 * D1-backed AdminEventService (AMPED-03A) - READS ONLY.
 *
 * This is the admin half of the event reads: everything including drafts and
 * archives, a single gig by id, the dashboard's "next gig", and the sales
 * summary. It reuses the exact AMPED-02C projection (`projectEventRows`), so a
 * draft renders through the same view model as a published event - including
 * its internal notes - with no second projection to drift.
 *
 * The sales arithmetic comes from the single authoritative AMPED-02D inventory
 * read (`TicketInventoryService.eventSummary`); gross and checked-in totals are
 * the only figures it adds. No writes, and no authentication: Cloudflare
 * Access is AMPED-04A, and this branch must not be deployed before it lands.
 */

import { formatPence } from '@/lib/money.ts';
import type { EventSalesSummary, EventView } from '@/types/view.ts';

import type { AdminEventService } from '../contracts.ts';
import {
  loadAllEvents,
  loadEventById,
  projectEventRows,
} from './events.ts';
import { createD1TicketInventoryService } from './tickets.ts';

const CHECKED_IN_SQL =
  "select count(*) as n from tickets where event_id = ?1 and status = 'checked_in'";

const bySoonest = (a: EventView, b: EventView): number =>
  Date.parse(a.startsAt) - Date.parse(b.startsAt);

class D1AdminEventService implements AdminEventService {
  constructor(
    private readonly db: D1Database,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async listAll(): Promise<EventView[]> {
    const rows = await loadAllEvents(this.db);
    const views = await this.project(rows);
    return views.sort(bySoonest);
  }

  async getById(id: string): Promise<EventView | null> {
    const row = await loadEventById(this.db, id);
    if (!row) return null;
    const [view] = await this.project([row]);
    return view ?? null;
  }

  async nextEvent(): Promise<EventView | null> {
    const rows = await loadAllEvents(this.db);
    const views = await this.project(rows);
    const upcoming = views
      .filter((event) => !event.isPast && event.status !== 'draft' && event.status !== 'archived')
      .sort(bySoonest);
    return upcoming[0] ?? null;
  }

  async salesSummary(eventId: string): Promise<EventSalesSummary> {
    const tickets = createD1TicketInventoryService(this.db, this.clock);
    const summary = await tickets.eventSummary(eventId);
    const checkedInRow = await this.db
      .prepare(CHECKED_IN_SQL)
      .bind(eventId)
      .first<{ n: number }>();
    const checkedIn = checkedInRow?.n ?? 0;

    if (!summary) {
      // An event with no ticket types yet: all zeros, not an error.
      return {
        eventId,
        capacity: 0,
        sold: 0,
        reserved: 0,
        available: 0,
        guestList: 0,
        grossInPence: 0,
        grossLabel: formatPence(0),
        percentSold: 0,
        checkedIn,
      };
    }

    const grossInPence = summary.publicTypes.reduce(
      (sum, entry) => sum + entry.sold * entry.ticketType.price_in_pence,
      0,
    );
    const capacity = summary.publicCapacity;
    const sold = summary.sold;
    const reserved = summary.reserved;

    return {
      eventId,
      capacity,
      sold,
      reserved,
      available: Math.max(0, capacity - sold - reserved),
      guestList: summary.guestList,
      grossInPence,
      grossLabel: formatPence(grossInPence),
      percentSold: capacity === 0 ? 0 : Math.round((sold / capacity) * 100),
      checkedIn,
    };
  }

  private project(rows: Parameters<typeof projectEventRows>[2]): Promise<EventView[]> {
    const tickets = createD1TicketInventoryService(this.db, this.clock);
    return projectEventRows(this.db, tickets, rows, this.clock());
  }
}

/** Build the D1 admin event service against a resolved binding. */
export function createD1AdminEventService(
  db: D1Database,
  clock?: () => Date,
): AdminEventService {
  return new D1AdminEventService(db, clock);
}
