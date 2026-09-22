/**
 * D1-backed MediaService (AMPED-03A reads, AMPED-05A writes).
 *
 * Reads are the AMPED-03A behaviour, unchanged. AMPED-05A adds upload,
 * attachment and delete on top of an R2 object store injected here, so no route
 * ever touches a Cloudflare binding directly.
 *
 * R2 and D1 do not share a transaction. The write path is therefore
 * compensating, not atomic:
 *   upload:  put object -> D1 batch (row + attachment + audit) -> on D1 failure
 *            delete the object we just wrote;
 *   delete:  read row -> buffer object -> delete object -> D1 batch (delete row
 *            + audit) -> on D1 failure put the buffered object back.
 * A failure is surfaced, never reported as success.
 */

import type { MediaAssetRow } from '@/db/schema.ts';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/validation.ts';
import { mediaUrlFor, storageKeyFor, type ValidatedUpload } from '@/lib/upload.ts';
import type { MediaAsset } from '@/types/domain.ts';

import type { MediaService } from '../contracts.ts';
import type { GigOperator } from './events.ts';
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

/**
 * Gallery reads also fetch `gallery_position` (AMPED-05B0/05B). The canonical
 * order is: explicit positions first, ascending; legacy NULL rows after them in
 * their historical id order. Before any operator has managed a gallery every
 * row is NULL, so the order is exactly the id order the site always used.
 */
const GALLERY_ORDER_SQL =
  'order by case when gallery_position is null then 1 else 0 end, gallery_position asc, id asc';

const SELECT_GALLERY_SQL =
  `select ${columns('m')}, m.gallery_position as gallery_position from media_assets m ` +
  `join events e on e.id = m.event_id where m.role = 'gallery' ` +
  `order by e.starts_at desc, ` +
  `case when m.gallery_position is null then 1 else 0 end, m.gallery_position asc, m.id asc`;

const SELECT_FOR_EVENT_SQL =
  `select ${columns()}, gallery_position from media_assets where event_id = ?1 ` +
  `order by case role when 'poster' then 0 when 'hero' then 1 when 'gallery' then 2 ` +
  `when 'artist' then 3 when 'venue' then 4 else 5 end, ` +
  `case when gallery_position is null then 1 else 0 end, gallery_position asc, id asc`;

const SELECT_BY_ID_SQL = `select ${columns()}, gallery_position from media_assets where id = ?1`;

const SELECT_GALLERY_FOR_EVENTS_SQL =
  `select ${columns()}, gallery_position from media_assets ` +
  `where role = 'gallery' and event_id in (select value from json_each(?1)) ` +
  `order by event_id, case when gallery_position is null then 1 else 0 end, gallery_position asc, id asc`;

type MediaRow = MediaAssetRow & { gallery_position: number | null };

class D1MediaService implements MediaService {
  constructor(private readonly db: D1Database) {}

  async listGallery(limit?: number): Promise<MediaAsset[]> {
    const { results } = await this.db.prepare(SELECT_GALLERY_SQL).all<MediaRow>();
    const list = results.map(toMediaAsset);
    return limit === undefined ? list : list.slice(0, limit);
  }

  async listForEvent(eventId: string): Promise<MediaAsset[]> {
    const { results } = await this.db
      .prepare(SELECT_FOR_EVENT_SQL)
      .bind(eventId)
      .all<MediaRow>();
    return results.map(toMediaAsset);
  }

  async get(id: string): Promise<MediaAsset | null> {
    const row = await this.db.prepare(SELECT_BY_ID_SQL).bind(id).first<MediaRow>();
    return row ? toMediaAsset(row) : null;
  }
}

/** Build the D1 media service against a resolved binding. */
export function createD1MediaService(db: D1Database): MediaService {
  return new D1MediaService(db);
}

// ---------------------------------------------------------------------------
// AMPED-05A - object storage
// ---------------------------------------------------------------------------

/** The slice of R2 the media service needs. Injected so tests can use a seam. */
export interface ObjectStore {
  put(key: string, bytes: Uint8Array, mime: string): Promise<void>;
  getBytes(key: string): Promise<Uint8Array | null>;
  getStream(key: string): Promise<{ body: ReadableStream; size: number } | null>;
  delete(key: string): Promise<void>;
}

/** The real store, backed by the MEDIA R2 binding. */
export function createR2ObjectStore(bucket: R2Bucket): ObjectStore {
  return {
    async put(key, bytes, mime) {
      await bucket.put(key, bytes, { httpMetadata: { contentType: mime } });
    },
    async getBytes(key) {
      const object = await bucket.get(key);
      return object ? new Uint8Array(await object.arrayBuffer()) : null;
    },
    async getStream(key) {
      const object = await bucket.get(key);
      if (!object) return null;
      return { body: object.body, size: object.size };
    },
    async delete(key) {
      await bucket.delete(key);
    },
  };
}

export interface MediaObject {
  body: ReadableStream;
  mime: string;
  byteSize: number;
}

/** Only real web links are accepted for photography metadata (AMPED-05B). */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** AMPED-05B batch bounds. Individual files remain capped at 8 MiB by 05A. */
export const MAX_FILES_PER_GALLERY_BATCH = 10;
export const MAX_TOTAL_BATCH_BYTES = 40 * 1024 * 1024;

export interface PhotographyFields {
  credit?: string;
  galleryUrl?: string;
  photographerUrl?: string;
}

export interface MediaMutationService {
  upload(input: ValidatedUpload, operator: GigOperator): Promise<{ id: string; url: string }>;
  remove(id: string, operator: GigOperator): Promise<void>;
  /** Public delivery: metadata lookup plus the object body, or null. */
  getObject(id: string): Promise<MediaObject | null>;
  /** AMPED-05B: upload a whole gallery batch in one operator action. */
  uploadGalleryBatch(
    eventId: string,
    items: readonly ValidatedUpload[],
    operator: GigOperator,
  ): Promise<{ ids: string[]; positions: number[] }>;
  /** AMPED-05B: gallery assets for several events, each in persisted order. */
  listGalleryForEvents(eventIds: readonly string[]): Promise<Map<string, MediaAsset[]>>;
  /** AMPED-05B: replace the explicit order of one event's gallery. */
  reorderGallery(eventId: string, assetIds: readonly string[], operator: GigOperator): Promise<void>;
  /** AMPED-05B: update only the event photography columns. */
  updatePhotography(eventId: string, fields: PhotographyFields, operator: GigOperator): Promise<void>;
}

type IdFactory = (prefix: string) => string;
const defaultId: IdFactory = (prefix) => `${prefix}_${crypto.randomUUID()}`;

const SELECT_GALLERY_ROWS_SQL =
  `select id, gallery_position from media_assets where role = 'gallery' and event_id = ?1 ` +
  GALLERY_ORDER_SQL;
const UPDATE_GALLERY_POSITION_SQL =
  "update media_assets set gallery_position = ?1 where id = ?2 and role = 'gallery' and event_id = ?3";
const UPDATE_PHOTOGRAPHY_SQL =
  'update events set photography_credit = ?1, photography_gallery_url = ?2, ' +
  'photography_photographer_url = ?3, updated_at = ?4 where id = ?5';

const INSERT_MEDIA_SQL =
  'insert into media_assets (id, storage_key, url, role, alt, width, height, mime_type, byte_size, credit, event_id, artist_id, uploaded_at) ' +
  'values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)';
const DELETE_MEDIA_SQL = 'delete from media_assets where id = ?1';
const AUDIT_SQL =
  'insert into audit_log (id, actor_email, action, entity_type, entity_id, summary, occurred_at) ' +
  'values (?1, ?2, ?3, ?4, ?5, ?6, ?7)';

class D1MediaMutations implements MediaMutationService {
  private lastStamp = 0;

  constructor(
    private readonly db: D1Database,
    private readonly objects: ObjectStore,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: IdFactory = defaultId,
  ) {}

  async upload(input: ValidatedUpload, operator: GigOperator): Promise<{ id: string; url: string }> {
    if (input.eventId) {
      const event = await this.db
        .prepare('select 1 as ok from events where id = ?1')
        .bind(input.eventId)
        .first<{ ok: number }>();
      if (!event) throw new ValidationError({ eventId: 'That gig does not exist.' });
    }
    if (input.artistId) {
      const artist = await this.db
        .prepare('select 1 as ok from artists where id = ?1')
        .bind(input.artistId)
        .first<{ ok: number }>();
      if (!artist) throw new ValidationError({ artistId: 'That artist does not exist.' });
    }

    const id = this.newId('med');
    const key = storageKeyFor(id, input.mime);
    const url = mediaUrlFor(id);
    const at = this.stamp();

    await this.objects.put(key, input.bytes, input.mime);

    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(INSERT_MEDIA_SQL)
        .bind(
          id,
          key,
          url,
          input.role,
          input.alt,
          input.width,
          input.height,
          input.mime,
          input.byteSize,
          input.credit ?? null,
          input.eventId ?? null,
          input.artistId ?? null,
          at,
        ),
      this.audit(this.newId('aud'), operator.email, 'media.uploaded', id, `Uploaded ${input.role} image`, at),
    ];

    // Poster/hero on an event also moves the event's artwork pointer, in the
    // same D1 batch so the pointer can never reference a missing row.
    const pointerColumn =
      input.role === 'poster' ? 'poster_asset_id' : input.role === 'hero' ? 'hero_asset_id' : null;
    if (pointerColumn && input.eventId) {
      statements.push(
        this.db
          .prepare(`update events set ${pointerColumn} = ?1, updated_at = ?2 where id = ?3`)
          .bind(id, at, input.eventId),
      );
      statements.push(
        this.audit(
          this.newId('aud'),
          operator.email,
          'media.attached',
          id,
          `Attached ${input.role} to ${input.eventId}`,
          at,
        ),
      );
    }

    try {
      await this.db.batch(statements);
    } catch (error) {
      // Compensate: no D1 row means the object must not linger.
      await this.objects.delete(key);
      throw error;
    }

    return { id, url };
  }

  async remove(id: string, operator: GigOperator): Promise<void> {
    const row = await this.db.prepare(SELECT_BY_ID_SQL).bind(id).first<MediaAssetRow>();
    if (!row) throw new NotFoundError('That media asset does not exist.');

    const bytes = await this.objects.getBytes(row.storage_key);
    await this.objects.delete(row.storage_key);

    const at = this.stamp();
    try {
      await this.db.batch([
        this.db.prepare(DELETE_MEDIA_SQL).bind(id),
        this.audit(this.newId('aud'), operator.email, 'media.deleted', id, `Deleted media ${id}`, at),
      ]);
    } catch (error) {
      // Restore the object so D1 and R2 still agree.
      if (bytes) await this.objects.put(row.storage_key, bytes, row.mime_type);
      throw error;
    }
  }

  async getObject(id: string): Promise<MediaObject | null> {
    const row = await this.db.prepare(SELECT_BY_ID_SQL).bind(id).first<MediaAssetRow>();
    if (!row) return null;
    const object = await this.objects.getStream(row.storage_key);
    if (!object) return null;
    return { body: object.body, mime: row.mime_type, byteSize: row.byte_size ?? object.size };
  }

  async uploadGalleryBatch(
    eventId: string,
    items: readonly ValidatedUpload[],
    operator: GigOperator,
  ): Promise<{ ids: string[]; positions: number[] }> {
    if (items.length === 0) {
      throw new ValidationError({ files: 'Choose at least one photograph.' });
    }
    if (items.length > MAX_FILES_PER_GALLERY_BATCH) {
      throw new ValidationError({
        files: `Upload up to ${MAX_FILES_PER_GALLERY_BATCH} photographs at a time.`,
      });
    }
    const totalBytes = items.reduce((sum, item) => sum + item.byteSize, 0);
    if (totalBytes > MAX_TOTAL_BATCH_BYTES) {
      throw new ValidationError({ files: 'That batch is larger than 40 MiB.' });
    }
    for (const item of items) {
      if (item.role !== 'gallery') {
        throw new ValidationError({ role: 'Gallery uploads must use the gallery role.' });
      }
    }

    const event = await this.db
      .prepare('select 1 as ok from events where id = ?1')
      .bind(eventId)
      .first<{ ok: number }>();
    if (!event) throw new ValidationError({ eventId: 'That gig does not exist.' });

    // Normalise legacy NULL positions on the first managed operation: the
    // existing rows keep their current display order and become 0..n-1.
    const existing = (
      await this.db.prepare(SELECT_GALLERY_ROWS_SQL).bind(eventId).all<{
        id: string;
        gallery_position: number | null;
      }>()
    ).results;
    const normalise: D1PreparedStatement[] = [];
    let next = 0;
    if (existing.some((row) => row.gallery_position === null)) {
      existing.forEach((row, index) => {
        normalise.push(this.db.prepare(UPDATE_GALLERY_POSITION_SQL).bind(index, row.id, eventId));
      });
      next = existing.length;
    } else {
      next = existing.reduce((max, row) => Math.max(max, row.gallery_position ?? 0) + 1, 0);
    }

    const allocated = items.map((item, index) => {
      const id = this.newId('med');
      return { id, key: storageKeyFor(id, item.mime), item, position: next + index };
    });

    const written: { key: string }[] = [];
    try {
      for (const entry of allocated) {
        await this.objects.put(entry.key, entry.item.bytes, entry.item.mime);
        written.push({ key: entry.key });
      }
    } catch (error) {
      await this.rollbackObjects(written);
      throw error;
    }

    const at = this.stamp();
    const statements: D1PreparedStatement[] = [...normalise];
    allocated.forEach((entry) => {
      statements.push(
        this.db
          .prepare(INSERT_MEDIA_SQL)
          .bind(
            entry.id,
            entry.key,
            mediaUrlFor(entry.id),
            'gallery',
            entry.item.alt,
            entry.item.width,
            entry.item.height,
            entry.item.mime,
            entry.item.byteSize,
            entry.item.credit ?? null,
            eventId,
            null,
            at,
          ),
      );
      statements.push(
        this.db
          .prepare('update media_assets set gallery_position = ?1 where id = ?2')
          .bind(entry.position, entry.id),
      );
      statements.push(
        this.audit(
          this.newId('aud'),
          operator.email,
          'media.uploaded',
          entry.id,
          `Uploaded gallery image for ${eventId}`,
          at,
        ),
      );
    });
    statements.push(
      this.audit(
        this.newId('aud'),
        operator.email,
        'gallery.uploaded',
        eventId,
        `Uploaded ${allocated.length} gallery image(s) to ${eventId}`,
        at,
      ),
    );

    try {
      await this.db.batch(statements);
    } catch (error) {
      await this.rollbackObjects(written);
      throw error;
    }

    return {
      ids: allocated.map((entry) => entry.id),
      positions: allocated.map((entry) => entry.position),
    };
  }

  async listGalleryForEvents(eventIds: readonly string[]): Promise<Map<string, MediaAsset[]>> {
    const grouped = new Map<string, MediaAsset[]>();
    if (eventIds.length === 0) return grouped;
    const { results } = await this.db
      .prepare(SELECT_GALLERY_FOR_EVENTS_SQL)
      .bind(JSON.stringify(eventIds))
      .all<MediaRow>();
    for (const row of results) {
      if (!row.event_id) continue;
      const list = grouped.get(row.event_id);
      if (list) list.push(toMediaAsset(row));
      else grouped.set(row.event_id, [toMediaAsset(row)]);
    }
    return grouped;
  }

  async reorderGallery(
    eventId: string,
    assetIds: readonly string[],
    operator: GigOperator,
  ): Promise<void> {
    const current = (
      await this.db.prepare(SELECT_GALLERY_ROWS_SQL).bind(eventId).all<{ id: string }>()
    ).results.map((row) => row.id);

    if (new Set(assetIds).size !== assetIds.length) {
      throw new ValidationError({ assetIds: 'Each photograph may appear only once.' });
    }
    if (assetIds.length !== current.length) {
      throw new ConflictError('This gallery has changed. Reload and try again.');
    }
    const currentSet = new Set(current);
    if (assetIds.some((id) => !currentSet.has(id))) {
      throw new ConflictError('This gallery has changed. Reload and try again.');
    }

    const at = this.stamp();
    const statements: D1PreparedStatement[] = assetIds.map((id, index) =>
      this.db.prepare(UPDATE_GALLERY_POSITION_SQL).bind(index, id, eventId),
    );
    statements.push(
      this.audit(
        this.newId('aud'),
        operator.email,
        'gallery.reordered',
        eventId,
        `Reordered ${assetIds.length} gallery image(s) for ${eventId}`,
        at,
      ),
    );
    await this.db.batch(statements);
  }

  async updatePhotography(
    eventId: string,
    fields: PhotographyFields,
    operator: GigOperator,
  ): Promise<void> {
    const event = await this.db
      .prepare(
        'select photography_credit, photography_gallery_url, photography_photographer_url from events where id = ?1',
      )
      .bind(eventId)
      .first<{
        photography_credit: string | null;
        photography_gallery_url: string | null;
        photography_photographer_url: string | null;
      }>();
    if (!event) throw new NotFoundError('That gig does not exist.');

    const at = this.stamp();
    await this.db.batch([
      this.db
        .prepare(UPDATE_PHOTOGRAPHY_SQL)
        .bind(
          fields.credit ?? null,
          fields.galleryUrl ?? null,
          fields.photographerUrl ?? null,
          at,
          eventId,
        ),
      this.audit(
        this.newId('aud'),
        operator.email,
        'event.photography_updated',
        eventId,
        `Updated photography details for ${eventId}`,
        at,
      ),
    ]);
  }

  private async rollbackObjects(written: readonly { key: string }[]): Promise<void> {
    for (const entry of written) {
      try {
        await this.objects.delete(entry.key);
      } catch {
        // Compensation failed; the caller surfaces the original error, and the
        // orphan key remains visible to operators rather than silently ignored.
      }
    }
  }

  private audit(
    id: string,
    actorEmail: string,
    action: string,
    entityId: string,
    summary: string,
    at: string,
  ): D1PreparedStatement {
    return this.db
      .prepare(AUDIT_SQL)
      .bind(id, actorEmail, action, 'media', entityId, summary, at);
  }

  private stamp(): string {
    const value = Math.max(this.now().getTime(), this.lastStamp + 1);
    this.lastStamp = value;
    return new Date(value).toISOString();
  }
}

/** Build the D1 media mutation service against resolved bindings. */
export function createD1MediaMutations(
  db: D1Database,
  objects: ObjectStore,
  clock?: () => Date,
  newId?: IdFactory,
): MediaMutationService {
  return new D1MediaMutations(db, objects, clock, newId);
}
