/**
 * Mock artists. Replaced by the D1 `artists` table in AMPED-02B.
 *
 * All bands are invented. Social URLs point at example.com on purpose so that
 * nothing in the scaffold links to a real account.
 */

import type { Artist } from '@/types/domain.ts';
import { FIXTURE_EPOCH } from '../clock.ts';

const base = { createdAt: FIXTURE_EPOCH, updatedAt: FIXTURE_EPOCH };

export const ARTISTS: Artist[] = [
  {
    ...base,
    id: 'art_glass_hearts',
    name: 'The Glass Hearts',
    slug: 'the-glass-hearts',
    tagline: 'Four-piece guitar band with a horn section and no sense of restraint.',
    genre: 'Indie rock',
    basedIn: 'Preston',
    imageAssetId: 'med_artist_glass_hearts',
    biography:
      'The Glass Hearts started as a two-piece playing the back room of a pub on Friargate and have spent three years turning into something considerably louder. Their second EP, Hold The Line, was recorded live over two days in a converted mill and sounds like it.\n\nThey have headlined for us four times now and have sold out the last three.',
    links: {
      instagram: 'https://example.com/instagram/theglasshearts',
      bandcamp: 'https://example.com/bandcamp/theglasshearts',
      spotify: 'https://example.com/spotify/theglasshearts',
      website: 'https://example.com/theglasshearts',
    },
  },
  {
    ...base,
    id: 'art_northern_static',
    name: 'Northern Static',
    slug: 'northern-static',
    tagline: 'Synths, drum machines and one very determined guitarist.',
    genre: 'Electronic post-punk',
    basedIn: 'Lancaster',
    imageAssetId: 'med_artist_northern_static',
    biography:
      'Northern Static make the kind of records that sound like a motorway at two in the morning. Three members, a rack of borrowed synthesisers and a light rig they built themselves out of scaffolding clamps.',
    links: {
      instagram: 'https://example.com/instagram/northernstatic',
      soundcloud: 'https://example.com/soundcloud/northernstatic',
      youtube: 'https://example.com/youtube/northernstatic',
    },
  },
  {
    ...base,
    id: 'art_velvet_antler',
    name: 'Velvet Antler',
    slug: 'velvet-antler',
    tagline: 'Slow, heavy and unreasonably beautiful.',
    genre: 'Post-rock',
    basedIn: 'Manchester',
    imageAssetId: 'med_artist_velvet_antler',
    biography:
      'Velvet Antler have one song that lasts eleven minutes and nobody has ever complained. Expect long builds, a cello, and a volume level the venue will quietly ask about afterwards.',
    links: {
      bandcamp: 'https://example.com/bandcamp/velvetantler',
      instagram: 'https://example.com/instagram/velvetantler',
    },
  },
  {
    ...base,
    id: 'art_ledger',
    name: 'LEDGER',
    slug: 'ledger',
    tagline: 'Two drummers. That is the whole pitch.',
    genre: 'Noise rock',
    basedIn: 'Blackpool',
    imageAssetId: 'med_artist_ledger',
    biography:
      'LEDGER have two drummers, a bass player and an amplifier that has been repaired more times than it has been serviced. Their set is thirty-two minutes long and does not include a ballad.',
    links: {
      instagram: 'https://example.com/instagram/ledgerband',
      tiktok: 'https://example.com/tiktok/ledgerband',
      bandcamp: 'https://example.com/bandcamp/ledger',
    },
  },
  {
    ...base,
    id: 'art_saltwater_parade',
    name: 'Saltwater Parade',
    slug: 'saltwater-parade',
    tagline: 'Big choruses, seaside melancholy.',
    genre: 'Alt-pop',
    basedIn: 'Morecambe',
    imageAssetId: 'med_artist_saltwater_parade',
    biography:
      'Formed on the promenade and still writing about it. Saltwater Parade are five people who can all sing, which is an unfair advantage and they know it.',
    links: {
      instagram: 'https://example.com/instagram/saltwaterparade',
      spotify: 'https://example.com/spotify/saltwaterparade',
      tiktok: 'https://example.com/tiktok/saltwaterparade',
    },
  },
  {
    ...base,
    id: 'art_hollow_coast',
    name: 'Hollow Coast',
    slug: 'hollow-coast',
    tagline: 'Reverb, restraint, and a drummer who plays with brushes until she does not.',
    genre: 'Dream pop',
    basedIn: 'Liverpool',
    imageAssetId: 'med_artist_hollow_coast',
    biography:
      'Hollow Coast spent a year refusing to play live and then played eleven shows in six weeks. Their debut album was self-released and sold out of vinyl in a fortnight.',
    links: {
      instagram: 'https://example.com/instagram/hollowcoast',
      bandcamp: 'https://example.com/bandcamp/hollowcoast',
      spotify: 'https://example.com/spotify/hollowcoast',
    },
  },
  {
    ...base,
    id: 'art_brass_tacks',
    name: 'Brass Tacks',
    slug: 'brass-tacks',
    tagline: 'Seven-piece soul revue. Bring shoes you can move in.',
    genre: 'Soul / funk',
    basedIn: 'Warrington',
    imageAssetId: 'med_artist_brass_tacks',
    biography:
      'Brass Tacks are seven people, four of whom play brass, and they have never once played a quiet gig. They close with a cover nobody expects and everybody sings.',
    links: {
      facebook: 'https://example.com/facebook/brasstacksband',
      instagram: 'https://example.com/instagram/brasstacksband',
      youtube: 'https://example.com/youtube/brasstacks',
    },
  },
  {
    ...base,
    id: 'art_paper_lions',
    name: 'Paper Lions',
    slug: 'paper-lions',
    tagline: 'Three chords and a grudge.',
    genre: 'Punk',
    basedIn: 'Preston',
    imageAssetId: 'med_artist_paper_lions',
    biography:
      'Paper Lions formed in a sixth form common room and have not slowed down since. Twenty-two minute sets, no encore, merch table run by one of their mums.',
    links: {
      instagram: 'https://example.com/instagram/paperlionsuk',
      bandcamp: 'https://example.com/bandcamp/paperlions',
    },
  },
  {
    ...base,
    id: 'art_mara_veil',
    name: 'Mara Veil',
    slug: 'mara-veil',
    tagline: 'Solo. Loop pedal. Absolute silence in the room.',
    genre: 'Folk',
    basedIn: 'Kendal',
    imageAssetId: 'med_artist_mara_veil',
    biography:
      'Mara Veil plays alone with a loop pedal and builds each song in front of you. We have watched a room of two hundred people stop talking within ninety seconds of the first note more than once.',
    links: {
      bandcamp: 'https://example.com/bandcamp/maraveil',
      instagram: 'https://example.com/instagram/maraveil',
      spotify: 'https://example.com/spotify/maraveil',
    },
  },
  {
    ...base,
    id: 'art_second_city',
    name: 'Second City Sound',
    slug: 'second-city-sound',
    tagline: 'DJ set. Northern soul into whatever the room wants.',
    genre: 'DJ',
    basedIn: 'Preston',
    imageAssetId: 'med_artist_second_city',
    biography:
      'Second City Sound close most of our nights. Records only, no laptop, and a bag that starts with northern soul and ends somewhere none of us predicted.',
    links: {
      instagram: 'https://example.com/instagram/secondcitysound',
      soundcloud: 'https://example.com/soundcloud/secondcitysound',
    },
  },
];

export const ARTISTS_BY_ID = new Map(ARTISTS.map((a) => [a.id, a]));
