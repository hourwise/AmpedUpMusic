/**
 * D1-backed MailingListService (AMPED-03A) - READS ONLY.
 *
 * The admin list, its status counts, and the growth bars. Subscription,
 * unsubscribe and mail sending belong to AMPED-10B; this slice only reads what
 * the seed wrote, including unsubscribed and bounced rows, which are kept as
 * suppressions rather than deleted.
 *
 * `growth` is derived from `consent_at` - one point per calendar month that
 * has sign-ups, newest six. The scaffold's fixture growth series was invented
 * numbers with no table behind it; deriving the real monthly curve from the
 * rows that exist is the honest D1 equivalent, and the label uses the same
 * Europe/London month names the rest of the admin does.
 */

import type { MailingListRow } from '@/db/schema.ts';
import { formatShortDate } from '@/lib/dates.ts';
import type { MailingListSubscriber } from '@/types/domain.ts';
import type { SubscriberView } from '@/types/view.ts';

import type { MailingListService } from '../contracts.ts';

const SUBSCRIBER_COLUMNS = [
  'id',
  'email',
  'name',
  'status',
  'consent_source',
  'consent_at',
  'unsubscribed_at',
].join(', ');

const SELECT_SQL =
  `select ${SUBSCRIBER_COLUMNS} from mailing_list order by consent_at desc, id asc`;

const COUNTS_SQL = `
  select
    (select count(*) from mailing_list where status = 'subscribed') as subscribed,
    (select count(*) from mailing_list where status = 'unsubscribed') as unsubscribed,
    (select count(*) from mailing_list where status = 'bounced') as bounced
`;

const GROWTH_SQL = `
  select substr(consent_at, 1, 7) as month, count(*) as count
  from mailing_list
  group by month
  order by month asc
`;

interface GrowthRow {
  month: string;
  count: number;
}

function monthLabel(month: string): string {
  const [year, monthNumber] = month.split('-');
  const date = new Date(Date.UTC(Number(year), Number(monthNumber) - 1, 1));
  return new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' }).format(date);
}

function toSubscriber(row: MailingListRow): MailingListSubscriber {
  return {
    id: row.id,
    email: row.email,
    ...(row.name !== null ? { name: row.name } : {}),
    status: row.status,
    consentSource: row.consent_source,
    consentAt: row.consent_at,
    ...(row.unsubscribed_at !== null ? { unsubscribedAt: row.unsubscribed_at } : {}),
  };
}

class D1MailingListService implements MailingListService {
  constructor(private readonly db: D1Database) {}

  async list(): Promise<SubscriberView[]> {
    const { results } = await this.db.prepare(SELECT_SQL).all<MailingListRow>();
    return results.map((row) => ({
      subscriber: toSubscriber(row),
      joinedLabel: formatShortDate(row.consent_at),
    }));
  }

  async counts(): Promise<{ subscribed: number; unsubscribed: number; bounced: number }> {
    const row = await this.db
      .prepare(COUNTS_SQL)
      .first<{ subscribed: number; unsubscribed: number; bounced: number }>();
    return row ?? { subscribed: 0, unsubscribed: 0, bounced: 0 };
  }

  async growth(): Promise<ReadonlyArray<{ label: string; count: number }>> {
    const { results } = await this.db.prepare(GROWTH_SQL).all<GrowthRow>();
    return results.slice(-6).map((row) => ({ label: monthLabel(row.month), count: row.count }));
  }
}

/** Build the D1 mailing list service against a resolved binding. */
export function createD1MailingListService(db: D1Database): MailingListService {
  return new D1MailingListService(db);
}
