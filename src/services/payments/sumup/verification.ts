/**
 * Authenticated SumUp payment verification (AMPED-07C1).
 *
 * THE SECURITY MODEL, stated plainly because the code only makes sense in its
 * light:
 *
 *   The notification is an unauthenticated hint containing a checkout ID. It
 *   has zero payment authority. Authenticity of the claimed payment state is
 *   established by an authenticated server-to-server SumUp API retrieval plus
 *   correlation against the local order.
 *
 * SumUp documents no webhook signature, no HMAC, no shared secret, no
 * timestamp and no delivery id (developer.sumup.com/online-payments/webhooks,
 * reviewed 2026-10-04). Its documented instruction is instead: "After
 * receiving a webhook call, your application must always verify if the event
 * really took place, by calling a relevant SumUp's API." This module is that
 * verification. Nothing here trusts the payload beyond using its id as a
 * lookup key, and anyone on the internet can supply that id.
 *
 * Because an attacker can name any checkout, "SumUp says this checkout is
 * PAID" is not sufficient on its own - that could be somebody else's real
 * payment pointed at our order. Every field below is therefore correlated
 * against authoritative LOCAL data before a penny is credited.
 */

import type {
  OrderMutationService,
  PaymentCorrelationSnapshot,
  VerifiedPayment,
} from '../../orders/service.ts';
import type { SumUpClient } from './client.ts';
import { SumUpError, type SumUpCheckoutPayload } from './types.ts';

/** Why a retrieved checkout could not be credited to the local order. */
export type CorrelationFailure =
  | 'checkout-id-mismatch'
  | 'reference-mismatch'
  | 'amount-malformed'
  | 'amount-mismatch'
  | 'currency-mismatch'
  | 'merchant-mismatch'
  | 'no-successful-transaction';

/**
 * Authenticated facts about a retrieved checkout (AMPED-07D2-2).
 *
 * Verification exists to answer one question - may this be credited? - and so
 * it collapses everything else. Discrepancy detection needs a different
 * question answered: does SumUp appear to be HOLDING money we cannot credit?
 * A bare `mismatch` reason cannot say, because "wrong amount" and "wrong
 * amount AND a completed payment" are very different financial situations.
 *
 * This carries only what an operator needs to understand the mismatch. There
 * is deliberately no provider body, no card data and no customer detail here,
 * and nothing in it is eligible to reach `applyVerifiedPayment` - only the
 * `paid` outcome's `verified` is.
 */
export interface ProviderPaymentEvidence {
  /** The checkout status SumUp reported, verbatim. */
  status: string;
  /** Exact integer pence, or null when SumUp's amount was unusable. */
  amountInPence: number | null;
  /** Set only when a SUCCESSFUL transaction exists. The money signal. */
  transactionId: string | null;
  /** The successful transaction's own timestamp, when SumUp supplies one. */
  paidAt: string | null;
}

export type VerificationOutcome =
  /** Fully correlated. Safe to apply. */
  | {
      kind: 'paid';
      verified: VerifiedPayment;
      orderReference: string;
      evidence: ProviderPaymentEvidence;
    }
  /** Provider spoke, but the payment has not succeeded. Nothing to do. */
  | {
      kind: 'not-paid';
      status: string;
      orderReference: string;
      evidence: ProviderPaymentEvidence;
    }
  /** No local order holds this checkout id. */
  | { kind: 'unknown-checkout' }
  /** Provider said PAID but the data does not match our order. */
  | {
      kind: 'mismatch';
      reason: CorrelationFailure;
      orderReference: string;
      retryable: boolean;
      evidence: ProviderPaymentEvidence;
    }
  /** We could not reach or parse SumUp. Nothing was decided. */
  | { kind: 'retrieval-failed'; retryable: true };

/**
 * Convert SumUp's major-unit amount into exact integer pence.
 *
 * Deliberately NOT `value * 100`. Money comparison by floating point is how
 * 10.07 becomes 1006.9999999999999 and a correct payment gets rejected - or,
 * worse, how a near-miss gets accepted. The value is normalised through its
 * decimal text and recombined with integer arithmetic, so the result is exact
 * or it is null.
 *
 * Returns null for anything not a plain decimal with at most two places:
 * over-precision (10.005), exponent form (1e3), currency symbols, empty
 * strings, NaN and Infinity. A null is a verification failure, never a zero.
 */
export function majorUnitsToPence(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;

  const text = (typeof value === 'string' ? value : String(value)).trim();
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;

  const [, sign, whole, fraction = ''] = match;
  const pence = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(pence)) return null;
  return sign === '-' ? -pence : pence;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The first SUCCESSFUL transaction, which is the payment we are crediting. */
function successfulTransaction(
  payload: SumUpCheckoutPayload,
): { id: string; timestamp: string | null } | null {
  if (!Array.isArray(payload.transactions)) return null;
  for (const entry of payload.transactions) {
    if (entry === null || typeof entry !== 'object') continue;
    const transaction = entry as Record<string, unknown>;
    if (transaction.status !== 'SUCCESSFUL') continue;
    // `id` is the stable resource identity; transaction_code is the
    // acquirer's and is only a fallback. One of them must exist - we never
    // invent an identity, because it becomes the dedupe key.
    const id = text(transaction.id) ?? text(transaction.transaction_code);
    if (id) return { id, timestamp: text(transaction.timestamp) };
  }
  return null;
}

/**
 * Correlate a retrieved checkout against the local order.
 *
 * Pure: no I/O, no clock, no provider. Every check compares provider data to
 * LOCAL authoritative data, and a missing provider field is a failure rather
 * than something to infer or default.
 */
export function correlateCheckout(
  payload: SumUpCheckoutPayload,
  local: PaymentCorrelationSnapshot,
  expectedMerchantCode: string,
  now: () => Date,
): VerificationOutcome {
  // Gathered once, up front, and attached to every outcome. Collecting the
  // authenticated facts before branching is what lets discrepancy detection
  // tell "wrong amount" from "wrong amount and SumUp took the money".
  const transaction = successfulTransaction(payload);
  const evidence: ProviderPaymentEvidence = {
    status: text(payload.status) ?? 'UNKNOWN',
    amountInPence: majorUnitsToPence(payload.amount),
    transactionId: transaction?.id ?? null,
    paidAt: transaction?.timestamp ?? null,
  };

  const status = text(payload.status);
  if (!status) {
    return mismatch('no-successful-transaction', local, false, evidence);
  }

  if (status !== 'PAID') {
    return { kind: 'not-paid', status, orderReference: local.reference, evidence };
  }

  // 1. The checkout SumUp described is the one we stored on this order.
  if (text(payload.id) !== local.paymentReference) {
    return mismatch('checkout-id-mismatch', local, false, evidence);
  }

  // 2. It is OUR order's reference, not another merchant's or another order's.
  //    This is the check that stops a real payment for checkout X being
  //    replayed at order Y.
  if (text(payload.checkout_reference) !== local.reference) {
    return mismatch('reference-mismatch', local, false, evidence);
  }

  // 3. Exact money, by integer pence.
  if (evidence.amountInPence === null) return mismatch('amount-malformed', local, false, evidence);
  if (evidence.amountInPence !== local.totalInPence) {
    return mismatch('amount-mismatch', local, false, evidence);
  }

  // 4. Currency. The order total is pence sterling by construction.
  if (text(payload.currency) !== 'GBP') return mismatch('currency-mismatch', local, false, evidence);

  // 5. The money reached OUR merchant account.
  if (text(payload.merchant_code) !== expectedMerchantCode) {
    return mismatch('merchant-mismatch', local, false, evidence);
  }

  // 6. A real completed transaction, supplying the identity we deduplicate on.
  if (!transaction) {
    // PAID with no SUCCESSFUL transaction yet is the one failure that can
    // plausibly fix itself: the checkout may have flipped status a moment
    // before its transaction list settled. Worth another delivery.
    return mismatch('no-successful-transaction', local, true, evidence);
  }

  return {
    kind: 'paid',
    orderReference: local.reference,
    evidence,
    verified: {
      orderId: local.orderId,
      checkoutId: local.paymentReference,
      provider: 'sumup',
      transactionId: transaction.id,
      // Never fabricated when SumUp supplies one; the local clock is only a
      // last resort so that `paid_at` is never null on a paid row.
      paidAt: transaction.timestamp ?? now().toISOString(),
    },
  };
}

function mismatch(
  reason: CorrelationFailure,
  local: PaymentCorrelationSnapshot,
  retryable: boolean,
  evidence: ProviderPaymentEvidence,
): VerificationOutcome {
  return { kind: 'mismatch', reason, orderReference: local.reference, retryable, evidence };
}

export interface SumUpPaymentVerifier {
  /** Look up, retrieve, and correlate. Decides nothing about local state. */
  verify(checkoutId: string): Promise<VerificationOutcome>;
}

export interface SumUpVerifierOptions {
  client: SumUpClient;
  merchantCode: string;
  orders: OrderMutationService;
  now?: () => Date;
}

export function createSumUpPaymentVerifier(
  options: SumUpVerifierOptions,
): SumUpPaymentVerifier {
  const now = options.now ?? (() => new Date());

  return {
    async verify(checkoutId: string): Promise<VerificationOutcome> {
      // Local first. An id nobody here has ever seen costs us one indexed
      // lookup and no outbound request, which keeps an unauthenticated
      // endpoint from being usable to probe SumUp on our credentials.
      const local = await options.orders.findOrderByPaymentReference('sumup', checkoutId);
      if (!local) return { kind: 'unknown-checkout' };

      let payload: SumUpCheckoutPayload;
      try {
        payload = await options.client.getCheckout(checkoutId);
      } catch (error) {
        // Transport, timeout, 5xx, unparseable: we did not learn anything, so
        // we change nothing and ask to be told again.
        if (error instanceof SumUpError) return { kind: 'retrieval-failed', retryable: true };
        throw error;
      }

      return correlateCheckout(payload, local, options.merchantCode, now);
    },
  };
}
