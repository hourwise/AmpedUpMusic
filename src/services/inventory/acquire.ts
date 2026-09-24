/**
 * Authoritative reservation acquisition (AMPED-06C).
 *
 * The final capacity gate is ONE conditional database mutation: it transitions
 * a pending order to awaiting_payment only if every line of the basket still
 * fits at the instant SQLite executes the statement. The order's quantities are
 * aggregated by ticket type first, so duplicate order_item rows cannot slip
 * through, and commercial inventory is derived from orders/order_items exactly
 * as AMPED-06B0 defined it - never from ticket rows and never from a counter.
 *
 * The 06B advisory reads remain for early, friendly failures; they are not the
 * stock authority. A migration-level trigger (0011) independently repeats the
 * same predicate as the database-level second line of defence, and raw SQL that
 * bypasses this service is refused with the stable `inventory_capacity_exceeded`
 * marker.
 *
 * There is deliberately no application lock of any kind: Workers are
 * distributed, so only D1 can arbitrate.
 */

import { ConflictError } from '@/lib/validation.ts';

/** Stable marker raised by the 0011 trigger; mapped to an inventory conflict. */
export const INVENTORY_CAPACITY_MARKER = 'inventory_capacity_exceeded';

/** One atomic transition: pending -> awaiting_payment iff the basket fits. */
export const ACQUIRE_RESERVATION_SQL =
  'update orders set ' +
  "status = 'awaiting_payment', reservation_expires_at = ?1, payment_provider = ?2, " +
  'payment_reference = ?3, updated_at = ?4 ' +
  "where id = ?5 and status = 'pending' " +
  'and exists (select 1 from order_items oi where oi.order_id = ?5) ' +
  'and not exists ( ' +
  '  select 1 from ( ' +
  '    select oi.ticket_type_id as ticket_type_id, sum(oi.quantity) as requested ' +
  '    from order_items oi where oi.order_id = ?5 group by oi.ticket_type_id ' +
  '  ) req ' +
  '  join ticket_types tt on tt.id = req.ticket_type_id ' +
  '  where req.requested > tt.capacity ' +
  '    - coalesce(( ' +
  '        select sum(s.quantity) from order_items s ' +
  '        join orders so on so.id = s.order_id ' +
  "        where s.ticket_type_id = tt.id and so.status in ('paid', 'partially_refunded') " +
  '      ), 0) ' +
  '    - coalesce(( ' +
  '        select sum(r.quantity) from order_items r ' +
  '        join orders ro on ro.id = r.order_id ' +
  "        where r.ticket_type_id = tt.id and ro.status = 'awaiting_payment' " +
  '          and julianday(ro.reservation_expires_at) > julianday(?4) ' +
  '      ), 0) ' +
  ')';

export interface AcquireReservationInput {
  orderId: string;
  /** The single canonical logical now, also written to updated_at. */
  now: Date;
  /** Canonical reservation expiry, derived from the same logical now. */
  expiresAt: string;
  provider: string;
  reference: string;
}

export type AcquireFailureReason = 'inventory' | 'stale';

export interface AcquireReservationResult {
  acquired: boolean;
  reason?: AcquireFailureReason;
}

export interface InventoryReservationService {
  acquireReservation(input: AcquireReservationInput): Promise<AcquireReservationResult>;
}

/** True only for the stable 0011 capacity marker - never any other constraint. */
export function isInventoryCapacityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(INVENTORY_CAPACITY_MARKER);
}

class D1InventoryReservations implements InventoryReservationService {
  constructor(private readonly db: D1Database) {}

  async acquireReservation(input: AcquireReservationInput): Promise<AcquireReservationResult> {
    const at = input.now.toISOString();

    let changes: number;
    try {
      const result = await this.db
        .prepare(ACQUIRE_RESERVATION_SQL)
        .bind(input.expiresAt, input.provider, input.reference, at, input.orderId)
        .run();
      changes = (result.meta?.changes ?? 0) as number;
    } catch (error) {
      // The trigger refused the transition: the basket no longer fits.
      if (isInventoryCapacityError(error)) return { acquired: false, reason: 'inventory' };
      throw error;
    }

    if (changes === 1) return { acquired: true };

    // Zero rows: diagnose only (no further write). A still-pending order means
    // the capacity predicate was the reason; anything else is a stale state.
    const row = await this.db
      .prepare('select status from orders where id = ?1')
      .bind(input.orderId)
      .first<{ status: string }>();
    if (row?.status === 'pending') return { acquired: false, reason: 'inventory' };
    return { acquired: false, reason: 'stale' };
  }
}

/** Build the inventory reservation service against a resolved binding. */
export function createD1InventoryReservations(db: D1Database): InventoryReservationService {
  return new D1InventoryReservations(db);
}

/** Controlled customer-facing conflict for a failed acquisition. */
export function inventoryConflict(reason: AcquireFailureReason | undefined): ConflictError {
  return reason === 'stale'
    ? new ConflictError('This order changed while payment was starting. Reload and try again.')
    : new ConflictError('Those tickets are no longer available.');
}
