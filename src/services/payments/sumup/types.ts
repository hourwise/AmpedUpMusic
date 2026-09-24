/**
 * SumUp REST types and adapter errors (AMPED-07A).
 *
 * Only the fields this application uses are modelled; every parser tolerates
 * unknown extra fields, because SumUp may add fields at any time. Nothing here
 * claims webhook authenticity - SumUp's notifications are treated as
 * notifications, and the authoritative state is always retrieved from the API.
 *
 * Official reference (developer.sumup.com, reviewed 2026-09-24):
 *  - POST /v0.1/checkouts  (checkout_reference, amount in major units, currency,
 *    merchant_code, hosted_checkout.enabled, optional redirect_url/return_url)
 *  - GET  /v0.1/checkouts/{checkout_id}
 *  - Authorization: Bearer <API key>
 *  - status: PENDING | PAID | FAILED | EXPIRED
 */

export const SUMUP_API_BASE = 'https://api.sumup.com';

/** The documented hosted-checkout lifetime, used only when SumUp omits valid_until. */
export const SUMUP_HOSTED_CHECKOUT_MINUTES = 30;

/** Default per-request timeout. */
export const SUMUP_TIMEOUT_MS = 10_000;

/** Safe GET retries after the first attempt. Creation POSTs are never retried. */
export const SUMUP_MAX_GET_RETRIES = 2;

export type SumUpCheckoutStatus = 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED';

/**
 * The raw checkout resource as far as this adapter reads it. All fields are
 * `unknown` deliberately: parsing, not the type, decides whether a response is
 * usable, and unknown additions are simply ignored.
 */
export interface SumUpCheckoutPayload {
  id?: unknown;
  status?: unknown;
  hosted_checkout_url?: unknown;
  valid_until?: unknown;
  transactions?: unknown;
}

export type SumUpFailureKind = 'transport' | 'timeout' | 'http' | 'protocol';

/**
 * Controlled adapter failure.
 *
 * `kind` is for internal categorisation (07B/07D); the message is deliberately
 * generic and never contains the API key, request headers or SumUp's body.
 */
export class SumUpError extends Error {
  constructor(
    readonly kind: SumUpFailureKind,
    message: string,
    readonly status?: number,
    /** True when the request may have reached SumUp (ambiguous outcome). */
    readonly ambiguous = false,
  ) {
    super(message);
    this.name = 'SumUpError';
  }
}

/** True when the failure means "we do not know what SumUp did". */
export function isAmbiguousProviderError(error: unknown): boolean {
  return error instanceof SumUpError && error.ambiguous;
}
