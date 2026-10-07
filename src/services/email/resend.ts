/**
 * The Resend EmailTransport adapter (AMPED-08C2, corrected by AMPED-08C2-R1).
 *
 * Everything provider-specific lives here: the endpoint, the request shape,
 * the authentication header, the idempotency header and the translation from
 * HTTP outcomes to the four provider-independent result classes. Business
 * logic — the outbox, the state machine, retries, the scheduler and the
 * operator screen — knows none of it.
 *
 * PRINCIPLES THIS ADAPTER KEEPS
 *
 *  - The frozen 08C1 message is sent verbatim. Nothing is recomputed from the
 *    event, order or venue tables, and no asset is fetched from any URL: the
 *    QR images travel as base64 content with their deterministic Content-IDs.
 *
 *  - The immutable 08C1 `idempotency_key` is the `Idempotency-Key` header on
 *    every attempt for the same logical intent. It identifies the exact
 *    email, never an individual delivery attempt, and it is never random.
 *    Provider-side deduplication is ADDITIONAL protection only; the durable
 *    local outbox remains authoritative.
 *
 *  - `accepted` is only ever returned when a response establishes acceptance
 *    and a provider message id. A request that failed after it may have been
 *    sent, timed out, or produced an uninterpretable response is `ambiguous`
 *    — never `retryable` merely because an idempotency key was supplied.
 *    Only conditions that demonstrably never reached the provider's
 *    application (DNS failure, connection refused, unreachable host, TLS
 *    handshake failure) are safe to retry automatically.
 *
 *  - The two documented 409 idempotency conflicts are told apart because
 *    they mean opposite things. `invalid_idempotent_request` (the key was
 *    reused with a different payload) is a permanent local invariant defect:
 *    retrying the unchanged request cannot repair it.
 *    `concurrent_idempotent_requests` (the same key is in flight) is
 *    `retryable` with the same durable key, honouring `Retry-After` when the
 *    provider supplies one. Any other 409 stays `ambiguous` — the adapter
 *    never guesses a classification from a coarser signal.
 *
 *  - No provider error body is stored anywhere. Only a short, validated error
 *    slug (e.g. `validation_error`) is kept as a code; the human message is
 *    ours, never the provider's echo of the request.
 */

import type { EmailTransport, OutboundEmail, TransportResult } from './transport.ts';

export const RESEND_ENDPOINT = 'https://api.resend.com/emails';
export const RESEND_TIMEOUT_MS = 15_000;

export interface ResendTransportConfig {
  apiKey: string;
  /** The configured sender, e.g. `Amped Up Music Promotions <tickets@…>`. */
  from: string;
  /** Optional Reply-To; omitted from the request entirely when not set. */
  replyTo?: string;
  /** Overridable only for tests and future self-hosting; defaults to Resend. */
  endpoint?: string;
  timeoutMs?: number;
  /** The HTTP boundary. The test suite always injects a fake; there is none. */
  fetchImpl?: typeof fetch;
}

/**
 * Error cause codes that prove the request never reached the provider's
 * application: resolution failed, the connection was refused, the host was
 * unreachable, or the TLS handshake failed. Anything not in this set is
 * treated as `ambiguous`, which is the only safe default.
 */
const NEVER_SENT_CAUSE_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_DNS_RESOLVE_FAILED',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);

const PROVIDER_NAME_PATTERN = /^[a-z][a-z0-9_]{1,63}$/i;

export function createResendTransport(config: ResendTransportConfig): EmailTransport {
  const fetchImpl = config.fetchImpl ?? fetch;
  const endpoint = config.endpoint ?? RESEND_ENDPOINT;
  const timeoutMs = config.timeoutMs ?? RESEND_TIMEOUT_MS;

  return {
    name: 'resend',

    async send(message: OutboundEmail): Promise<TransportResult> {
      const body = JSON.stringify({
        from: config.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
        ...(config.replyTo ? { reply_to: config.replyTo } : {}),
        attachments: message.attachments.map((attachment) => ({
          filename: attachment.filename,
          content: attachment.contentBase64,
          content_type: attachment.mimeType,
          content_id: attachment.contentId,
        })),
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            'content-type': 'application/json',
            // The frozen logical key, identical on every retry of this intent.
            'idempotency-key': message.idempotencyKey,
          },
          body,
          signal: controller.signal,
          // A redirect is never a Resend outcome; refollowing could leak the
          // Authorization header or the message to a third origin.
          redirect: 'manual',
        });
      } catch (error) {
        return classifyFetchFailure(error);
      } finally {
        clearTimeout(timer);
      }

      if (isSuccessStatus(response.status)) {
        let text: string;
        try {
          text = await response.text();
        } catch {
          return ambiguous(
            'resend_response_lost',
            'Resend returned a success status but the response was lost before it could be read; acceptance cannot be established.',
          );
        }
        const messageId = parseProviderMessageId(text);
        if (messageId) return { class: 'accepted', providerMessageId: messageId };
        return ambiguous(
          'resend_uninterpretable_response',
          'Resend returned a success status without a readable message id; acceptance cannot be established safely.',
        );
      }

      // For every non-success status the status line is authoritative and a
      // body read failure cannot change the classification.
      let providerName: string | null = null;
      try {
        providerName = parseProviderErrorName(await response.text());
      } catch {
        providerName = null;
      }
      return classifyHttpFailure(response.status, response.headers.get('retry-after'), providerName);
    },
  };
}

function isSuccessStatus(status: number): boolean {
  return status === 200 || status === 201 || status === 202;
}

function parseProviderMessageId(text: string): string | null {
  try {
    const body = JSON.parse(text) as { id?: unknown };
    if (typeof body?.id === 'string') {
      const id = body.id.trim();
      if (id.length > 0 && id.length <= 200 && !id.includes('\n')) return id;
    }
  } catch {
    // Falls through to null: an unreadable success body is not acceptance.
  }
  return null;
}

function parseProviderErrorName(text: string): string | null {
  try {
    const body = JSON.parse(text) as { name?: unknown };
    if (typeof body?.name === 'string' && PROVIDER_NAME_PATTERN.test(body.name)) {
      return body.name.toLowerCase();
    }
  } catch {
    // No safe name available.
  }
  return null;
}

function classifyHttpFailure(
  status: number,
  retryAfterHeader: string | null,
  providerName: string | null,
): TransportResult {
  const detail = providerName ? ` (${providerName})` : '';
  const code = (fallback: string) => (providerName ? `resend_${providerName}` : fallback);

  switch (status) {
    case 400:
      return permanent(code('resend_http_400'), `Resend rejected the request as malformed${detail}.`);
    case 401:
    case 403:
      return permanent(
        code('resend_auth_failed'),
        `Resend refused the request${detail}; check the API key and sender configuration.`,
      );
    case 404:
      return permanent(code('resend_http_404'), `Resend did not recognise the request path${detail}.`);
    case 408:
      return ambiguous(
        code('resend_timeout'),
        `Resend reported a gateway timeout${detail}; acceptance cannot be established.`,
      );
    case 409: {
      // Resend documents two distinguishable idempotency conflicts, and they
      // mean opposite things for the queue. The comparison is against the
      // exact documented error codes; anything else — a missing, malformed or
      // unknown code — stays ambiguous. The adapter never guesses.
      if (providerName === 'invalid_idempotent_request') {
        // The key was already used with a DIFFERENT payload. The accepted
        // design requires the immutable key and frozen payload to identify
        // one exact logical email, so this indicates a local
        // invariant/configuration defect: retrying the unchanged request
        // cannot repair it.
        return permanent(
          'resend_invalid_idempotent_request',
          'Resend rejected the idempotency key because it was previously used with a different request. The frozen payload and key must identify one logical email; retrying the unchanged request cannot repair this.',
        );
      }
      if (providerName === 'concurrent_idempotent_requests') {
        // Another request with the same key is in flight; Resend explicitly
        // permits retrying this later. The durable key never changes.
        return retryable(
          'resend_concurrent_idempotent_requests',
          'Resend has another request in flight for this idempotency key; the provider permits retrying later with the same key.',
          parseRetryAfterMs(retryAfterHeader),
        );
      }
      return ambiguous(
        'resend_conflict',
        `Resend reported a conflict${detail} that does not match a documented idempotency response; acceptance cannot be established.`,
      );
    }
    case 413:
      return permanent(code('resend_payload_too_large'), `Resend rejected the request as too large${detail}.`);
    case 422:
      return permanent(
        code('resend_validation_error'),
        `Resend rejected the request as invalid${detail}; the frozen message will not become valid by retrying.`,
      );
    case 429:
      return retryable(
        code('resend_rate_limited'),
        `Resend rate limited the request${detail}.`,
        parseRetryAfterMs(retryAfterHeader),
      );
    case 500:
    case 502:
    case 503:
    case 504:
      return retryable(
        code('resend_server_error'),
        `Resend reported a transient server failure${detail}; the request was not accepted.`,
        parseRetryAfterMs(retryAfterHeader),
      );
    default:
      return ambiguous(
        code('resend_unexpected_status'),
        `Resend returned an unexpected status (HTTP ${status})${detail}; acceptance cannot be established.`,
      );
  }
}

function classifyFetchFailure(error: unknown): TransportResult {
  const name = error instanceof Error ? error.name : 'unknown';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return ambiguous(
      'resend_timeout',
      'The Resend request timed out; the provider may or may not have received it, so acceptance cannot be established.',
    );
  }
  const causeCode = networkCauseCode(error);
  if (causeCode && NEVER_SENT_CAUSE_CODES.has(causeCode)) {
    return {
      class: 'retryable',
      errorCode: 'resend_network_unreachable',
      errorMessage: `Resend was unreachable before the request was sent (${causeCode}).`,
    };
  }
  return ambiguous(
    'resend_network_uncertain',
    `The Resend request failed without a response (${name}); acceptance cannot be established.`,
  );
}

function networkCauseCode(error: unknown): string | null {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  if (cause && typeof cause.code === 'string' && cause.code.length <= 80) return cause.code;
  const direct = (error as { code?: unknown } | null)?.code;
  if (typeof direct === 'string' && direct.length <= 80) return direct;
  return null;
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = header.trim();
  if (/^\d{1,7}$/.test(seconds)) {
    const ms = Number(seconds) * 1000;
    return ms > 0 ? ms : undefined;
  }
  return undefined;
}

function ambiguous(errorCode: string, errorMessage: string): TransportResult {
  return { class: 'ambiguous', errorCode, errorMessage };
}

function permanent(errorCode: string, errorMessage: string): TransportResult {
  return { class: 'permanent_failure', errorCode, errorMessage };
}

function retryable(errorCode: string, errorMessage: string, retryAfterMs?: number): TransportResult {
  return {
    class: 'retryable',
    errorCode,
    errorMessage,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}
