import type { TicketTokenService } from './token.ts';

export type CheckInResult =
  | { outcome: 'admitted'; ticketId: string; checkedInAt: string }
  | { outcome: 'already_checked_in'; ticketId: string; checkedInAt: string }
  | { outcome: 'manual_review_required' | 'wrong_event' | 'not_eligible' | 'invalid_ticket' };

/** Explicit V1 order-level admission policy; unknown states fail closed. */
export function admissionOrderPolicy(status: string): 'eligible' | 'manual_review_required' | 'not_eligible' {
  if (status === 'paid') return 'eligible';
  if (status === 'partially_refunded') return 'manual_review_required';
  return 'not_eligible';
}

interface TicketAdmissionRow {
  id: string;
  event_id: string;
  status: string;
  checked_in_at: string | null;
  order_status: string;
  event_status: string;
}

const FIND_SQL = `
  select t.id, t.event_id, t.status, t.checked_in_at, o.status as order_status,
         e.status as event_status
  from tickets t join orders o on o.id = t.order_id join events e on e.id = t.event_id
  where t.credential_id = ?1
`;

const CHECK_IN_SQL = `
  update tickets set status = 'checked_in', checked_in_at = ?3
  where id = ?1 and credential_id = ?2 and event_id = ?4
    and status = 'issued' and checked_in_at is null
    and exists (select 1 from orders o where o.id = tickets.order_id and o.status = 'paid')
    and exists (select 1 from events e where e.id = tickets.event_id and e.status in ('published', 'completed'))
`;

const RECORD_SQL = `
  insert into checkins (id, ticket_id, event_id, operator_email, method, scanned_at)
  select 'chk_' || t.id, t.id, t.event_id, ?4, 'qr', ?3
  from tickets t where t.id = ?1 and t.credential_id = ?2
    and t.event_id = ?5 and t.status = 'checked_in' and t.checked_in_at = ?3
    and not exists (select 1 from checkins c where c.ticket_id = t.id)
`;

const AUDIT_SQL = `
  insert into audit_log (id, actor_email, action, entity_type, entity_id, summary, occurred_at)
  select 'aud_checkin_' || c.ticket_id, c.operator_email,
         'ticket.checked_in', 'ticket', c.ticket_id, 'Ticket admitted at door', c.scanned_at
  from checkins c where c.ticket_id = ?1 and c.scanned_at = ?2
    and not exists (select 1 from audit_log a
      where a.entity_type = 'ticket' and a.entity_id = c.ticket_id and a.action = 'ticket.checked_in')
`;

export function createD1TicketCheckIn(
  db: D1Database,
  tokens: TicketTokenService,
  now: () => Date = () => new Date(),
) {
  async function state(credentialId: string, eventId: string): Promise<CheckInResult> {
    const row = await db.prepare(FIND_SQL).bind(credentialId).first<TicketAdmissionRow>();
    if (!row) return { outcome: 'invalid_ticket' };
    if (row.event_id !== eventId) return { outcome: 'wrong_event' };
    const policy = admissionOrderPolicy(row.order_status);
    if (policy === 'manual_review_required') return { outcome: 'manual_review_required' };
    if (policy !== 'eligible' || !['published', 'completed'].includes(row.event_status) || row.status === 'void' || row.status === 'refunded') {
      return { outcome: 'not_eligible' };
    }
    if (row.status === 'checked_in' && row.checked_in_at) {
      return { outcome: 'already_checked_in', ticketId: row.id, checkedInAt: row.checked_in_at };
    }
    return { outcome: 'invalid_ticket' }; // Callers handle an issued ticket separately.
  }

  async function scan(token: string, eventId: string, operatorEmail: string): Promise<CheckInResult> {
    const verified = await tokens.verify(token);
    if (verified.outcome !== 'valid') return { outcome: 'invalid_ticket' };
    const row = await db.prepare(FIND_SQL).bind(verified.credentialId).first<TicketAdmissionRow>();
    if (!row) return { outcome: 'invalid_ticket' };
    if (row.event_id !== eventId) return { outcome: 'wrong_event' };
    const policy = admissionOrderPolicy(row.order_status);
    if (policy === 'manual_review_required') return { outcome: 'manual_review_required' };
    if (policy !== 'eligible' || !['published', 'completed'].includes(row.event_status) || row.status === 'void' || row.status === 'refunded') {
      return { outcome: 'not_eligible' };
    }
    if (row.status === 'checked_in' && row.checked_in_at) {
      return { outcome: 'already_checked_in', ticketId: row.id, checkedInAt: row.checked_in_at };
    }
    if (row.status !== 'issued' || row.checked_in_at !== null) return { outcome: 'not_eligible' };

    const at = now().toISOString();
    const results = await db.batch([
      db.prepare(CHECK_IN_SQL).bind(row.id, verified.credentialId, at, eventId),
      db.prepare(RECORD_SQL).bind(row.id, verified.credentialId, at, operatorEmail, eventId),
      db.prepare(AUDIT_SQL).bind(row.id, at),
    ]);
    if (Number(results[0]?.meta?.changes ?? 0) === 1) {
      return { outcome: 'admitted', ticketId: row.id, checkedInAt: at };
    }
    return state(verified.credentialId, eventId);
  }

  return { scan };
}
