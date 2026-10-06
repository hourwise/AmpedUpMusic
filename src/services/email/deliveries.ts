/**
 * The durable ticket-email outbox (AMPED-08C1).
 *
 * This is the store behind the delivery model. It owns five things and
 * nothing else:
 *
 *   1. Intent creation — a guarded INSERT that only ever lands for a paid,
 *      fully fulfilled, fully credentialised order, with one logical intent
 *      per (order, message type, version) enforced by a UNIQUE index.
 *   2. Bounded recovery — an indexed scan for completed orders that lack
 *      their intent, used by the scheduler after a crash window.
 *   3. The claim/lease primitive — D1 conditional state transitions with a
 *      fencing token, so concurrent workers cannot simultaneously own a
 *      delivery and an abandoned lease can be recovered safely.
 *   4. Result recording — the provider-independent outcome classes from
 *      ./transport.ts translated into state transitions with retry backoff.
 *   5. Operator reads — state counts and a bounded recent list.
 *
 * WHAT THIS FILE DOES NOT DO: it never sends anything, never calls a network,
 * never touches payment, inventory, ticket issuance or credentials. Email is
 * downstream evidence of a paid order, never an authority over one.
 *
 * Provider message ids are stored as evidence only. Local identity is always
 * the durable `id`; nothing here looks a delivery up by provider id.
 */

import type { EmailDeliveryRow } from '@/db/schema.ts';
import type { AgeRestriction } from '@/types/domain.ts';
import type { TransportResult } from './transport.ts';
import {
  TICKET_CONFIRMATION_CONTACT_EMAIL,
  TICKET_CONFIRMATION_MESSAGE_TYPE,
  TICKET_CONFIRMATION_TEMPLATE,
  TICKET_CONFIRMATION_VERSION,
  canonicalPayloadJson,
  payloadHash,
  ticketConfirmationIdempotencyKey,
  type TicketConfirmationPayload,
  type TicketConfirmationTicket,
} from './render.ts';

/** How many completed-but-missing intents one recovery pass creates. */
export const EMAIL_INTENT_RECOVERY_LIMIT = 25;
/** How many due deliveries one pass will look at. */
export const EMAIL_DUE_BATCH_LIMIT = 25;
/** How long one worker may hold a claim before it is considered abandoned. */
export const EMAIL_CLAIM_LEASE_MS = 5 * 60_000;
/** First retry delay; doubles per attempt up to the cap. */
export const EMAIL_RETRY_BASE_MS = 5 * 60_000;
export const EMAIL_RETRY_CAP_MS = 6 * 60 * 60_000;

export type EmailDeliveryState =
  | 'pending'
  | 'claimed'
  | 'accepted'
  | 'retryable'
  | 'permanent_failure'
  | 'ambiguous';

export type EmailDeliveryErrorClass = 'retryable' | 'permanent_failure' | 'ambiguous' | 'lease_expired';

export interface EmailDelivery {
  id: string;
  orderId: string;
  messageType: string;
  version: number;
  recipient: string;
  state: EmailDeliveryState;
  attemptCount: number;
  provider: string | null;
  providerMessageId: string | null;
  idempotencyKey: string;
  /** The frozen payload, exactly as hashed. */
  payload: string;
  payloadHash: string;
  createdAt: string;
  updatedAt: string;
  lastAttemptAt: string | null;
  acceptedAt: string | null;
  nextRetryAt: string | null;
  claimedAt: string | null;
  leaseExpiresAt: string | null;
  claimToken: string | null;
  lastErrorClass: EmailDeliveryErrorClass | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
}

export interface EnsureIntentResult {
  outcome: 'created' | 'exists' | 'not_eligible';
  deliveryId: string | null;
}

export interface EmailIntentRecoverySummary {
  examined: number;
  created: number;
  failures: number;
}

export interface ClaimOptions {
  /** Fencing token identifying this attempt. */
  token: string;
  now: Date;
  leaseMs?: number;
}

export interface RecordResultContext {
  now: Date;
  providerName: string;
}

export interface EmailDeliveryRecord {
  delivery: EmailDelivery;
  /** The human-quotable order reference, joined for the operator screen. */
  orderReference: string;
}

export interface EmailDeliveryService {
  /** Idempotent: returns `exists` when the logical intent is already present. */
  ensureConfirmationIntent(orderId: string, now?: Date): Promise<EnsureIntentResult>;
  /** Bounded crash recovery: finds completed orders lacking their intent. */
  recoverMissingIntents(limit?: number, now?: Date): Promise<EmailIntentRecoverySummary>;
  getDelivery(id: string): Promise<EmailDelivery | null>;
  findForOrder(orderId: string): Promise<EmailDelivery | null>;
  /** Due pending/retryable delivery ids, oldest first, bounded. */
  listDueIds(now: Date, limit?: number): Promise<string[]>;
  /**
   * Claim one delivery. `null` means it is not due, already owned, or was lost
   * to another worker — never "try anyway".
   */
  claim(id: string, options: ClaimOptions): Promise<EmailDelivery | null>;
  /** Flip expired claims back to retryable. Returns how many were recovered. */
  requeueAbandonedLeases(now: Date): Promise<number>;
  /**
   * Record a provider-independent result for the claim we hold. Returns false
   * when the claim was lost (stale worker) and nothing was written.
   */
  recordResult(id: string, token: string, result: TransportResult, context: RecordResultContext): Promise<boolean>;
  countByState(): Promise<Record<EmailDeliveryState, number>>;
  /** Newest first, joined to the order reference for the operator screen. */
  listRecent(limit?: number): Promise<EmailDeliveryRecord[]>;
}

/** Exponential backoff, capped. Attempt count is the post-increment value. */
export function retryDelayMs(attemptCount: number): number {
  const exponent = Math.max(0, attemptCount - 1);
  return Math.min(EMAIL_RETRY_BASE_MS * 2 ** exponent, EMAIL_RETRY_CAP_MS);
}

const COLUMNS = `id, order_id, message_type, version, recipient, state, attempt_count,
  provider, provider_message_id, idempotency_key, payload, payload_hash,
  created_at, updated_at, last_attempt_at, accepted_at, next_retry_at,
  claimed_at, lease_expires_at, claim_token, last_error_class, last_error_code,
  last_error_message`;

const FIND_FOR_ORDER_SQL = `
  select ${COLUMNS} from email_deliveries
  where order_id = ?1 and message_type = ?2 and version = ?3
`;

const GET_SQL = `select ${COLUMNS} from email_deliveries where id = ?1`;

const PRESENTATION_SQL = `
  select o.reference as order_reference, o.customer_email, o.status as order_status,
         o.tickets_fulfilled_at, e.title as event_title, e.doors_at, e.starts_at,
         e.age_restriction, v.name as venue_name, v.address_line1, v.address_line2,
         v.city, v.postcode
  from orders o
    join events e on e.id = o.event_id
    join venues v on v.id = e.venue_id
  where o.id = ?1
`;

const TICKETS_SQL = `
  select t.id, t.reference, t.credential_id,
         coalesce(i.ticket_type_name, tt.name, 'Ticket') as ticket_type_name
  from tickets t
    left join order_items i on i.id = t.order_item_id
    left join ticket_types tt on tt.id = t.ticket_type_id
  where t.order_id = ?1 and t.status in ('issued', 'checked_in')
  order by t.order_item_id, t.unit_ordinal, t.reference
`;

const EXPECTED_SQL = `select coalesce(sum(quantity), 0) as expected from order_items where order_id = ?1`;

// The eligibility predicates are repeated inside the INSERT, so a stale read
// can never insert an intent for an order that is not eligible at insert time.
// The unique logical index turns concurrent winners into `do nothing`.
const INSERT_INTENT_SQL = `
  insert into email_deliveries (
    id, order_id, message_type, version, recipient, state, attempt_count,
    idempotency_key, payload, payload_hash, created_at, updated_at
  )
  select ?1, o.id, ?7, ?8, o.customer_email, 'pending', 0, ?2, ?3, ?4, ?5, ?5
  from orders o
  where o.id = ?6
    and o.status = 'paid'
    and o.tickets_fulfilled_at is not null
    and (select count(*) from tickets t
          where t.order_id = o.id and t.status in ('issued', 'checked_in')) > 0
    and (select count(*) from tickets t
          where t.order_id = o.id and t.status in ('issued', 'checked_in'))
        = (select coalesce(sum(i.quantity), 0) from order_items i where i.order_id = o.id)
    and not exists (select 1 from tickets t
          where t.order_id = o.id and t.status in ('issued', 'checked_in')
            and t.credential_id is null)
  on conflict (order_id, message_type, version) do nothing
`;

const CANDIDATES_SQL = `
  select o.id from orders o indexed by orders_email_intent_missing_idx
  where o.status = 'paid' and o.tickets_fulfilled_at is not null
    and not exists (select 1 from email_deliveries d
      where d.order_id = o.id and d.message_type = ?1 and d.version = ?2)
    and exists (select 1 from tickets t
      where t.order_id = o.id and t.status in ('issued', 'checked_in'))
    and (select count(*) from tickets t
          where t.order_id = o.id and t.status in ('issued', 'checked_in'))
        = (select coalesce(sum(i.quantity), 0) from order_items i where i.order_id = o.id)
    and not exists (select 1 from tickets t
      where t.order_id = o.id and t.status in ('issued', 'checked_in')
        and t.credential_id is null)
  order by o.paid_at, o.id
  limit ?3
`;

const DUE_SQL = `
  select id from email_deliveries indexed by email_deliveries_due_idx
  where state in ('pending', 'retryable')
    and (next_retry_at is null or next_retry_at <= ?1)
  order by coalesce(next_retry_at, created_at), created_at, id
  limit ?2
`;

const CLAIM_SQL = `
  update email_deliveries
  set state = 'claimed', attempt_count = attempt_count + 1,
      claimed_at = ?3, lease_expires_at = ?4, last_attempt_at = ?3,
      updated_at = ?3, claim_token = ?2, next_retry_at = null
  where id = ?1 and (
    (state in ('pending', 'retryable')
      and (next_retry_at is null or next_retry_at <= ?3))
    or (state = 'claimed'
      and (lease_expires_at is null or lease_expires_at <= ?3))
  )
`;

const REQUEUE_LEASE_SQL = `
  update email_deliveries
  set state = 'retryable', last_error_class = 'lease_expired',
      next_retry_at = ?1, updated_at = ?1,
      claim_token = null, claimed_at = null, lease_expires_at = null
  where state = 'claimed' and lease_expires_at is not null and lease_expires_at <= ?1
`;

const OWNED_SQL = `
  select attempt_count from email_deliveries
  where id = ?1 and claim_token = ?2 and state = 'claimed'
`;

const ACCEPT_SQL = `
  update email_deliveries
  set state = 'accepted', accepted_at = ?3, provider = ?4, provider_message_id = ?5,
      last_error_class = null, last_error_code = null, last_error_message = null,
      next_retry_at = null, updated_at = ?3,
      claim_token = null, claimed_at = null, lease_expires_at = null
  where id = ?1 and claim_token = ?2 and state = 'claimed'
`;

const RETRY_SQL = `
  update email_deliveries
  set state = 'retryable', next_retry_at = ?3, last_error_class = 'retryable',
      last_error_code = ?4, last_error_message = ?5, updated_at = ?6,
      claim_token = null, claimed_at = null, lease_expires_at = null
  where id = ?1 and claim_token = ?2 and state = 'claimed'
`;

const FAIL_SQL = `
  update email_deliveries
  set state = 'permanent_failure', next_retry_at = null,
      last_error_class = 'permanent_failure', last_error_code = ?3,
      last_error_message = ?4, updated_at = ?5,
      claim_token = null, claimed_at = null, lease_expires_at = null
  where id = ?1 and claim_token = ?2 and state = 'claimed'
`;

const AMBIGUOUS_SQL = `
  update email_deliveries
  set state = 'ambiguous', next_retry_at = null,
      last_error_class = 'ambiguous', last_error_code = ?3,
      last_error_message = ?4, updated_at = ?5,
      claim_token = null, claimed_at = null, lease_expires_at = null
  where id = ?1 and claim_token = ?2 and state = 'claimed'
`;

const COUNT_SQL = `select state, count(*) as n from email_deliveries group by state`;

const RECENT_SQL = `
  select d.id, d.order_id, d.message_type, d.version, d.recipient, d.state,
    d.attempt_count, d.provider, d.provider_message_id, d.idempotency_key,
    d.payload, d.payload_hash, d.created_at, d.updated_at, d.last_attempt_at,
    d.accepted_at, d.next_retry_at, d.claimed_at, d.lease_expires_at,
    d.claim_token, d.last_error_class, d.last_error_code, d.last_error_message,
    o.reference as order_reference
  from email_deliveries d
    join orders o on o.id = d.order_id
  order by d.created_at desc, d.id desc
  limit ?1
`;

const ALL_STATES: readonly EmailDeliveryState[] = [
  'pending',
  'claimed',
  'accepted',
  'retryable',
  'permanent_failure',
  'ambiguous',
];

interface PresentationRow {
  order_reference: string;
  customer_email: string;
  order_status: string;
  tickets_fulfilled_at: string | null;
  event_title: string;
  doors_at: string;
  starts_at: string;
  age_restriction: AgeRestriction;
  venue_name: string;
  address_line1: string;
  address_line2: string | null;
  city: string;
  postcode: string;
}

interface TicketRow {
  id: string;
  reference: string;
  credential_id: string | null;
  ticket_type_name: string;
}

export function createD1EmailDeliveries(db: D1Database): EmailDeliveryService {
  async function findForOrder(orderId: string): Promise<EmailDelivery | null> {
    const row = await db
      .prepare(FIND_FOR_ORDER_SQL)
      .bind(orderId, TICKET_CONFIRMATION_MESSAGE_TYPE, TICKET_CONFIRMATION_VERSION)
      .first<EmailDeliveryRow>();
    return row ? toDelivery(row) : null;
  }

  async function getDelivery(id: string): Promise<EmailDelivery | null> {
    const row = await db.prepare(GET_SQL).bind(id).first<EmailDeliveryRow>();
    return row ? toDelivery(row) : null;
  }

  async function ensureConfirmationIntent(orderId: string, now: Date = new Date()): Promise<EnsureIntentResult> {
    const existing = await findForOrder(orderId);
    if (existing) return { outcome: 'exists', deliveryId: existing.id };

    const presentation = await db.prepare(PRESENTATION_SQL).bind(orderId).first<PresentationRow>();
    if (!presentation) return { outcome: 'not_eligible', deliveryId: null };

    const [tickets, expected] = await Promise.all([
      db.prepare(TICKETS_SQL).bind(orderId).all<TicketRow>(),
      db.prepare(EXPECTED_SQL).bind(orderId).first<{ expected: number }>(),
    ]);

    const complete =
      presentation.order_status === 'paid' &&
      presentation.tickets_fulfilled_at !== null &&
      tickets.results.length > 0 &&
      tickets.results.length === Number(expected?.expected ?? 0) &&
      tickets.results.every((ticket) => ticket.credential_id !== null);
    if (!complete) return { outcome: 'not_eligible', deliveryId: null };

    const payload = buildPayload(presentation, tickets.results);
    const json = canonicalPayloadJson(payload);
    const hash = await payloadHash(json);
    const id = `eml_${orderId}_ticket_confirmation_v1`;

    const inserted = await db
      .prepare(INSERT_INTENT_SQL)
      .bind(
        id,
        ticketConfirmationIdempotencyKey(orderId),
        json,
        hash,
        now.toISOString(),
        orderId,
        TICKET_CONFIRMATION_MESSAGE_TYPE,
        TICKET_CONFIRMATION_VERSION,
      )
      .run();
    if (Number(inserted.meta.changes ?? 0) === 1) {
      return { outcome: 'created', deliveryId: id };
    }

    // Another worker won the race, or eligibility changed between the read
    // and the guarded insert. Either way nothing was duplicated.
    const winner = await findForOrder(orderId);
    return winner
      ? { outcome: 'exists', deliveryId: winner.id }
      : { outcome: 'not_eligible', deliveryId: null };
  }

  async function recoverMissingIntents(
    limit: number = EMAIL_INTENT_RECOVERY_LIMIT,
    now: Date = new Date(),
  ): Promise<EmailIntentRecoverySummary> {
    const bounded = Math.max(1, Math.min(EMAIL_INTENT_RECOVERY_LIMIT, Math.floor(limit)));
    const candidates = await db
      .prepare(CANDIDATES_SQL)
      .bind(TICKET_CONFIRMATION_MESSAGE_TYPE, TICKET_CONFIRMATION_VERSION, bounded)
      .all<{ id: string }>();
    const summary: EmailIntentRecoverySummary = {
      examined: candidates.results.length,
      created: 0,
      failures: 0,
    };
    for (const candidate of candidates.results) {
      try {
        const result = await ensureConfirmationIntent(candidate.id, now);
        if (result.outcome === 'created') summary.created += 1;
      } catch (error) {
        summary.failures += 1;
        console.warn(JSON.stringify({
          at: 'email-intent',
          event: 'recovery-failed',
          kind: error instanceof Error ? error.name : 'unknown',
        }));
      }
    }
    return summary;
  }

  async function listDueIds(now: Date, limit: number = EMAIL_DUE_BATCH_LIMIT): Promise<string[]> {
    const bounded = Math.max(1, Math.min(EMAIL_DUE_BATCH_LIMIT, Math.floor(limit)));
    const rows = await db
      .prepare(DUE_SQL)
      .bind(now.toISOString(), bounded)
      .all<{ id: string }>();
    return rows.results.map((row) => row.id);
  }

  async function claim(id: string, options: ClaimOptions): Promise<EmailDelivery | null> {
    const at = options.now.toISOString();
    const leaseUntil = new Date(options.now.getTime() + (options.leaseMs ?? EMAIL_CLAIM_LEASE_MS)).toISOString();
    const result = await db
      .prepare(CLAIM_SQL)
      .bind(id, options.token, at, leaseUntil)
      .run();
    if (Number(result.meta.changes ?? 0) !== 1) return null;
    return getDelivery(id);
  }

  async function requeueAbandonedLeases(now: Date): Promise<number> {
    const result = await db.prepare(REQUEUE_LEASE_SQL).bind(now.toISOString()).run();
    return Number(result.meta.changes ?? 0);
  }

  async function recordResult(
    id: string,
    token: string,
    result: TransportResult,
    context: RecordResultContext,
  ): Promise<boolean> {
    const owned = await db.prepare(OWNED_SQL).bind(id, token).first<{ attempt_count: number }>();
    if (!owned) return false;

    const at = context.now.toISOString();
    const code = result.errorCode ? result.errorCode.slice(0, 120) : null;
    const message = result.errorMessage ? result.errorMessage.slice(0, 500) : null;

    let applied: D1Result;
    switch (result.class) {
      case 'accepted':
        applied = await db
          .prepare(ACCEPT_SQL)
          .bind(id, token, at, context.providerName, result.providerMessageId ?? null)
          .run();
        break;
      case 'retryable': {
        const delay = result.retryAfterMs && result.retryAfterMs > 0
          ? Math.min(result.retryAfterMs, EMAIL_RETRY_CAP_MS)
          : retryDelayMs(owned.attempt_count);
        const nextRetryAt = new Date(context.now.getTime() + delay).toISOString();
        applied = await db.prepare(RETRY_SQL).bind(id, token, nextRetryAt, code, message, at).run();
        break;
      }
      case 'permanent_failure':
        applied = await db.prepare(FAIL_SQL).bind(id, token, code, message, at).run();
        break;
      case 'ambiguous':
        applied = await db.prepare(AMBIGUOUS_SQL).bind(id, token, code, message, at).run();
        break;
    }
    return Number(applied.meta.changes ?? 0) === 1;
  }

  async function countByState(): Promise<Record<EmailDeliveryState, number>> {
    const rows = await db.prepare(COUNT_SQL).all<{ state: EmailDeliveryState; n: number }>();
    const counts = Object.fromEntries(ALL_STATES.map((state) => [state, 0])) as Record<EmailDeliveryState, number>;
    for (const row of rows.results) counts[row.state] = Number(row.n);
    return counts;
  }

  async function listRecent(limit = 100): Promise<EmailDeliveryRecord[]> {
    const bounded = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = await db
      .prepare(RECENT_SQL)
      .bind(bounded)
      .all<EmailDeliveryRow & { order_reference: string }>();
    return rows.results.map((row) => ({
      delivery: toDelivery(row),
      orderReference: row.order_reference,
    }));
  }

  return {
    ensureConfirmationIntent,
    recoverMissingIntents,
    getDelivery,
    findForOrder,
    listDueIds,
    claim,
    requeueAbandonedLeases,
    recordResult,
    countByState,
    listRecent,
  };
}

function buildPayload(
  presentation: PresentationRow,
  tickets: TicketRow[],
): TicketConfirmationPayload {
  const frozenTickets: TicketConfirmationTicket[] = tickets.map((ticket) => ({
    ticketId: ticket.id,
    reference: ticket.reference,
    ticketTypeName: ticket.ticket_type_name,
    credentialId: ticket.credential_id!,
  }));
  return {
    messageType: TICKET_CONFIRMATION_MESSAGE_TYPE,
    version: TICKET_CONFIRMATION_VERSION,
    template: TICKET_CONFIRMATION_TEMPLATE,
    orderReference: presentation.order_reference,
    recipient: presentation.customer_email,
    event: {
      title: presentation.event_title,
      doorsAt: presentation.doors_at,
      startsAt: presentation.starts_at,
      ageRestriction: presentation.age_restriction,
      timeZone: 'Europe/London',
    },
    venue: {
      name: presentation.venue_name,
      addressLine1: presentation.address_line1,
      addressLine2: presentation.address_line2,
      city: presentation.city,
      postcode: presentation.postcode,
    },
    tickets: frozenTickets,
    contactEmail: TICKET_CONFIRMATION_CONTACT_EMAIL,
  };
}

function toDelivery(row: EmailDeliveryRow): EmailDelivery {
  return {
    id: row.id,
    orderId: row.order_id,
    messageType: row.message_type,
    version: row.version,
    recipient: row.recipient,
    state: row.state,
    attemptCount: row.attempt_count,
    provider: row.provider,
    providerMessageId: row.provider_message_id,
    idempotencyKey: row.idempotency_key,
    payload: row.payload,
    payloadHash: row.payload_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAttemptAt: row.last_attempt_at,
    acceptedAt: row.accepted_at,
    nextRetryAt: row.next_retry_at,
    claimedAt: row.claimed_at,
    leaseExpiresAt: row.lease_expires_at,
    claimToken: row.claim_token,
    lastErrorClass: row.last_error_class,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
  };
}
