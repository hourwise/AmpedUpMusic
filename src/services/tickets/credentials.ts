import { newCredentialId } from './token.ts';

export const CREDENTIAL_RECOVERY_LIMIT = 25;

export interface CredentialRecoverySummary {
  examined: number;
  created: number;
  failures: number;
}

export interface TicketCredentialService {
  ensureTicketCredential(ticketId: string): Promise<string | null>;
  ensureForOrder(orderId: string): Promise<number>;
  recoverMissing(limit?: number): Promise<CredentialRecoverySummary>;
}

const ELIGIBLE_TICKET_SQL = `
  select t.credential_id from tickets t join orders o on o.id = t.order_id
  where t.id = ?1 and o.status = 'paid' and t.status in ('issued', 'checked_in')
`;

const SET_CREDENTIAL_SQL = `
  update tickets set credential_id = ?2
  where id = ?1 and credential_id is null and status in ('issued', 'checked_in')
    and exists (select 1 from orders o where o.id = tickets.order_id and o.status = 'paid')
`;

const MISSING_SQL = `
  select t.id from tickets t indexed by tickets_missing_credential_idx
  join orders o on o.id = t.order_id
  where t.credential_id is null and t.status in ('issued', 'checked_in')
    and o.status = 'paid'
  order by t.issued_at, t.id limit ?1
`;

export function createD1TicketCredentials(db: D1Database): TicketCredentialService {
  async function ensureTicketCredential(ticketId: string): Promise<string | null> {
    const existing = await db.prepare(ELIGIBLE_TICKET_SQL).bind(ticketId)
      .first<{ credential_id: string | null }>();
    if (!existing) return null;
    if (existing.credential_id) return existing.credential_id;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const candidate = newCredentialId();
      try {
        await db.prepare(SET_CREDENTIAL_SQL).bind(ticketId, candidate).run();
      } catch (error) {
        // A random collision is extraordinary, but the database UNIQUE index
        // is authoritative. A concurrent winner may also have written first.
        const winner = await db.prepare(ELIGIBLE_TICKET_SQL).bind(ticketId)
          .first<{ credential_id: string | null }>();
        if (winner?.credential_id) return winner.credential_id;
        if (attempt === 2) throw error;
        continue;
      }
      const winner = await db.prepare(ELIGIBLE_TICKET_SQL).bind(ticketId)
        .first<{ credential_id: string | null }>();
      if (winner?.credential_id) return winner.credential_id;
      return null; // Order ceased to be admissible between reads.
    }
    return null;
  }

  async function ensureForOrder(orderId: string): Promise<number> {
    const rows = await db.prepare(
      "select t.id from tickets t join orders o on o.id = t.order_id where o.id = ?1 and o.status = 'paid' and t.credential_id is null and t.status in ('issued', 'checked_in') order by t.id",
    ).bind(orderId).all<{ id: string }>();
    let created = 0;
    for (const row of rows.results) {
      if (await ensureTicketCredential(row.id)) created += 1;
    }
    return created;
  }

  async function recoverMissing(limit = CREDENTIAL_RECOVERY_LIMIT): Promise<CredentialRecoverySummary> {
    const bounded = Math.max(1, Math.min(CREDENTIAL_RECOVERY_LIMIT, Math.floor(limit)));
    const candidates = await db.prepare(MISSING_SQL).bind(bounded).all<{ id: string }>();
    const summary = { examined: candidates.results.length, created: 0, failures: 0 };
    for (const row of candidates.results) {
      try {
        if (await ensureTicketCredential(row.id)) summary.created += 1;
      } catch (error) {
        summary.failures += 1;
        console.warn(JSON.stringify({ at: 'ticket-credential', event: 'recovery-failed', kind: error instanceof Error ? error.name : 'unknown' }));
      }
    }
    return summary;
  }

  return { ensureTicketCredential, ensureForOrder, recoverMissing };
}
