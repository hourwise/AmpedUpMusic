/**
 * Payment discrepancy persistence (AMPED-07D2-2).
 *
 * A discrepancy means exactly one thing:
 *
 *   authenticated provider evidence indicates SumUp may hold customer money
 *   which Amped Up cannot safely attach to the local order.
 *
 * It is not a refund, not an order state, and not an operational warning. It
 * is a financial exception that a human has to resolve, recorded durably so
 * that they can.
 *
 * Everything here is append-first: a discrepancy is inserted once and then
 * only touched (`last_checked_at`) or transitioned by an operator in a later
 * slice. Its event history is never rewritten or deleted, including after
 * resolution - the trail is the point.
 */

import type { OrderStatus } from '@/types/domain.ts';

/** What kind of money problem this is. */
export type DiscrepancyKind =
  /** The hold lapsed before we could credit a payment SumUp did take. */
  | 'paid_after_expiry'
  /** Same, but bookkeeping has already moved the order to `expired`. */
  | 'paid_order_expired'
  /** A completed payment whose amount does not match the order total. */
  | 'amount_mismatch'
  /** A completed payment we cannot attach for some other correlation reason. */
  | 'correlation_mismatch';

/**
 * `refund_*` are reserved by migration 0013 for the later in-app refund
 * slice. This slice writes only `open`; AMPED-07D2-3 adds the manual
 * outcomes. Nothing here may transition into a refund state, because no
 * refund operation exists yet and claiming otherwise would be a lie in the
 * financial record.
 */
export type DiscrepancyState =
  | 'open'
  | 'resolved_manually'
  | 'dismissed'
  | 'refund_requested'
  | 'refund_confirmed'
  | 'refund_failed';

export interface DiscrepancyRecord {
  identityKey: string;
  orderId: string;
  provider: string;
  checkoutId: string;
  transactionId: string | null;
  kind: DiscrepancyKind;
  providerAmountInPence: number | null;
  localAmountInPence: number;
  providerPaidAt: string | null;
  reservationExpiresAt: string;
}

/** One order the detector should ask the provider about. */
export interface DiscrepancyCandidate {
  orderId: string;
  reference: string;
  status: OrderStatus;
  paymentReference: string;
  totalInPence: number;
  reservationExpiresAt: string;
}

export interface RecordOutcome {
  /** True only when THIS call inserted the row. */
  created: boolean;
}

export interface DiscrepancyStore {
  listCandidates(input: {
    provider: string;
    now: Date;
    windowStart: Date;
    limit: number;
  }): Promise<DiscrepancyCandidate[]>;
  record(record: DiscrepancyRecord, now: Date): Promise<RecordOutcome>;
  touch(orderId: string, checkoutId: string, now: Date): Promise<void>;
}

/**
 * Deterministic business identity for a discrepancy.
 *
 * Two rules, in order:
 *
 *  1. Prefer the authenticated provider TRANSACTION. That is the identity of
 *     the money itself, and it is what a refund would later address.
 *  2. Otherwise fall back to our OWN stored checkout id. This covers the real
 *     and recurring case of a PAID checkout whose transaction list has not
 *     settled yet - there is money, but nothing yet names it.
 *
 * Both inputs are trustworthy: the checkout id comes from `payment_reference`
 * in our own database, never from a webhook body, and the transaction id
 * comes from an authenticated retrieval. Nothing attacker-supplied reaches
 * this function, and it is never random - a random key would deduplicate
 * nothing.
 */
export function discrepancyIdentityKey(input: {
  provider: string;
  checkoutId: string;
  transactionId: string | null;
}): string {
  return input.transactionId
    ? `${input.provider}_txn:${input.transactionId}`
    : `${input.provider}_checkout:${input.checkoutId}`;
}

type IdFactory = (prefix: string) => string;
const defaultId: IdFactory = (prefix) => `${prefix}_${crypto.randomUUID()}`;

const CANDIDATE_SQL =
  'select o.id, o.reference, o.status, o.payment_reference, o.total_in_pence, o.reservation_expires_at ' +
  'from orders o ' +
  'where o.payment_provider = ?1 ' +
  'and o.payment_reference is not null ' +
  "and o.status in ('awaiting_payment', 'expired') " +
  'and o.reservation_expires_at <= ?2 ' +
  'and o.reservation_expires_at > ?3 ' +
  'and not exists (select 1 from payment_discrepancies d where d.order_id = o.id) ' +
  'order by o.reservation_expires_at desc limit ?4';

class D1DiscrepancyStore implements DiscrepancyStore {
  constructor(
    private readonly db: D1Database,
    private readonly newId: IdFactory = defaultId,
  ) {}

  async listCandidates(input: {
    provider: string;
    now: Date;
    windowStart: Date;
    limit: number;
  }): Promise<DiscrepancyCandidate[]> {
    // `<=` on the upper bound is deliberate and matches the reservation
    // predicate used everywhere else: a hold is active only while
    // `reservation_expires_at > now`, so the exact timestamp is already
    // lapsed and already a candidate.
    //
    // Timestamps are CHECK-constrained to one canonical ISO-8601 UTC format,
    // so string comparison both orders correctly and stays sargable against
    // the accepted 0010 index.
    const rows = await this.db
      .prepare(CANDIDATE_SQL)
      .bind(
        input.provider,
        input.now.toISOString(),
        input.windowStart.toISOString(),
        input.limit,
      )
      .all<{
        id: string;
        reference: string;
        status: OrderStatus;
        payment_reference: string;
        total_in_pence: number;
        reservation_expires_at: string;
      }>();

    return rows.results.map((row) => ({
      orderId: row.id,
      reference: row.reference,
      status: row.status,
      paymentReference: row.payment_reference,
      totalInPence: row.total_in_pence,
      reservationExpiresAt: row.reservation_expires_at,
    }));
  }

  async record(record: DiscrepancyRecord, now: Date): Promise<RecordOutcome> {
    const at = now.toISOString();
    const id = this.newId('pdx');

    // Guarded insert plus TWO unique indexes, because they stop different
    // things. `not exists` stops a sequential re-identification (the same
    // money seen first without a transaction id and later with one, which
    // would otherwise carry a different identity_key). The unique indexes
    // stop concurrent inserts that both passed that check. Neither alone is
    // sufficient; `on conflict do nothing` makes the loser harmless rather
    // than an exception.
    const results = await this.db.batch([
      this.db
        .prepare(
          'insert into payment_discrepancies (' +
            'id, identity_key, order_id, provider, checkout_id, transaction_id, kind, ' +
            'provider_amount_in_pence, local_amount_in_pence, provider_paid_at, ' +
            'reservation_expires_at, state, detected_at, last_checked_at' +
            ') select ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13 ' +
            'where not exists (' +
            '  select 1 from payment_discrepancies where order_id = ?3 and checkout_id = ?5' +
            ') on conflict do nothing',
        )
        .bind(
          id,
          record.identityKey,
          record.orderId,
          record.provider,
          record.checkoutId,
          record.transactionId,
          record.kind,
          record.providerAmountInPence,
          record.localAmountInPence,
          record.providerPaidAt,
          record.reservationExpiresAt,
          'open',
          at,
        ),
      // Guarded on the row this statement just wrote, so a losing concurrent
      // attempt contributes no event. History records what happened, not how
      // many processes noticed.
      this.db
        .prepare(
          'insert into payment_discrepancy_events (id, discrepancy_id, event, actor, occurred_at, detail) ' +
            "select ?1, ?2, 'detected', ?3, ?4, ?5 " +
            'where exists (select 1 from payment_discrepancies where id = ?2)',
        )
        .bind(
          this.newId('pde'),
          id,
          `system:${record.provider}-reconcile`,
          at,
          record.kind,
        ),
    ]);

    return { created: ((results[0]?.meta?.changes ?? 0) as number) === 1 };
  }

  async touch(orderId: string, checkoutId: string, now: Date): Promise<void> {
    // Only the timestamp. Re-observing the same unresolved problem is not new
    // information, and writing an event every five minutes would bury the one
    // event that matters under a scrolling wall of identical noise.
    await this.db
      .prepare(
        'update payment_discrepancies set last_checked_at = ?1 ' +
          'where order_id = ?2 and checkout_id = ?3',
      )
      .bind(now.toISOString(), orderId, checkoutId)
      .run();
  }
}

export function createD1DiscrepancyStore(
  db: D1Database,
  newId?: IdFactory,
): DiscrepancyStore {
  return new D1DiscrepancyStore(db, newId);
}

/** Exported for query-plan tests; the detector never builds SQL itself. */
export const DISCREPANCY_CANDIDATE_SQL = CANDIDATE_SQL;
