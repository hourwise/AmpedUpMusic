/**
 * Order state machine (AMPED-06A).
 *
 * The graph is exactly the one documented on `OrderStatus` in domain.ts:
 *
 *   pending --reserve--> awaiting_payment --verified--> paid --> refunded
 *      |                        |
 *      +--abandoned--> cancelled +--expired/failed--> expired
 *
 * Scope boundaries this module does NOT cross:
 *  - `paid` is reachable only through `confirmPayment`, which asks a
 *    `PaymentProvider` for the authoritative result. There is no `setStatus`,
 *    no `markPaid`, and no accepted status string on any public method.
 *  - There is no reservation sweep, no lazy reconciliation, no maxPerOrder
 *    holding rule and no oversell protection: those are AMPED-06B/06C. The
 *    checkout window is written only because the accepted schema requires
 *    `reservation_expires_at` on an `awaiting_payment` row.
 *
 * AMPED-07B narrowed exactly two things here and nothing else:
 *  - `reservation_expires_at` is now the provider's own `checkout.expiresAt`,
 *    stored verbatim. There is no locally calculated 30-minute window any
 *    more, because two independent clocks meant the local hold could outlive
 *    the hosted payment session and keep stock off sale for a dead checkout.
 *  - `beginPayment` takes an absolute `returnUrl` derived server-side from the
 *    current request, because a real provider cannot be handed a relative path
 *    and the browser must not choose where a payment session returns to.
 *  - No tickets are issued; issuance is AMPED-08A.
 *  - Refund transitions (`refunded`, `partially_refunded`) are not implemented:
 *    domain.ts documents `paid --> refunded` without defining partial-refund
 *    edges, and refunds are reconciled in a later phase. No edge into
 *    `partially_refunded` is invented here.
 *
 * Orders and order items are written from server-authoritative ticket data
 * (integer pence). References are `AMP-YY-NNNNN` with a bounded retry on the
 * database's unique-reference failure - never a read-then-increment.
 */

import { ConflictError, NotFoundError, ValidationError } from '@/lib/validation.ts';
import type { OrderStatus } from '@/types/domain.ts';

import type { PaymentProvider } from '../contracts.ts';
import { createD1TicketInventoryService } from '../d1/tickets.ts';
import {
  createD1InventoryReservations,
  inventoryConflict,
} from '../inventory/acquire.ts';

export interface CheckoutItemInput {
  ticketTypeId: string;
  quantity: number;
}

export interface CheckoutInput {
  eventId: string;
  items: ReadonlyArray<CheckoutItemInput>;
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  marketingOptIn?: boolean;
}

export interface CreatedOrder {
  orderId: string;
  reference: string;
  totalInPence: number;
  status: OrderStatus;
}

export interface BegunPayment {
  orderId: string;
  reference: string;
  checkoutId: string;
  redirectUrl: string;
  expiresAt: string;
}

export interface ConfirmedPayment {
  orderId: string;
  status: OrderStatus;
  paidAt?: string;
}

/**
 * A payment the server has ALREADY verified against the provider (AMPED-07C1).
 *
 * Constructing one of these is a claim that every correlation check has
 * passed: the provider was asked over an authenticated channel, it said PAID,
 * and the checkout it described matches this local order's reference, total,
 * currency and merchant. Nothing in this type comes from a webhook payload
 * except indirectly - the payload supplies only the checkout id that triggered
 * the lookup, and carries no payment authority of its own.
 *
 * It deliberately holds no provider response, no customer data and no
 * credentials: it is the small, already-trusted residue of verification.
 */
export interface VerifiedPayment {
  /** The local order, established by correlation - never by the payload. */
  orderId: string;
  /** The provider checkout id, already matched against payment_reference. */
  checkoutId: string;
  /** Which provider observed the payment. Scopes the observation record. */
  provider: string;
  /**
   * The provider's successful TRANSACTION id - not the checkout id.
   *
   * This is the observation identity. One checkout can be attempted many
   * times and can move FAILED -> PAID, so deduplicating on a checkout id
   * would let an early failure permanently suppress the later real payment.
   */
  transactionId: string;
  /** Authoritative paid timestamp, from the provider's successful transaction. */
  paidAt: string;
}

/**
 * What `applyVerifiedPayment` did. Business outcomes are returned, not thrown:
 * a webhook handler has to tell "we paid it" from "it was already paid" from
 * "the hold had gone" without catching exceptions to do routing.
 */
export type ApplyPaymentResult =
  | { outcome: 'applied'; orderId: string; paidAt: string }
  | { outcome: 'already-paid'; orderId: string; paidAt?: string }
  | { outcome: 'not-applicable'; orderId: string; status: OrderStatus };

/** The minimum local truth needed to correlate a provider checkout. */
export interface PaymentCorrelationSnapshot {
  orderId: string;
  reference: string;
  status: OrderStatus;
  totalInPence: number;
  paymentReference: string;
}

export interface OrderMutationService {
  createOrder(input: CheckoutInput): Promise<CreatedOrder>;
  /**
   * Create the provider checkout and activate the local reservation.
   *
   * `returnUrl` MUST be an absolute URL derived server-side from the current
   * request (AMPED-07B). It is a parameter rather than a constant because the
   * provider needs an origin, and because the browser must never be able to
   * choose where a payment session returns to.
   */
  beginPayment(
    orderId: string,
    provider: PaymentProvider,
    returnUrl: string,
  ): Promise<BegunPayment>;
  /**
   * Provider-authoritative confirmation for the mock-era checkout route.
   *
   * Retrieves the provider state itself and then delegates the actual
   * transition to `applyVerifiedPayment`. It is NOT a second writer to `paid`.
   */
  confirmPayment(
    orderId: string,
    checkoutId: string,
    provider: PaymentProvider,
  ): Promise<ConfirmedPayment>;
  /**
   * THE single local primitive that moves an order to `paid` (AMPED-07C1).
   *
   * Performs no network I/O whatsoever - verification happened before it was
   * called. AMPED-07C's webhook and AMPED-07D's scheduled reconciliation both
   * call exactly this, so there is one writer to `paid` and one place where
   * the atomicity, the audit and the observation record are decided.
   */
  applyVerifiedPayment(verified: VerifiedPayment): Promise<ApplyPaymentResult>;
  /**
   * Resolve a provider checkout id to the local order holding it.
   *
   * Backed by the 0012 partial unique index, so it cannot return two orders
   * for one checkout id - which would mean crediting someone else's payment.
   */
  findOrderByPaymentReference(
    provider: string,
    paymentReference: string,
  ): Promise<PaymentCorrelationSnapshot | null>;
  cancelOrder(orderId: string): Promise<void>;
  expireOrder(orderId: string): Promise<void>;
  /**
   * Reservation-expiry sweep (AMPED-06B): persist `expired` for holds whose
   * 30-minute window has passed. Idempotent - a second run transitions and
   * audits nothing further.
   */
  expireDueReservations(now: Date): Promise<{ expired: number }>;
}

type IdFactory = (prefix: string) => string;
const defaultId: IdFactory = (prefix) => `${prefix}_${crypto.randomUUID()}`;

/** Only a published gig sells tickets; everything else is not on sale. */
const SELLABLE_EVENT_STATUS_SQL = "status = 'published'";
const MAX_REFERENCE_ATTEMPTS = 8;
const MAX_LINE_QUANTITY = 99;

const AUDIT_SQL =
  'insert into audit_log (id, actor_email, action, entity_type, entity_id, summary, occurred_at) ' +
  'values (?1, ?2, ?3, ?4, ?5, ?6, ?7)';

interface TicketTypeRow {
  id: string;
  event_id: string;
  name: string;
  price_in_pence: number;
  visibility: string;
  max_per_order: number | null;
  sales_open_at: string | null;
  sales_close_at: string | null;
}

interface OrderRow {
  id: string;
  reference: string;
  event_id: string;
  status: OrderStatus;
  total_in_pence: number;
  customer_email: string;
  reservation_expires_at: string | null;
}

class D1OrderMutations implements OrderMutationService {
  private lastStamp = 0;

  constructor(
    private readonly db: D1Database,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: IdFactory = defaultId,
    /** Test seam: force reference candidates (collision/retry behaviour). */
    private readonly referenceSource?: () => string,
  ) {}

  async createOrder(input: CheckoutInput): Promise<CreatedOrder> {
    const items = this.normaliseItems(input.items);
    const event = await this.db
      .prepare(`select status from events where id = ?1 and ${SELLABLE_EVENT_STATUS_SQL}`)
      .bind(input.eventId)
      .first<{ status: string }>();
    if (!event) throw new NotFoundError('That gig is not taking orders.');

    // Authoritative ticket definitions: price and name are captured here.
    const captured: Array<{ ticketTypeId: string; quantity: number; name: string; price: number }> = [];
    for (const item of items) {
      const row = await this.db
        .prepare(
          'select id, event_id, name, price_in_pence, visibility, max_per_order, sales_open_at, sales_close_at from ticket_types where id = ?1',
        )
        .bind(item.ticketTypeId)
        .first<TicketTypeRow>();
      if (!row || row.event_id !== input.eventId || row.visibility !== 'public') {
        throw new NotFoundError('That ticket type is not on sale for this gig.');
      }
      // maxPerOrder is authoritative server-side and never clamped silently.
      if (row.max_per_order !== null && item.quantity > row.max_per_order) {
        throw new ValidationError({
          items: `You can order at most ${row.max_per_order} of ${row.name} at a time.`,
        });
      }
      captured.push({
        ticketTypeId: row.id,
        quantity: item.quantity,
        name: row.name,
        price: row.price_in_pence,
      });
    }

    const total = captured.reduce((sum, entry) => sum + entry.price * entry.quantity, 0);
    const at = this.stamp();

    for (let attempt = 0; attempt < MAX_REFERENCE_ATTEMPTS; attempt += 1) {
      const orderId = this.newId('ord');
      const reference = this.reference();
      const statements: D1PreparedStatement[] = [
        this.db
          .prepare(
            'insert into orders (id, reference, event_id, customer_name, customer_email, customer_phone, status, total_in_pence, fee_in_pence, marketing_opt_in, created_at, updated_at) ' +
              "values (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, 0, ?8, ?9, ?9)",
          )
          .bind(
            orderId,
            reference,
            input.eventId,
            input.customerName,
            input.customerEmail,
            input.customerPhone ?? null,
            total,
            input.marketingOptIn ? 1 : 0,
            at,
          ),
      ];
      for (const entry of captured) {
        statements.push(
          this.db
            .prepare(
              'insert into order_items (id, order_id, ticket_type_id, quantity, unit_price_in_pence, ticket_type_name) values (?1, ?2, ?3, ?4, ?5, ?6)',
            )
            .bind(this.newId('oi'), orderId, entry.ticketTypeId, entry.quantity, entry.price, entry.name),
        );
      }
      statements.push(
        this.audit('order.created', orderId, `Created ${reference}`, at),
      );

      try {
        await this.db.batch(statements);
        return { orderId, reference, totalInPence: total, status: 'pending' };
      } catch (error) {
        if (!isReferenceCollision(error) || attempt === MAX_REFERENCE_ATTEMPTS - 1) {
          // Only the specific unique-reference failure is retried; anything
          // else (including exhausted retries) surfaces as a controlled error.
          if (isReferenceCollision(error)) {
            throw new ConflictError('Could not allocate an order reference. Please try again.');
          }
          throw error;
        }
      }
    }
    throw new ConflictError('Could not allocate an order reference. Please try again.');
  }

  async beginPayment(
    orderId: string,
    provider: PaymentProvider,
    returnUrl: string,
  ): Promise<BegunPayment> {
    assertAbsoluteReturnUrl(returnUrl);

    const order = await this.loadOrder(orderId);
    if (order.status === 'awaiting_payment') {
      throw new ConflictError('Payment for this order has already started.');
    }
    if (order.status !== 'pending') {
      throw new ValidationError({ status: `An order in ${order.status} cannot start payment.` });
    }

    // Everything is validated before any reservation is activated, so a bad
    // line can never leave an orphan awaiting_payment hold.
    await this.assertReservable(order);

    const checkout = await provider.createCheckout({
      orderId: order.id,
      reference: order.reference,
      amountInPence: order.total_in_pence,
      currency: 'GBP',
      customerEmail: order.customer_email,
      returnUrl,
    });

    // ONE canonical logical now for the capacity cutoff and the row's
    // updated_at - the trigger reads the same instant via NEW.updated_at.
    const now = this.now();
    const at = now.toISOString();

    // ONE expiry clock (AMPED-07B). The reservation expires exactly when the
    // provider's checkout expires - the value is stored verbatim, never
    // recomputed locally, so there is no second 30-minute boundary that could
    // hold stock after the customer's payment session has already died.
    const reservationExpiresAt = checkout.expiresAt;
    assertUsableProviderExpiry(reservationExpiresAt, now);

    // PRIMARY stock authority (AMPED-06C): one conditional mutation that
    // checks the whole basket atomically. The advisory read above is not the
    // gate; the 0011 trigger remains the second line of defence.
    const acquired = await createD1InventoryReservations(this.db).acquireReservation({
      orderId,
      now,
      expiresAt: reservationExpiresAt,
      provider: provider.name,
      reference: checkout.checkoutId,
    });
    if (!acquired.acquired) throw inventoryConflict(acquired.reason);

    // Audited only after the transition succeeded, guarded on the exact row
    // state this acquisition wrote.
    await this.db
      .prepare(
        'insert into audit_log (id, actor_email, action, entity_type, entity_id, summary, occurred_at) ' +
          'select ?1, ?2, ?3, ?4, ?5, ?6, ?7 where exists (select 1 from orders where id = ?5 and status = ?8 and updated_at = ?9)',
      )
      .bind(
        this.newId('aud'),
        'checkout',
        'order.awaiting_payment',
        'order',
        orderId,
        `Started payment for ${order.reference}`,
        at,
        'awaiting_payment',
        at,
      )
      .run();

    return {
      orderId,
      reference: order.reference,
      checkoutId: checkout.checkoutId,
      redirectUrl: checkout.redirectUrl,
      expiresAt: checkout.expiresAt,
    };
  }

  async confirmPayment(
    orderId: string,
    checkoutId: string,
    provider: PaymentProvider,
  ): Promise<ConfirmedPayment> {
    const order = await this.loadOrder(orderId);

    // Idempotent: a second confirmation of an already-paid order changes
    // nothing and reports the same paid state.
    if (order.status === 'paid') return { orderId, status: 'paid' };
    if (order.status !== 'awaiting_payment') {
      throw new ValidationError({
        status: `An order in ${order.status} cannot be confirmed as paid.`,
      });
    }

    // An expired local hold is never resurrected by a late confirmation. The
    // inventory read already released the stock; the operator/provider
    // reconciliation for real SumUp discrepancies belongs to a later phase.
    const nowMs = this.now().getTime();
    if (
      order.reservation_expires_at !== null &&
      Date.parse(order.reservation_expires_at) <= nowMs
    ) {
      throw new ConflictError('This reservation has expired. Start checkout again.');
    }

    const result = await provider.confirm(checkoutId);

    // AMPED-07C1: a provider FAILURE no longer expires the order.
    //
    // It used to map `failed` -> local `expired`, which released the stock
    // immediately. That is wrong against a hosted checkout: a declined card
    // can be retried on the provider's own page, so a FAILED observation
    // means "this attempt did not work", not "this customer has gone". Acting
    // on it would sell the tickets out from under someone who is still paying
    // and may yet succeed. Expiry belongs solely to the time-based
    // reservation sweep (AMPED-06B), which is the one thing that actually
    // knows the customer has run out of time.
    if (result.status !== 'paid') {
      return { orderId, status: order.status };
    }

    // The generic PaymentProvider contract exposes no transaction identity,
    // so the checkout id stands in as the observation key for this path. The
    // SumUp webhook path has a real transaction id and uses it.
    const applied = await this.applyVerifiedPayment({
      orderId,
      checkoutId,
      provider: provider.name,
      transactionId: checkoutId,
      paidAt: result.paidAt ?? this.now().toISOString(),
    });

    if (applied.outcome === 'not-applicable') {
      throw new ConflictError('This order changed while payment was confirming.');
    }
    return applied.paidAt
      ? { orderId, status: 'paid', paidAt: applied.paidAt }
      : { orderId, status: 'paid' };
  }

  async applyVerifiedPayment(verified: VerifiedPayment): Promise<ApplyPaymentResult> {
    const order = await this.loadOrder(verified.orderId);

    if (order.status === 'paid') {
      const paidAt = await this.paidAtFor(verified.orderId);
      return paidAt
        ? { outcome: 'already-paid', orderId: verified.orderId, paidAt }
        : { outcome: 'already-paid', orderId: verified.orderId };
    }
    if (order.status !== 'awaiting_payment') {
      return { outcome: 'not-applicable', orderId: verified.orderId, status: order.status };
    }

    const at = this.stamp();
    const reservationFloor = this.now().toISOString();
    const observationKey = `${verified.provider}_txn:${verified.transactionId}`;

    // ONE batch, three statements, every one of them conditional.
    //
    //  1. The transition. The predicate IS the correctness gate: only an
    //     unexpired awaiting_payment row can become paid, so of N concurrent
    //     deliveries exactly one sees changes === 1 and the sweep can never
    //     be undone by a late payment.
    //
    //  2. The audit. Previously this was an UNCONDITIONAL insert beside a
    //     conditional update, so concurrent duplicates produced one
    //     transition and several `order.paid` rows. It is now guarded on the
    //     absence of such a row. The guard is on existence rather than on the
    //     values this batch wrote, because `paid_at` comes from the provider
    //     and is IDENTICAL across duplicate deliveries - a value-based guard
    //     would match for every loser too.
    //
    //  3. The observation. Keyed on the provider's transaction id, so a
    //     retry of the same payment is ignored while a genuinely later
    //     payment on the same checkout still records. ON CONFLICT DO NOTHING
    //     keeps a duplicate delivery harmless instead of raising.
    //
    // D1 serialises write transactions, so the losers' guards observe the
    // winner's committed rows rather than racing them.
    const results = await this.db.batch([
      this.db
        .prepare(
          "update orders set status = 'paid', paid_at = ?1, updated_at = ?2 " +
            "where id = ?3 and status = 'awaiting_payment' and reservation_expires_at > ?4",
        )
        .bind(verified.paidAt, at, verified.orderId, reservationFloor),
      this.db
        .prepare(
          'insert into audit_log (id, actor_email, action, entity_type, entity_id, summary, occurred_at) ' +
            "select ?1, ?2, 'order.paid', 'order', ?3, ?4, ?5 " +
            'where exists (select 1 from orders where id = ?3 and status = ?6 and updated_at = ?5) ' +
            "and not exists (select 1 from audit_log where entity_type = 'order' and entity_id = ?3 and action = 'order.paid')",
        )
        .bind(
          this.newId('aud'),
          `system:${verified.provider}-payment`,
          verified.orderId,
          `Paid ${order.reference}`,
          at,
          'paid',
        ),
      this.db
        .prepare(
          'insert into processed_webhooks (id, provider, provider_event_id, received_at, processed_at) ' +
            'values (?1, ?2, ?3, ?4, ?4) on conflict (provider, provider_event_id) do nothing',
        )
        .bind(this.newId('pwh'), verified.provider, observationKey, at),
    ]);

    if (((results[0]?.meta?.changes ?? 0) as number) === 0) {
      const current = await this.loadOrder(verified.orderId);
      if (current.status === 'paid') {
        const paidAt = await this.paidAtFor(verified.orderId);
        return paidAt
          ? { outcome: 'already-paid', orderId: verified.orderId, paidAt }
          : { outcome: 'already-paid', orderId: verified.orderId };
      }
      // The hold lapsed between the read and the write: the sweep won. This
      // is a real money discrepancy for AMPED-07D to surface, not something
      // to resolve here by resurrecting released stock.
      return { outcome: 'not-applicable', orderId: verified.orderId, status: current.status };
    }

    return { outcome: 'applied', orderId: verified.orderId, paidAt: verified.paidAt };
  }

  async findOrderByPaymentReference(
    provider: string,
    paymentReference: string,
  ): Promise<PaymentCorrelationSnapshot | null> {
    // The 0012 partial unique index makes this at most one row and keeps the
    // scan off a public, unauthenticated endpoint. Provider is matched too, so
    // a mock reference can never answer for a SumUp checkout.
    const row = await this.db
      .prepare(
        'select id, reference, status, total_in_pence, payment_reference from orders ' +
          'where payment_reference = ?1 and payment_provider = ?2',
      )
      .bind(paymentReference, provider)
      .first<{
        id: string;
        reference: string;
        status: OrderStatus;
        total_in_pence: number;
        payment_reference: string;
      }>();
    if (!row) return null;
    return {
      orderId: row.id,
      reference: row.reference,
      status: row.status,
      totalInPence: row.total_in_pence,
      paymentReference: row.payment_reference,
    };
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.transition(orderId, 'cancelled', 'pending', 'order.cancelled');
  }

  async expireOrder(orderId: string): Promise<void> {
    await this.transition(orderId, 'expired', 'awaiting_payment', 'order.expired');
  }

  async expireDueReservations(now: Date): Promise<{ expired: number }> {
    const at = now.toISOString();
    const due = (
      await this.db
        .prepare(
          "select id from orders where status = 'awaiting_payment' and julianday(reservation_expires_at) <= julianday(?1)",
        )
        .bind(at)
        .all<{ id: string }>()
    ).results;

    let expired = 0;
    for (const row of due) {
      const results = await this.db.batch([
        this.db
          .prepare(
            "update orders set status = 'expired', updated_at = ?1 where id = ?2 and status = 'awaiting_payment' and julianday(reservation_expires_at) <= julianday(?3)",
          )
          .bind(at, row.id, at),
        // Guarded audit: written only when this statement's update actually
        // moved the row, so a second sweep records nothing.
        this.db
          .prepare(
            'insert into audit_log (id, actor_email, action, entity_type, entity_id, summary, occurred_at) ' +
              'select ?1, ?2, ?3, ?4, ?5, ?6, ?7 where exists (select 1 from orders where id = ?5 and status = ?8 and updated_at = ?9)',
          )
          .bind(
            this.newId('aud'),
            'system:reservation-sweep',
            'order.expired',
            'order',
            row.id,
            'Expired by reservation sweep',
            at,
            'expired',
            at,
          ),
      ]);
      if (((results[0]?.meta?.changes ?? 0) as number) === 1) expired += 1;
    }
    return { expired };
  }

  // -- helpers -------------------------------------------------------------

  private normaliseItems(items: ReadonlyArray<CheckoutItemInput>): CheckoutItemInput[] {
    if (items.length === 0) throw new ValidationError({ items: 'Choose at least one ticket.' });
    if (items.length > 10) throw new ValidationError({ items: 'Too many ticket types in one order.' });

    // Duplicate lines are rejected outright: 3 + 3 must never slip past a
    // maxPerOrder of 5.
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.ticketTypeId)) {
        throw new ValidationError({ items: 'Each ticket type may appear only once.' });
      }
      seen.add(item.ticketTypeId);
    }

    return items.map((item) => {
      if (!/^[A-Za-z0-9_-]+$/.test(item.ticketTypeId)) {
        throw new ValidationError({ items: 'One of the ticket types is not valid.' });
      }
      if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_LINE_QUANTITY) {
        throw new ValidationError({ items: 'Ticket quantities must be whole numbers between 1 and 99.' });
      }
      return { ticketTypeId: item.ticketTypeId, quantity: item.quantity };
    });
  }

  /**
   * Sellability + serial availability for the whole basket, checked before
   * any reservation is activated. This is ordinary request correctness, not
   * the AMPED-06C concurrency guarantee.
   */
  private async assertReservable(order: OrderRow): Promise<void> {
    const event = await this.db
      .prepare('select status from events where id = ?1')
      .bind(order.event_id)
      .first<{ status: string }>();
    if (!event) throw new NotFoundError('That gig does not exist.');
    if (event.status !== 'published') {
      throw new ConflictError('This gig is not on sale.');
    }

    const lines = (
      await this.db
        .prepare(
          'select oi.ticket_type_id, oi.quantity, tt.name, tt.visibility, tt.sales_open_at, tt.sales_close_at ' +
            'from order_items oi join ticket_types tt on tt.id = oi.ticket_type_id where oi.order_id = ?1',
        )
        .bind(order.id)
        .all<{
          ticket_type_id: string;
          quantity: number;
          name: string;
          visibility: string;
          sales_open_at: string | null;
          sales_close_at: string | null;
        }>()
    ).results;
    if (lines.length === 0) {
      throw new ValidationError({ items: 'This order has no ticket lines.' });
    }

    const now = this.now();
    for (const line of lines) {
      if (line.visibility !== 'public') {
        throw new ConflictError('That ticket type is not on public sale.');
      }
      if (line.sales_open_at !== null && Date.parse(line.sales_open_at) > now.getTime()) {
        throw new ConflictError(`Sales for ${line.name} have not opened yet.`);
      }
      if (line.sales_close_at !== null && Date.parse(line.sales_close_at) <= now.getTime()) {
        throw new ConflictError(`Sales for ${line.name} have closed.`);
      }
    }

    const inventory = await createD1TicketInventoryService(this.db, this.now).publicInventory([
      order.event_id,
    ]);
    const available = new Map(
      (inventory.inventoryByEvent.get(order.event_id) ?? []).map((entry) => [
        entry.ticketType.id,
        entry.available,
      ]),
    );
    for (const line of lines) {
      const left = available.get(line.ticket_type_id) ?? 0;
      if (line.quantity > left) {
        throw new ConflictError(`Only ${left} left for ${line.name}.`);
      }
    }
  }

  /** The persisted paid_at, for reporting an already-paid order faithfully. */
  private async paidAtFor(orderId: string): Promise<string | undefined> {
    const row = await this.db
      .prepare('select paid_at from orders where id = ?1')
      .bind(orderId)
      .first<{ paid_at: string | null }>();
    return row?.paid_at ?? undefined;
  }

  private async loadOrder(orderId: string): Promise<OrderRow> {
    const row = await this.db
      .prepare(
        'select id, reference, event_id, status, total_in_pence, customer_email, reservation_expires_at from orders where id = ?1',
      )
      .bind(orderId)
      .first<OrderRow>();
    if (!row) throw new NotFoundError('That order does not exist.');
    return row;
  }

  /** A conditional, status-checked transition - never an unrestricted setter. */
  private async transition(
    orderId: string,
    to: 'cancelled' | 'expired',
    from: OrderStatus,
    action: string,
  ): Promise<void> {
    const order = await this.loadOrder(orderId);
    if (order.status === to) return;
    if (order.status !== from) {
      throw new ValidationError({ status: `An order in ${order.status} cannot become ${to}.` });
    }
    const at = this.stamp();
    const results = await this.db.batch([
      this.db
        .prepare('update orders set status = ?1, updated_at = ?2 where id = ?3 and status = ?4')
        .bind(to, at, orderId, from),
      this.audit(action, orderId, `${to === 'cancelled' ? 'Cancelled' : 'Expired'} ${order.reference}`, at),
    ]);
    if (((results[0]?.meta?.changes ?? 0) as number) === 0) {
      throw new ConflictError('This order changed. Reload and try again.');
    }
  }

  /** `AMP-YY-NNNNN`: London year, cryptographically random five digits. */
  private reference(): string {
    if (this.referenceSource) return this.referenceSource();
    const year = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      year: '2-digit',
    }).format(this.now());
    const random = crypto.getRandomValues(new Uint32Array(1))[0]! % 100_000;
    return `AMP-${year}-${String(random).padStart(5, '0')}`;
  }

  private audit(action: string, orderId: string, summary: string, at: string): D1PreparedStatement {
    // The actor is the checkout itself: no customer PII is written to audit.
    return this.db
      .prepare(AUDIT_SQL)
      .bind(this.newId('aud'), 'checkout', action, 'order', orderId, summary, at);
  }

  private stamp(): string {
    const value = Math.max(this.now().getTime(), this.lastStamp + 1);
    this.lastStamp = value;
    return new Date(value).toISOString();
  }
}

/**
 * The return URL must be absolute and http(s), and must come from the server.
 *
 * A relative path is not a programming style question here: SumUp rejects one,
 * and silently "fixing" it against a guessed origin would send customers back
 * to the wrong site. A bad value is a server misconfiguration, so it fails
 * before any provider call and therefore before any reservation exists.
 */
function assertAbsoluteReturnUrl(returnUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(returnUrl);
  } catch {
    throw new Error('The checkout return URL was not absolute.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('The checkout return URL was not an http(s) URL.');
  }
}

/**
 * The provider's expiry must be usable as the local reservation boundary.
 *
 * Two failures matter and neither may be papered over:
 *  - An unparseable timestamp would make SQLite's `julianday()` return NULL,
 *    so the hold would never count as active and the stock would leak.
 *  - An already-past expiry would reserve nothing for the same reason.
 *
 * Both are refused BEFORE the reservation is acquired, leaving the order
 * `pending` with no hold. Widening the local window to compensate is exactly
 * the second clock this slice removed, so it is deliberately not an option.
 */
function assertUsableProviderExpiry(expiresAt: string, now: Date): void {
  const parsed = Date.parse(expiresAt);
  if (!Number.isFinite(parsed)) {
    throw new Error('The payment provider returned an unusable checkout expiry.');
  }
  if (parsed <= now.getTime()) {
    throw new Error('The payment provider returned a checkout that had already expired.');
  }
}

/** Only the unique-reference failure is retried; other errors are surfaced. */
export function isReferenceCollision(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique constraint failed: orders\.reference/i.test(message);
}

/** Build the D1 order mutation service against a resolved binding. */
export function createD1OrderMutations(
  db: D1Database,
  clock?: () => Date,
  newId?: IdFactory,
  referenceSource?: () => string,
): OrderMutationService {
  return new D1OrderMutations(db, clock, newId, referenceSource);
}
