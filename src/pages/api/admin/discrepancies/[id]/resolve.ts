/**
 * POST /api/admin/discrepancies/:id/resolve - mark a payment discrepancy as
 * dealt with (AMPED-07D2-3).
 *
 * WHAT THIS DOES NOT DO
 * It does not send a refund. It does not call SumUp at all. It does not touch
 * the order: an expired order stays expired, an awaiting_payment order stays
 * governed by the reservation lifecycle, and nothing here can make an order
 * `paid` or `refunded`. The only writer to `paid` remains
 * `applyVerifiedPayment`, and this route cannot reach it.
 *
 * WHAT IT MEANS
 * An authenticated operator attesting that they have dealt with the money in
 * SumUp. That is a statement about a human action taken elsewhere, not a
 * provider fact we retrieved - so the recorded event says exactly that and
 * claims nothing about whether a refund actually completed.
 *
 * SECURITY
 * It lives under `/api/admin/`, so the AMPED-04A middleware has already
 * verified a Cloudflare Access application token before this handler runs,
 * and `operatorFrom` refuses to proceed without the verified operator those
 * claims produced. The body carries nothing: the discrepancy id comes from
 * the path and the only permitted transition is implied by the route. There
 * is deliberately no client-supplied state, amount, kind or provider fact to
 * validate, because none is trusted.
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
    // The actor is the verified Access identity, never anything the browser
    // sent. A financial attestation has to name a real person.
    const result = await getPaymentDiscrepancies().resolveManually(
      id,
      operator.email,
      new Date(),
    );

    if (result.outcome === 'not-found') return fail(404, 'not-found');
    // Already resolved is a no-op, not an error: two operators looking at the
    // same queue should not see a failure for agreeing with each other.
    return json({
      ok: true,
      id,
      state: 'resolved_manually',
      alreadyResolved: result.outcome === 'already-resolved',
    });
  } catch (error) {
    return fromError(error);
  }
};
