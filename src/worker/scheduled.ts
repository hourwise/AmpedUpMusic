/**
 * Scheduled orchestration (AMPED-06B).
 *
 * Orchestration only: it asks the service layer to expire whatever holds are
 * due and returns the count. All SQL and all reservation semantics live behind
 * `src/services/**`, resolved through the accepted binding architecture.
 */

import { getReservationMaintenance } from '@/services/index.ts';

export async function runScheduledTasks(now: Date = new Date()): Promise<{ expired: number }> {
  return getReservationMaintenance().expireDueReservations(now);
}
