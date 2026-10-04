/**
 * POST /api/admin/discrepancies/:id/reopen - put a resolved discrepancy back
 * in the queue (AMPED-07D2-3).
 *
 * The undo for a resolution recorded in error. A financial record should not
 * be a one-way door: marking the wrong row resolved is an easy mistake, and
 * the cost of being unable to correct it is that real money silently stops
 * being chased.
 *
 * Nothing is erased. The original `detected` and `resolved_manually` events
 * remain, and reopening appends its own - the history says what was believed
 * and when, including the part that turned out to be wrong.
 *
 * Like the resolve route: no SumUp call, no refund, no change to the order.
 * Protected by the AMPED-04A Access middleware through the `/api/admin/`
 * namespace, and the actor is the verified operator identity.
 */

import type { APIRoute } from 'astro';
import { getPaymentDiscrepancies } from '@/services/index.ts';
import { fail, fromError, json, operatorFrom } from '../../gigs/_respond.ts';

export const POST: APIRoute = async ({ params, locals }) => {
  const operator = operatorFrom(locals);
  if (!operator) return fail(403, 'forbidden');

  const id = params.id;
  if (!id) return fail(404, 'not-found');

  try {
    const result = await getPaymentDiscrepancies().reopen(id, operator.email, new Date());

    if (result.outcome === 'not-found') return fail(404, 'not-found');
    return json({
      ok: true,
      id,
      state: 'open',
      alreadyOpen: result.outcome === 'already-open',
    });
  } catch (error) {
    return fromError(error);
  }
};
