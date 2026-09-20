/**
 * D1-backed AuditService (AMPED-03A) - READS ONLY.
 *
 * The dashboard's recent-activity feed. Reading the ledger is all this slice
 * does; writing audit entries begins with the admin mutations in AMPED-04B.
 * The log has no foreign keys by design, so it survives the rows it describes.
 */

import type { AuditLogRow } from '@/db/schema.ts';
import type { AuditLogEntry } from '@/types/domain.ts';

import type { AuditService } from '../contracts.ts';

const AUDIT_COLUMNS = [
  'id',
  'actor_email',
  'action',
  'entity_type',
  'entity_id',
  'summary',
  'occurred_at',
].join(', ');

const SELECT_RECENT_SQL =
  `select ${AUDIT_COLUMNS} from audit_log order by occurred_at desc, id asc limit ?1`;

class D1AuditService implements AuditService {
  constructor(private readonly db: D1Database) {}

  async listRecent(limit = 8): Promise<AuditLogEntry[]> {
    const { results } = await this.db.prepare(SELECT_RECENT_SQL).bind(limit).all<AuditLogRow>();
    return results.map((row) => ({
      id: row.id,
      actorEmail: row.actor_email,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      summary: row.summary,
      occurredAt: row.occurred_at,
    }));
  }
}

/** Build the D1 audit service against a resolved binding. */
export function createD1AuditService(db: D1Database): AuditService {
  return new D1AuditService(db);
}
