/**
 * D1-backed ArtistService (AMPED-02B).
 *
 * `list()` and `getBySlug()` read the `artists` table. `eventsFor()` does NOT:
 * event persistence is AMPED-02C, so this slice delegates that one method to
 * the still-fixture `ArtistService`. That keeps the observable behaviour
 * identical while the boundary is moved one service at a time - the whole
 * point of the AMPED-01 seam.
 *
 * Same discipline as the venue repository: explicit column lists, one bound
 * parameter, `null` for an unknown slug, fixture-identical ordering, and no
 * raw `ArtistRow` ever leaving this module.
 */

import type { ArtistRow } from '@/db/schema.ts';
import { slugify } from '@/lib/text.ts';
import {
  ConflictError,
  NotFoundError,
  type ValidatedArtistInput,
} from '@/lib/validation.ts';
import type { Artist, SocialLinks } from '@/types/domain.ts';

import type { ArtistService } from '../contracts.ts';
import type { GigOperator } from './events.ts';

/**
 * The row shape as selected here. `archived_at` arrives in migration 0007, and
 * src/db is frozen for this slice, so the column is typed locally rather than
 * by editing the accepted schema module.
 */
type ArtistRowWithArchive = ArtistRow & { archived_at: string | null };

/** The fields the `Artist` contract needs, snake_case as stored. */
const ARTIST_COLUMNS = [
  'id',
  'name',
  'slug',
  'tagline',
  'biography',
  'genre',
  'based_in',
  'image_asset_id',
  'link_instagram',
  'link_tiktok',
  'link_facebook',
  'link_youtube',
  'link_spotify',
  'link_bandcamp',
  'link_soundcloud',
  'link_website',
  'archived_at',
  'created_at',
  'updated_at',
].join(', ');

const SELECT_ARTISTS_SQL = `select ${ARTIST_COLUMNS} from artists order by name, id`;
const SELECT_ARTIST_BY_SLUG_SQL = `select ${ARTIST_COLUMNS} from artists where slug = ?1`;
const SELECT_ACTIVE_ARTISTS_SQL =
  `select ${ARTIST_COLUMNS} from artists where archived_at is null order by name, id`;

/** The eight stored link columns, in the order the schema declares them. */
const LINK_COLUMNS: ReadonlyArray<[keyof SocialLinks, keyof ArtistRow]> = [
  ['instagram', 'link_instagram'],
  ['tiktok', 'link_tiktok'],
  ['facebook', 'link_facebook'],
  ['youtube', 'link_youtube'],
  ['spotify', 'link_spotify'],
  ['bandcamp', 'link_bandcamp'],
  ['soundcloud', 'link_soundcloud'],
  ['website', 'link_website'],
];

function toLinks(row: ArtistRow): SocialLinks {
  const links: SocialLinks = {};
  for (const [network, column] of LINK_COLUMNS) {
    const url = row[column];
    if (typeof url === 'string' && url.length > 0) links[network] = url;
  }
  return links;
}

/** Optional keys are present only when stored, matching the fixtures. */
export function toArtist(row: ArtistRowWithArchive): Artist {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    ...(row.tagline !== null ? { tagline: row.tagline } : {}),
    ...(row.biography !== null ? { biography: row.biography } : {}),
    ...(row.genre !== null ? { genre: row.genre } : {}),
    ...(row.based_in !== null ? { basedIn: row.based_in } : {}),
    ...(row.image_asset_id !== null ? { imageAssetId: row.image_asset_id } : {}),
    links: toLinks(row),
    ...(row.archived_at !== null ? { archivedAt: row.archived_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Identical wording to the fixture service, so page order cannot shift. */
const byName = (a: Artist, b: Artist): number => a.name.localeCompare(b.name, 'en-GB');

class D1ArtistService implements ArtistService {
  constructor(
    private readonly db: D1Database,
    /** Still-fixture event source; replaced by the D1 event repository in AMPED-02C. */
    private readonly events: Pick<ArtistService, 'eventsFor'>,
  ) {}

  async list(): Promise<Artist[]> {
    const { results } = await this.db.prepare(SELECT_ARTISTS_SQL).all<ArtistRowWithArchive>();
    return results.map(toArtist).sort(byName);
  }

  /** Active artists only - the new-promotion picker (AMPED-04C). */
  async listActive(): Promise<Artist[]> {
    const { results } = await this.db
      .prepare(SELECT_ACTIVE_ARTISTS_SQL)
      .all<ArtistRowWithArchive>();
    return results.map(toArtist).sort(byName);
  }

  async getBySlug(slug: string): Promise<Artist | null> {
    const row = await this.db
      .prepare(SELECT_ARTIST_BY_SLUG_SQL)
      .bind(slug)
      .first<ArtistRowWithArchive>();
    return row ? toArtist(row) : null;
  }

  eventsFor(artistId: string) {
    return this.events.eventsFor(artistId);
  }
}

/** The read service plus the active-only read the admin picker uses. */
export type ArtistReadService = ArtistService & { listActive(): Promise<Artist[]> };

/** Build the D1 artist service against a resolved binding. */
export function createD1ArtistService(
  db: D1Database,
  events: Pick<ArtistService, 'eventsFor'>,
): ArtistReadService {
  return new D1ArtistService(db, events);
}

// ---------------------------------------------------------------------------
// AMPED-04C - artist administration (writes)
// ---------------------------------------------------------------------------

export interface ArtistMutationService {
  create(input: ValidatedArtistInput, operator: GigOperator): Promise<{ id: string; slug: string }>;
  update(id: string, input: ValidatedArtistInput, operator: GigOperator): Promise<{ slug: string }>;
  archive(id: string, operator: GigOperator): Promise<void>;
  remove(id: string, operator: GigOperator): Promise<void>;
  /**
   * Create an artist and put them on a bill in one coherent action
   * (PromotionForm's "+ Add artist"). Artist insert, line-up join and both
   * audit rows run in one D1 batch.
   */
  createAndAttachToEvent(
    input: ValidatedArtistInput,
    eventId: string,
    operator: GigOperator,
  ): Promise<{ id: string; slug: string; position: number }>;
}

type IdFactory = (prefix: string) => string;
const defaultId: IdFactory = (prefix) => `${prefix}_${crypto.randomUUID()}`;

const SELECT_ARTIST_ROW_SQL = `select ${ARTIST_COLUMNS} from artists where id = ?1`;
const SELECT_ARTIST_REFERENCES_SQL =
  'select count(*) as n from event_artists where artist_id = ?1';
const SELECT_EVENT_EXISTS_SQL = 'select 1 as ok from events where id = ?1';
const SELECT_NEXT_POSITION_SQL =
  'select coalesce(max(position), -1) + 1 as next from event_artists where event_id = ?1';
const AUDIT_SQL =
  'insert into audit_log (id, actor_email, action, entity_type, entity_id, summary, occurred_at) ' +
  'values (?1, ?2, ?3, ?4, ?5, ?6, ?7)';

class D1ArtistMutations implements ArtistMutationService {
  private lastStamp = 0;

  constructor(
    private readonly db: D1Database,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: IdFactory = defaultId,
  ) {}

  async create(
    input: ValidatedArtistInput,
    operator: GigOperator,
  ): Promise<{ id: string; slug: string }> {
    const id = this.newId('art');
    const slug = await this.uniqueSlug(slugify(input.name));
    const at = this.stamp();
    await this.db.batch([
      this.insertStatement(id, slug, input, at),
      this.audit(this.newId('aud'), operator.email, 'artist.created', id, `Created "${input.name}"`, at),
    ]);
    return { id, slug };
  }

  async update(
    id: string,
    input: ValidatedArtistInput,
    operator: GigOperator,
  ): Promise<{ slug: string }> {
    const row = await this.db
      .prepare(SELECT_ARTIST_ROW_SQL)
      .bind(id)
      .first<ArtistRowWithArchive>();
    if (!row) throw new NotFoundError('That artist does not exist.');
    if (row.archived_at !== null) {
      throw new ConflictError('This artist is archived and cannot be edited.');
    }

    const at = this.stamp();
    await this.db.batch([
      this.db
        .prepare(
          `update artists set name = ?1, tagline = ?2, biography = ?3, genre = ?4,
             based_in = ?5, link_instagram = ?6, link_tiktok = ?7, link_facebook = ?8,
             link_youtube = ?9, link_spotify = ?10, link_bandcamp = ?11,
             link_soundcloud = ?12, link_website = ?13, updated_at = ?14
           where id = ?15`,
        )
        .bind(
          input.name,
          input.tagline ?? null,
          input.biography ?? null,
          input.genre ?? null,
          input.basedIn ?? null,
          input.links.instagram ?? null,
          input.links.tiktok ?? null,
          input.links.facebook ?? null,
          input.links.youtube ?? null,
          input.links.spotify ?? null,
          input.links.bandcamp ?? null,
          input.links.soundcloud ?? null,
          input.links.website ?? null,
          at,
          id,
        ),
      this.audit(this.newId('aud'), operator.email, 'artist.updated', id, `Edited "${input.name}"`, at),
    ]);
    return { slug: row.slug };
  }

  async archive(id: string, operator: GigOperator): Promise<void> {
    const at = this.stamp();
    const update = this.db
      .prepare('update artists set archived_at = ?1, updated_at = ?1 where id = ?2 and archived_at is null')
      .bind(at, id);
    const audit = this.db
      .prepare(
        'insert into audit_log (id, actor_email, action, entity_type, entity_id, summary, occurred_at) ' +
          'select ?1, ?2, ?3, ?4, ?5, ?6, ?7 where exists (select 1 from artists where id = ?5 and archived_at = ?8)',
      )
      .bind(this.newId('aud'), operator.email, 'artist.archived', 'artist', id, `Archived "${id}"`, at, at);

    const results = await this.db.batch([update, audit]);
    if (((results[0]?.meta?.changes ?? 0) as number) === 0) {
      const row = await this.db
        .prepare(SELECT_ARTIST_ROW_SQL)
        .bind(id)
        .first<ArtistRowWithArchive>();
      if (!row) throw new NotFoundError('That artist does not exist.');
      throw new ConflictError('This artist is already archived.');
    }
  }

  async remove(id: string, operator: GigOperator): Promise<void> {
    const references = await this.db
      .prepare(SELECT_ARTIST_REFERENCES_SQL)
      .bind(id)
      .first<{ n: number }>();
    if ((references?.n ?? 0) > 0) {
      throw new ConflictError('This artist appears on a bill and can only be archived.');
    }

    const at = this.stamp();
    const del = this.db
      .prepare(
        'delete from artists where id = ?1 and not exists (select 1 from event_artists where artist_id = ?1)',
      )
      .bind(id);
    const audit = this.db
      .prepare(
        'insert into audit_log (id, actor_email, action, entity_type, entity_id, summary, occurred_at) ' +
          'select ?1, ?2, ?3, ?4, ?5, ?6, ?7 where not exists (select 1 from artists where id = ?5)',
      )
      .bind(this.newId('aud'), operator.email, 'artist.deleted', 'artist', id, `Deleted "${id}"`, at);

    const results = await this.db.batch([del, audit]);
    if (((results[0]?.meta?.changes ?? 0) as number) === 0) {
      const row = await this.db.prepare(SELECT_ARTIST_ROW_SQL).bind(id).first();
      if (!row) throw new NotFoundError('That artist does not exist.');
      throw new ConflictError('This artist is referenced and can only be archived.');
    }
  }

  async createAndAttachToEvent(
    input: ValidatedArtistInput,
    eventId: string,
    operator: GigOperator,
  ): Promise<{ id: string; slug: string; position: number }> {
    const event = await this.db.prepare(SELECT_EVENT_EXISTS_SQL).bind(eventId).first<{ ok: number }>();
    if (!event) throw new NotFoundError('That gig does not exist.');

    const id = this.newId('art');
    const slug = await this.uniqueSlug(slugify(input.name));
    const positionRow = await this.db
      .prepare(SELECT_NEXT_POSITION_SQL)
      .bind(eventId)
      .first<{ next: number }>();
    const position = positionRow?.next ?? 0;
    const at = this.stamp();

    await this.db.batch([
      this.insertStatement(id, slug, input, at),
      this.db
        .prepare(
          'insert into event_artists (event_id, artist_id, position, billing_note, set_time) values (?1, ?2, ?3, null, null)',
        )
        .bind(eventId, id, position),
      this.audit(this.newId('aud'), operator.email, 'artist.created', id, `Created "${input.name}"`, at),
      this.audit(
        this.newId('aud'),
        operator.email,
        'artist.attached_to_event',
        id,
        `Added "${input.name}" to ${eventId} at position ${position}`,
        at,
      ),
    ]);

    return { id, slug, position };
  }

  // -- helpers -------------------------------------------------------------

  private insertStatement(
    id: string,
    slug: string,
    input: ValidatedArtistInput,
    at: string,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `insert into artists (
           id, name, slug, tagline, biography, genre, based_in,
           link_instagram, link_tiktok, link_facebook, link_youtube,
           link_spotify, link_bandcamp, link_soundcloud, link_website,
           created_at, updated_at
         ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16)`,
      )
      .bind(
        id,
        input.name,
        slug,
        input.tagline ?? null,
        input.biography ?? null,
        input.genre ?? null,
        input.basedIn ?? null,
        input.links.instagram ?? null,
        input.links.tiktok ?? null,
        input.links.facebook ?? null,
        input.links.youtube ?? null,
        input.links.spotify ?? null,
        input.links.bandcamp ?? null,
        input.links.soundcloud ?? null,
        input.links.website ?? null,
        at,
      );
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
      .bind(id, actorEmail, action, 'artist', entityId, summary, at);
  }

  private stamp(): string {
    const value = Math.max(this.now().getTime(), this.lastStamp + 1);
    this.lastStamp = value;
    return new Date(value).toISOString();
  }

  private async uniqueSlug(base: string): Promise<string> {
    const seed = base.length > 0 ? base : 'artist';
    let candidate = seed;
    for (let suffix = 2; suffix < 500; suffix += 1) {
      const row = await this.db
        .prepare('select id from artists where slug = ?1')
        .bind(candidate)
        .first<{ id: string }>();
      if (!row) return candidate;
      candidate = `${seed}-${suffix}`;
    }
    throw new ConflictError('Could not find an available URL for that name.');
  }
}

/** Build the D1 artist mutation service against a resolved binding. */
export function createD1ArtistMutations(
  db: D1Database,
  clock?: () => Date,
  newId?: IdFactory,
): ArtistMutationService {
  return new D1ArtistMutations(db, clock, newId);
}
