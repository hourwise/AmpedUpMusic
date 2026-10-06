/**
 * The provider-independent email transport contract (AMPED-08C1).
 *
 * Business logic never speaks a provider's language. A future Resend adapter
 * (AMPED-08C2) translates HTTP responses, timeouts and rate limits into these
 * four result classes; the outbox store, retry policy, scheduler and operator
 * screen know nothing else. Swapping providers is a one-file change at the
 * adapter, never a change to the delivery state machine.
 *
 * The classes deliberately distinguish "safe to retry" from "outcome unknown":
 *
 *  - `accepted`          the provider has taken responsibility for delivery.
 *  - `retryable`         nothing was accepted and attempting again is safe.
 *  - `permanent_failure` attempting again will not help without human action.
 *  - `ambiguous`         the outcome is unknown (for example a timeout after
 *                        the request left the process). Retrying may duplicate
 *                        a send, so it must never be treated as retryable.
 *
 * No external exactly-once delivery is claimed anywhere in this system. The
 * durable guarantee is local: one logical delivery intent per order and
 * message version, plus a stable idempotency key the provider may use to
 * deduplicate its own retries.
 */

/** How a provider-independent send attempt ended. */
export type EmailDeliveryOutcomeClass =
  | 'accepted'
  | 'retryable'
  | 'permanent_failure'
  | 'ambiguous';

/** One inline/attached image. Content ids are deterministic per ticket. */
export interface OutboundEmailAttachment {
  filename: string;
  /** RFC 2392 content id without angle brackets; HTML refers to `cid:<id>`. */
  contentId: string;
  mimeType: string;
  contentBase64: string;
}

/** A fully rendered message, ready for any transport. */
export interface OutboundEmail {
  /** The frozen recipient snapshot; never re-read from the order at send time. */
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments: readonly OutboundEmailAttachment[];
  /**
   * Logical idempotency key, stable for the life of the intent. A transport
   * that supports deduplication must pass it to the provider.
   */
  idempotencyKey: string;
}

export interface TransportResult {
  class: EmailDeliveryOutcomeClass;
  /**
   * The provider's message id when it returned one. Evidence only: it is
   * never local identity and never a lookup key.
   */
  providerMessageId?: string;
  /** Short machine-readable code, e.g. "rate_limited". Safe to store. */
  errorCode?: string;
  /**
   * A message the adapter has already made safe to store. Must not contain
   * payloads, tokens, addresses or credentials; the store truncates it.
   */
  errorMessage?: string;
  /** Optional provider hint for the next attempt. */
  retryAfterMs?: number;
}

export interface EmailTransport {
  /** Stable provider name recorded with an accepted delivery. */
  readonly name: string;
  send(message: OutboundEmail): Promise<TransportResult>;
}
