/**
 * POST /api/checkout/confirm - mock-era confirmation route (AMPED-06A).
 *
 * It asks the payment provider for the authoritative result rather than
 * trusting the caller, and a repeated confirmation of a paid order is a no-op.
 *
 * CLOSED FOR SUMUP (AMPED-07B)
 * Under the live SumUp runtime this route refuses before it touches either the
 * provider or the order service. Left open it would be an anonymous public
 * path of exactly the wrong shape - POST a checkout id, we GET SumUp, the
 * order becomes `paid` - which would make payment authority reachable from a
 * browser before AMPED-07C's authoritative asynchronous confirmation exists.
 * Whoever opened the hosted page knows the checkout id, so "knowing the id" is
 * not authentication.
 *
 * It is gated rather than deleted because the mock certification suite still
 * exercises the AMPED-06A state machine through it. The refusal is a plain 404
 * so the route's existence is not advertised, and it is returned BEFORE any
 * provider call so no SumUp request is made at all.
 */

import type { APIRoute } from 'astro';
import { getCheckout } from '@/services/index.ts';
import { PaymentConfigurationError } from '@/services/payments/sumup/types.ts';
import { fail, fromError, json, readJson } from '../admin/gigs/_respond.ts';

export const POST: APIRoute = async ({ request }) => {
  const body = await readJson(request);
  if (!body) return fail(400, 'invalid');

  const unknown = Object.keys(body).filter((key) => key !== 'orderId' && key !== 'checkoutId');
  if (unknown.length > 0) return fail(400, 'invalid', { [unknown[0]!]: 'Unsupported field.' });

  const orderId = typeof body.orderId === 'string' ? body.orderId.trim() : '';
  const checkoutId = typeof body.checkoutId === 'string' ? body.checkoutId.trim() : '';
  if (!orderId) return fail(400, 'invalid', { orderId: 'Missing order.' });
  if (!checkoutId) return fail(400, 'invalid', { checkoutId: 'Missing checkout reference.' });

  try {
    const { orders, provider } = getCheckout();

    // The gate. Nothing above this line has contacted SumUp or read the order,
    // and nothing below it runs for the live provider.
    if (provider.name === 'sumup') return fail(404, 'not-found');

    const result = await orders.confirmPayment(orderId, checkoutId, provider);
    return json({ ok: true, orderId: result.orderId, status: result.status, paidAt: result.paidAt });
  } catch (error) {
    // An unconfigured runtime has no provider to confirm against either.
    if (error instanceof PaymentConfigurationError) return fail(404, 'not-found');
    return fromError(error);
  }
};
