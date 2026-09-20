/**
 * D1-backed SocialService (AMPED-03A).
 *
 * The operator curates this list by hand - no crawler, no oEmbed, no social
 * API, exactly as the contract says. Reads only: a post, its optional
 * thumbnail, the event it belongs to and the human network label.
 *
 * Ordering is by id, which is the insertion order the scaffold curated in, so
 * the homepage strip shows the same posts in the same order it did from
 * fixtures. `listFeatured` is sliced after ordering, matching the fixture
 * service.
 */

import type { SocialPostRow } from '@/db/schema.ts';
import { SOCIAL_LABEL } from '@/lib/text.ts';
import type { SocialPost } from '@/types/domain.ts';
import type { SocialPostView } from '@/types/view.ts';

import type { SocialService } from '../contracts.ts';

const POST_COLUMNS = [
  'id',
  'event_id',
  'network',
  'url',
  'caption',
  'thumbnail_asset_id',
  'posted_at',
  'featured',
].join(', ');

const SELECT_FEATURED_SQL =
  `select ${POST_COLUMNS} from social_posts where featured = 1 order by id asc limit ?1`;
const SELECT_FOR_EVENT_SQL =
  `select ${POST_COLUMNS} from social_posts where event_id = ?1 order by id asc`;

const SELECT_THUMBNAILS_SQL =
  'select id, url, alt from media_assets where id in (select value from json_each(?1))';
const SELECT_EVENT_TITLES_SQL =
  'select id, title from events where id in (select value from json_each(?1))';

interface ThumbnailRow {
  id: string;
  url: string;
  alt: string;
}
interface EventTitleRow {
  id: string;
  title: string;
}

function toSocialPost(row: SocialPostRow): SocialPost {
  return {
    id: row.id,
    ...(row.event_id !== null ? { eventId: row.event_id } : {}),
    network: row.network,
    url: row.url,
    ...(row.caption !== null ? { caption: row.caption } : {}),
    ...(row.thumbnail_asset_id !== null ? { thumbnailAssetId: row.thumbnail_asset_id } : {}),
    ...(row.posted_at !== null ? { postedAt: row.posted_at } : {}),
    featured: row.featured === 1,
  };
}

class D1SocialService implements SocialService {
  constructor(private readonly db: D1Database) {}

  async listFeatured(limit = 4): Promise<SocialPostView[]> {
    const { results } = await this.db.prepare(SELECT_FEATURED_SQL).bind(limit).all<SocialPostRow>();
    return this.toViews(results);
  }

  async listForEvent(eventId: string): Promise<SocialPostView[]> {
    const { results } = await this.db
      .prepare(SELECT_FOR_EVENT_SQL)
      .bind(eventId)
      .all<SocialPostRow>();
    return this.toViews(results);
  }

  /** Two bounded lookups for the whole batch, whatever its size. */
  private async toViews(rows: readonly SocialPostRow[]): Promise<SocialPostView[]> {
    if (rows.length === 0) return [];

    const thumbnailIds = [
      ...new Set(
        rows
          .map((row) => row.thumbnail_asset_id)
          .filter((id): id is string => id !== null),
      ),
    ];
    const thumbnails = new Map<string, ThumbnailRow>();
    if (thumbnailIds.length > 0) {
      const { results } = await this.db
        .prepare(SELECT_THUMBNAILS_SQL)
        .bind(JSON.stringify(thumbnailIds))
        .all<ThumbnailRow>();
      for (const row of results) thumbnails.set(row.id, row);
    }

    const eventIds = [
      ...new Set(rows.map((row) => row.event_id).filter((id): id is string => id !== null)),
    ];
    const eventTitles = new Map<string, string>();
    if (eventIds.length > 0) {
      const { results } = await this.db
        .prepare(SELECT_EVENT_TITLES_SQL)
        .bind(JSON.stringify(eventIds))
        .all<EventTitleRow>();
      for (const row of results) eventTitles.set(row.id, row.title);
    }

    return rows.map((row) => {
      const thumbnail = row.thumbnail_asset_id
        ? thumbnails.get(row.thumbnail_asset_id)
        : undefined;
      const eventTitle = row.event_id ? eventTitles.get(row.event_id) : undefined;
      return {
        post: toSocialPost(row),
        thumbnailUrl: thumbnail?.url,
        thumbnailAlt: thumbnail?.alt,
        eventTitle,
        networkLabel: SOCIAL_LABEL[row.network],
      };
    });
  }
}

/** Build the D1 social service against a resolved binding. */
export function createD1SocialService(db: D1Database): SocialService {
  return new D1SocialService(db);
}
