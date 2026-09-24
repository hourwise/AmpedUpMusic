/**
 * D1 ticket-type and inventory READS (AMPED-02D).
 *
 * This is the single authoritative implementation of the sold / reserved /
 * available arithmetic for this project. `src/services/d1/events.ts` no longer
 * carries its own copy - it calls `publicInventory()` here and hands the rows
 * and counters to the (unchanged) AMPED-02C projector. Reservation CREATION,
 * expiry mutation, checkout, orders and ticket issuance are later phases and
 * are deliberately absent: this module only reads.
 *
 * Definitions, exactly as the slice specifies:
 *
 *   sold      = sum(order_items.quantity) for the type whose order is
 *               'paid' or 'partially_refunded' (AMPED-06B0)
 *   reserved  = sum(order_items.quantity) for the type whose order is
 *               'awaiting_payment' and whose reservation_expires_at is strictly
 *               in the future. An expired reservation never counts (R15).
 *   available = max(0, capacity - sold - reserved)
 *
 * AUTHORITY (AMPED-06B0): order state is the authority for commercial
 * inventory commitment; ticket rows are the authority for fulfilment and
 * admission only. A paid order is sold stock the moment it is paid, even with
 * zero tickets issued, and issuing tickets later must not add a second sale.
 * `refunded` releases the quantity; `partially_refunded` conservatively keeps
 * the whole captured quantity because the schema has no item-level refunded
 * quantity to release part of it safely.
 *
 * Both sold and reserved are derived from order_items - never reconstructed
 * from tickets or checkins.
 *
 * Rules:
 *  - explicit columns everywhere, no `select *`;
 *  - every value is bound; a batch is expressed as a bound JSON array through
 *    `json_each(?1)`, so statement text never changes with batch size;
 *  - grouped reads, never one sold query and one reserved query per type;
 *  - hidden (guest-list) types are excluded from public reads and from the
 *    public on-sale capacity, and are available through the internal summary.
 */

import type { TicketTypeRow } from '@/db/schema.ts';

/** Counters a ticket type carries, regardless of visibility. */
export interface TicketCounters {
  sold: number;
  reserved: number;
}

/** Live inventory for one ticket type. */
export interface TicketTypeInventory extends TicketCounters {
  ticketType: TicketTypeRow;
  /** capacity - sold - reserved, floored at zero. The value the public sees. */
  available: number;
  /**
   * capacity - sold - reserved without the floor. A negative value would mean
   * the database holds more admissions and holds than the allocation, which no
   * schema constraint forbids - so it is surfaced rather than hidden.
   */
  rawAvailable: number;
  /** True when rawAvailable is negative. */
  overCommitted: boolean;
}

/** The public ticket types for a batch of events, ready for the 02C projector. */
export interface PublicTicketInventory {
  /** Public types per event id, in position order. Hidden types are absent. */
  typesByEvent: ReadonlyMap<string, TicketTypeRow[]>;
  /** Full per-type inventory for those public types, in position order. */
  inventoryByEvent: ReadonlyMap<string, TicketTypeInventory[]>;
  /** sold/reserved per public ticket type id. */
  counters: ReadonlyMap<string, TicketCounters>;
}

/** Internal/admin summary for one event - every type, with capacity figures. */
export interface EventInventorySummary {
  eventId: string;
  publicTypes: TicketTypeInventory[];
  hiddenTypes: TicketTypeInventory[];
  /** Public and hidden, in position order. */
  allTypes: TicketTypeInventory[];
  /** Sum of public capacities only; hidden allocation is never on sale. */
  publicCapacity: number;
  /** Sold across public types. Hidden sales are counted as guestList instead. */
  sold: number;
  reserved: number;
  available: number;
  /** Sold hidden types - comps and guest list. */
  guestList: number;
}

export interface TicketInventoryService {
  /** Public types and their counters for a batch of event ids. */
  publicInventory(eventIds: readonly string[]): Promise<PublicTicketInventory>;
  /** Internal read: full summary per event id, hidden types included. */
  inventorySummary(eventIds: readonly string[]): Promise<Map<string, EventInventorySummary>>;
  /** Internal read for one event; null when the event has no ticket types. */
  eventSummary(eventId: string): Promise<EventInventorySummary | null>;
  /** One ticket type's live inventory; null when the id is unknown. */
  ticketTypeInventory(ticketTypeId: string): Promise<TicketTypeInventory | null>;
}

const TICKET_TYPE_COLUMNS = [
  'id',
  'event_id',
  'name',
  'description',
  'price_in_pence',
  'capacity',
  'max_per_order',
  'sales_open_at',
  'sales_close_at',
  'position',
  'visibility',
].join(', ');

const SELECT_TYPES_FOR_EVENTS_SQL =
  `select ${TICKET_TYPE_COLUMNS} from ticket_types ` +
  'where event_id in (select value from json_each(?1)) order by event_id, position, id';
const SELECT_TYPE_BY_ID_SQL = `select ${TICKET_TYPE_COLUMNS} from ticket_types where id = ?1`;

const SELECT_SOLD_SQL =
  'select oi.ticket_type_id as ticket_type_id, coalesce(sum(oi.quantity), 0) as sold ' +
  'from order_items oi join orders o on o.id = oi.order_id ' +
  'where oi.ticket_type_id in (select value from json_each(?1)) ' +
  "and o.status in ('paid', 'partially_refunded') " +
  'group by oi.ticket_type_id';

/**
 * Strictly future reservations only. The comparison is done with `julianday`
 * rather than string ordering so the boundary case (expires exactly at now) is
 * decided by the database, not by an assumption about lexical ordering.
 */
const SELECT_RESERVED_SQL =
  'select i.ticket_type_id as ticket_type_id, coalesce(sum(i.quantity), 0) as reserved ' +
  'from order_items i join orders o on o.id = i.order_id ' +
  'where i.ticket_type_id in (select value from json_each(?1)) ' +
  "and o.status = 'awaiting_payment' " +
  'and julianday(o.reservation_expires_at) > julianday(?2) ' +
  'group by i.ticket_type_id';

interface SoldRow {
  ticket_type_id: string;
  sold: number;
}
interface ReservedRow {
  ticket_type_id: string;
  reserved: number;
}

function toInventory(
  ticketType: TicketTypeRow,
  sold: number,
  reserved: number,
): TicketTypeInventory {
  const rawAvailable = ticketType.capacity - sold - reserved;
  return {
    ticketType,
    sold,
    reserved,
    available: Math.max(0, rawAvailable),
    rawAvailable,
    overCommitted: rawAvailable < 0,
  };
}

class D1TicketInventoryService implements TicketInventoryService {
  constructor(
    private readonly db: D1Database,
    /** Clock seam: reservation expiry must be testable without sleeping. */
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async publicInventory(eventIds: readonly string[]): Promise<PublicTicketInventory> {
    if (eventIds.length === 0) {
      return { typesByEvent: new Map(), inventoryByEvent: new Map(), counters: new Map() };
    }

    const rows = (
      await this.db
        .prepare(SELECT_TYPES_FOR_EVENTS_SQL)
        .bind(JSON.stringify(eventIds))
        .all<TicketTypeRow>()
    ).results;
    const publicTypes = rows.filter((row) => row.visibility === 'public');
    const inventory = await this.withCounters(publicTypes);

    const typesByEvent = new Map<string, TicketTypeRow[]>();
    const inventoryByEvent = new Map<string, TicketTypeInventory[]>();
    const counters = new Map<string, TicketCounters>();

    for (const entry of inventory) {
      const eventId = entry.ticketType.event_id;
      const types = typesByEvent.get(eventId);
      if (types) types.push(entry.ticketType);
      else typesByEvent.set(eventId, [entry.ticketType]);

      const list = inventoryByEvent.get(eventId);
      if (list) list.push(entry);
      else inventoryByEvent.set(eventId, [entry]);

      counters.set(entry.ticketType.id, { sold: entry.sold, reserved: entry.reserved });
    }

    return { typesByEvent, inventoryByEvent, counters };
  }

  async inventorySummary(
    eventIds: readonly string[],
  ): Promise<Map<string, EventInventorySummary>> {
    const summaries = new Map<string, EventInventorySummary>();
    if (eventIds.length === 0) return summaries;

    const rows = (
      await this.db
        .prepare(SELECT_TYPES_FOR_EVENTS_SQL)
        .bind(JSON.stringify(eventIds))
        .all<TicketTypeRow>()
    ).results;
    const inventory = await this.withCounters(rows);

    const byEvent = new Map<string, TicketTypeInventory[]>();
    for (const entry of inventory) {
      const list = byEvent.get(entry.ticketType.event_id);
      if (list) list.push(entry);
      else byEvent.set(entry.ticketType.event_id, [entry]);
    }

    for (const [eventId, allTypes] of byEvent) {
      const publicTypes = allTypes.filter((entry) => entry.ticketType.visibility === 'public');
      const hiddenTypes = allTypes.filter((entry) => entry.ticketType.visibility === 'hidden');

      const publicCapacity = publicTypes.reduce((sum, entry) => sum + entry.ticketType.capacity, 0);
      const sold = publicTypes.reduce((sum, entry) => sum + entry.sold, 0);
      const reserved = publicTypes.reduce((sum, entry) => sum + entry.reserved, 0);
      const guestList = hiddenTypes.reduce((sum, entry) => sum + entry.sold, 0);

      summaries.set(eventId, {
        eventId,
        publicTypes,
        hiddenTypes,
        allTypes,
        publicCapacity,
        sold,
        reserved,
        available: Math.max(0, publicCapacity - sold - reserved),
        guestList,
      });
    }

    return summaries;
  }

  async eventSummary(eventId: string): Promise<EventInventorySummary | null> {
    const summaries = await this.inventorySummary([eventId]);
    return summaries.get(eventId) ?? null;
  }

  async ticketTypeInventory(ticketTypeId: string): Promise<TicketTypeInventory | null> {
    const row = await this.db
      .prepare(SELECT_TYPE_BY_ID_SQL)
      .bind(ticketTypeId)
      .first<TicketTypeRow>();
    if (!row) return null;

    const [inventory] = await this.withCounters([row]);
    return inventory ?? null;
  }

  /** Two grouped statements for any number of types - never one pair per type. */
  private async withCounters(rows: readonly TicketTypeRow[]): Promise<TicketTypeInventory[]> {
    if (rows.length === 0) return [];

    const idJson = JSON.stringify(rows.map((row) => row.id));

    const sold = new Map<string, number>();
    const soldRows = (
      await this.db.prepare(SELECT_SOLD_SQL).bind(idJson).all<SoldRow>()
    ).results;
    for (const row of soldRows) sold.set(row.ticket_type_id, row.sold);

    const reserved = new Map<string, number>();
    const reservedRows = (
      await this.db
        .prepare(SELECT_RESERVED_SQL)
        .bind(idJson, this.clock().toISOString())
        .all<ReservedRow>()
    ).results;
    for (const row of reservedRows) reserved.set(row.ticket_type_id, row.reserved);

    return rows.map((row) => toInventory(row, sold.get(row.id) ?? 0, reserved.get(row.id) ?? 0));
  }
}

/** Build the D1 ticket inventory service against a resolved binding. */
export function createD1TicketInventoryService(
  db: D1Database,
  clock?: () => Date,
): TicketInventoryService {
  return new D1TicketInventoryService(db, clock);
}
