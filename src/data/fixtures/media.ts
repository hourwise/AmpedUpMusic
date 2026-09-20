/**
 * Mock media assets. Replaced by R2-backed records in AMPED-05A.
 *
 * The files themselves are generated abstract stage-lighting artwork produced
 * by scripts/generate-artwork.mjs. Every asset carries real alt text because
 * the admin UI treats alt text as required, and the fixtures should not model
 * a shortcut the product does not allow.
 */

import type { MediaAsset } from '@/types/domain.ts';
import { FIXTURE_EPOCH } from '../clock.ts';

const POSTER = { width: 900, height: 1200, mimeType: 'image/svg+xml', uploadedAt: FIXTURE_EPOCH };
const HERO = { width: 1920, height: 1080, mimeType: 'image/svg+xml', uploadedAt: FIXTURE_EPOCH };
const SQUARE = { width: 800, height: 800, mimeType: 'image/svg+xml', uploadedAt: FIXTURE_EPOCH };
const WIDE = { width: 1200, height: 800, mimeType: 'image/svg+xml', uploadedAt: FIXTURE_EPOCH };

const PHOTO_CREDIT = 'AnyaParallax';

function asset(
  id: string,
  file: string,
  role: MediaAsset['role'],
  alt: string,
  dims: Omit<MediaAsset, 'id' | 'storageKey' | 'url' | 'role' | 'alt'>,
  extra: Partial<MediaAsset> = {},
): MediaAsset {
  return { id, storageKey: `media/${file}`, url: `/media/${file}`, role, alt, ...dims, ...extra };
}

export const MEDIA: MediaAsset[] = [
  // --- Posters -------------------------------------------------------------
  asset('med_poster_glass_hearts', 'poster-glass-hearts.svg', 'poster',
    'Poster artwork for The Glass Hearts at The Lomax Rooms: acid yellow stage beams cutting across a black background.',
    POSTER, { eventId: 'evt_glass_hearts_nov' }),
  asset('med_poster_northern_static', 'poster-northern-static.svg', 'poster',
    'Poster artwork for Northern Static: cyan equaliser bars rising from a dark floor.',
    POSTER, { eventId: 'evt_northern_static_oct' }),
  asset('med_poster_velvet_antler', 'poster-velvet-antler.svg', 'poster',
    'Poster artwork for Velvet Antler: concentric violet rings radiating from a single point of light.',
    POSTER, { eventId: 'evt_velvet_antler_dec' }),
  asset('med_poster_ledger', 'poster-ledger.svg', 'poster',
    'Poster artwork for LEDGER: orange halftone dots burning out towards the centre of a black field.',
    POSTER, { eventId: 'evt_ledger_oct' }),
  asset('med_poster_winter_amp', 'poster-winter-amp.svg', 'poster',
    'Poster artwork for the Amped Up Winter All-Dayer: a green grid under a wide pool of light.',
    POSTER, { eventId: 'evt_winter_allday' }),
  asset('med_poster_saltwater', 'poster-saltwater.svg', 'poster',
    'Poster artwork for Saltwater Parade: pink scan lines across a warm dark background.',
    POSTER, { eventId: 'evt_saltwater_nov' }),
  asset('med_poster_hollow_coast', 'poster-hollow-coast.svg', 'poster',
    'Poster artwork for Hollow Coast: violet beams fanning out over deep blue-black.',
    POSTER, { eventId: 'evt_hollow_coast_past' }),
  asset('med_poster_brass_tacks', 'poster-brass-tacks.svg', 'poster',
    'Poster artwork for Brass Tacks: yellow halftone dots massing towards a bright centre.',
    POSTER, { eventId: 'evt_brass_tacks_past' }),
  asset('med_poster_paper_lions', 'poster-paper-lions.svg', 'poster',
    'Poster artwork for Paper Lions: hard cyan rings on black.',
    POSTER, { eventId: 'evt_paper_lions_past' }),
  asset('med_poster_spring_amp', 'poster-spring-amp.svg', 'poster',
    'Poster artwork for the Amped Up Spring Session: orange equaliser bars on a dark red field.',
    POSTER, { eventId: 'evt_spring_session_past' }),

  // --- Heroes --------------------------------------------------------------
  asset('med_hero_glass_hearts', 'hero-glass-hearts.svg', 'hero',
    'A crowd silhouetted against acid yellow stage lighting, arms raised at the front.',
    HERO, { eventId: 'evt_glass_hearts_nov', credit: PHOTO_CREDIT }),
  asset('med_hero_northern_static', 'hero-northern-static.svg', 'hero',
    'Cyan light spilling over a packed dark room.',
    HERO, { eventId: 'evt_northern_static_oct', credit: PHOTO_CREDIT }),
  asset('med_hero_velvet_antler', 'hero-velvet-antler.svg', 'hero',
    'Violet haze above a still, watching audience.',
    HERO, { eventId: 'evt_velvet_antler_dec', credit: PHOTO_CREDIT }),
  asset('med_hero_ledger', 'hero-ledger.svg', 'hero',
    'Orange light burning through smoke over a crowd.',
    HERO, { eventId: 'evt_ledger_oct', credit: PHOTO_CREDIT }),
  asset('med_hero_hollow_coast', 'hero-hollow-coast.svg', 'hero',
    'Deep violet wash across a crowd with hands in the air.',
    HERO, { eventId: 'evt_hollow_coast_past', credit: PHOTO_CREDIT }),
  asset('med_hero_brass_tacks', 'hero-brass-tacks.svg', 'hero',
    'Warm pink stage light over a dancing crowd.',
    HERO, { eventId: 'evt_brass_tacks_past', credit: PHOTO_CREDIT }),

  // --- Artist portraits ----------------------------------------------------
  asset('med_artist_glass_hearts', 'artist-glass-hearts.svg', 'artist',
    'The Glass Hearts band image: yellow concentric rings on black.', SQUARE, { artistId: 'art_glass_hearts' }),
  asset('med_artist_northern_static', 'artist-northern-static.svg', 'artist',
    'Northern Static band image: cyan equaliser bars.', SQUARE, { artistId: 'art_northern_static' }),
  asset('med_artist_velvet_antler', 'artist-velvet-antler.svg', 'artist',
    'Velvet Antler band image: violet halftone field.', SQUARE, { artistId: 'art_velvet_antler' }),
  asset('med_artist_ledger', 'artist-ledger.svg', 'artist',
    'LEDGER band image: orange grid over black.', SQUARE, { artistId: 'art_ledger' }),
  asset('med_artist_saltwater_parade', 'artist-saltwater-parade.svg', 'artist',
    'Saltwater Parade band image: pink rings on a warm dark background.', SQUARE, { artistId: 'art_saltwater_parade' }),
  asset('med_artist_hollow_coast', 'artist-hollow-coast.svg', 'artist',
    'Hollow Coast band image: violet scan lines.', SQUARE, { artistId: 'art_hollow_coast' }),
  asset('med_artist_brass_tacks', 'artist-brass-tacks.svg', 'artist',
    'Brass Tacks band image: green equaliser bars.', SQUARE, { artistId: 'art_brass_tacks' }),
  asset('med_artist_paper_lions', 'artist-paper-lions.svg', 'artist',
    'Paper Lions band image: cyan beams on black.', SQUARE, { artistId: 'art_paper_lions' }),
  asset('med_artist_mara_veil', 'artist-mara-veil.svg', 'artist',
    'Mara Veil artist image: violet rings radiating outwards.', SQUARE, { artistId: 'art_mara_veil' }),
  asset('med_artist_second_city', 'artist-second-city-sound.svg', 'artist',
    'Second City Sound artist image: yellow grid on black.', SQUARE, { artistId: 'art_second_city' }),

  // --- Galleries (attached to completed events) ----------------------------
  asset('med_gal_01', 'gallery-01.svg', 'gallery',
    'Hollow Coast at Parr Street Hall: the crowd lit from behind in yellow.', WIDE,
    { eventId: 'evt_hollow_coast_past', credit: PHOTO_CREDIT }),
  asset('med_gal_02', 'gallery-02.svg', 'gallery',
    'Hollow Coast at Parr Street Hall: cyan light across the front rows.', WIDE,
    { eventId: 'evt_hollow_coast_past', credit: PHOTO_CREDIT }),
  asset('med_gal_03', 'gallery-03.svg', 'gallery',
    'Hollow Coast at Parr Street Hall: violet beams over the stage.', WIDE,
    { eventId: 'evt_hollow_coast_past', credit: PHOTO_CREDIT }),
  asset('med_gal_04', 'gallery-04.svg', 'gallery',
    'Brass Tacks at Ironworks Social: orange light through smoke.', WIDE,
    { eventId: 'evt_brass_tacks_past', credit: PHOTO_CREDIT }),
  asset('med_gal_05', 'gallery-05.svg', 'gallery',
    'Brass Tacks at Ironworks Social: pink halftone glow over the brass section.', WIDE,
    { eventId: 'evt_brass_tacks_past', credit: PHOTO_CREDIT }),
  asset('med_gal_06', 'gallery-06.svg', 'gallery',
    'Brass Tacks at Ironworks Social: the floor full and moving.', WIDE,
    { eventId: 'evt_brass_tacks_past', credit: PHOTO_CREDIT }),
  asset('med_gal_07', 'gallery-07.svg', 'gallery',
    'Paper Lions at The Cellar: violet equaliser bars behind the band.', WIDE,
    { eventId: 'evt_paper_lions_past', credit: PHOTO_CREDIT }),
  asset('med_gal_08', 'gallery-08.svg', 'gallery',
    'Paper Lions at The Cellar: cyan scan lines across a low ceiling.', WIDE,
    { eventId: 'evt_paper_lions_past', credit: PHOTO_CREDIT }),
  asset('med_gal_09', 'gallery-09.svg', 'gallery',
    'Spring Session at The Lomax Rooms: yellow light over raised hands.', WIDE,
    { eventId: 'evt_spring_session_past', credit: PHOTO_CREDIT }),
  asset('med_gal_10', 'gallery-10.svg', 'gallery',
    'Spring Session at The Lomax Rooms: orange beams from the rig.', WIDE,
    { eventId: 'evt_spring_session_past', credit: PHOTO_CREDIT }),
  asset('med_gal_11', 'gallery-11.svg', 'gallery',
    'Spring Session at The Lomax Rooms: the room in violet just before the last song.', WIDE,
    { eventId: 'evt_spring_session_past', credit: PHOTO_CREDIT }),
  asset('med_gal_12', 'gallery-12.svg', 'gallery',
    'Spring Session at The Lomax Rooms: pink light on the crowd at the barrier.', WIDE,
    { eventId: 'evt_spring_session_past', credit: PHOTO_CREDIT }),

  // --- Social thumbnails ---------------------------------------------------
  asset('med_social_01', 'social-01.svg', 'gallery',
    'Instagram post thumbnail: crowd under yellow light.', SQUARE),
  asset('med_social_02', 'social-02.svg', 'gallery',
    'TikTok post thumbnail: cyan halftone pattern.', SQUARE),
  asset('med_social_03', 'social-03.svg', 'gallery',
    'Instagram post thumbnail: pink light over a full room.', SQUARE),
  asset('med_social_04', 'social-04.svg', 'gallery',
    'Instagram post thumbnail: violet equaliser bars.', SQUARE),

  // --- Default social preview ---------------------------------------------
  asset('med_og_default', 'og-default.svg', 'og',
    'Amped Up Music Promotions.', { width: 1200, height: 630, mimeType: 'image/svg+xml', uploadedAt: FIXTURE_EPOCH }),
];

export const MEDIA_BY_ID = new Map(MEDIA.map((m) => [m.id, m]));

export function galleryForEvent(eventId: string): MediaAsset[] {
  return MEDIA.filter((m) => m.role === 'gallery' && m.eventId === eventId);
}
