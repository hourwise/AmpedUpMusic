/**
 * Scheduled payment reconciliation (AMPED-07D).
 *
 * WHY THIS EXISTS
 * AMPED-07C1 confirms payments from SumUp's webhook. Webhooks are delayed,
 * dropped, retried into the void, or simply never delivered because the
 * callback URL was wrong, unreachable, or not yet configured. Without a
 * second way to notice, a customer who genuinely paid would sit in
 * `awaiting_payment` until their hold lapsed and their tickets went back on
 * sale. That is the failure this module exists to prevent.
 *
 * WHAT IT IS NOT
 * It is NOT a second payment authority. It discovers candidates, asks the
 * SAME 07C1 verifier, and hands any verified payment to the SAME
 * `applyVerifiedPayment` primitive. There is deliberately no SQL here, no
 * correlation logic here, and no transition here - exactly one statement in
 * the application can set an order to `paid`, and it is not in this file.
 *
 * ORDERING MATTERS
 * The scheduled run reconciles BEFORE it expires holds. The other order would
 * be quietly destructive: a paid-but-unnotified order whose window has just
 * closed would be expired and its stock resold, moments before the reconciler
 * would have rescued it. Paying first and expiring second costs nothing and
 * closes that gap.
 *
 * RATE
 * A bounded batch and a small concurrency cap, because this runs on a timer
 * against someone else's API. A reconciler that stampedes SumUp every five
 * minutes is its own kind of outage.
 */

import type {
  OrderMutationService,
  ReconciliationCandidate,
} from '../orders/service.ts';
import type { TicketIssuanceService } from '../tickets/issuance.ts';
import type { SumUpPaymentVerifier } from './sumup/verification.ts';

/**
 * Orders examined per run.
 *
 * With the accepted 30-minute hold and the existing five-minute cron, an
 * order gets roughly six attempts before it expires, so this is a per-run
 * cap rather than a limit on how much can ever be recovered. Candidates are
 * taken soonest-expiry-first, so the most urgent are never starved.
 */
export const RECONCILIATION_BATCH_SIZE = 20;

/**
 * Simultaneous SumUp retrievals.
 *
 * Deliberately small. Each retrieval already carries its own timeout and
 * bounded retries inside the accepted client, so the risk being managed here
 * is burst load on the provider, not latency.
 */
export const RECONCILIATION_CONCURRENCY = 4;

/**
 * What one run did. Counters only - no order ids, no customer data, no
 * provider payloads, nothing an attacker could have influenced.
 */
export interface ReconciliationSummary {
  examined: number;
  /** Verified and transitioned to paid by THIS run. */
  paid: number;
  /** Verified, but another path had already paid it. */
  alreadyPaid: number;
  /** Provider says not paid yet (PENDING / FAILED / EXPIRED). */
  unchanged: number;
  /** Could not reach or read SumUp. Nothing was decided. */
  retrievalFailures: number;
  /** Provider said PAID but the checkout did not match the local order. */
  verificationFailures: number;
  /**
   * Verified PAID, but the order could no longer accept it - the sweep won
   * first. A real money discrepancy for an operator, never auto-resolved.
   */
  discrepancies: number;
  /** Payment was recorded, but immediate ticket fulfilment needs recovery. */
  fulfilmentFailures: number;
}

export interface ReconciliationOptions {
  orders: OrderMutationService;
  verifier: SumUpPaymentVerifier;
  fulfilment?: TicketIssuanceService;
  now?: () => Date;
  batchSize?: number;
  concurrency?: number;
  /** Operational logging seam; defaults to console. Never audit, never PII. */
  log?: (event: string, detail?: Record<string, string | number>) => void;
}

const emptySummary = (): ReconciliationSummary => ({
  examined: 0,
  paid: 0,
  alreadyPaid: 0,
  unchanged: 0,
  retrievalFailures: 0,
  verificationFailures: 0,
  discrepancies: 0,
  fulfilmentFailures: 0,
});

/** Run `worker` over `items`, at most `limit` at a time. */
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

export async function reconcileSumUpPayments(
  options: ReconciliationOptions,
): Promise<ReconciliationSummary> {
  const now = options.now ?? (() => new Date());
  const batchSize = options.batchSize ?? RECONCILIATION_BATCH_SIZE;
  const concurrency = options.concurrency ?? RECONCILIATION_CONCURRENCY;
  const log =
    options.log ??
    ((event, detail) => console.warn(JSON.stringify({ at: 'sumup-reconcile', event, ...detail })));

  const candidates = await options.orders.listReconciliationCandidates(
    'sumup',
    now(),
    batchSize,
  );

  const summary = emptySummary();
  summary.examined = candidates.length;
  if (candidates.length === 0) return summary;

  await mapBounded(candidates, concurrency, async (candidate: ReconciliationCandidate) => {
    try {
      // The SAME verifier the webhook uses. It performs its own lookup by
      // payment reference, which repeats one indexed read per candidate -
      // accepted deliberately, because one shared verification implementation
      // is worth more than one saved query.
      const outcome = await options.verifier.verify(candidate.paymentReference);

      switch (outcome.kind) {
        case 'paid': {
          // The SAME writer the webhook uses. Its conditional update is what
          // makes a concurrent webhook, a second reconciler run and the
          // expiry sweep all safe - not anything in this file.
          const applied = await options.orders.applyVerifiedPayment(outcome.verified);
          if (applied.outcome === 'applied') summary.paid += 1;
          else if (applied.outcome === 'already-paid') summary.alreadyPaid += 1;
          else {
            summary.discrepancies += 1;
            // Money that SumUp has and we cannot attach to a live hold.
            // Surfaced, never resolved here: resurrecting released stock
            // could oversell the room.
            log('verified-payment-not-applicable', {
              order: candidate.reference,
              status: applied.status,
            });
          }
          if (applied.outcome !== 'not-applicable' && options.fulfilment) {
            try {
              await options.fulfilment.issuePaidOrder(applied.orderId);
            } catch (error) {
              summary.fulfilmentFailures += 1;
              log('ticket-fulfilment-failed', {
                kind: error instanceof Error ? error.name : 'unknown',
              });
            }
          }
          return;
        }

        case 'not-paid':
          // PENDING, FAILED or EXPIRED at the provider. No local transition:
          // a declined attempt can still be retried on SumUp's hosted page,
          // and local expiry belongs solely to the reservation sweep.
          summary.unchanged += 1;
          return;

        case 'retrieval-failed':
          // We learned nothing, so we change nothing and try again next run.
          summary.retrievalFailures += 1;
          return;

        case 'mismatch':
          summary.verificationFailures += 1;
          log('correlation-mismatch', { order: candidate.reference, reason: outcome.reason });
          return;

        case 'unknown-checkout':
          // The candidate came from our own table, so this means the order
          // changed underneath us mid-run. Harmless; next run re-reads.
          summary.unchanged += 1;
          return;
      }
    } catch (error) {
      // One bad order must never strand the rest of the batch. The message is
      // not logged: it can contain provider text we have not vetted.
      summary.retrievalFailures += 1;
      log('candidate-failed', {
        order: candidate.reference,
        kind: error instanceof Error ? error.name : 'unknown',
      });
    }
  });

  log('run-complete', { ...summary });
  return summary;
}
