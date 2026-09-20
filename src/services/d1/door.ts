/**
 * D1-backed DoorService (AMPED-03A) - READS ONLY.
 *
 * Door Mode in the scaffold is a presentation driver: it lists tonight's gigs,
 * counts admissions, shows the guest list, and renders the three demonstration
 * result cards from real tickets. Those reads come from D1 here.
 *
 * `checkIn` and `undoCheckIn` are NOT implemented. The scaffold's versions
 * mutated an in-memory Set and were explicitly non-atomic; the real admission
 * transition - a single conditional UPDATE that makes two simultaneous scans
 * produce exactly one `valid` - belongs to AMPED-09B, together with the QR
 * decode in AMPED-09A. Until then they throw rather than pretend to admit
 * somebody, so no caller can mistake a successful-looking result for a real
 * check-in. No page calls them.
 */

import type { TicketRow } from '@/db/schema.ts';
import type { ScanResult, Ticket } from '@/types/domain.ts';
import type { EventView } from '@/types/view.ts';

import type { DoorService } from '../contracts.ts';
import { loadAllEvents, projectEventRows } from './events.ts';
import { toTicket } from './orders.ts';
import { createD1TicketInventoryService } from './tickets.ts';

const TICKET_COLUMNS = [
  'id',
  'order_id',
  'event_id',
  'ticket_type_id',
  'reference',
  'status',
  'attendee_name',
  'is_guest_list',
  'issued_at',
  'checked_in_at',
].join(', ');

const SELECT_TICKET_SQL =
  `select ${TICKET_COLUMNS} from tickets ` +
  'where lower(reference) = lower(?1) or id = ?2 limit 1';
const SELECT_GUEST_LIST_SQL =
  `select ${TICKET_COLUMNS} from tickets ` +
  'where event_id = ?1 and is_guest_list = 1 order by reference asc';

const SELECT_ORDER_SQL =
  'select reference, customer_name from orders where id = ?1 limit 1';
const SELECT_TYPE_NAME_SQL = 'select name from ticket_types where id = ?1 limit 1';
const SELECT_REMAINING_SQL =
  "select count(*) as n from tickets where order_id = ?1 and status <> 'checked_in'";

const COUNTS_SQL = `
  select
    (select count(*) from tickets where event_id = ?1) as expected,
    (select count(*) from tickets where event_id = ?1 and status = 'checked_in') as admitted,
    (select count(*) from tickets where event_id = ?1 and is_guest_list = 1) as guestList
`;

const NOT_IMPLEMENTED =
  'Door check-in is implemented in AMPED-09B, where the issued -> checked_in ' +
  'transition is atomic. AMPED-03A only reads door data.';

const MESSAGES: Record<ScanResult['outcome'], string> = {
  valid: 'Admit.',
  'already-used': 'This ticket has already been scanned.',
  invalid: 'This code is not an Amped Up ticket.',
  'wrong-event': 'This ticket is for a different Amped Up show.',
  void: 'This ticket has been refunded or cancelled.',
};

class D1DoorService implements DoorService {
  constructor(
    private readonly db: D1Database,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async listDoorEvents(): Promise<EventView[]> {
    const tickets = createD1TicketInventoryService(this.db, this.clock);
    const now = this.clock();
    const rows = (await loadAllEvents(this.db)).filter(
      (row) => row.status === 'published' || row.status === 'completed',
    );
    const views = await projectEventRows(this.db, tickets, rows, now);
    return views
      .sort(
        (a, b) =>
          Math.abs(Date.parse(a.startsAt) - now.getTime()) -
          Math.abs(Date.parse(b.startsAt) - now.getTime()),
      )
      .slice(0, 6);
  }

  async inspect(token: string, eventId: string): Promise<ScanResult> {
    const row = await this.db
      .prepare(SELECT_TICKET_SQL)
      .bind(token, token)
      .first<TicketRow>();
    if (!row) return { outcome: 'invalid', message: MESSAGES.invalid };

    const ticket = toTicket(row);
    const outcome: ScanResult['outcome'] =
      row.event_id !== eventId
        ? 'wrong-event'
        : row.status === 'void' || row.status === 'refunded'
          ? 'void'
          : row.status === 'checked_in'
            ? 'already-used'
            : 'valid';
    return this.describe(ticket, outcome);
  }

  async checkIn(_token: string, _eventId: string, _operatorEmail: string): Promise<ScanResult> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async undoCheckIn(_ticketId: string, _operatorEmail: string): Promise<ScanResult> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async listGuestList(eventId: string): Promise<Ticket[]> {
    const { results } = await this.db
      .prepare(SELECT_GUEST_LIST_SQL)
      .bind(eventId)
      .all<TicketRow>();
    return results.map(toTicket);
  }

  async admissionCounts(
    eventId: string,
  ): Promise<{ admitted: number; expected: number; guestList: number }> {
    const row = await this.db
      .prepare(COUNTS_SQL)
      .bind(eventId)
      .first<{ admitted: number; expected: number; guestList: number }>();
    return row ?? { admitted: 0, expected: 0, guestList: 0 };
  }

  /** Look up the surrounding order and type without admitting anybody. */
  private async describe(ticket: Ticket, outcome: ScanResult['outcome']): Promise<ScanResult> {
    const order = await this.db
      .prepare(SELECT_ORDER_SQL)
      .bind(ticket.orderId)
      .first<{ reference: string; customer_name: string }>();
    const type = await this.db
      .prepare(SELECT_TYPE_NAME_SQL)
      .bind(ticket.ticketTypeId)
      .first<{ name: string }>();
    const remaining = await this.db
      .prepare(SELECT_REMAINING_SQL)
      .bind(ticket.orderId)
      .first<{ n: number }>();

    return {
      outcome,
      ticket,
      order: order
        ? { reference: order.reference, customerName: order.customer_name }
        : undefined,
      ticketTypeName: type?.name,
      remainingOnOrder: remaining?.n ?? 0,
      previousCheckInAt: ticket.checkedInAt,
      message: MESSAGES[outcome],
    };
  }
}

/** Build the D1 door service against a resolved binding. */
export function createD1DoorService(db: D1Database, clock?: () => Date): DoorService {
  return new D1DoorService(db, clock);
}
