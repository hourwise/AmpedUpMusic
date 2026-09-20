/**
 * Deterministic seed generation for orders, order items, tickets and check-ins.
 *
 * The numbers here are the AMPED-01 fixture numbers, not invented ones. For
 * every ticket type the paid total equals the `SALES` counter in
 * `src/data/fixtures/events.ts`, and the checked-in totals equal that file's
 * per-event `checkedIn` figures, so the availability states the scaffold
 * demonstrates are reproducible from the database:
 *
 *   The Glass Hearts   early bird 60/60 (gone), GA 96 sold + 4 reserved
 *                      -> GA reads "selling fast", guest list hidden
 *   LEDGER             GA 82 sold of 82 -> "sold out"
 *   Northern Static    early bird 80/80 (gone), GA 64 sold + 2 reserved
 *   Saltwater Parade   GA 118, seated 51 -> event postponed, nothing on sale
 *   Velvet Antler      GA 186 sold + 1 reserved of 200 -> "last few"
 *   Winter All-Dayer   nothing sold, sales open in 12 days -> "not yet on sale"
 *   Completed events   468, 291, 85 and 194 sold, most of them already scanned
 *
 * Two deliberate differences from the fixture generator, both of which make
 * the data correct rather than merely equivalent:
 *
 *  1. Tickets are issued only by paid orders. `TicketStatus` has no "held"
 *     state and the domain model states that only a paid order may issue
 *     tickets, so an unpaid order carries order_items but no ticket rows.
 *     Reserved stock is therefore derived from order_items - which is how
 *     AMPED-02D is specified to compute it. The AMPED-01 fixture issued
 *     `issued` tickets for its in-flight checkout, which would have counted
 *     as sold under that definition.
 *  2. The paid total is declared per ticket type rather than emerging from a
 *     pseudo-random split. The counts are then correct by construction and a
 *     reviewer can check them against the fixture table by eye.
 *
 * Names and dates still come from a seeded linear congruential generator, so
 * the dataset is identical on every machine and for a given `now`.
 */

import type { CheckInRow, OrderItemRow, OrderRow, TicketRow, TicketTypeRow } from './schema.ts';
import { offsetFrom } from './seed-clock.ts';

// --- deterministic pseudo-randomness ---------------------------------------
// A linear congruential generator. The same sequence on every machine, which
// is what keeps the seed reproducible.
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

/** The two operators referenced by the scaffold's audit entries. */
const OPERATORS = ['anya@ampedupmusic.co.uk', 'jay@ampedupmusic.co.uk'] as const;

/** SumUp hosted checkouts last 30 minutes; see `Order.reservationExpiresAt`. */
const RESERVATION_WINDOW_MS = 30 * 60_000;

/** Order references restart here so the seeded set never collides. */
const FIRST_ORDER_NUMBER = 701;

export interface OrderPlan {
  eventId: string;
  /** Paid tickets per ticket type. The sum is the fixture's `sold` figure. */
  paid: ReadonlyArray<{ ticketTypeId: string; quantity: number }>;
  /** The in-flight checkout that makes `reserved` non-zero. */
  reservation?: { ticketTypeId: string; quantity: number };
  /** Guest list admissions, issued as a fully paid `comp` order. */
  guestList?: { ticketTypeId: string; quantity: number };
  /** Paid tickets already scanned in. Non-zero only for past events. */
  checkedIn: number;
  seed: number;
  /** Orders are spread backwards over this many days. */
  placedWithinDays: number;
}

export const ORDER_PLANS: readonly OrderPlan[] = [
  {
    eventId: 'evt_glass_hearts_nov',
    paid: [
      { ticketTypeId: 'tt_gh_early', quantity: 60 },
      { ticketTypeId: 'tt_gh_ga', quantity: 96 },
    ],
    reservation: { ticketTypeId: 'tt_gh_ga', quantity: 4 },
    guestList: { ticketTypeId: 'tt_gh_guest', quantity: 11 },
    checkedIn: 0,
    seed: 101,
    placedWithinDays: 34,
  },
  {
    eventId: 'evt_ledger_oct',
    paid: [{ ticketTypeId: 'tt_led_ga', quantity: 82 }],
    guestList: { ticketTypeId: 'tt_led_guest', quantity: 6 },
    checkedIn: 0,
    seed: 202,
    placedWithinDays: 28,
  },
  {
    eventId: 'evt_northern_static_oct',
    paid: [
      { ticketTypeId: 'tt_ns_early', quantity: 80 },
      { ticketTypeId: 'tt_ns_ga', quantity: 64 },
    ],
    reservation: { ticketTypeId: 'tt_ns_ga', quantity: 2 },
    guestList: { ticketTypeId: 'tt_ns_guest', quantity: 4 },
    checkedIn: 0,
    seed: 303,
    placedWithinDays: 40,
  },
  {
    eventId: 'evt_saltwater_nov',
    paid: [
      { ticketTypeId: 'tt_sw_ga', quantity: 118 },
      { ticketTypeId: 'tt_sw_seated', quantity: 51 },
    ],
    checkedIn: 0,
    seed: 404,
    placedWithinDays: 45,
  },
  {
    eventId: 'evt_velvet_antler_dec',
    paid: [{ ticketTypeId: 'tt_va_ga', quantity: 186 }],
    reservation: { ticketTypeId: 'tt_va_ga', quantity: 1 },
    guestList: { ticketTypeId: 'tt_va_guest', quantity: 3 },
    checkedIn: 0,
    seed: 505,
    placedWithinDays: 52,
  },
  {
    eventId: 'evt_hollow_coast_past',
    paid: [
      { ticketTypeId: 'tt_hc_ga', quantity: 330 },
      { ticketTypeId: 'tt_hc_seated', quantity: 138 },
    ],
    checkedIn: 441,
    seed: 606,
    placedWithinDays: 60,
  },
  {
    eventId: 'evt_brass_tacks_past',
    paid: [{ ticketTypeId: 'tt_bp_ga', quantity: 291 }],
    checkedIn: 268,
    seed: 707,
    placedWithinDays: 55,
  },
  {
    eventId: 'evt_paper_lions_past',
    paid: [{ ticketTypeId: 'tt_pp_ga', quantity: 85 }],
    checkedIn: 79,
    seed: 808,
    placedWithinDays: 30,
  },
  {
    eventId: 'evt_spring_session_past',
    paid: [{ ticketTypeId: 'tt_ss_ga', quantity: 194 }],
    checkedIn: 181,
    seed: 909,
    placedWithinDays: 48,
  },
];

/**
 * The two one-off orders the fixture set carries so the admin order table
 * shows what abandonment and refunds look like.
 */
export const EXTRA_ORDERS = {
  expired: { eventId: 'evt_glass_hearts_nov', ticketTypeId: 'tt_gh_ga', quantity: 2 },
  refunded: { eventId: 'evt_saltwater_nov', ticketTypeId: 'tt_sw_ga', quantity: 2 },
} as const;

export interface SeedOrderRows {
  orders: OrderRow[];
  orderItems: OrderItemRow[];
  tickets: TicketRow[];
  checkins: CheckInRow[];
}

/** `AMP-26-00701` -> `ord_amp_26_00701`. */
function orderIdFor(reference: string): string {
  return `ord_${reference.toLowerCase().replace(/-/g, '_')}`;
}

export function buildOrderRows(now: Date, ticketTypes: readonly TicketTypeRow[]): SeedOrderRows {
  const typesById = new Map(ticketTypes.map((type) => [type.id, type]));
  const orders: OrderRow[] = [];
  const orderItems: OrderItemRow[] = [];
  const tickets: TicketRow[] = [];
  const checkins: CheckInRow[] = [];

  const yearSuffix = now.getFullYear().toString().slice(2);
  let orderNumber = FIRST_ORDER_NUMBER;
  let ticketCounter = 0;

  function nextReference(): string {
    orderNumber += 1;
    return `AMP-${yearSuffix}-${orderNumber.toString().padStart(5, '0')}`;
  }

  interface BuildInput {
    eventId: string;
    ticketTypeId: string;
    quantity: number;
    status: OrderRow['status'];
    placedAgoMs: number;
    rnd: () => number;
    isGuestList?: boolean;
    checkedInCount?: number;
    reservationExpiresAt?: string;
  }

  function buildOrder(input: BuildInput): void {
    const type = typesById.get(input.ticketTypeId);
    if (!type) {
      throw new Error(`Seed plan refers to unknown ticket type ${input.ticketTypeId}.`);
    }

    const reference = nextReference();
    const orderId = orderIdFor(reference);
    const unitPrice = type.price_in_pence;
    const isGuestList = input.isGuestList ?? false;
    const placedAt = new Date(now.getTime() - input.placedAgoMs).toISOString();
    const total = unitPrice * input.quantity;

    const customerName = `${FIRST_NAMES[Math.floor(input.rnd() * FIRST_NAMES.length)]!} ${
      LAST_NAMES[Math.floor(input.rnd() * LAST_NAMES.length)]!
    }`;
    const customerEmail = `${customerName.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`;
    const optedIn = input.rnd() > 0.45 ? 1 : 0;

    const isPaid = input.status === 'paid';
    // Money was taken for a paid order or for one that has since been refunded.
    const wasPaid = isPaid || input.status === 'refunded' || input.status === 'partially_refunded';

    orders.push({
      id: orderId,
      reference,
      event_id: input.eventId,
      customer_name: customerName,
      customer_email: customerEmail,
      customer_phone: null,
      status: input.status,
      total_in_pence: total,
      fee_in_pence: 0,
      payment_reference: wasPaid && !isGuestList ? `mock_checkout_${orderId.slice(-8)}` : null,
      payment_provider: isGuestList ? 'comp' : wasPaid ? 'mock' : null,
      paid_at: wasPaid ? placedAt : null,
      reservation_expires_at: input.reservationExpiresAt ?? null,
      marketing_opt_in: optedIn as 0 | 1,
      created_at: placedAt,
      updated_at: placedAt,
    });

    orderItems.push({
      id: `oi_${orderId}`,
      order_id: orderId,
      ticket_type_id: input.ticketTypeId,
      quantity: input.quantity,
      unit_price_in_pence: unitPrice,
      ticket_type_name: type.name,
    });

    // Tickets exist only where money has been taken. See the file header. A
    // refunded order keeps its tickets, marked `refunded`, so the order history
    // still shows what was issued.
    if (wasPaid) {
      const toCheckIn = input.checkedInCount ?? 0;
      const orderStatusForTickets = isPaid ? null : 'refunded';

      for (let index = 0; index < input.quantity; index += 1) {
        ticketCounter += 1;
        const checkedIn = isPaid && index < toCheckIn;
        const ticketId = `tkt_${orderId}_${index + 1}`;
        const checkedInAt = checkedIn
          ? new Date(Date.parse(placedAt) + 86_400_000).toISOString()
          : null;

        tickets.push({
          id: ticketId,
          order_id: orderId,
          event_id: input.eventId,
          ticket_type_id: input.ticketTypeId,
          reference: `${reference}-${index + 1}`,
          token_hash: null,
          status: orderStatusForTickets ?? (checkedIn ? 'checked_in' : 'issued'),
          attendee_name: isGuestList ? customerName : null,
          is_guest_list: isGuestList ? 1 : 0,
          issued_at: placedAt,
          checked_in_at: checkedInAt,
        });

        if (checkedIn && checkedInAt) {
          checkins.push({
            id: `chk_${ticketId}`,
            ticket_id: ticketId,
            event_id: input.eventId,
            operator_email: OPERATORS[ticketCounter % OPERATORS.length]!,
            method: 'qr',
            scanned_at: checkedInAt,
          });
        }
      }
    }
  }

  for (const plan of ORDER_PLANS) {
    const rnd = makeRandom(plan.seed);
    const span = plan.placedWithinDays * 86_400_000;
    let remainingCheckIns = plan.checkedIn;

    for (const allocation of plan.paid) {
      let remaining = allocation.quantity;

      while (remaining > 0) {
        const quantity = Math.min(remaining, 1 + Math.floor(rnd() * 4));
        const checkedInCount = Math.min(quantity, remainingCheckIns);
        remainingCheckIns -= checkedInCount;

        buildOrder({
          eventId: plan.eventId,
          ticketTypeId: allocation.ticketTypeId,
          quantity,
          status: 'paid',
          placedAgoMs: rnd() * span,
          rnd,
          checkedInCount,
        });

        remaining -= quantity;
      }
    }

    if (plan.guestList) {
      buildOrder({
        eventId: plan.eventId,
        ticketTypeId: plan.guestList.ticketTypeId,
        quantity: plan.guestList.quantity,
        status: 'paid',
        placedAgoMs: rnd() * span,
        rnd,
        isGuestList: true,
      });
    }

    if (plan.reservation) {
      // An in-flight checkout. It carries no tickets: it has not been paid for.
      buildOrder({
        eventId: plan.eventId,
        ticketTypeId: plan.reservation.ticketTypeId,
        quantity: plan.reservation.quantity,
        status: 'awaiting_payment',
        placedAgoMs: 11 * 60_000,
        rnd,
        reservationExpiresAt: new Date(now.getTime() + RESERVATION_WINDOW_MS).toISOString(),
      });
    }
  }

  // One abandoned checkout, so the orders table shows what expiring looks like.
  buildOrder({
    eventId: EXTRA_ORDERS.expired.eventId,
    ticketTypeId: EXTRA_ORDERS.expired.ticketTypeId,
    quantity: EXTRA_ORDERS.expired.quantity,
    status: 'expired',
    placedAgoMs: 3 * 86_400_000,
    rnd: makeRandom(9_999),
    reservationExpiresAt: offsetFrom(now, -3, 0.5),
  });

  // One refunded order, from the postponed show. Its tickets were issued and
  // then refunded, so they exist and do not count as sold.
  const refunded = EXTRA_ORDERS.refunded;
  buildOrder({
    eventId: refunded.eventId,
    ticketTypeId: refunded.ticketTypeId,
    quantity: refunded.quantity,
    status: 'refunded',
    placedAgoMs: 21 * 86_400_000,
    rnd: makeRandom(8_888),
  });

  return { orders, orderItems, tickets, checkins };
}
