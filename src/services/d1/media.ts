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
import { NotFoundError, ValidationError } from '@/lib/validation.ts';
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

export interface MediaMutationService {
  upload(input: ValidatedUpload, operator: GigOperator): Promise<{ id: string; url: string }>;
  remove(id: string, operator: GigOperator): Promise<void>;
  /** Public delivery: metadata lookup plus the object body, or null. */
  getObject(id: string): Promise<MediaObject | null>;
}

type IdFactory = (prefix: string) => string;
const defaultId: IdFactory = (prefix) => `${prefix}_${crypto.randomUUID()}`;

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
