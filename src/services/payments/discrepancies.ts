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

export interface EnrichOutcome {
  /** True only when THIS call attached the transaction evidence. */
  enriched: boolean;
}

/** Stronger authenticated evidence for a discrepancy we already recorded. */
export interface DiscrepancyEvidence {
  orderId: string;
  checkoutId: string;
  transactionId: string;
  providerPaidAt: string | null;
  providerAmountInPence: number | null;
}

export interface DiscrepancyStore {
  listCandidates(input: {
    provider: string;
    now: Date;
    windowStart: Date;
    limit: number;
  }): Promise<DiscrepancyCandidate[]>;
  record(record: DiscrepancyRecord, now: Date): Promise<RecordOutcome>;
  /**
   * Attach a transaction identity that was not available when the row was
   * first written. Evidence only: it can never change `state`, `kind` or
   * `resolved_at`, so a resolved discrepancy cannot be silently reopened by
   * a later observation.
   */
  enrich(evidence: DiscrepancyEvidence, now: Date): Promise<EnrichOutcome>;
  touch(orderId: string, checkoutId: string, now: Date): Promise<void>;
  /** How many still need an operator. Drives the admin badge. */
  countOpen(): Promise<number>;
  /** Newest-detected first within each group. */
  list(state: 'open' | 'resolved', limit: number): Promise<DiscrepancyView[]>;
  /**
   * `open -> resolved_manually`, by an authenticated operator.
   *
   * An attestation that the money was dealt with in SumUp - NOT proof that a
   * refund happened, and never a change to the order.
   */
  resolveManually(id: string, actor: string, now: Date): Promise<ResolutionOutcome>;
  /**
   * `resolved_manually -> open`, for a resolution recorded in error.
   *
   * A financial record must not be a one-way door: an operator who clicks the
   * wrong row should be able to put it back in the queue. The original
   * detection and resolution events are kept - reopening appends, it does not
   * erase what was said before.
   */
  reopen(id: string, actor: string, now: Date): Promise<ReopenOutcome>;
}

/** One discrepancy as an operator needs to read it. No PII, no provider body. */
export interface DiscrepancyView {
  id: string;
  orderReference: string;
  orderStatus: OrderStatus;
  kind: DiscrepancyKind;
  state: DiscrepancyState;
  providerAmountInPence: number | null;
  localAmountInPence: number;
  providerPaidAt: string | null;
  reservationExpiresAt: string;
  transactionId: string | null;
  detectedAt: string;
  lastCheckedAt: string;
  resolvedAt: string | null;
}

export type ResolutionOutcome =
  | { outcome: 'resolved'; resolvedAt: string }
  /** Someone already did it. Idempotent, and writes no second event. */
  | { outcome: 'already-resolved' }
  | { outcome: 'not-found' };

export type ReopenOutcome =
  | { outcome: 'reopened' }
  /** Already back in the queue. Idempotent, and writes no second event. */
  | { outcome: 'already-open' }
  | { outcome: 'not-found' };

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
  // Exclude only FULLY IDENTIFIED discrepancies. A row recorded from the
  // checkout fallback still has no transaction naming the money, so it
  // stays a candidate until that settles - otherwise the first
  // observation would freeze the record forever with weaker evidence
  // than SumUp can now give us. Once `transaction_id` is set there is
  // nothing left to learn and the order stops costing provider calls.
  'and not exists (' +
  '  select 1 from payment_discrepancies d ' +
  '  where d.order_id = o.id and d.transaction_id is not null' +
  ') ' +
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

  async enrich(evidence: DiscrepancyEvidence, now: Date): Promise<EnrichOutcome> {
    const at = now.toISOString();

    // EVIDENCE ONLY. `state`, `kind` and `resolved_at` are untouched, so an
    // already-resolved discrepancy can gain the transaction that names its
    // money without being silently reopened.
    //
    // `transaction_id is null` is the exactly-once gate: of N concurrent
    // observations only one sees a null and reports `enriched`.
    const update = await this.db
      .prepare(
        'update payment_discrepancies set ' +
          'transaction_id = ?1, ' +
          'provider_paid_at = coalesce(?2, provider_paid_at), ' +
          'provider_amount_in_pence = coalesce(?3, provider_amount_in_pence), ' +
          'last_checked_at = ?4 ' +
          'where order_id = ?5 and checkout_id = ?6 and transaction_id is null',
      )
      .bind(
        evidence.transactionId,
        evidence.providerPaidAt,
        evidence.providerAmountInPence,
        at,
        evidence.orderId,
        evidence.checkoutId,
      )
      .run();

    if (((update.meta?.changes ?? 0) as number) !== 1) return { enriched: false };

    // Written as a SEPARATE statement, deliberately. Batching it would mean
    // guarding on the row's final state - and that state looks identical
    // whether this call enriched the row or merely arrived after someone
    // else did, which produced a history entry claiming a transaction had
    // just been identified when it had been known all along.
    //
    // The cost is that a crash between the two leaves enriched evidence with
    // no history line. That is acceptable: enrichment is evidence, not a
    // state transition, and the row will not be re-enriched because
    // `transaction_id` is now set - so it cannot double-count either way.
    await this.db
      .prepare(
        'insert into payment_discrepancy_events (id, discrepancy_id, event, actor, occurred_at, detail) ' +
          "select ?1, d.id, 'evidence_enriched', ?2, ?3, 'transaction identified' " +
          'from payment_discrepancies d ' +
          'where d.order_id = ?4 and d.checkout_id = ?5 ' +
          'and not exists (' +
          '  select 1 from payment_discrepancy_events e ' +
          "  where e.discrepancy_id = d.id and e.event = 'evidence_enriched'" +
          ')',
      )
      .bind(this.newId('pde'), 'system:sumup-reconcile', at, evidence.orderId, evidence.checkoutId)
      .run();

    return { enriched: true };
  }

  async countOpen(): Promise<number> {
    const row = await this.db
      .prepare("select count(*) as n from payment_discrepancies where state = 'open'")
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  async list(state: 'open' | 'resolved', limit: number): Promise<DiscrepancyView[]> {
    // Open first by OLDEST detection: the longest-unresolved money is the
    // most urgent. Resolved history reads newest-first, which is how anyone
    // actually looks back at it.
    const predicate =
      state === 'open'
        ? "d.state = 'open' order by d.detected_at asc"
        : "d.state <> 'open' order by coalesce(d.resolved_at, d.detected_at) desc";

    const rows = await this.db
      .prepare(
        'select d.id, d.kind, d.state, d.provider_amount_in_pence, d.local_amount_in_pence, ' +
          'd.provider_paid_at, d.reservation_expires_at, d.transaction_id, d.detected_at, ' +
          'd.last_checked_at, d.resolved_at, o.reference as order_reference, o.status as order_status ' +
          'from payment_discrepancies d join orders o on o.id = d.order_id ' +
          `where ${predicate} limit ?1`,
      )
      .bind(limit)
      .all<Record<string, unknown>>();

    return rows.results.map((row) => ({
      id: String(row.id),
      orderReference: String(row.order_reference),
      orderStatus: row.order_status as OrderStatus,
      kind: row.kind as DiscrepancyKind,
      state: row.state as DiscrepancyState,
      providerAmountInPence:
        row.provider_amount_in_pence === null ? null : Number(row.provider_amount_in_pence),
      localAmountInPence: Number(row.local_amount_in_pence),
      providerPaidAt: row.provider_paid_at === null ? null : String(row.provider_paid_at),
      reservationExpiresAt: String(row.reservation_expires_at),
      transactionId: row.transaction_id === null ? null : String(row.transaction_id),
      detectedAt: String(row.detected_at),
      lastCheckedAt: String(row.last_checked_at),
      resolvedAt: row.resolved_at === null ? null : String(row.resolved_at),
    }));
  }

  async resolveManually(id: string, actor: string, now: Date): Promise<ResolutionOutcome> {
    const at = now.toISOString();

    // The conditional update IS the exactly-once gate. Two operators clicking
    // at the same instant produce one transition, one `resolved_at` and one
    // event - enforced by D1, not by a disabled button.
    const results = await this.db.batch([
      this.db
        .prepare(
          "update payment_discrepancies set state = 'resolved_manually', resolved_at = ?1 " +
            "where id = ?2 and state = 'open'",
        )
        .bind(at, id),
      // Guarded on the row this statement just moved, so the loser of a race
      // contributes no second entry to the financial history.
      this.db
        .prepare(
          'insert into payment_discrepancy_events (id, discrepancy_id, event, actor, occurred_at, detail) ' +
            "select ?1, ?2, 'resolved_manually', ?3, ?4, " +
            "'Operator states the payment was dealt with in SumUp. No refund was sent by Amped Up.' " +
            'where exists (' +
            "  select 1 from payment_discrepancies where id = ?2 and state = 'resolved_manually' " +
            '  and resolved_at = ?4' +
            ')',
        )
        .bind(this.newId('pde'), id, actor, at),
    ]);

    if (((results[0]?.meta?.changes ?? 0) as number) === 1) {
      return { outcome: 'resolved', resolvedAt: at };
    }

    const current = await this.db
      .prepare('select state from payment_discrepancies where id = ?1')
      .bind(id)
      .first<{ state: string }>();
    if (!current) return { outcome: 'not-found' };
    return { outcome: 'already-resolved' };
  }

  async reopen(id: string, actor: string, now: Date): Promise<ReopenOutcome> {
    const at = now.toISOString();

    // Only a manually resolved row can be reopened, and only from that exact
    // state - so this can never drag a future refund state backwards.
    const results = await this.db.batch([
      this.db
        .prepare(
          "update payment_discrepancies set state = 'open', resolved_at = null " +
            "where id = ?1 and state = 'resolved_manually'",
        )
        .bind(id),
      this.db
        .prepare(
          'insert into payment_discrepancy_events (id, discrepancy_id, event, actor, occurred_at, detail) ' +
            "select ?1, ?2, 'reopened', ?3, ?4, 'Returned to the queue by an operator.' " +
            'where exists (' +
            "  select 1 from payment_discrepancies where id = ?2 and state = 'open' and resolved_at is null" +
            ') and (' +
            // Each resolution can be followed by at most one reopen. Counting
            // the pair is what makes this exactly-once: deduping on the new
            // event's own timestamp would not, because concurrent callers
            // each carry a different one. The history is append-only, so the
            // counts are a faithful record of how many cycles have happened.
            "  select count(*) from payment_discrepancy_events where discrepancy_id = ?2 and event = 'reopened'" +
            ') < (' +
            "  select count(*) from payment_discrepancy_events where discrepancy_id = ?2 and event = 'resolved_manually'" +
            ')',
        )
        .bind(this.newId('pde'), id, actor, at),
    ]);

    if (((results[0]?.meta?.changes ?? 0) as number) === 1) return { outcome: 'reopened' };

    const current = await this.db
      .prepare('select state from payment_discrepancies where id = ?1')
      .bind(id)
      .first<{ state: string }>();
    if (!current) return { outcome: 'not-found' };
    return { outcome: 'already-open' };
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
