/**
 * One scheduled email-delivery pass (AMPED-08C1).
 *
 * The pass runs after credential recovery in the scheduler and does exactly
 * two things:
 *
 *   1. Intent recovery — bounded, idempotent creation of missing
 *      ticket-confirmation intents for paid, fully fulfilled, fully
 *      credentialised orders. A crash between ticket completion and intent
 *      creation heals here.
 *   2. Delivery — identifies due deliveries and, if a transport is
 *      configured, claims each one, renders from the frozen payload and hands
 *      it to the provider-independent transport, recording the result class.
 *
 * NO TRANSPORT IS CONFIGURED IN 08C1. The pass then performs zero external
 * sends, marks nothing accepted, and does not claim or count an attempt: a
 * row that cannot be sent yet is identified once per pass, not churned every
 * five minutes. AMPED-08C2 supplies the Resend adapter; nothing else changes.
 *
 * ORDERING WITHIN THE PASS IS DELIBERATE
 * Recovering an intent never sends. Sending only ever happens through the
 * claim/lease primitive, one delivery at a time, with results recorded under
 * a fencing token. A worker that loses its lease mid-send writes nothing —
 * the reclaiming attempt owns the outcome.
 */

import type { TicketTokenService } from '../tickets/token.ts';
import {
  EMAIL_CLAIM_LEASE_MS,
  EMAIL_DUE_BATCH_LIMIT,
  EMAIL_INTENT_RECOVERY_LIMIT,
  type EmailDeliveryService,
  type EmailIntentRecoverySummary,
} from './deliveries.ts';
import {
  isTicketConfirmationPayload,
  renderTicketConfirmation,
  type TicketConfirmationPayload,
} from './render.ts';
import type { EmailTransport, TransportResult } from './transport.ts';

export interface EmailDeliveryPassSummary {
  intents: EmailIntentRecoverySummary;
  /** Expired claims flipped back to retryable before this pass. */
  leasesRequeued: number;
  /** Due deliveries identified. Read-only when no transport is configured. */
  identified: number;
  /** Deliveries actually handed to a transport this pass. */
  attempted: number;
  accepted: number;
  retryable: number;
  permanentFailures: number;
  ambiguous: number;
  /** The provider name, or null when no transport is configured. */
  transport: string | null;
}

export interface EmailDeliveryPass {
  run(now: Date): Promise<EmailDeliveryPassSummary>;
}

export interface EmailDeliveryPassDeps {
  deliveries: EmailDeliveryService;
  /**
   * Resolved lazily so a runtime without the signing secret can still recover
   * intents; the token service is only needed when a send is actually
   * attempted.
   */
  tokens: () => TicketTokenService;
  /**
   * Null means "no provider is configured". See the file header: zero sends,
   * no claims, nothing marked accepted.
   */
  transport: EmailTransport | null;
}

export function createEmailDeliveryPass(deps: EmailDeliveryPassDeps): EmailDeliveryPass {
  async function run(now: Date): Promise<EmailDeliveryPassSummary> {
    const intents = await deps.deliveries.recoverMissingIntents(EMAIL_INTENT_RECOVERY_LIMIT, now);
    const leasesRequeued = await deps.deliveries.requeueAbandonedLeases(now);
    const dueIds = await deps.deliveries.listDueIds(now, EMAIL_DUE_BATCH_LIMIT);
    const summary: EmailDeliveryPassSummary = {
      intents,
      leasesRequeued,
      identified: dueIds.length,
      attempted: 0,
      accepted: 0,
      retryable: 0,
      permanentFailures: 0,
      ambiguous: 0,
      transport: deps.transport?.name ?? null,
    };
    if (!deps.transport) return summary;

    const transport = deps.transport;
    for (const id of dueIds) {
      const token = `claim_${crypto.randomUUID()}`;
      const delivery = await deps.deliveries.claim(id, { token, now, leaseMs: EMAIL_CLAIM_LEASE_MS });
      if (!delivery) continue;
      summary.attempted += 1;

      let payload: TicketConfirmationPayload;
      try {
        payload = parsePayload(delivery.payload);
      } catch {
        // The payload is frozen; if it cannot be validated, retrying will not
        // help. Recorded as permanent rather than churned forever.
        await record(deps, summary, id, token, {
          class: 'permanent_failure',
          errorCode: 'payload_unreadable',
          errorMessage: 'Stored payload failed validation.',
        }, now, transport.name);
        continue;
      }

      let rendered;
      try {
        rendered = await renderTicketConfirmation(payload, deps.tokens());
      } catch (error) {
        // Nothing has left the process, so another attempt is safe once the
        // cause (for example a missing signing secret) is fixed.
        await record(deps, summary, id, token, {
          class: 'retryable',
          errorCode: 'render_failed',
          errorMessage: error instanceof Error ? error.name : 'unknown',
        }, now, transport.name);
        continue;
      }

      let result: TransportResult;
      try {
        result = await transport.send({
          to: delivery.recipient,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          attachments: rendered.attachments,
          idempotencyKey: delivery.idempotencyKey,
        });
      } catch (error) {
        // The adapter contract says results are translated, not thrown. If it
        // threw anyway we cannot know whether the provider saw the message,
        // so the truthful class is `ambiguous` — never `retryable`, which
        // could double-send.
        result = {
          class: 'ambiguous',
          errorCode: 'transport_threw',
          errorMessage: error instanceof Error ? error.name : 'unknown',
        };
      }

      await record(deps, summary, id, token, result, now, transport.name);
    }
    return summary;
  }

  return { run };
}

async function record(
  deps: EmailDeliveryPassDeps,
  summary: EmailDeliveryPassSummary,
  id: string,
  token: string,
  result: TransportResult,
  now: Date,
  providerName: string,
): Promise<void> {
  let applied: boolean;
  try {
    applied = await deps.deliveries.recordResult(id, token, result, { now, providerName });
  } catch (error) {
    // A recording failure must not abort the whole pass: the delivery stays
    // claimed until its lease expires and is then recovered like any other
    // abandoned attempt.
    console.warn(JSON.stringify({
      at: 'email-delivery',
      event: 'record-failed',
      kind: error instanceof Error ? error.name : 'unknown',
    }));
    return;
  }
  if (!applied) return; // The lease was lost mid-send; the reclaiming attempt owns it.
  switch (result.class) {
    case 'accepted':
      summary.accepted += 1;
      break;
    case 'retryable':
      summary.retryable += 1;
      break;
    case 'permanent_failure':
      summary.permanentFailures += 1;
      break;
    case 'ambiguous':
      summary.ambiguous += 1;
      break;
  }
}

class UnreadablePayloadError extends Error {}

function parsePayload(payload: string): TicketConfirmationPayload {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw new UnreadablePayloadError('email payload is not JSON');
  }
  if (!isTicketConfirmationPayload(value)) {
    throw new UnreadablePayloadError('email payload does not match the ticket-confirmation contract');
  }
  return value;
}
