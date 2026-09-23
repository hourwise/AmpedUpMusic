/**
 * D1-backed SocialService (AMPED-03A reads, AMPED-05C curation).
 *
 * The operator curates this list by hand - no crawler, no oEmbed, no social
 * API. AMPED-05C adds create/edit/delete and explicit featured ordering on top
 * of the accepted reads.
 *
 * Featured order (AMPED-05C0 field, AMPED-05C behaviour):
 *   positioned rows first, `featured_position` ascending; legacy NULL rows
 *   after them in id order. Before any managed mutation every featured row is
 *   NULL, so the visible order is exactly the id order the site always used.
 *   The first managed mutation normalises the whole set to 0..n-1.
 *
 * `eventTitle` enrichment for the public featured read only includes events
 * that are publicly visible, so a curated post associated with a draft event
 * cannot leak that event's title onto the homepage.
 */

import type { SocialPostRow } from '@/db/schema.ts';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/validation.ts';
import { SOCIAL_LABEL } from '@/lib/text.ts';
import type { SocialNetwork, SocialPost } from '@/types/domain.ts';
import type { SocialPostView } from '@/types/view.ts';

import type { SocialService } from '../contracts.ts';
import type { GigOperator } from './events.ts';

const POST_COLUMNS = [
  'id',
  'event_id',
  'network',
  'url',
  'caption',
  'thumbnail_asset_id',
  'posted_at',
  'featured',
  'featured_position',
].join(', ');

/** The statuses the public may see, matching the accepted event visibility. */
const PUBLIC_STATUS_SQL = "status in ('published', 'postponed', 'cancelled', 'completed')";

const FEATURED_ORDER_SQL =
  'order by case when featured_position is null then 1 else 0 end, featured_position asc, id asc';

const SELECT_FEATURED_SQL =
  `select ${POST_COLUMNS} from social_posts where featured = 1 ${FEATURED_ORDER_SQL} limit ?1`;
const SELECT_FOR_EVENT_SQL =
  `select ${POST_COLUMNS} from social_posts where event_id = ?1 order by id asc`;

const SELECT_THUMBNAILS_SQL =
  'select id, url, alt from media_assets where id in (select value from json_each(?1))';
const SELECT_EVENT_TITLES_SQL =
  'select id, title from events where id in (select value from json_each(?1))';
/** Public reads only: a draft/archived event title must never reach the site. */
const SELECT_PUBLIC_EVENT_TITLES_SQL =
  `select id, title from events where id in (select value from json_each(?1)) and ${PUBLIC_STATUS_SQL}`;

type SocialRow = SocialPostRow & { featured_position: number | null };

interface ThumbnailRow {
  id: string;
  url: string;
  alt: string;
}
interface EventTitleRow {
  id: string;
  title: string;
}

export function toSocialPost(row: SocialRow): SocialPost {
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
    const { results } = await this.db.prepare(SELECT_FEATURED_SQL).bind(limit).all<SocialRow>();
    return toViews(this.db, results, true);
  }

  async listForEvent(eventId: string): Promise<SocialPostView[]> {
    const { results } = await this.db
      .prepare(SELECT_FOR_EVENT_SQL)
      .bind(eventId)
      .all<SocialRow>();
    return toViews(this.db, results, false);
  }
}

/** Two bounded lookups for the whole batch, whatever its size. */
async function toViews(
  db: D1Database,
  rows: readonly SocialRow[],
  publicEventTitlesOnly: boolean,
): Promise<SocialPostView[]> {
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
      const { results } = await db
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
      const { results } = await db
        .prepare(publicEventTitlesOnly ? SELECT_PUBLIC_EVENT_TITLES_SQL : SELECT_EVENT_TITLES_SQL)
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

/** Build the D1 social service against a resolved binding. */
export function createD1SocialService(db: D1Database): SocialService {
  return new D1SocialService(db);
}

// ---------------------------------------------------------------------------
// AMPED-05C - curation (writes)
// ---------------------------------------------------------------------------

export const MAX_CAPTION_LENGTH = 500;
export const SOCIAL_NETWORKS: readonly SocialNetwork[] = [
  'instagram',
  'tiktok',
  'facebook',
  'youtube',
  'spotify',
  'bandcamp',
  'soundcloud',
  'website',
];

export interface SocialWriteInput {
  url: string;
  network: SocialNetwork;
  caption?: string;
  thumbnailAssetId?: string;
  eventId?: string;
  featured: boolean;
}

export interface AdminSocialPost {
  view: SocialPostView;
  featuredPosition: number | null;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Validate a create/edit payload against an explicit allowlist. The URL is
 * only ever inspected - never fetched - and the caption stays plain text.
 */
export function parseSocialPayload(
  payload: unknown,
):
  | { ok: true; value: SocialWriteInput }
  | { ok: false; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  const body = (payload ?? {}) as Record<string, unknown>;
  const allowed = ['url', 'network', 'caption', 'thumbnailAssetId', 'eventId', 'featured'];

  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) fields[key] = 'Unsupported field.';
  }

  const url = clean(body.url);
  if (url.length === 0) fields.url = 'Paste the link to the post.';
  else if (!isHttpUrl(url)) fields.url = 'Use a full http:// or https:// link.';

  const network = clean(body.network) as SocialNetwork;
  if (!SOCIAL_NETWORKS.includes(network)) fields.network = 'Choose a network.';

  const caption = clean(body.caption);
  if (caption.length > MAX_CAPTION_LENGTH) {
    fields.caption = `Keep the caption under ${MAX_CAPTION_LENGTH} characters.`;
  }

  const thumbnailAssetId = clean(body.thumbnailAssetId);
  if (thumbnailAssetId && !/^[A-Za-z0-9_-]+$/.test(thumbnailAssetId)) {
    fields.thumbnailAssetId = 'Choose an image from the library.';
  }
  const eventId = clean(body.eventId);
  if (eventId && !/^[A-Za-z0-9_-]+$/.test(eventId)) {
    fields.eventId = 'Choose a gig.';
  }
  if (body.featured !== undefined && typeof body.featured !== 'boolean') {
    fields.featured = 'Featured must be true or false.';
  }

  if (Object.values(fields).some(Boolean)) return { ok: false, fields };

  return {
    ok: true,
    value: {
      url,
      network,
      ...(caption ? { caption } : {}),
      ...(thumbnailAssetId ? { thumbnailAssetId } : {}),
      ...(eventId ? { eventId } : {}),
      featured: body.featured === true,
    },
  };
}

export interface SocialMutationService {
  create(input: SocialWriteInput, operator: GigOperator): Promise<{ id: string }>;
  update(id: string, input: SocialWriteInput, operator: GigOperator): Promise<void>;
  remove(id: string, operator: GigOperator): Promise<void>;
  /** The entire current featured set, in order, exactly once. */
  reorder(ids: readonly string[], operator: GigOperator): Promise<void>;
  listAdmin(): Promise<AdminSocialPost[]>;
}

type IdFactory = (prefix: string) => string;
const defaultId: IdFactory = (prefix) => `${prefix}_${crypto.randomUUID()}`;

const SELECT_BY_ID_SQL = `select ${POST_COLUMNS} from social_posts where id = ?1`;
const SELECT_FEATURED_ROWS_SQL =
  `select id, featured_position from social_posts where featured = 1 ${FEATURED_ORDER_SQL}`;
const SELECT_ALL_SQL =
  `select ${POST_COLUMNS} from social_posts ` +
  `order by case when featured = 1 then 0 else 1 end, ` +
  `case when featured_position is null then 1 else 0 end, featured_position asc, id asc`;

const UPDATE_POSITION_SQL =
  'update social_posts set featured_position = ?1 where id = ?2 and featured = 1';
const INSERT_SQL =
  'insert into social_posts (id, event_id, network, url, caption, thumbnail_asset_id, posted_at, featured, featured_position) ' +
  'values (?1, ?2, ?3, ?4, ?5, ?6, null, ?7, ?8)';
const UPDATE_SQL =
  'update social_posts set event_id = ?1, network = ?2, url = ?3, caption = ?4, ' +
  'thumbnail_asset_id = ?5, featured = ?6 where id = ?7';
const DELETE_SQL = 'delete from social_posts where id = ?1';
const AUDIT_SQL =
  'insert into audit_log (id, actor_email, action, entity_type, entity_id, summary, occurred_at) ' +
  'values (?1, ?2, ?3, ?4, ?5, ?6, ?7)';

class D1SocialMutations implements SocialMutationService {
  private lastStamp = 0;

  constructor(
    private readonly db: D1Database,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: IdFactory = defaultId,
  ) {}

  async create(input: SocialWriteInput, operator: GigOperator): Promise<{ id: string }> {
    await this.assertReferences(input);

    const statements: D1PreparedStatement[] = [];
    let position: number | null = null;
    if (input.featured) {
      const append = await this.appendToFeatured();
      statements.push(...append.statements);
      position = append.position;
    }

    const id = this.newId('soc');
    const at = this.stamp();
    statements.push(
      this.db
        .prepare(INSERT_SQL)
        .bind(
          id,
          input.eventId ?? null,
          input.network,
          input.url,
          input.caption ?? null,
          input.thumbnailAssetId ?? null,
          input.featured ? 1 : 0,
          position,
        ),
    );
    statements.push(
      this.audit(this.newId('aud'), operator.email, 'social.created', id, `Created ${input.network} post`, at),
    );
    if (input.featured) {
      statements.push(
        this.audit(this.newId('aud'), operator.email, 'social.featured', id, 'Featured on the homepage', at),
      );
    }

    await this.db.batch(statements);
    return { id };
  }

  async update(id: string, input: SocialWriteInput, operator: GigOperator): Promise<void> {
    const row = await this.db.prepare(SELECT_BY_ID_SQL).bind(id).first<SocialRow>();
    if (!row) throw new NotFoundError('That social post does not exist.');
    await this.assertReferences(input);

    const wasFeatured = row.featured === 1;
    const statements: D1PreparedStatement[] = [];
    let position: number | null = row.featured_position;

    if (input.featured && !wasFeatured) {
      const append = await this.appendToFeatured();
      statements.push(...append.statements);
      position = append.position;
    } else if (!input.featured && wasFeatured) {
      position = null;
    }

    const at = this.stamp();
    statements.push(
      this.db
        .prepare(UPDATE_SQL)
        .bind(
          input.eventId ?? null,
          input.network,
          input.url,
          input.caption ?? null,
          input.thumbnailAssetId ?? null,
          input.featured ? 1 : 0,
          id,
        ),
    );
    statements.push(this.db.prepare(UPDATE_POSITION_SQL).bind(position, id));
    statements.push(
      this.audit(this.newId('aud'), operator.email, 'social.updated', id, 'Updated social post', at),
    );

    if (input.featured && !wasFeatured) {
      statements.push(
        this.audit(this.newId('aud'), operator.email, 'social.featured', id, 'Featured on the homepage', at),
      );
    } else if (!input.featured && wasFeatured) {
      // Compaction of the remaining featured set.
      const remaining = (await this.featuredRows()).filter((entry) => entry.id !== id);
      remaining.forEach((entry, index) => {
        statements.push(this.db.prepare(UPDATE_POSITION_SQL).bind(index, entry.id));
      });
      statements.push(
        this.audit(this.newId('aud'), operator.email, 'social.unfeatured', id, 'Removed from the homepage', at),
      );
    }

    await this.db.batch(statements);
  }

  async remove(id: string, operator: GigOperator): Promise<void> {
    const row = await this.db.prepare(SELECT_BY_ID_SQL).bind(id).first<SocialRow>();
    if (!row) throw new NotFoundError('That social post does not exist.');

    const at = this.stamp();
    const statements: D1PreparedStatement[] = [this.db.prepare(DELETE_SQL).bind(id)];

    if (row.featured === 1) {
      const remaining = (await this.featuredRows()).filter((entry) => entry.id !== id);
      remaining.forEach((entry, index) => {
        statements.push(this.db.prepare(UPDATE_POSITION_SQL).bind(index, entry.id));
      });
    }

    statements.push(
      this.audit(this.newId('aud'), operator.email, 'social.deleted', id, 'Deleted social post', at),
    );
    await this.db.batch(statements);
  }

  async reorder(ids: readonly string[], operator: GigOperator): Promise<void> {
    if (new Set(ids).size !== ids.length) {
      throw new ValidationError({ ids: 'Each social post may appear only once.' });
    }
    const current = await this.featuredRows();
    if (ids.length !== current.length) {
      throw new ConflictError('The featured posts have changed. Reload and try again.');
    }
    const currentSet = new Set(current.map((entry) => entry.id));
    if (ids.some((id) => !currentSet.has(id))) {
      throw new ConflictError('The featured posts have changed. Reload and try again.');
    }

    const at = this.stamp();
    const statements: D1PreparedStatement[] = ids.map((id, index) =>
      this.db.prepare(UPDATE_POSITION_SQL).bind(index, id),
    );
    statements.push(
      this.audit(
        this.newId('aud'),
        operator.email,
        'social.reordered',
        'featured',
        `Reordered ${ids.length} featured post(s)`,
        at,
      ),
    );
    await this.db.batch(statements);
  }

  async listAdmin(): Promise<AdminSocialPost[]> {
    const { results } = await this.db.prepare(SELECT_ALL_SQL).all<SocialRow>();
    const views = await toViews(this.db, results, false);
    return views.map((view, index) => ({
      view,
      featuredPosition: results[index]?.featured_position ?? null,
    }));
  }

  // -- helpers -------------------------------------------------------------

  /** Current featured rows in canonical order, with their raw positions. */
  private async featuredRows(): Promise<Array<{ id: string; featured_position: number | null }>> {
    const { results } = await this.db
      .prepare(SELECT_FEATURED_ROWS_SQL)
      .all<{ id: string; featured_position: number | null }>();
    return results;
  }

  /**
   * Normalise any legacy NULL positions and return the statements to do it,
   * plus the next free position. The visible order is preserved.
   */
  private async appendToFeatured(): Promise<{
    statements: D1PreparedStatement[];
    position: number;
  }> {
    const current = await this.featuredRows();
    const statements: D1PreparedStatement[] = [];
    const hasLegacy = current.some((entry) => entry.featured_position === null);
    if (hasLegacy) {
      current.forEach((entry, index) => {
        statements.push(this.db.prepare(UPDATE_POSITION_SQL).bind(index, entry.id));
      });
      return { statements, position: current.length };
    }
    const next = current.reduce(
      (max, entry) => Math.max(max, (entry.featured_position ?? 0) + 1),
      0,
    );
    return { statements, position: next };
  }

  private async assertReferences(input: SocialWriteInput): Promise<void> {
    if (input.eventId) {
      const event = await this.db
        .prepare('select 1 as ok from events where id = ?1')
        .bind(input.eventId)
        .first<{ ok: number }>();
      if (!event) throw new NotFoundError('That gig does not exist.');
    }
    if (input.thumbnailAssetId) {
      const asset = await this.db
        .prepare('select 1 as ok from media_assets where id = ?1')
        .bind(input.thumbnailAssetId)
        .first<{ ok: number }>();
      if (!asset) throw new NotFoundError('That image does not exist.');
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
      .bind(id, actorEmail, action, 'social', entityId, summary, at);
  }

  private stamp(): string {
    const value = Math.max(this.now().getTime(), this.lastStamp + 1);
    this.lastStamp = value;
    return new Date(value).toISOString();
  }
}

/** Build the D1 social curation service against a resolved binding. */
export function createD1SocialMutations(
  db: D1Database,
  clock?: () => Date,
  newId?: IdFactory,
): SocialMutationService {
  return new D1SocialMutations(db, clock, newId);
}
