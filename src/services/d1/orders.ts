/**
 * D1-backed OrderService (AMPED-03A) - READS ONLY.
 *
 * Every method here answers a question the scaffold already asks: list this
 * gig's orders, show the most recent, look one up by reference, or run the
 * door's single search box. Nothing writes. The AMPED-06A order state machine,
 * reservation, payment and ticket issuance are deliberately not present.
 *
 * Assembly is batched: one query for the orders, then one each for their
 * items, their tickets and the events they belong to - four statements for a
 * batch of any size, never four per order.
 */

import type { OrderItemRow, OrderRow, TicketRow } from '@/db/schema.ts';
import { formatDateTime } from '@/lib/dates.ts';
import { formatPence } from '@/lib/money.ts';
import { ORDER_STATUS_LABEL } from '@/lib/text.ts';
import type { Order, OrderItem, Ticket } from '@/types/domain.ts';
import type { OrderView } from '@/types/view.ts';

import type { OrderService } from '../contracts.ts';

const ORDER_COLUMNS = [
  'id',
  'reference',
  'event_id',
  'customer_name',
  'customer_email',
  'customer_phone',
  'status',
  'total_in_pence',
  'fee_in_pence',
  'payment_reference',
  'payment_provider',
  'paid_at',
  'reservation_expires_at',
  'marketing_opt_in',
  'created_at',
  'updated_at',
].join(', ');

const ORDER_ITEM_COLUMNS = [
  'id',
  'order_id',
  'ticket_type_id',
  'quantity',
  'unit_price_in_pence',
  'ticket_type_name',
].join(', ');

const TICKET_COLUMNS = [
  'id',
  'order_id',
  'event_id',
  'ticket_type_id',
  'reference',
  'token_hash',
  'status',
  'attendee_name',
  'is_guest_list',
  'issued_at',
  'checked_in_at',
].join(', ');

const SELECT_FOR_EVENT_SQL =
  `select ${ORDER_COLUMNS} from orders where event_id = ?1 order by created_at desc, id asc`;
const SELECT_RECENT_SQL =
  `select ${ORDER_COLUMNS} from orders order by created_at desc, id asc limit ?1`;
const SELECT_BY_REFERENCE_SQL =
  `select ${ORDER_COLUMNS} from orders where lower(reference) = lower(?1) limit 1`;

/**
 * The door's one search box. Matches name, email, order reference or any
 * ticket reference on the order, optionally scoped to one gig, and caps the
 * result the way the fixture service did.
 */
const SELECT_SEARCH_SQL =
  `select ${ORDER_COLUMNS} from orders o ` +
  `where (?2 = '' or o.event_id = ?2) and (` +
  `instr(lower(o.customer_name), ?1) > 0 ` +
  `or instr(lower(o.customer_email), ?1) > 0 ` +
  `or instr(lower(o.reference), ?1) > 0 ` +
  `or exists (select 1 from tickets k where k.order_id = o.id and instr(lower(k.reference), ?1) > 0)` +
  `) order by o.created_at desc, o.id asc limit 25`;

const SELECT_ITEMS_SQL =
  `select ${ORDER_ITEM_COLUMNS} from order_items ` +
  'where order_id in (select value from json_each(?1))';
const SELECT_TICKETS_SQL =
  `select ${TICKET_COLUMNS} from tickets ` +
  'where order_id in (select value from json_each(?1)) order by reference asc';
const SELECT_EVENT_TITLES_SQL =
  'select id, title, slug from events where id in (select value from json_each(?1))';

interface EventTitleRow {
  id: string;
  title: string;
  slug: string;
}

function toOrderItem(row: OrderItemRow): OrderItem {
  return {
    id: row.id,
    orderId: row.order_id,
    ticketTypeId: row.ticket_type_id,
    quantity: row.quantity,
    unitPriceInPence: row.unit_price_in_pence,
    ticketTypeName: row.ticket_type_name,
  };
}

function toOrder(row: OrderRow, items: OrderItem[]): Order {
  return {
    id: row.id,
    reference: row.reference,
    eventId: row.event_id,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    ...(row.customer_phone !== null ? { customerPhone: row.customer_phone } : {}),
    status: row.status,
    totalInPence: row.total_in_pence,
    feeInPence: row.fee_in_pence,
    items,
    ...(row.payment_reference !== null ? { paymentReference: row.payment_reference } : {}),
    ...(row.payment_provider !== null ? { paymentProvider: row.payment_provider } : {}),
    ...(row.paid_at !== null ? { paidAt: row.paid_at } : {}),
    ...(row.reservation_expires_at !== null
      ? { reservationExpiresAt: row.reservation_expires_at }
      : {}),
    marketingOptIn: row.marketing_opt_in === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Ticket row -> domain. Exported so Door Mode maps tickets the same way. */
export function toTicket(row: TicketRow): Ticket {
  return {
    id: row.id,
    orderId: row.order_id,
    eventId: row.event_id,
    ticketTypeId: row.ticket_type_id,
    reference: row.reference,
    ...(row.token_hash !== null ? { tokenHash: row.token_hash } : {}),
    status: row.status,
    ...(row.attendee_name !== null ? { attendeeName: row.attendee_name } : {}),
    isGuestList: row.is_guest_list === 1,
    issuedAt: row.issued_at,
    ...(row.checked_in_at !== null ? { checkedInAt: row.checked_in_at } : {}),
  };
}

class D1OrderService implements OrderService {
  constructor(private readonly db: D1Database) {}

  async listForEvent(eventId: string): Promise<OrderView[]> {
    const { results } = await this.db.prepare(SELECT_FOR_EVENT_SQL).bind(eventId).all<OrderRow>();
    return this.toViews(results);
  }

  async listRecent(limit = 12): Promise<OrderView[]> {
    const { results } = await this.db.prepare(SELECT_RECENT_SQL).bind(limit).all<OrderRow>();
    return this.toViews(results);
  }

  async getByReference(reference: string): Promise<OrderView | null> {
    const row = await this.db
      .prepare(SELECT_BY_REFERENCE_SQL)
      .bind(reference)
      .first<OrderRow>();
    if (!row) return null;
    const [view] = await this.toViews([row]);
    return view ?? null;
  }

  async search(query: string, eventId?: string): Promise<OrderView[]> {
    const normalised = query.trim().toLowerCase();
    if (normalised.length < 2) return [];

    const { results } = await this.db
      .prepare(SELECT_SEARCH_SQL)
      .bind(normalised, eventId ?? '')
      .all<OrderRow>();
    return this.toViews(results);
  }

  /** Four bounded statements for a batch of any size. */
  private async toViews(rows: readonly OrderRow[]): Promise<OrderView[]> {
    if (rows.length === 0) return [];
    const orderIdJson = JSON.stringify(rows.map((row) => row.id));

    const itemsByOrder = new Map<string, OrderItemRow[]>();
    {
      const { results } = await this.db
        .prepare(SELECT_ITEMS_SQL)
        .bind(orderIdJson)
        .all<OrderItemRow>();
      for (const row of results) {
        const list = itemsByOrder.get(row.order_id);
        if (list) list.push(row);
        else itemsByOrder.set(row.order_id, [row]);
      }
    }

    const ticketsByOrder = new Map<string, TicketRow[]>();
    {
      const { results } = await this.db
        .prepare(SELECT_TICKETS_SQL)
        .bind(orderIdJson)
        .all<TicketRow>();
      for (const row of results) {
        const list = ticketsByOrder.get(row.order_id);
        if (list) list.push(row);
        else ticketsByOrder.set(row.order_id, [row]);
      }
    }

    const eventIds = [...new Set(rows.map((row) => row.event_id))];
    const events = new Map<string, EventTitleRow>();
    if (eventIds.length > 0) {
      const { results } = await this.db
        .prepare(SELECT_EVENT_TITLES_SQL)
        .bind(JSON.stringify(eventIds))
        .all<EventTitleRow>();
      for (const row of results) events.set(row.id, row);
    }

    return rows.map((row) => {
      const items = (itemsByOrder.get(row.id) ?? []).map(toOrderItem);
      const tickets = (ticketsByOrder.get(row.id) ?? []).map(toTicket);
      const event = events.get(row.event_id);
      return {
        order: toOrder(row, items),
        eventTitle: event?.title ?? 'Unknown event',
        eventSlug: event?.slug ?? '',
        totalLabel: formatPence(row.total_in_pence),
        ticketCount: tickets.length,
        checkedInCount: tickets.filter((ticket) => ticket.status === 'checked_in').length,
        statusLabel: ORDER_STATUS_LABEL[row.status],
        placedLabel: formatDateTime(row.created_at),
        tickets,
      };
    });
  }
}

/** Build the D1 order service against a resolved binding. */
export function createD1OrderService(db: D1Database): OrderService {
  return new D1OrderService(db);
}
