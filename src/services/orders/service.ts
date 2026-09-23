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
import { CHECKOUT_WINDOW_MINUTES } from '../payments/mock.ts';

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

export interface OrderMutationService {
  createOrder(input: CheckoutInput): Promise<CreatedOrder>;
  beginPayment(orderId: string, provider: PaymentProvider): Promise<BegunPayment>;
  /** The ONLY path into `paid`. */
  confirmPayment(
    orderId: string,
    checkoutId: string,
    provider: PaymentProvider,
  ): Promise<ConfirmedPayment>;
  cancelOrder(orderId: string): Promise<void>;
  expireOrder(orderId: string): Promise<void>;
}

type IdFactory = (prefix: string) => string;
const defaultId: IdFactory = (prefix) => `${prefix}_${crypto.randomUUID()}`;

const PUBLIC_EVENT_STATUS_SQL = "status in ('published', 'postponed', 'cancelled', 'completed')";
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
}

interface OrderRow {
  id: string;
  reference: string;
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
      .prepare(`select status from events where id = ?1 and ${PUBLIC_EVENT_STATUS_SQL}`)
      .bind(input.eventId)
      .first<{ status: string }>();
    if (!event) throw new NotFoundError('That gig is not taking orders.');

    // Authoritative ticket definitions: price and name are captured here.
    const captured: Array<{ ticketTypeId: string; quantity: number; name: string; price: number }> = [];
    for (const item of items) {
      const row = await this.db
        .prepare(
          'select id, event_id, name, price_in_pence, visibility from ticket_types where id = ?1',
        )
        .bind(item.ticketTypeId)
        .first<TicketTypeRow>();
      if (!row || row.event_id !== input.eventId || row.visibility !== 'public') {
        throw new NotFoundError('That ticket type is not on sale for this gig.');
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

  async beginPayment(orderId: string, provider: PaymentProvider): Promise<BegunPayment> {
    const order = await this.loadOrder(orderId);
    if (order.status === 'awaiting_payment') {
      throw new ConflictError('Payment for this order has already started.');
    }
    if (order.status !== 'pending') {
      throw new ValidationError({ status: `An order in ${order.status} cannot start payment.` });
    }

    const checkout = await provider.createCheckout({
      orderId: order.id,
      reference: order.reference,
      amountInPence: order.total_in_pence,
      currency: 'GBP',
      customerEmail: order.customer_email,
      returnUrl: '/checkout/return',
    });

    const at = this.stamp();
    const reservationExpiresAt = new Date(
      this.now().getTime() + CHECKOUT_WINDOW_MINUTES * 60_000,
    ).toISOString();

    const results = await this.db.batch([
      this.db
        .prepare(
          "update orders set status = 'awaiting_payment', reservation_expires_at = ?1, payment_provider = ?2, payment_reference = ?3, updated_at = ?4 where id = ?5 and status = 'pending'",
        )
        .bind(reservationExpiresAt, provider.name, checkout.checkoutId, at, orderId),
      this.audit('order.awaiting_payment', orderId, `Started payment for ${order.reference}`, at),
    ]);
    if (((results[0]?.meta?.changes ?? 0) as number) === 0) {
      throw new ConflictError('This order changed while payment was starting. Reload and try again.');
    }

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

    const result = await provider.confirm(checkoutId);

    if (result.status === 'pending') {
      return { orderId, status: 'awaiting_payment' };
    }

    if (result.status === 'failed') {
      // Documented graph: awaiting_payment --expired/failed--> expired.
      const at = this.stamp();
      await this.db.batch([
        this.db
          .prepare(
            "update orders set status = 'expired', updated_at = ?1 where id = ?2 and status = 'awaiting_payment'",
          )
          .bind(at, orderId),
        this.audit('order.expired', orderId, `Payment failed for ${order.reference}`, at),
      ]);
      return { orderId, status: 'expired' };
    }

    const paidAt = result.paidAt ?? this.now().toISOString();
    const at = this.stamp();
    const results = await this.db.batch([
      this.db
        .prepare(
          "update orders set status = 'paid', paid_at = ?1, updated_at = ?2 where id = ?3 and status = 'awaiting_payment'",
        )
        .bind(paidAt, at, orderId),
      this.audit('order.paid', orderId, `Paid ${order.reference}`, at),
    ]);

    if (((results[0]?.meta?.changes ?? 0) as number) === 0) {
      const current = await this.loadOrder(orderId);
      if (current.status === 'paid') return { orderId, status: 'paid' };
      throw new ConflictError('This order changed while payment was confirming.');
    }

    return { orderId, status: 'paid', paidAt };
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.transition(orderId, 'cancelled', 'pending', 'order.cancelled');
  }

  async expireOrder(orderId: string): Promise<void> {
    await this.transition(orderId, 'expired', 'awaiting_payment', 'order.expired');
  }

  // -- helpers -------------------------------------------------------------

  private normaliseItems(items: ReadonlyArray<CheckoutItemInput>): CheckoutItemInput[] {
    if (items.length === 0) throw new ValidationError({ items: 'Choose at least one ticket.' });
    if (items.length > 10) throw new ValidationError({ items: 'Too many ticket types in one order.' });
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

  private async loadOrder(orderId: string): Promise<OrderRow> {
    const row = await this.db
      .prepare(
        'select id, reference, status, total_in_pence, customer_email, reservation_expires_at from orders where id = ?1',
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
