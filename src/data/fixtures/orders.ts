/**
 * Mock orders, order items and tickets.
 * Replaced by the D1 `orders` / `order_items` / `tickets` tables in AMPED-02A
 * and by the real order state machine in AMPED-06A.
 *
 * Generated deterministically from a seeded pseudo-random sequence so that the
 * admin tables, the door lookup and the dashboard totals are consistent with
 * the SALES counters in ./events.ts and with each other, without having to
 * hand-write three hundred rows.
 *
 * Nothing here is real customer data. Names are drawn from a fixed invented
 * list and every email address is on example.com.
 */

import type { Order, OrderItem, Ticket } from '@/types/domain.ts';
import { TICKET_TYPES_BY_ID } from './events.ts';

// --- deterministic pseudo-randomness ---------------------------------------
// A linear congruential generator. Same sequence on every machine and every
// build, which is what keeps the fixtures reproducible.
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

const FIRST_NAMES = [
  'Aisha', 'Tom', 'Priya', 'Callum', 'Nia', 'Dan', 'Yusuf', 'Erin', 'Marcus', 'Bea',
  'Owen', 'Jade', 'Rory', 'Lena', 'Sam', 'Fiona', 'Idris', 'Kelly', 'Nathan', 'Rosa',
  'Gethin', 'Amara', 'Joe', 'Simone', 'Hugh', 'Tasha', 'Elliot', 'Mo', 'Cerys', 'Vik',
];

const LAST_NAMES = [
  'Okafor', 'Whitfield', 'Nair', 'Docherty', 'Brennan', 'Hale', 'Iqbal', 'Moss',
  'Ainsworth', 'Kowalski', 'Pryce', 'Sutcliffe', 'Bannerman', 'Ferris', 'Hollis',
  'Dunne', 'Achebe', 'Rowntree', 'Garvey', 'Petrova', 'Lloyd', 'Kaur', 'Stead',
  'Marchetti', 'Oyelaran', 'Fitzgerald', 'Barlow', 'Nkemdirim', 'Quinn', 'Rashford',
];

/** Which ticket types each generated batch of orders draws from. */
interface OrderPlan {
  eventId: string;
  ticketTypeIds: string[];
  /** Paid tickets to distribute across generated orders. */
  paidTickets: number;
  /** Tickets held by in-flight checkouts (one awaiting_payment order). */
  reservedTickets: number;
  /** Guest list admissions, issued as a comp order. */
  guestTickets: number;
  /** Tickets already scanned in. Only ever non-zero for past events. */
  checkedIn: number;
  /** Seed so each event gets a different but stable customer list. */
  seed: number;
  /** Days ago the orders were placed, spread backwards from this. */
  placedWithinDays: number;
}

const PLANS: OrderPlan[] = [
  { eventId: 'evt_glass_hearts_nov', ticketTypeIds: ['tt_gh_early', 'tt_gh_ga'], paidTickets: 156, reservedTickets: 4, guestTickets: 11, checkedIn: 0, seed: 101, placedWithinDays: 34 },
  { eventId: 'evt_ledger_oct', ticketTypeIds: ['tt_led_ga'], paidTickets: 82, reservedTickets: 0, guestTickets: 6, checkedIn: 0, seed: 202, placedWithinDays: 28 },
  { eventId: 'evt_northern_static_oct', ticketTypeIds: ['tt_ns_early', 'tt_ns_ga'], paidTickets: 144, reservedTickets: 2, guestTickets: 4, checkedIn: 0, seed: 303, placedWithinDays: 40 },
  { eventId: 'evt_saltwater_nov', ticketTypeIds: ['tt_sw_ga', 'tt_sw_seated'], paidTickets: 169, reservedTickets: 0, guestTickets: 0, checkedIn: 0, seed: 404, placedWithinDays: 45 },
  { eventId: 'evt_velvet_antler_dec', ticketTypeIds: ['tt_va_ga'], paidTickets: 186, reservedTickets: 1, guestTickets: 3, checkedIn: 0, seed: 505, placedWithinDays: 52 },
  { eventId: 'evt_hollow_coast_past', ticketTypeIds: ['tt_hc_ga', 'tt_hc_seated'], paidTickets: 468, reservedTickets: 0, guestTickets: 0, checkedIn: 441, seed: 606, placedWithinDays: 60 },
  { eventId: 'evt_brass_tacks_past', ticketTypeIds: ['tt_bp_ga'], paidTickets: 291, reservedTickets: 0, guestTickets: 0, checkedIn: 268, seed: 707, placedWithinDays: 55 },
  { eventId: 'evt_paper_lions_past', ticketTypeIds: ['tt_pp_ga'], paidTickets: 85, reservedTickets: 0, guestTickets: 0, checkedIn: 79, seed: 808, placedWithinDays: 30 },
  { eventId: 'evt_spring_session_past', ticketTypeIds: ['tt_ss_ga'], paidTickets: 194, reservedTickets: 0, guestTickets: 0, checkedIn: 181, seed: 909, placedWithinDays: 48 },
];

const ORDERS: Order[] = [];
const TICKETS: Ticket[] = [];

let orderCounter = 700;
const YEAR_SUFFIX = new Date().getFullYear().toString().slice(2);

function nextReference(): string {
  orderCounter += 1;
  return `AMP-${YEAR_SUFFIX}-${orderCounter.toString().padStart(5, '0')}`;
}

function buildOrder(options: {
  eventId: string;
  ticketTypeId: string;
  quantity: number;
  status: Order['status'];
  rnd: () => number;
  placedAgoMs: number;
  isGuestList?: boolean;
  checkInCount?: number;
}): Order {
  const { eventId, ticketTypeId, quantity, status, rnd, placedAgoMs, isGuestList = false } = options;
  const ticketType = TICKET_TYPES_BY_ID.get(ticketTypeId);
  const unitPrice = ticketType?.priceInPence ?? 0;
  const name = `${FIRST_NAMES[Math.floor(rnd() * FIRST_NAMES.length)]} ${LAST_NAMES[Math.floor(rnd() * LAST_NAMES.length)]}`;
  const email = `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`;
  const reference = nextReference();
  const orderId = `ord_${reference.toLowerCase().replace(/-/g, '_')}`;
  const placedAt = new Date(Date.now() - placedAgoMs).toISOString();

  const item: OrderItem = {
    id: `oi_${orderId}`,
    orderId,
    ticketTypeId,
    quantity,
    unitPriceInPence: unitPrice,
    ticketTypeName: ticketType?.name ?? 'General Admission',
  };

  const order: Order = {
    id: orderId,
    reference,
    eventId,
    customerName: name,
    customerEmail: email,
    status,
    totalInPence: unitPrice * quantity,
    feeInPence: 0,
    items: [item],
    paymentProvider: isGuestList ? 'comp' : 'mock',
    paymentReference: status === 'paid' && !isGuestList ? `mock_checkout_${orderId.slice(-8)}` : undefined,
    paidAt: status === 'paid' ? placedAt : undefined,
    reservationExpiresAt:
      status === 'awaiting_payment' ? new Date(Date.now() + 18 * 60_000).toISOString() : undefined,
    marketingOptIn: rnd() > 0.45,
    createdAt: placedAt,
    updatedAt: placedAt,
  };

  const toCheckIn = options.checkInCount ?? 0;
  for (let i = 0; i < quantity; i += 1) {
    const checkedIn = i < toCheckIn;
    TICKETS.push({
      id: `tkt_${orderId}_${i + 1}`,
      orderId,
      eventId,
      ticketTypeId,
      reference: `${reference}-${i + 1}`,
      status: status === 'paid' ? (checkedIn ? 'checked_in' : 'issued') : 'issued',
      isGuestList,
      issuedAt: placedAt,
      checkedInAt: checkedIn ? new Date(Date.parse(placedAt) + 86_400_000).toISOString() : undefined,
      attendeeName: isGuestList ? name : undefined,
    });
  }

  return order;
}

for (const plan of PLANS) {
  const rnd = makeRandom(plan.seed);
  const span = plan.placedWithinDays * 86_400_000;

  // Paid orders, sized 1-4 tickets, until the plan total is met exactly.
  let remaining = plan.paidTickets;
  let remainingCheckIns = plan.checkedIn;
  let typeIndex = 0;
  while (remaining > 0) {
    const quantity = Math.min(remaining, 1 + Math.floor(rnd() * 4));
    const ticketTypeId = plan.ticketTypeIds[typeIndex % plan.ticketTypeIds.length]!;
    typeIndex += 1;
    const checkInCount = Math.min(quantity, remainingCheckIns);
    remainingCheckIns -= checkInCount;
    ORDERS.push(
      buildOrder({
        eventId: plan.eventId,
        ticketTypeId,
        quantity,
        status: 'paid',
        rnd,
        placedAgoMs: rnd() * span,
        checkInCount,
      }),
    );
    remaining -= quantity;
  }

  if (plan.reservedTickets > 0) {
    ORDERS.push(
      buildOrder({
        eventId: plan.eventId,
        ticketTypeId: plan.ticketTypeIds[plan.ticketTypeIds.length - 1]!,
        quantity: plan.reservedTickets,
        status: 'awaiting_payment',
        rnd,
        placedAgoMs: 11 * 60_000,
      }),
    );
  }

  if (plan.guestTickets > 0) {
    const guestTypeId = `${plan.ticketTypeIds[0]!.split('_').slice(0, 2).join('_')}_guest`;
    ORDERS.push(
      buildOrder({
        eventId: plan.eventId,
        ticketTypeId: TICKET_TYPES_BY_ID.has(guestTypeId) ? guestTypeId : plan.ticketTypeIds[0]!,
        quantity: plan.guestTickets,
        status: 'paid',
        rnd,
        placedAgoMs: rnd() * span,
        isGuestList: true,
      }),
    );
  }
}

/** One expired checkout, so the orders table shows what abandonment looks like. */
ORDERS.push(
  buildOrder({
    eventId: 'evt_glass_hearts_nov',
    ticketTypeId: 'tt_gh_ga',
    quantity: 2,
    status: 'expired',
    rnd: makeRandom(9_999),
    placedAgoMs: 3 * 86_400_000,
  }),
);

/** One refunded order, from the postponed show. */
ORDERS.push(
  buildOrder({
    eventId: 'evt_saltwater_nov',
    ticketTypeId: 'tt_sw_ga',
    quantity: 2,
    status: 'refunded',
    rnd: makeRandom(8_888),
    placedAgoMs: 21 * 86_400_000,
  }),
);

/** Newest first, which is how every admin table wants them. */
ORDERS.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

export { ORDERS, TICKETS };

export const ORDERS_BY_ID = new Map(ORDERS.map((o) => [o.id, o]));
export const TICKETS_BY_ORDER = TICKETS.reduce<Map<string, Ticket[]>>((map, ticket) => {
  const list = map.get(ticket.orderId) ?? [];
  list.push(ticket);
  map.set(ticket.orderId, list);
  return map;
}, new Map());
