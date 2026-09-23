/**
 * POST /api/checkout/confirm - provider-authoritative confirmation (AMPED-06A).
 *
 * This is the only route that can move an order to `paid`, and it does so by
 * asking the payment provider for the authoritative result - never by trusting
 * the caller. A repeated confirmation of a paid order is a no-op.
 */

import type { APIRoute } from 'astro';
import { getCheckout } from '@/services/index.ts';
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
    const result = await orders.confirmPayment(orderId, checkoutId, provider);
    return json({ ok: true, orderId: result.orderId, status: result.status, paidAt: result.paidAt });
  } catch (error) {
    return fromError(error);
  }
};
