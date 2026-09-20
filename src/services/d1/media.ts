/**
 * D1-backed MediaService (AMPED-03A).
 *
 * Metadata only: the image files themselves stay where the scaffold put them
 * under public/media until AMPED-05A moves storage to R2. Nothing here uploads,
 * deletes or rewrites a storage key.
 *
 * Ordering reproduces the fixture service exactly:
 *  - `listGallery` walks events newest-first, then each event's gallery rows by
 *    id, which is the reverse-chronological archive the gallery page expects;
 *  - `listForEvent` keeps the poster/hero/gallery order the fixture array used,
 *    so the admin photo set reads the same way it did.
 */

import type { MediaAssetRow } from '@/db/schema.ts';
import type { MediaAsset } from '@/types/domain.ts';

import type { MediaService } from '../contracts.ts';
import { toMediaAsset } from './project.ts';

const MEDIA_COLUMNS = [
  'id',
  'storage_key',
  'url',
  'role',
  'alt',
  'width',
  'height',
  'mime_type',
  'byte_size',
  'credit',
  'event_id',
  'artist_id',
  'uploaded_at',
] as const;

function columns(prefix = ''): string {
  return MEDIA_COLUMNS.map((column) => (prefix ? `${prefix}.${column}` : column)).join(', ');
}

const SELECT_GALLERY_SQL =
  `select ${columns('m')} from media_assets m join events e on e.id = m.event_id ` +
  `where m.role = 'gallery' order by e.starts_at desc, m.id asc`;

const SELECT_FOR_EVENT_SQL =
  `select ${columns()} from media_assets where event_id = ?1 ` +
  `order by case role when 'poster' then 0 when 'hero' then 1 when 'gallery' then 2 ` +
  `when 'artist' then 3 when 'venue' then 4 else 5 end, id asc`;

const SELECT_BY_ID_SQL = `select ${columns()} from media_assets where id = ?1`;

class D1MediaService implements MediaService {
  constructor(private readonly db: D1Database) {}

  async listGallery(limit?: number): Promise<MediaAsset[]> {
    const { results } = await this.db.prepare(SELECT_GALLERY_SQL).all<MediaAssetRow>();
    const list = results.map(toMediaAsset);
    return limit === undefined ? list : list.slice(0, limit);
  }

  async listForEvent(eventId: string): Promise<MediaAsset[]> {
    const { results } = await this.db
      .prepare(SELECT_FOR_EVENT_SQL)
      .bind(eventId)
      .all<MediaAssetRow>();
    return results.map(toMediaAsset);
  }

  async get(id: string): Promise<MediaAsset | null> {
    const row = await this.db.prepare(SELECT_BY_ID_SQL).bind(id).first<MediaAssetRow>();
    return row ? toMediaAsset(row) : null;
  }
}

/** Build the D1 media service against a resolved binding. */
export function createD1MediaService(db: D1Database): MediaService {
  return new D1MediaService(db);
}
