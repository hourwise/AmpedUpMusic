/**
 * Bounded payment-discrepancy detection (AMPED-07D2-2).
 *
 * THE POLICY THIS ENFORCES
 * Once `reservation_expires_at` has passed, the seats are back on sale -
 * availability is computed against the reading request's clock, not against
 * whether the bookkeeping sweep has run. So the order can never afterwards
 * become `paid`, no matter when the provider says the money moved. That rule
 * protects the room from being sold twice, and this module exists to make
 * sure it does not quietly cost a customer their money instead.
 *
 * THE QUESTION IT ASKS
 * Not "did this fail?" but:
 *
 *   does authenticated provider evidence indicate SumUp may hold customer
 *   money which we cannot safely attach to the local order?
 *
 * The discriminator is a SUCCESSFUL transaction, or a PAID checkout whose
 * transaction list has not settled. Everything else - PENDING, an ordinary
 * decline, an expired checkout nobody paid, a timeout, a malformed webhook -
 * is an operational condition and gets no financial record. Recording those
 * would bury the handful of rows that represent real money.
 *
 * WHAT IT CANNOT DO
 * It never writes an order. It has no access to `applyVerifiedPayment` and
 * creates no path to `paid`. It reuses the AMPED-07C1 verifier rather than
 * re-implementing correlation, and takes its candidates from our own database
 * rather than from any webhook payload.
 */

import type {
  DiscrepancyKind,
  DiscrepancyStore,
} from './discrepancies.ts';
import { discrepancyIdentityKey } from './discrepancies.ts';
import type {
  CorrelationFailure,
  ProviderPaymentEvidence,
  SumUpPaymentVerifier,
} from './sumup/verification.ts';

/**
 * How far back a run looks.
 *
 * Derived from the lifecycle, not convenience: a hold lasts 30 minutes and
 * the scheduler ticks every 5, so this window gives each lapsed order about
 * six opportunities to be examined - the same budget a live hold gets from
 * ordinary reconciliation. That is ample tolerance for a missed tick or a
 * short outage while staying firmly bounded.
 *
 * It is NOT longer, because a payment cannot happen after the checkout's own
 * `valid_until` (which is the same instant as the local expiry, by the
 * AMPED-07B single-clock rule). By the time the window closes, everything
 * that could have been paid already has been. A wider window would re-probe
 * long-abandoned checkouts forever and buy nothing.
 */
export const DISCREPANCY_WINDOW_MINUTES = 30;

/** Hard per-run cap, matching the reconciliation batch for the same reasons. */
export const DISCREPANCY_BATCH_SIZE = 20;

/** Simultaneous provider retrievals. Deliberately small. */
export const DISCREPANCY_CONCURRENCY = 4;

export interface DiscrepancyDetectionSummary {
  examined: number;
  /** New discrepancy rows written by this run. */
  created: number;
  /** Already recorded; only `last_checked_at` moved. */
  alreadyRecorded: number;
  /** Already recorded, and this run attached the transaction that names it. */
  enriched: number;
  /** Provider holds nothing. Nothing to record. */
  clear: number;
  /** Could not reach SumUp. Nothing decided, nothing written. */
  retrievalFailures: number;
}

export interface DiscrepancyDetectionOptions {
  store: DiscrepancyStore;
  verifier: SumUpPaymentVerifier;
  now?: () => Date;
  windowMinutes?: number;
  batchSize?: number;
  concurrency?: number;
  log?: (event: string, detail?: Record<string, string | number>) => void;
}

const emptySummary = (): DiscrepancyDetectionSummary => ({
  examined: 0,
  created: 0,
  alreadyRecorded: 0,
  enriched: 0,
  clear: 0,
  retrievalFailures: 0,
});

async function mapBounded<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/**
 * Does this evidence mean SumUp may be holding money?
 *
 * A settled SUCCESSFUL transaction is the clear signal. A PAID checkout with
 * no settled transaction is the awkward one: SumUp says the checkout is paid,
 * so the money has almost certainly moved even though nothing yet names the
 * transaction. Treating that as "nothing to see" would lose real money, so it
 * counts - and the identity key falls back to the checkout id for it.
 */
function holdsMoney(evidence: ProviderPaymentEvidence): boolean {
  return evidence.transactionId !== null || evidence.status === 'PAID';
}

export async function detectPaymentDiscrepancies(
  options: DiscrepancyDetectionOptions,
): Promise<DiscrepancyDetectionSummary> {
  const now = options.now ?? (() => new Date());
  const windowMinutes = options.windowMinutes ?? DISCREPANCY_WINDOW_MINUTES;
  const batchSize = options.batchSize ?? DISCREPANCY_BATCH_SIZE;
  const concurrency = options.concurrency ?? DISCREPANCY_CONCURRENCY;
  const log =
    options.log ??
    ((event, detail) =>
      console.warn(JSON.stringify({ at: 'sumup-discrepancy', event, ...detail })));

  const at = now();
  const candidates = await options.store.listCandidates({
    provider: 'sumup',
    now: at,
    windowStart: new Date(at.getTime() - windowMinutes * 60_000),
    limit: batchSize,
  });

  const summary = emptySummary();
  summary.examined = candidates.length;
  if (candidates.length === 0) return summary;

  await mapBounded(candidates, concurrency, async (candidate) => {
    try {
      // The SAME verifier the webhook and the reconciler use. It correlates
      // against the local order itself, so nothing here re-implements the
      // checks that decide whether money belongs to this customer.
      const outcome = await options.verifier.verify(candidate.paymentReference);

      if (outcome.kind === 'retrieval-failed') {
        summary.retrievalFailures += 1;
        return;
      }
      if (outcome.kind === 'unknown-checkout') {
        // The candidate came from our own table, so the order changed
        // underneath this run. Harmless; the next pass re-reads.
        summary.clear += 1;
        return;
      }
      if (!holdsMoney(outcome.evidence)) {
        // PENDING, an ordinary decline, or a checkout that simply expired
        // unpaid. No money, no financial record.
        summary.clear += 1;
        return;
      }

      const kind = classify(
        outcome.kind === 'mismatch' ? outcome.reason : null,
        candidate.status,
      );
      const identityKey = discrepancyIdentityKey({
        provider: 'sumup',
        checkoutId: candidate.paymentReference,
        transactionId: outcome.evidence.transactionId,
      });

      const { created } = await options.store.record(
        {
          identityKey,
          orderId: candidate.orderId,
          provider: 'sumup',
          checkoutId: candidate.paymentReference,
          transactionId: outcome.evidence.transactionId,
          kind,
          providerAmountInPence: outcome.evidence.amountInPence,
          localAmountInPence: candidate.totalInPence,
          providerPaidAt: outcome.evidence.paidAt,
          reservationExpiresAt: candidate.reservationExpiresAt,
        },
        at,
      );

      if (created) {
        summary.created += 1;
        log('discrepancy-detected', { order: candidate.reference, kind });
        return;
      }

      // Already recorded. If the row was written from the checkout fallback
      // and SumUp can now name the transaction, attach it: the record should
      // be as authoritative as the newest authenticated observation, and a
      // refund would later be addressed to that transaction. This enriches
      // the EXISTING row - a second financial record for the same money
      // would be worse than weaker evidence.
      if (outcome.evidence.transactionId !== null) {
        const { enriched } = await options.store.enrich(
          {
            orderId: candidate.orderId,
            checkoutId: candidate.paymentReference,
            transactionId: outcome.evidence.transactionId,
            providerPaidAt: outcome.evidence.paidAt,
            providerAmountInPence: outcome.evidence.amountInPence,
          },
          at,
        );
        if (enriched) {
          summary.enriched += 1;
          log('discrepancy-enriched', { order: candidate.reference });
          return;
        }
      }

      summary.alreadyRecorded += 1;
      await options.store.touch(candidate.orderId, candidate.paymentReference, at);
    } catch (error) {
      // One bad candidate must never strand the batch.
      summary.retrievalFailures += 1;
      log('candidate-failed', {
        order: candidate.reference,
        kind: error instanceof Error ? error.name : 'unknown',
      });
    }
  });

  return summary;
}

/** Which flavour of money problem this is, from authenticated facts only. */
function classify(
  reason: CorrelationFailure | null,
  localStatus: string,
): DiscrepancyKind {
  if (reason !== null) {
    // The correlation itself failed, so the money cannot be attached for a
    // reason other than timing. A price disagreement is called out
    // separately because it is the one an operator can act on immediately.
    return reason === 'amount-mismatch' || reason === 'amount-malformed'
      ? 'amount_mismatch'
      : 'correlation_mismatch';
  }
  // A correlated payment, or a PAID checkout still settling, against an order
  // whose hold has gone. The only distinction left is whether bookkeeping has
  // caught up - which changes how the row reads to an operator, not the
  // money. Correctness does not depend on which it is.
  return localStatus === 'expired' ? 'paid_order_expired' : 'paid_after_expiry';
}
