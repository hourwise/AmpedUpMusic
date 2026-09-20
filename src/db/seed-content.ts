/**
 * Seed rows for media, social posts, enquiries, the mailing list and the audit
 * log - the content either side of the diary itself.
 *
 * The media set is the AMPED-01 one: 43 generated stage-lighting SVGs at real
 * poster (3:4), hero (16:9), square and wide ratios. The files are committed
 * under public/media and produced by scripts/generate-artwork.mjs; AMPED-05A
 * moves them to R2 and rewrites `storage_key`/`url`.
 *
 * Every asset carries real alt text. The schema makes it NOT NULL and
 * non-blank, so the seed cannot model a shortcut the product does not allow.
 */

import type { AuditLogRow, EnquiryRow, MailingListRow, MediaAssetRow, SocialPostRow } from './schema.ts';
import { offsetFrom } from './seed-clock.ts';

const SVG = 'image/svg+xml';
const CREDIT = 'AnyaParallax';

const POSTER_DIMENSIONS = { width: 900, height: 1200 } as const;
const HERO_DIMENSIONS = { width: 1920, height: 1080 } as const;
const SQUARE_DIMENSIONS = { width: 800, height: 800 } as const;
const WIDE_DIMENSIONS = { width: 1200, height: 800 } as const;

interface AssetSpec {
  id: string;
  file: string;
  role: MediaAssetRow['role'];
  alt: string;
  width: number;
  height: number;
  credit?: string;
  eventId?: string;
  artistId?: string;
}

function toMediaRow(spec: AssetSpec, uploadedAt: string): MediaAssetRow {
  return {
    id: spec.id,
    storage_key: `media/${spec.file}`,
    url: `/media/${spec.file}`,
    role: spec.role,
    alt: spec.alt,
    width: spec.width,
    height: spec.height,
    mime_type: SVG,
    byte_size: null,
    credit: spec.credit ?? null,
    event_id: spec.eventId ?? null,
    artist_id: spec.artistId ?? null,
    uploaded_at: uploadedAt,
  };
}

// ---------------------------------------------------------------------------
// Artwork
// ---------------------------------------------------------------------------

/** One poster per event that has artwork. The two without are deliberate. */
export const POSTER_SPECS: AssetSpec[] = [
  {
    id: 'med_poster_glass_hearts',
    file: 'poster-glass-hearts.svg',
    role: 'poster',
    alt: 'Poster artwork for The Glass Hearts at The Lomax Rooms: acid yellow stage beams cutting across a black background.',
    ...POSTER_DIMENSIONS,
    eventId: 'evt_glass_hearts_nov',
  },
  {
    id: 'med_poster_northern_static',
    file: 'poster-northern-static.svg',
    role: 'poster',
    alt: 'Poster artwork for Northern Static: cyan equaliser bars rising from a dark floor.',
    ...POSTER_DIMENSIONS,
    eventId: 'evt_northern_static_oct',
  },
  {
    id: 'med_poster_velvet_antler',
    file: 'poster-velvet-antler.svg',
    role: 'poster',
    alt: 'Poster artwork for Velvet Antler: concentric violet rings radiating from a single point of light.',
    ...POSTER_DIMENSIONS,
    eventId: 'evt_velvet_antler_dec',
  },
  {
    id: 'med_poster_ledger',
    file: 'poster-ledger.svg',
    role: 'poster',
    alt: 'Poster artwork for LEDGER: orange halftone dots burning out towards the centre of a black field.',
    ...POSTER_DIMENSIONS,
    eventId: 'evt_ledger_oct',
  },
  {
    id: 'med_poster_winter_amp',
    file: 'poster-winter-amp.svg',
    role: 'poster',
    alt: 'Poster artwork for the Amped Up Winter All-Dayer: a green grid under a wide pool of light.',
    ...POSTER_DIMENSIONS,
    eventId: 'evt_winter_allday',
  },
  {
    id: 'med_poster_saltwater',
    file: 'poster-saltwater.svg',
    role: 'poster',
    alt: 'Poster artwork for Saltwater Parade: pink scan lines across a warm dark background.',
    ...POSTER_DIMENSIONS,
    eventId: 'evt_saltwater_nov',
  },
  {
    id: 'med_poster_hollow_coast',
    file: 'poster-hollow-coast.svg',
    role: 'poster',
    alt: 'Poster artwork for Hollow Coast: violet beams fanning out over deep blue-black.',
    ...POSTER_DIMENSIONS,
    eventId: 'evt_hollow_coast_past',
  },
  {
    id: 'med_poster_brass_tacks',
    file: 'poster-brass-tacks.svg',
    role: 'poster',
    alt: 'Poster artwork for Brass Tacks: yellow halftone dots massing towards a bright centre.',
    ...POSTER_DIMENSIONS,
    eventId: 'evt_brass_tacks_past',
  },
  {
    id: 'med_poster_paper_lions',
    file: 'poster-paper-lions.svg',
    role: 'poster',
    alt: 'Poster artwork for Paper Lions: hard cyan rings on black.',
    ...POSTER_DIMENSIONS,
    eventId: 'evt_paper_lions_past',
  },
  {
    id: 'med_poster_spring_amp',
    file: 'poster-spring-amp.svg',
    role: 'poster',
    alt: 'Poster artwork for the Amped Up Spring Session: orange equaliser bars on a dark red field.',
    ...POSTER_DIMENSIONS,
    eventId: 'evt_spring_session_past',
  },
];

export const HERO_SPECS: AssetSpec[] = [
  {
    id: 'med_hero_glass_hearts',
    file: 'hero-glass-hearts.svg',
    role: 'hero',
    alt: 'A crowd silhouetted against acid yellow stage lighting, arms raised at the front.',
    ...HERO_DIMENSIONS,
    credit: CREDIT,
    eventId: 'evt_glass_hearts_nov',
  },
  {
    id: 'med_hero_northern_static',
    file: 'hero-northern-static.svg',
    role: 'hero',
    alt: 'Cyan light spilling over a packed dark room.',
    ...HERO_DIMENSIONS,
    credit: CREDIT,
    eventId: 'evt_northern_static_oct',
  },
  {
    id: 'med_hero_velvet_antler',
    file: 'hero-velvet-antler.svg',
    role: 'hero',
    alt: 'Violet haze above a still, watching audience.',
    ...HERO_DIMENSIONS,
    credit: CREDIT,
    eventId: 'evt_velvet_antler_dec',
  },
  {
    id: 'med_hero_ledger',
    file: 'hero-ledger.svg',
    role: 'hero',
    alt: 'Orange light burning through smoke over a crowd.',
    ...HERO_DIMENSIONS,
    credit: CREDIT,
    eventId: 'evt_ledger_oct',
  },
  {
    id: 'med_hero_hollow_coast',
    file: 'hero-hollow-coast.svg',
    role: 'hero',
    alt: 'Deep violet wash across a crowd with hands in the air.',
    ...HERO_DIMENSIONS,
    credit: CREDIT,
    eventId: 'evt_hollow_coast_past',
  },
  {
    id: 'med_hero_brass_tacks',
    file: 'hero-brass-tacks.svg',
    role: 'hero',
    alt: 'Warm pink stage light over a dancing crowd.',
    ...HERO_DIMENSIONS,
    credit: CREDIT,
    eventId: 'evt_brass_tacks_past',
  },
];

export const ARTIST_SPECS: AssetSpec[] = [
  { id: 'med_artist_glass_hearts', file: 'artist-glass-hearts.svg', role: 'artist', alt: 'The Glass Hearts band image: yellow concentric rings on black.', ...SQUARE_DIMENSIONS, artistId: 'art_glass_hearts' },
  { id: 'med_artist_northern_static', file: 'artist-northern-static.svg', role: 'artist', alt: 'Northern Static band image: cyan equaliser bars.', ...SQUARE_DIMENSIONS, artistId: 'art_northern_static' },
  { id: 'med_artist_velvet_antler', file: 'artist-velvet-antler.svg', role: 'artist', alt: 'Velvet Antler band image: violet halftone field.', ...SQUARE_DIMENSIONS, artistId: 'art_velvet_antler' },
  { id: 'med_artist_ledger', file: 'artist-ledger.svg', role: 'artist', alt: 'LEDGER band image: orange grid over black.', ...SQUARE_DIMENSIONS, artistId: 'art_ledger' },
  { id: 'med_artist_saltwater_parade', file: 'artist-saltwater-parade.svg', role: 'artist', alt: 'Saltwater Parade band image: pink rings on a warm dark background.', ...SQUARE_DIMENSIONS, artistId: 'art_saltwater_parade' },
  { id: 'med_artist_hollow_coast', file: 'artist-hollow-coast.svg', role: 'artist', alt: 'Hollow Coast band image: violet scan lines.', ...SQUARE_DIMENSIONS, artistId: 'art_hollow_coast' },
  { id: 'med_artist_brass_tacks', file: 'artist-brass-tacks.svg', role: 'artist', alt: 'Brass Tacks band image: green equaliser bars.', ...SQUARE_DIMENSIONS, artistId: 'art_brass_tacks' },
  { id: 'med_artist_paper_lions', file: 'artist-paper-lions.svg', role: 'artist', alt: 'Paper Lions band image: cyan beams on black.', ...SQUARE_DIMENSIONS, artistId: 'art_paper_lions' },
  { id: 'med_artist_mara_veil', file: 'artist-mara-veil.svg', role: 'artist', alt: 'Mara Veil artist image: violet rings radiating outwards.', ...SQUARE_DIMENSIONS, artistId: 'art_mara_veil' },
  { id: 'med_artist_second_city', file: 'artist-second-city-sound.svg', role: 'artist', alt: 'Second City Sound artist image: yellow grid on black.', ...SQUARE_DIMENSIONS, artistId: 'art_second_city' },
];

export const GALLERY_SPECS: AssetSpec[] = [
  { id: 'med_gal_01', file: 'gallery-01.svg', role: 'gallery', alt: 'Hollow Coast at Parr Street Hall: the crowd lit from behind in yellow.', ...WIDE_DIMENSIONS, credit: CREDIT, eventId: 'evt_hollow_coast_past' },
  { id: 'med_gal_02', file: 'gallery-02.svg', role: 'gallery', alt: 'Hollow Coast at Parr Street Hall: cyan light across the front rows.', ...WIDE_DIMENSIONS, credit: CREDIT, eventId: 'evt_hollow_coast_past' },
  { id: 'med_gal_03', file: 'gallery-03.svg', role: 'gallery', alt: 'Hollow Coast at Parr Street Hall: violet beams over the stage.', ...WIDE_DIMENSIONS, credit: CREDIT, eventId: 'evt_hollow_coast_past' },
  { id: 'med_gal_04', file: 'gallery-04.svg', role: 'gallery', alt: 'Brass Tacks at Ironworks Social: orange light through smoke.', ...WIDE_DIMENSIONS, credit: CREDIT, eventId: 'evt_brass_tacks_past' },
  { id: 'med_gal_05', file: 'gallery-05.svg', role: 'gallery', alt: 'Brass Tacks at Ironworks Social: pink halftone glow over the brass section.', ...WIDE_DIMENSIONS, credit: CREDIT, eventId: 'evt_brass_tacks_past' },
  { id: 'med_gal_06', file: 'gallery-06.svg', role: 'gallery', alt: 'Brass Tacks at Ironworks Social: the floor full and moving.', ...WIDE_DIMENSIONS, credit: CREDIT, eventId: 'evt_brass_tacks_past' },
  { id: 'med_gal_07', file: 'gallery-07.svg', role: 'gallery', alt: 'Paper Lions at The Cellar: violet equaliser bars behind the band.', ...WIDE_DIMENSIONS, credit: CREDIT, eventId: 'evt_paper_lions_past' },
  { id: 'med_gal_08', file: 'gallery-08.svg', role: 'gallery', alt: 'Paper Lions at The Cellar: cyan scan lines across a low ceiling.', ...WIDE_DIMENSIONS, credit: CREDIT, eventId: 'evt_paper_lions_past' },
  { id: 'med_gal_09', file: 'gallery-09.svg', role: 'gallery', alt: 'Spring Session at The Lomax Rooms: yellow light over raised hands.', ...WIDE_DIMENSIONS, credit: CREDIT, eventId: 'evt_spring_session_past' },
  { id: 'med_gal_10', file: 'gallery-10.svg', role: 'gallery', alt: 'Spring Session at The Lomax Rooms: orange beams from the rig.', ...WIDE_DIMENSIONS, credit: CREDIT, eventId: 'evt_spring_session_past' },
  { id: 'med_gal_11', file: 'gallery-11.svg', role: 'gallery', alt: 'Spring Session at The Lomax Rooms: the room in violet just before the last song.', ...WIDE_DIMENSIONS, credit: CREDIT, eventId: 'evt_spring_session_past' },
  { id: 'med_gal_12', file: 'gallery-12.svg', role: 'gallery', alt: 'Spring Session at The Lomax Rooms: pink light on the crowd at the barrier.', ...WIDE_DIMENSIONS, credit: CREDIT, eventId: 'evt_spring_session_past' },
];

export const SOCIAL_THUMBNAIL_SPECS: AssetSpec[] = [
  { id: 'med_social_01', file: 'social-01.svg', role: 'gallery', alt: 'Instagram post thumbnail: crowd under yellow light.', ...SQUARE_DIMENSIONS },
  { id: 'med_social_02', file: 'social-02.svg', role: 'gallery', alt: 'TikTok post thumbnail: cyan halftone pattern.', ...SQUARE_DIMENSIONS },
  { id: 'med_social_03', file: 'social-03.svg', role: 'gallery', alt: 'Instagram post thumbnail: pink light over a full room.', ...SQUARE_DIMENSIONS },
  { id: 'med_social_04', file: 'social-04.svg', role: 'gallery', alt: 'Instagram post thumbnail: violet equaliser bars.', ...SQUARE_DIMENSIONS },
];

export const OG_SPEC: AssetSpec = {
  id: 'med_og_default',
  file: 'og-default.svg',
  role: 'og',
  alt: 'Amped Up Music Promotions.',
  width: 1200,
  height: 630,
};

/** Every asset, in fixture order. 43 rows. */
export function buildMediaRows(uploadedAt: string): MediaAssetRow[] {
  const all = [
    ...POSTER_SPECS,
    ...HERO_SPECS,
    ...ARTIST_SPECS,
    ...GALLERY_SPECS,
    ...SOCIAL_THUMBNAIL_SPECS,
    OG_SPEC,
  ].map((spec) => toMediaRow(spec, uploadedAt));

  return all;
}

/**
 * The artwork columns, written after the media rows exist.
 *
 * `evt_paper_lions_jan` (cancelled) and `evt_brass_tacks_nye` (draft) have no
 * poster on purpose - the second is the fixture's artwork-less draft, which
 * the admin gig list renders as a designed placeholder rather than a broken
 * image.
 */
export function buildEventArtwork(): Array<{
  event_id: string;
  poster_asset_id: string;
  hero_asset_id: string | null;
}> {
  const heroesByEvent = new Map(
    HERO_SPECS.flatMap((spec) => (spec.eventId ? [[spec.eventId, spec.id] as const] : [])),
  );

  return POSTER_SPECS.flatMap((spec) => {
    if (!spec.eventId) return [];
    return [
      {
        event_id: spec.eventId,
        poster_asset_id: spec.id,
        hero_asset_id: heroesByEvent.get(spec.eventId) ?? null,
      },
    ];
  });
}

/** `artists.image_asset_id`, written after the media rows exist. */
export function buildArtistImageLinks(): Array<{ artist_id: string; image_asset_id: string }> {
  return ARTIST_SPECS.flatMap((spec) =>
    spec.artistId ? [{ artist_id: spec.artistId, image_asset_id: spec.id }] : [],
  );
}

// ---------------------------------------------------------------------------
// Social posts
// ---------------------------------------------------------------------------

export function buildSocialPostRows(now: Date): SocialPostRow[] {
  return [
    {
      id: 'soc_01',
      event_id: 'evt_glass_hearts_nov',
      network: 'instagram',
      url: 'https://example.com/instagram/p/ampedup-glasshearts-announce',
      caption:
        'THE GLASS HEARTS. Lomax Rooms. Early birds are nearly gone and we have not even announced the support yet.',
      thumbnail_asset_id: 'med_social_01',
      posted_at: offsetFrom(now, -6),
      featured: 1,
    },
    {
      id: 'soc_02',
      event_id: 'evt_ledger_oct',
      network: 'tiktok',
      url: 'https://example.com/tiktok/@ampedupmusic/video/ledger-soundcheck',
      caption: 'Two drummers. Ninety capacity. Sold out in four days. Sorry.',
      thumbnail_asset_id: 'med_social_02',
      posted_at: offsetFrom(now, -11),
      featured: 1,
    },
    {
      id: 'soc_03',
      event_id: 'evt_hollow_coast_past',
      network: 'instagram',
      url: 'https://example.com/instagram/p/ampedup-hollowcoast-gallery',
      caption: 'Hollow Coast at Parr Street Hall. Full gallery by AnyaParallax is up now.',
      thumbnail_asset_id: 'med_social_03',
      posted_at: offsetFrom(now, -16),
      featured: 1,
    },
    {
      id: 'soc_04',
      event_id: 'evt_northern_static_oct',
      network: 'instagram',
      url: 'https://example.com/instagram/p/ampedup-northernstatic-rig',
      caption:
        'Northern Static are bringing the scaffolding rig to Ironworks. Early birds have gone; GA is on sale.',
      thumbnail_asset_id: 'med_social_04',
      posted_at: offsetFrom(now, -3),
      featured: 1,
    },
    {
      id: 'soc_05',
      event_id: 'evt_brass_tacks_past',
      network: 'facebook',
      url: 'https://example.com/facebook/ampedup/posts/brasstacks-thankyou',
      caption: 'Three hundred of you, one brass section and a floor that did not stop. Thank you.',
      thumbnail_asset_id: null,
      posted_at: offsetFrom(now, -44),
      featured: 0,
    },
    {
      id: 'soc_06',
      event_id: null,
      network: 'youtube',
      url: 'https://example.com/youtube/watch?v=ampedup-spring-session-recap',
      caption: 'Spring Session, two minutes, all four bands.',
      thumbnail_asset_id: null,
      posted_at: offsetFrom(now, -108),
      featured: 0,
    },
  ];
}

// ---------------------------------------------------------------------------
// Enquiries
// ---------------------------------------------------------------------------

export function buildEnquiryRows(now: Date): EnquiryRow[] {
  return [
    {
      id: 'enq_01',
      kind: 'artist',
      name: 'Rhiannon Teale',
      email: 'rhiannon@example.com',
      phone: null,
      subject: 'Cold Harbour Radio - four piece from Chorley',
      message:
        'We have an EP out in February and we are looking for a support slot in the North West. We can bring about forty people on a Friday. Links below - happy to send the unmastered tracks if that helps.',
      links: 'https://example.com/bandcamp/coldharbourradio',
      status: 'new',
      bot_check_passed: 1,
      received_at: offsetFrom(now, 0, -9.6),
    },
    {
      id: 'enq_02',
      kind: 'venue',
      name: 'Denise Okonkwo',
      email: 'bookings@example.com',
      phone: '01772 000000',
      subject: 'The Sedgewick Vaults - 120 capacity, available Thursdays',
      message:
        'We have just finished refitting the back room and we are looking for promoters. Full PA, in-house engineer, step-free entrance. Would you like to come and look at it?',
      links: null,
      status: 'new',
      bot_check_passed: 1,
      received_at: offsetFrom(now, -1.2, 0),
    },
    {
      id: 'enq_03',
      kind: 'general',
      name: 'Marcus Hale',
      email: 'marcus.hale@example.com',
      phone: null,
      subject: 'Accessible viewing at The Lomax Rooms',
      message:
        'I have a ticket for The Glass Hearts and I use a wheelchair. The venue page mentions accessible viewing positions - could you reserve one? Order reference is AMP-26-00712.',
      links: null,
      status: 'read',
      bot_check_passed: 1,
      received_at: offsetFrom(now, -2.6, 0),
    },
    {
      id: 'enq_04',
      kind: 'press',
      name: 'Sofia Marchetti',
      email: 'sofia@example.com',
      phone: null,
      subject: 'Photo pass request - Northern Static',
      message:
        'Writing a live review for a regional music site. Would there be a photo pass available for the first three songs?',
      links: null,
      status: 'replied',
      bot_check_passed: 1,
      received_at: offsetFrom(now, -5.1, 0),
    },
    {
      id: 'enq_05',
      kind: 'promoter',
      name: 'Hidden Track Collective',
      email: 'hello@example.com',
      phone: null,
      subject: 'Co-promotion - all-dayer next summer',
      message:
        'We run a small festival in the Ribble Valley and wondered whether you would be interested in co-promoting a stage. No pressure, no deadline, just putting it in front of you.',
      links: null,
      status: 'read',
      bot_check_passed: 1,
      received_at: offsetFrom(now, -9.3, 0),
    },
    {
      id: 'enq_06',
      kind: 'general',
      name: 'Win A Free iPhone',
      email: 'noreply@example.com',
      phone: null,
      subject: null,
      message: 'CONGRATULATIONS you have been selected click here immediately to claim',
      links: null,
      status: 'spam',
      // Turnstile verification failed, so this one is recorded as unverified.
      bot_check_passed: 0,
      received_at: offsetFrom(now, -12.8, 0),
    },
  ];
}

// ---------------------------------------------------------------------------
// Mailing list
// ---------------------------------------------------------------------------

const SUBSCRIBER_NAMES: ReadonlyArray<[string, string]> = [
  ['Aisha Okafor', 'aisha.okafor@example.com'],
  ['Tom Whitfield', 'tom.whitfield@example.com'],
  ['Priya Nair', 'priya.nair@example.com'],
  ['Callum Docherty', 'callum.docherty@example.com'],
  ['Nia Brennan', 'nia.brennan@example.com'],
  ['Dan Hale', 'dan.hale@example.com'],
  ['Yusuf Iqbal', 'yusuf.iqbal@example.com'],
  ['Erin Moss', 'erin.moss@example.com'],
  ['Marcus Ainsworth', 'marcus.ainsworth@example.com'],
  ['Bea Kowalski', 'bea.kowalski@example.com'],
  ['Owen Pryce', 'owen.pryce@example.com'],
  ['Jade Sutcliffe', 'jade.sutcliffe@example.com'],
  ['Rory Bannerman', 'rory.bannerman@example.com'],
  ['Lena Ferris', 'lena.ferris@example.com'],
  ['Sam Hollis', 'sam.hollis@example.com'],
  ['Fiona Dunne', 'fiona.dunne@example.com'],
  ['Idris Achebe', 'idris.achebe@example.com'],
  ['Kelly Rowntree', 'kelly.rowntree@example.com'],
  ['Nathan Garvey', 'nathan.garvey@example.com'],
  ['Rosa Petrova', 'rosa.petrova@example.com'],
];

const CONSENT_SOURCES = ['checkout', 'homepage-footer', 'gig-page', 'door-signup'] as const;

export function buildSubscriberRows(now: Date): MailingListRow[] {
  return SUBSCRIBER_NAMES.map(([name, email], index) => {
    const status: MailingListRow['status'] =
      index === 17 ? 'unsubscribed' : index === 19 ? 'bounced' : 'subscribed';

    return {
      id: `sub_${index.toString().padStart(3, '0')}`,
      email,
      name,
      status,
      consent_source: CONSENT_SOURCES[index % CONSENT_SOURCES.length]!,
      consent_at: offsetFrom(now, -(index * 4 + 2)),
      unsubscribed_at: status === 'unsubscribed' ? offsetFrom(now, -6) : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

/** Minutes before `now` that each seeded audit entry happened. */
const AUDIT_SCHEDULE: ReadonlyArray<{ minutesAgo: number; entry: Omit<AuditLogRow, 'occurred_at'> }> = [
  {
    minutesAgo: 95,
    entry: {
      id: 'aud_01',
      actor_email: 'anya@ampedupmusic.co.uk',
      action: 'event.published',
      entity_type: 'event',
      entity_id: 'evt_velvet_antler_dec',
      summary: 'Published Velvet Antler at The Lomax Rooms',
    },
  },
  {
    minutesAgo: 260,
    entry: {
      id: 'aud_02',
      actor_email: 'anya@ampedupmusic.co.uk',
      action: 'media.uploaded',
      entity_type: 'media',
      entity_id: 'med_gal_03',
      summary: 'Added 3 photographs to Hollow Coast',
    },
  },
  {
    minutesAgo: 1_450,
    entry: {
      id: 'aud_03',
      actor_email: 'jay@ampedupmusic.co.uk',
      action: 'event.postponed',
      entity_type: 'event',
      entity_id: 'evt_saltwater_nov',
      summary: 'Marked Saltwater Parade as postponed and notified 169 ticket holders',
    },
  },
  {
    minutesAgo: 2_880,
    entry: {
      id: 'aud_04',
      actor_email: 'anya@ampedupmusic.co.uk',
      action: 'ticket_type.created',
      entity_type: 'ticket_type',
      entity_id: 'tt_wa_early',
      summary: 'Added Early Bird to Winter All-Dayer',
    },
  },
  {
    minutesAgo: 4_320,
    entry: {
      id: 'aud_05',
      actor_email: 'jay@ampedupmusic.co.uk',
      action: 'event.duplicated',
      entity_type: 'event',
      entity_id: 'evt_brass_tacks_nye',
      summary: 'Duplicated Brass Tacks Soul Revue as a new draft',
    },
  },
  {
    minutesAgo: 7_200,
    entry: {
      id: 'aud_06',
      actor_email: 'anya@ampedupmusic.co.uk',
      action: 'artist.created',
      entity_type: 'artist',
      entity_id: 'art_mara_veil',
      summary: 'Added Mara Veil to the artist directory',
    },
  },
];

export function buildAuditLogRows(now: Date): AuditLogRow[] {
  return AUDIT_SCHEDULE.map(({ minutesAgo, entry }) => ({
    ...entry,
    occurred_at: offsetFrom(now, 0, -minutesAgo / 60),
  }));
}
