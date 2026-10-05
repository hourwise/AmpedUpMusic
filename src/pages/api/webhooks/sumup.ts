/**
 * POST /api/webhooks/sumup - SumUp checkout status notifications (AMPED-07C1).
 *
 * THIS ENDPOINT IS UNAUTHENTICATED AND ANYONE MAY CALL IT.
 *
 * That is not an oversight. SumUp documents no signature, HMAC, shared
 * secret, timestamp or delivery id for Online Payments notifications; its
 * documented instruction is to verify by calling the API back. So the body is
 * treated as a hint with zero payment authority: the only thing taken from it
 * is a checkout id, which is then used as a lookup key. Everything that could
 * move money is established by an authenticated server-to-server retrieval
 * correlated against our own order row.
 *
 * The handler is therefore deliberately boring, and boring in a specific way:
 *
 *  - It returns an EMPTY body in every case. No order id, no status, no
 *    customer data, no provider data, no diagnostics. An unauthenticated
 *    caller learns nothing - in particular it cannot tell a checkout id we
 *    know from one we do not, so the endpoint is not an oracle.
 *  - It returns 2xx for everything it has finished with, including rubbish.
 *    SumUp retries any non-2xx at 1 min, 5 min, 20 min and 2 hours, so
 *    rejecting malformed input with a 4xx would buy four more copies of the
 *    same malformed input and nothing else.
 *  - It returns 502 ONLY when a retry could plausibly succeed: we could not
 *    reach SumUp, or the configuration needed to reach it is missing. Those
 *    are the cases where being told again genuinely helps.
 *
 * It never sends email or touches inventory. `applyVerifiedPayment` alone
 * decides paid status. After that succeeds, a separate 08A service attempts
 * durable ticket fulfilment; the scheduled recovery pass covers a crash gap.
 */

import type { APIRoute } from 'astro';
import { getSumUpVerification } from '@/services/index.ts';
import { PaymentConfigurationError } from '@/services/payments/sumup/types.ts';

/** SumUp asks for "a valid, empty response with any 2xx status code". */
function acknowledge(): Response {
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

/** Ask SumUp to deliver this again. Used only when a retry could help. */
function retryable(): Response {
  return new Response(null, { status: 502, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * Checkout ids are SumUp UUIDs. Bounding the shape before it reaches a log or
 * a query keeps an attacker from using this endpoint to write newlines and
 * control characters into our operational logs.
 */
const CHECKOUT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Operational logging only. Never audit, never PII, never provider bodies. */
function note(event: string, detail?: Record<string, string>): void {
  console.warn(JSON.stringify({ at: 'sumup-webhook', event, ...detail }));
}

export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    // Unparseable now is unparseable in two hours.
    note('malformed-json');
    return acknowledge();
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    note('malformed-body');
    return acknowledge();
  }

  const notification = body as Record<string, unknown>;

  // SumUp: "New events may be introduced at any time, without prior notice...
  // Our recommendation would be to silently ignore unknown events."
  if (notification.event_type !== 'CHECKOUT_STATUS_CHANGED') {
    note('unknown-event-type');
    return acknowledge();
  }

  const checkoutId = typeof notification.id === 'string' ? notification.id : '';
  if (!CHECKOUT_ID.test(checkoutId)) {
    // Deliberately does not echo the value, for the reason above.
    note('missing-or-invalid-id');
    return acknowledge();
  }

  let verification: ReturnType<typeof getSumUpVerification>;
  try {
    verification = getSumUpVerification();
  } catch (error) {
    if (error instanceof PaymentConfigurationError) {
      // A real notification may be waiting behind a missing credential.
      // Retrying gives an operator a window to fix it; acknowledging would
      // silently discard a payment we are obliged to record.
      note('not-configured');
      return retryable();
    }
    throw error;
  }

  const outcome = await verification.verifier.verify(checkoutId);

  switch (outcome.kind) {
    case 'retrieval-failed':
      // We learned nothing and changed nothing. Please tell us again.
      note('retrieval-failed');
      return retryable();

    case 'unknown-checkout':
      // Either noise, or a checkout belonging to someone else entirely. The
      // response is identical to the success case on purpose.
      note('unknown-checkout');
      return acknowledge();

    case 'not-paid':
      // PENDING, FAILED or EXPIRED. No local state changes - a declined
      // attempt can still be retried on SumUp's hosted page, and expiry
      // belongs solely to the AMPED-06B reservation sweep.
      note('not-paid', { status: outcome.status, order: outcome.orderReference });
      return acknowledge();

    case 'mismatch':
      // SumUp says PAID but the checkout does not match this order's
      // reference, total, currency or merchant. Never credit it. Only the
      // "transactions not populated yet" case is worth another delivery.
      note('correlation-mismatch', { reason: outcome.reason, order: outcome.orderReference });
      return outcome.retryable ? retryable() : acknowledge();

    case 'paid': {
      const applied = await verification.orders.applyVerifiedPayment(outcome.verified);
      if (applied.outcome === 'not-applicable') {
        // Verified payment against an order that is no longer holding stock -
        // the sweep won, or it was cancelled. A genuine money discrepancy,
        // and deliberately NOT resolved here: AMPED-07D surfaces it to an
        // operator rather than this handler resurrecting released inventory.
        note('verified-payment-not-applicable', {
          order: outcome.orderReference,
          status: applied.status,
        });
      } else {
        await verification.fulfilment.issuePaidOrder(applied.orderId);
      }
      return acknowledge();
    }
  }
};
