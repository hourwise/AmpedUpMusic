/**
 * Scheduled orchestration (AMPED-06B, extended by AMPED-07D).
 *
 * Orchestration only: it asks the service layer to do two things and reports
 * what happened. All SQL, all reservation semantics and all payment
 * verification live behind `src/services/**`.
 *
 * ORDER IS LOAD-BEARING
 * Reconciliation runs BEFORE expiry, every time. Reversed, a customer who
 * genuinely paid but whose webhook never arrived would have their hold
 * expired and their tickets resold moments before the reconciler would have
 * rescued them. Paying first costs nothing and closes that window; the sweep
 * then expires whatever is genuinely abandoned.
 *
 * CADENCE
 * The existing five-minute cron is already the right rate and is unchanged.
 * It is derived from the accepted lifecycle, not from convenience: a hold
 * lasts 30 minutes, so every order gets roughly six reconciliation attempts
 * before it can lapse, and a dropped webhook is recovered within five minutes
 * rather than at the end of the window.
 *
 * FAILURE ISOLATION
 * A runtime with no SumUp credentials must still expire holds - otherwise a
 * missing secret would silently take stock off sale. Reconciliation is
 * therefore allowed to be skipped, never to fail the run.
 */

import { getPaymentReconciliation, getReservationMaintenance } from '@/services/index.ts';
import {
  reconcileSumUpPayments,
  type ReconciliationSummary,
} from '@/services/payments/reconciliation.ts';
import { PaymentConfigurationError } from '@/services/payments/sumup/types.ts';

export interface ScheduledTaskSummary {
  /** Null when SumUp is not configured in this runtime. */
  reconciliation: ReconciliationSummary | null;
  expired: number;
}

export async function runScheduledTasks(now: Date = new Date()): Promise<ScheduledTaskSummary> {
  const reconciliation = await reconcileIfConfigured(now);
  const { expired } = await getReservationMaintenance().expireDueReservations(now);
  return { reconciliation, expired };
}

async function reconcileIfConfigured(now: Date): Promise<ReconciliationSummary | null> {
  let seam: ReturnType<typeof getPaymentReconciliation>;
  try {
    seam = getPaymentReconciliation();
  } catch (error) {
    if (error instanceof PaymentConfigurationError) return null;
    throw error;
  }

  return reconcileSumUpPayments({
    orders: seam.orders,
    verifier: seam.verifier,
    now: () => now,
  });
}
