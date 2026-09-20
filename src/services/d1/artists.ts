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
import type { Artist, SocialLinks } from '@/types/domain.ts';

import type { ArtistService } from '../contracts.ts';

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
  'created_at',
  'updated_at',
].join(', ');

const SELECT_ARTISTS_SQL = `select ${ARTIST_COLUMNS} from artists order by name, id`;
const SELECT_ARTIST_BY_SLUG_SQL = `select ${ARTIST_COLUMNS} from artists where slug = ?1`;

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
function toArtist(row: ArtistRow): Artist {
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
    const { results } = await this.db.prepare(SELECT_ARTISTS_SQL).all<ArtistRow>();
    return results.map(toArtist).sort(byName);
  }

  async getBySlug(slug: string): Promise<Artist | null> {
    const row = await this.db.prepare(SELECT_ARTIST_BY_SLUG_SQL).bind(slug).first<ArtistRow>();
    return row ? toArtist(row) : null;
  }

  eventsFor(artistId: string) {
    return this.events.eventsFor(artistId);
  }
}

/** Build the D1 artist service against a resolved binding. */
export function createD1ArtistService(
  db: D1Database,
  events: Pick<ArtistService, 'eventsFor'>,
): ArtistService {
  return new D1ArtistService(db, events);
}
