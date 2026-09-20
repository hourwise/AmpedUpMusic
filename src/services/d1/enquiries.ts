/**
 * D1-backed EnquiryService (AMPED-03A) - READS ONLY.
 *
 * The admin inbox list and its "new" badge. Enquiry submission, Turnstile and
 * status changes belong to AMPED-10A, so nothing here writes.
 */

import type { EnquiryRow } from '@/db/schema.ts';
import { formatDateTime } from '@/lib/dates.ts';
import { ENQUIRY_KIND_LABEL } from '@/lib/text.ts';
import type { Enquiry, EnquiryStatus } from '@/types/domain.ts';
import type { EnquiryView } from '@/types/view.ts';

import type { EnquiryService } from '../contracts.ts';

const ENQUIRY_COLUMNS = [
  'id',
  'kind',
  'name',
  'email',
  'phone',
  'subject',
  'message',
  'links',
  'status',
  'bot_check_passed',
  'received_at',
].join(', ');

const SELECT_SQL =
  `select ${ENQUIRY_COLUMNS} from enquiries ` +
  "where (?1 = '' or status = ?1) order by received_at desc, id asc";

const COUNT_NEW_SQL = "select count(*) as n from enquiries where status = 'new'";

function toEnquiry(row: EnquiryRow): Enquiry {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    email: row.email,
    ...(row.phone !== null ? { phone: row.phone } : {}),
    ...(row.subject !== null ? { subject: row.subject } : {}),
    message: row.message,
    ...(row.links !== null ? { links: row.links } : {}),
    status: row.status,
    botCheckPassed: row.bot_check_passed === 1,
    receivedAt: row.received_at,
  };
}

class D1EnquiryService implements EnquiryService {
  constructor(private readonly db: D1Database) {}

  async list(status?: EnquiryStatus): Promise<EnquiryView[]> {
    const { results } = await this.db
      .prepare(SELECT_SQL)
      .bind(status ?? '')
      .all<EnquiryRow>();
    return results.map((row) => {
      const enquiry = toEnquiry(row);
      return {
        enquiry,
        kindLabel: ENQUIRY_KIND_LABEL[enquiry.kind],
        receivedLabel: formatDateTime(enquiry.receivedAt),
      };
    });
  }

  async countNew(): Promise<number> {
    const row = await this.db.prepare(COUNT_NEW_SQL).first<{ n: number }>();
    return row?.n ?? 0;
  }
}

/** Build the D1 enquiry service against a resolved binding. */
export function createD1EnquiryService(db: D1Database): EnquiryService {
  return new D1EnquiryService(db);
}
