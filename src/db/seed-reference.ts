/**
 * Seed rows for the reference and diary tables: venues, artists, events,
 * line-ups and ticket types.
 *
 * This is the AMPED-01 fixture dataset translated into the V1 schema. The
 * event ids, slugs, statuses, prices, capacities and sale windows are
 * deliberately identical to `src/data/fixtures/*`, so every visual state the
 * scaffold demonstrates is reachable from the database:
 *
 *   evt_glass_hearts_nov   published,  selling fast          <- the next gig
 *   evt_ledger_oct         published,  sold out
 *   evt_northern_static_oct published, mixed (early bird gone, GA on sale)
 *   evt_saltwater_nov      postponed,  refunds offered
 *   evt_velvet_antler_dec  published,  last few
 *   evt_winter_allday      published,  not yet on sale
 *   evt_paper_lions_jan    cancelled
 *   evt_brass_tacks_nye    draft, no artwork yet (admin only)
 *   ...plus four completed events with galleries.
 *
 * Events and artists are inserted without their artwork columns, which are
 * written after the media rows exist (see ./seed.ts).
 */

import type { SocialLinks } from '../types/domain.ts';
import type { ArtistRow, EventArtistRow, EventRow, TicketTypeRow, VenueRow } from './schema.ts';
import { londonAt } from './seed-clock.ts';

/** The eight social columns every linkable table carries. */
export interface SocialLinkColumns {
  link_instagram: string | null;
  link_tiktok: string | null;
  link_facebook: string | null;
  link_youtube: string | null;
  link_spotify: string | null;
  link_bandcamp: string | null;
  link_soundcloud: string | null;
  link_website: string | null;
}

/** Turn a `SocialLinks` map into the eight columns the schema stores. */
export function socialLinkColumns(links: SocialLinks): SocialLinkColumns {
  return {
    link_instagram: links.instagram ?? null,
    link_tiktok: links.tiktok ?? null,
    link_facebook: links.facebook ?? null,
    link_youtube: links.youtube ?? null,
    link_spotify: links.spotify ?? null,
    link_bandcamp: links.bandcamp ?? null,
    link_soundcloud: links.soundcloud ?? null,
    link_website: links.website ?? null,
  };
}

export interface ReferenceRows {
  venues: VenueRow[];
  artists: ArtistRow[];
  events: EventRow[];
  eventArtists: EventArtistRow[];
  ticketTypes: TicketTypeRow[];
}

const MAP_QUERY_BASE = 'https://www.openstreetmap.org/search?query=';

export function buildReferenceRows(now: Date): ReferenceRows {
  const epoch = now.toISOString();

  // -------------------------------------------------------------------------
  // Venues
  // -------------------------------------------------------------------------
  const venues: VenueRow[] = [
    {
      id: 'ven_lomax',
      name: 'The Lomax Rooms',
      slug: 'the-lomax-rooms',
      address_line1: '14 Sedgewick Street',
      address_line2: null,
      city: 'Preston',
      postcode: 'PR1 4AQ',
      standard_notes:
        'Downstairs bar is open from 18:00 and serves until close. Cloakroom is £1 a coat, cash or card. The smoking area is through the side door on Sedgewick Street.',
      accessibility_info:
        'Step-free entrance from Sedgewick Street with a level route to the main room and the accessible toilet. No lift to the balcony. Personal assistants come in free of charge - email us before the day and we will add them to the door list.',
      capacity: 220,
      website_url: 'https://example.com/lomax-rooms',
      map_url: `${MAP_QUERY_BASE}Preston%20PR1`,
      created_at: epoch,
      updated_at: epoch,
    },
    {
      id: 'ven_ironworks',
      name: 'Ironworks Social',
      slug: 'ironworks-social',
      address_line1: 'Unit 3, Canal Side Works',
      address_line2: 'Bispham Road',
      city: 'Blackpool',
      postcode: 'FY2 0HA',
      standard_notes:
        'Big room, concrete floor, proper PA. Parking on Bispham Road is free after 18:00. The 14 bus stops two minutes from the door.',
      accessibility_info:
        'Fully step-free throughout, including the bar and toilets. Two accessible viewing spaces at the front of house desk - reserve one when you book by emailing tickets@ampedupmusicpromo.co.uk.',
      capacity: 350,
      website_url: null,
      map_url: `${MAP_QUERY_BASE}Blackpool%20FY2`,
      created_at: epoch,
      updated_at: epoch,
    },
    {
      id: 'ven_cellar',
      name: 'The Cellar at Hartley Street',
      slug: 'the-cellar-hartley-street',
      address_line1: '2b Hartley Street',
      address_line2: null,
      city: 'Lancaster',
      postcode: 'LA1 1XP',
      standard_notes:
        'Small, low ceiling, very loud. Earplugs are free on the bar. Gets warm - the cloakroom is worth using.',
      accessibility_info:
        'The room is down twelve steps with a handrail and there is currently no step-free route. We are honest about this rather than vague: if stairs are a problem, the same bills usually play The Lomax Rooms within a couple of months and we will happily let you know when.',
      capacity: 90,
      website_url: null,
      map_url: `${MAP_QUERY_BASE}Lancaster%20LA1`,
      created_at: epoch,
      updated_at: epoch,
    },
    {
      id: 'ven_parr_hall',
      name: 'Parr Street Hall',
      slug: 'parr-street-hall',
      address_line1: 'Parr Street',
      address_line2: null,
      city: 'Warrington',
      postcode: 'WA1 2AX',
      standard_notes:
        'Seated balcony, standing floor. Doors are on Parr Street; the box office window is to the left of the main entrance.',
      accessibility_info:
        'Step-free entrance and lift to the balcony. Six wheelchair spaces on the balcony with a companion seat each. Hearing loop covers the stalls and balcony.',
      capacity: 480,
      website_url: 'https://example.com/parr-street-hall',
      map_url: `${MAP_QUERY_BASE}Warrington%20WA1`,
      created_at: epoch,
      updated_at: epoch,
    },
  ];

  // -------------------------------------------------------------------------
  // Artists
  // -------------------------------------------------------------------------
  const artists: ArtistRow[] = [
    {
      id: 'art_glass_hearts',
      name: 'The Glass Hearts',
      slug: 'the-glass-hearts',
      tagline: 'Four-piece guitar band with a horn section and no sense of restraint.',
      genre: 'Indie rock',
      based_in: 'Preston',
      image_asset_id: null,
      biography:
        'The Glass Hearts started as a two-piece playing the back room of a pub on Friargate and have spent three years turning into something considerably louder. Their second EP, Hold The Line, was recorded live over two days in a converted mill and sounds like it.\n\nThey have headlined for us four times now and have sold out the last three.',
      ...socialLinkColumns({
        instagram: 'https://example.com/instagram/theglasshearts',
        bandcamp: 'https://example.com/bandcamp/theglasshearts',
        spotify: 'https://example.com/spotify/theglasshearts',
        website: 'https://example.com/theglasshearts',
      }),
      created_at: epoch,
      updated_at: epoch,
    },
    {
      id: 'art_northern_static',
      name: 'Northern Static',
      slug: 'northern-static',
      tagline: 'Synths, drum machines and one very determined guitarist.',
      genre: 'Electronic post-punk',
      based_in: 'Lancaster',
      image_asset_id: null,
      biography:
        'Northern Static make the kind of records that sound like a motorway at two in the morning. Three members, a rack of borrowed synthesisers and a light rig they built themselves out of scaffolding clamps.',
      ...socialLinkColumns({
        instagram: 'https://example.com/instagram/northernstatic',
        soundcloud: 'https://example.com/soundcloud/northernstatic',
        youtube: 'https://example.com/youtube/northernstatic',
      }),
      created_at: epoch,
      updated_at: epoch,
    },
    {
      id: 'art_velvet_antler',
      name: 'Velvet Antler',
      slug: 'velvet-antler',
      tagline: 'Slow, heavy and unreasonably beautiful.',
      genre: 'Post-rock',
      based_in: 'Manchester',
      image_asset_id: null,
      biography:
        'Velvet Antler have one song that lasts eleven minutes and nobody has ever complained. Expect long builds, a cello, and a volume level the venue will quietly ask about afterwards.',
      ...socialLinkColumns({
        bandcamp: 'https://example.com/bandcamp/velvetantler',
        instagram: 'https://example.com/instagram/velvetantler',
      }),
      created_at: epoch,
      updated_at: epoch,
    },
    {
      id: 'art_ledger',
      name: 'LEDGER',
      slug: 'ledger',
      tagline: 'Two drummers. That is the whole pitch.',
      genre: 'Noise rock',
      based_in: 'Blackpool',
      image_asset_id: null,
      biography:
        'LEDGER have two drummers, a bass player and an amplifier that has been repaired more times than it has been serviced. Their set is thirty-two minutes long and does not include a ballad.',
      ...socialLinkColumns({
        instagram: 'https://example.com/instagram/ledgerband',
        tiktok: 'https://example.com/tiktok/ledgerband',
        bandcamp: 'https://example.com/bandcamp/ledger',
      }),
      created_at: epoch,
      updated_at: epoch,
    },
    {
      id: 'art_saltwater_parade',
      name: 'Saltwater Parade',
      slug: 'saltwater-parade',
      tagline: 'Big choruses, seaside melancholy.',
      genre: 'Alt-pop',
      based_in: 'Morecambe',
      image_asset_id: null,
      biography:
        'Formed on the promenade and still writing about it. Saltwater Parade are five people who can all sing, which is an unfair advantage and they know it.',
      ...socialLinkColumns({
        instagram: 'https://example.com/instagram/saltwaterparade',
        spotify: 'https://example.com/spotify/saltwaterparade',
        tiktok: 'https://example.com/tiktok/saltwaterparade',
      }),
      created_at: epoch,
      updated_at: epoch,
    },
    {
      id: 'art_hollow_coast',
      name: 'Hollow Coast',
      slug: 'hollow-coast',
      tagline: 'Reverb, restraint, and a drummer who plays with brushes until she does not.',
      genre: 'Dream pop',
      based_in: 'Liverpool',
      image_asset_id: null,
      biography:
        'Hollow Coast spent a year refusing to play live and then played eleven shows in six weeks. Their debut album was self-released and sold out of vinyl in a fortnight.',
      ...socialLinkColumns({
        instagram: 'https://example.com/instagram/hollowcoast',
        bandcamp: 'https://example.com/bandcamp/hollowcoast',
        spotify: 'https://example.com/spotify/hollowcoast',
      }),
      created_at: epoch,
      updated_at: epoch,
    },
    {
      id: 'art_brass_tacks',
      name: 'Brass Tacks',
      slug: 'brass-tacks',
      tagline: 'Seven-piece soul revue. Bring shoes you can move in.',
      genre: 'Soul / funk',
      based_in: 'Warrington',
      image_asset_id: null,
      biography:
        'Brass Tacks are seven people, four of whom play brass, and they have never once played a quiet gig. They close with a cover nobody expects and everybody sings.',
      ...socialLinkColumns({
        facebook: 'https://example.com/facebook/brasstacksband',
        instagram: 'https://example.com/instagram/brasstacksband',
        youtube: 'https://example.com/youtube/brasstacks',
      }),
      created_at: epoch,
      updated_at: epoch,
    },
    {
      id: 'art_paper_lions',
      name: 'Paper Lions',
      slug: 'paper-lions',
      tagline: 'Three chords and a grudge.',
      genre: 'Punk',
      based_in: 'Preston',
      image_asset_id: null,
      biography:
        'Paper Lions formed in a sixth form common room and have not slowed down since. Twenty-two minute sets, no encore, merch table run by one of their mums.',
      ...socialLinkColumns({
        instagram: 'https://example.com/instagram/paperlionsuk',
        bandcamp: 'https://example.com/bandcamp/paperlions',
      }),
      created_at: epoch,
      updated_at: epoch,
    },
    {
      id: 'art_mara_veil',
      name: 'Mara Veil',
      slug: 'mara-veil',
      tagline: 'Solo. Loop pedal. Absolute silence in the room.',
      genre: 'Folk',
      based_in: 'Kendal',
      image_asset_id: null,
      biography:
        'Mara Veil plays alone with a loop pedal and builds each song in front of you. We have watched a room of two hundred people stop talking within ninety seconds of the first note more than once.',
      ...socialLinkColumns({
        bandcamp: 'https://example.com/bandcamp/maraveil',
        instagram: 'https://example.com/instagram/maraveil',
        spotify: 'https://example.com/spotify/maraveil',
      }),
      created_at: epoch,
      updated_at: epoch,
    },
    {
      id: 'art_second_city',
      name: 'Second City Sound',
      slug: 'second-city-sound',
      tagline: 'DJ set. Northern soul into whatever the room wants.',
      genre: 'DJ',
      based_in: 'Preston',
      image_asset_id: null,
      biography:
        'Second City Sound close most of our nights. Records only, no laptop, and a bag that starts with northern soul and ends somewhere none of us predicted.',
      ...socialLinkColumns({
        instagram: 'https://example.com/instagram/secondcitysound',
        soundcloud: 'https://example.com/soundcloud/secondcitysound',
      }),
      created_at: epoch,
      updated_at: epoch,
    },
  ];

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  /** The shape every event row shares before its own fields are added. */
  const eventBase = {
    poster_asset_id: null,
    hero_asset_id: null,
    photography_credit: null,
    photography_gallery_url: null,
    photography_photographer_url: null,
    internal_notes: null,
    status_message: null,
    rescheduled_to_event_id: null,
    published_at: epoch,
    created_at: epoch,
    updated_at: epoch,
  };

  const anyaCredit = {
    photography_credit: 'AnyaParallax',
    photography_photographer_url: 'https://anyaparallax.com',
  };

  const events: EventRow[] = [
    {
      ...eventBase,
      id: 'evt_glass_hearts_nov',
      title: 'The Glass Hearts',
      slug: 'the-glass-hearts-lomax-rooms',
      status: 'published',
      strapline: 'Amped Up presents',
      description:
        'The Glass Hearts come home. Four of them, a horn section borrowed from two other bands, and the whole of Hold The Line played start to finish for the first time.\n\nMara Veil opens with a solo set and a loop pedal, and Second City Sound plays records until closing. This is the fourth time they have headlined for us and the third time we have had to stop selling tickets early, so do not leave it.',
      venue_id: 'ven_lomax',
      doors_at: londonAt(now, 12, '19:00'),
      starts_at: londonAt(now, 12, '19:45'),
      ends_at: londonAt(now, 12, '23:00'),
      age_restriction: '16-plus',
      accessibility_notes:
        'Two accessible viewing positions are held for every Amped Up show at this venue. Email tickets@ampedupmusicpromo.co.uk after booking and we will reserve one.',
      ...anyaCredit,
      ...socialLinkColumns({
        instagram: 'https://example.com/instagram/ampedup/glasshearts',
        facebook: 'https://example.com/facebook/events/glasshearts',
      }),
    },
    {
      ...eventBase,
      id: 'evt_ledger_oct',
      title: 'LEDGER',
      slug: 'ledger-the-cellar',
      status: 'published',
      strapline: 'Amped Up presents',
      description:
        'Two drummers in a room built for ninety people. LEDGER play thirty-two minutes and then it is over.\n\nPaper Lions open. Earplugs are free on the bar and we strongly suggest you take a pair.',
      venue_id: 'ven_cellar',
      doors_at: londonAt(now, 19, '19:30'),
      starts_at: londonAt(now, 19, '20:15'),
      ends_at: londonAt(now, 19, '23:00'),
      age_restriction: '18-plus',
      accessibility_notes: null,
      ...anyaCredit,
      ...socialLinkColumns({ instagram: 'https://example.com/instagram/ampedup/ledger' }),
    },
    {
      ...eventBase,
      id: 'evt_northern_static_oct',
      title: 'Northern Static',
      slug: 'northern-static-ironworks-social',
      status: 'published',
      strapline: 'Amped Up presents',
      description:
        'Northern Static bring the full rig - the one they built out of scaffolding clamps - to the biggest room we use.\n\nHollow Coast support, playing their first Amped Up show since the album came out. Early bird tickets have gone; general admission is still on sale.',
      venue_id: 'ven_ironworks',
      doors_at: londonAt(now, 26, '19:00'),
      starts_at: londonAt(now, 26, '20:00'),
      ends_at: londonAt(now, 26, '23:30'),
      age_restriction: '14-plus',
      accessibility_notes:
        'Step-free throughout. Two accessible viewing spaces at the front of house desk - reserve one by emailing tickets@ampedupmusicpromo.co.uk.',
      ...anyaCredit,
      ...socialLinkColumns({
        instagram: 'https://example.com/instagram/ampedup/northernstatic',
        tiktok: 'https://example.com/tiktok/ampedup/northernstatic',
      }),
    },
    {
      ...eventBase,
      id: 'evt_saltwater_nov',
      title: 'Saltwater Parade',
      slug: 'saltwater-parade-parr-street-hall',
      status: 'postponed',
      strapline: 'Amped Up presents',
      description:
        'Saltwater Parade at Parr Street Hall, with a full band and the balcony open.',
      status_message:
        'This show has been postponed. Saltwater Parade have had to pull the date on medical advice and we are working on a new one for the spring. Your tickets remain valid for the rescheduled date. If you would rather have a refund, reply to your confirmation email and we will sort it within five working days - no explanation needed.',
      venue_id: 'ven_parr_hall',
      doors_at: londonAt(now, 33, '19:00'),
      starts_at: londonAt(now, 33, '20:00'),
      ends_at: londonAt(now, 33, '23:00'),
      age_restriction: 'all-ages',
      accessibility_notes: null,
      ...socialLinkColumns({ instagram: 'https://example.com/instagram/ampedup/saltwater' }),
    },
    {
      ...eventBase,
      id: 'evt_velvet_antler_dec',
      title: 'Velvet Antler',
      slug: 'velvet-antler-lomax-rooms',
      status: 'published',
      strapline: 'Amped Up presents',
      description:
        'Velvet Antler play one set, no support and no interval. Doors at seven, on stage at eight, and if you are late you will be waiting at the back until the first long one finishes.\n\nMara Veil opens the room with thirty minutes.',
      venue_id: 'ven_lomax',
      doors_at: londonAt(now, 40, '19:00'),
      starts_at: londonAt(now, 40, '20:00'),
      ends_at: londonAt(now, 40, '22:30'),
      age_restriction: '16-plus',
      accessibility_notes: null,
      ...anyaCredit,
      ...socialLinkColumns({ bandcamp: 'https://example.com/bandcamp/velvetantler' }),
    },
    {
      ...eventBase,
      id: 'evt_winter_allday',
      title: 'Amped Up Winter All-Dayer',
      slug: 'amped-up-winter-all-dayer',
      status: 'published',
      strapline: 'Six bands, one room, one ticket',
      description:
        'Our second all-dayer. Doors at two in the afternoon, six bands across one stage, last band off at eleven.\n\nThe full line-up goes up two weeks before tickets open. Early bird tickets are limited to eighty and they will not last.',
      venue_id: 'ven_ironworks',
      doors_at: londonAt(now, 55, '14:00'),
      starts_at: londonAt(now, 55, '14:30'),
      ends_at: londonAt(now, 55, '23:00'),
      age_restriction: '14-plus',
      accessibility_notes: null,
      ...socialLinkColumns({ instagram: 'https://example.com/instagram/ampedup/winterallday' }),
    },
    {
      ...eventBase,
      id: 'evt_paper_lions_jan',
      title: 'Paper Lions',
      slug: 'paper-lions-the-cellar',
      status: 'cancelled',
      strapline: 'Amped Up presents',
      description: 'Paper Lions in the smallest room we use.',
      status_message:
        'This show has been cancelled. The venue has a licensing problem it could not resolve in time and we were unable to move the date. Everyone who bought a ticket has been refunded in full and should see the money back within five working days. If you have not, email tickets@ampedupmusicpromo.co.uk and we will chase it.',
      venue_id: 'ven_cellar',
      doors_at: londonAt(now, 47, '19:30'),
      starts_at: londonAt(now, 47, '20:15'),
      ends_at: londonAt(now, 47, '23:00'),
      age_restriction: '18-plus',
      accessibility_notes: null,
      ...socialLinkColumns({}),
    },
    {
      ...eventBase,
      id: 'evt_brass_tacks_nye',
      title: 'Brass Tacks New Year Social',
      slug: 'brass-tacks-new-year-social',
      status: 'draft',
      strapline: 'Amped Up presents',
      description:
        'Seven-piece soul revue, a late licence and a dance floor. Confirming the support and the bar extension before this goes live.',
      venue_id: 'ven_parr_hall',
      doors_at: londonAt(now, 69, '20:00'),
      starts_at: londonAt(now, 69, '21:00'),
      ends_at: londonAt(now, 70, '01:00'),
      age_restriction: '18-plus',
      accessibility_notes: null,
      internal_notes:
        'Waiting on the late licence before publishing. Ask the venue about the balcony bar. Poster not commissioned yet.',
      published_at: null,
      ...socialLinkColumns({}),
    },
    {
      ...eventBase,
      id: 'evt_hollow_coast_past',
      title: 'Hollow Coast',
      slug: 'hollow-coast-parr-street-hall',
      status: 'completed',
      strapline: 'Amped Up presents',
      description:
        'Hollow Coast headlined Parr Street Hall with Saltwater Parade supporting. Sold out ten days ahead and the balcony was open for the first time in two years.',
      venue_id: 'ven_parr_hall',
      doors_at: londonAt(now, -16, '19:00'),
      starts_at: londonAt(now, -16, '20:00'),
      ends_at: londonAt(now, -16, '23:00'),
      age_restriction: 'all-ages',
      accessibility_notes: null,
      photography_credit: 'AnyaParallax',
      photography_gallery_url: 'https://anyaparallax.com/galleries/hollow-coast-parr-street',
      photography_photographer_url: 'https://anyaparallax.com',
      ...socialLinkColumns({ instagram: 'https://example.com/instagram/ampedup/hollowcoast' }),
    },
    {
      ...eventBase,
      id: 'evt_brass_tacks_past',
      title: 'Brass Tacks Soul Revue',
      slug: 'brass-tacks-soul-revue-ironworks',
      status: 'completed',
      strapline: 'Amped Up presents',
      description:
        'Seven people, four of them playing brass, and a floor that did not stop for ninety minutes. Second City Sound played records either side.',
      venue_id: 'ven_ironworks',
      doors_at: londonAt(now, -43, '19:30'),
      starts_at: londonAt(now, -43, '20:30'),
      ends_at: londonAt(now, -43, '23:30'),
      age_restriction: '18-plus',
      accessibility_notes: null,
      photography_credit: 'AnyaParallax',
      photography_gallery_url: 'https://anyaparallax.com/galleries/brass-tacks-ironworks',
      photography_photographer_url: 'https://anyaparallax.com',
      ...socialLinkColumns({ facebook: 'https://example.com/facebook/events/brasstacks' }),
    },
    {
      ...eventBase,
      id: 'evt_paper_lions_past',
      title: 'Paper Lions',
      slug: 'paper-lions-the-cellar-summer',
      status: 'completed',
      strapline: 'Amped Up presents',
      description:
        'Paper Lions and LEDGER in a room with a low ceiling and no air conditioning. Twenty-two minutes and thirty-two minutes respectively, and everybody went home happy and slightly deaf.',
      venue_id: 'ven_cellar',
      doors_at: londonAt(now, -71, '19:30'),
      starts_at: londonAt(now, -71, '20:15'),
      ends_at: londonAt(now, -71, '23:00'),
      age_restriction: '18-plus',
      accessibility_notes: null,
      photography_credit: 'AnyaParallax',
      photography_gallery_url: 'https://anyaparallax.com/galleries/paper-lions-cellar',
      photography_photographer_url: 'https://anyaparallax.com',
      ...socialLinkColumns({}),
    },
    {
      ...eventBase,
      id: 'evt_spring_session_past',
      title: 'Amped Up Spring Session',
      slug: 'amped-up-spring-session',
      status: 'completed',
      strapline: 'Four bands, one ticket',
      description:
        'Our first all-dayer. Four bands, doors at three, and a queue down Sedgewick Street by half past two. The Glass Hearts closed it.',
      venue_id: 'ven_lomax',
      doors_at: londonAt(now, -106, '15:00'),
      starts_at: londonAt(now, -106, '15:30'),
      ends_at: londonAt(now, -106, '23:00'),
      age_restriction: '14-plus',
      accessibility_notes: null,
      photography_credit: 'AnyaParallax',
      photography_gallery_url: 'https://anyaparallax.com/galleries/amped-up-spring-session',
      photography_photographer_url: 'https://anyaparallax.com',
      ...socialLinkColumns({ instagram: 'https://example.com/instagram/ampedup/springsession' }),
    },
  ];

  // -------------------------------------------------------------------------
  // Line-ups
  // -------------------------------------------------------------------------
  const eventArtists: EventArtistRow[] = [
    { event_id: 'evt_glass_hearts_nov', artist_id: 'art_glass_hearts', position: 0, billing_note: null, set_time: londonAt(now, 12, '21:30') },
    { event_id: 'evt_glass_hearts_nov', artist_id: 'art_mara_veil', position: 1, billing_note: 'Solo set', set_time: londonAt(now, 12, '20:30') },
    { event_id: 'evt_glass_hearts_nov', artist_id: 'art_second_city', position: 2, billing_note: 'DJ set until close', set_time: londonAt(now, 12, '22:45') },

    { event_id: 'evt_ledger_oct', artist_id: 'art_ledger', position: 0, billing_note: null, set_time: londonAt(now, 19, '21:30') },
    { event_id: 'evt_ledger_oct', artist_id: 'art_paper_lions', position: 1, billing_note: null, set_time: londonAt(now, 19, '20:30') },

    { event_id: 'evt_northern_static_oct', artist_id: 'art_northern_static', position: 0, billing_note: null, set_time: londonAt(now, 26, '21:45') },
    { event_id: 'evt_northern_static_oct', artist_id: 'art_hollow_coast', position: 1, billing_note: null, set_time: londonAt(now, 26, '20:30') },

    { event_id: 'evt_saltwater_nov', artist_id: 'art_saltwater_parade', position: 0, billing_note: null, set_time: null },

    { event_id: 'evt_velvet_antler_dec', artist_id: 'art_velvet_antler', position: 0, billing_note: null, set_time: londonAt(now, 40, '20:45') },
    { event_id: 'evt_velvet_antler_dec', artist_id: 'art_mara_veil', position: 1, billing_note: null, set_time: londonAt(now, 40, '20:00') },

    { event_id: 'evt_winter_allday', artist_id: 'art_brass_tacks', position: 0, billing_note: null, set_time: null },
    { event_id: 'evt_winter_allday', artist_id: 'art_saltwater_parade', position: 1, billing_note: null, set_time: null },
    { event_id: 'evt_winter_allday', artist_id: 'art_paper_lions', position: 2, billing_note: null, set_time: null },
    { event_id: 'evt_winter_allday', artist_id: 'art_mara_veil', position: 3, billing_note: null, set_time: null },
    { event_id: 'evt_winter_allday', artist_id: 'art_second_city', position: 4, billing_note: 'Between every set', set_time: null },

    { event_id: 'evt_paper_lions_jan', artist_id: 'art_paper_lions', position: 0, billing_note: null, set_time: null },

    { event_id: 'evt_brass_tacks_nye', artist_id: 'art_brass_tacks', position: 0, billing_note: null, set_time: null },

    { event_id: 'evt_hollow_coast_past', artist_id: 'art_hollow_coast', position: 0, billing_note: null, set_time: null },
    { event_id: 'evt_hollow_coast_past', artist_id: 'art_saltwater_parade', position: 1, billing_note: null, set_time: null },

    { event_id: 'evt_brass_tacks_past', artist_id: 'art_brass_tacks', position: 0, billing_note: null, set_time: null },
    { event_id: 'evt_brass_tacks_past', artist_id: 'art_second_city', position: 1, billing_note: 'DJ set', set_time: null },

    { event_id: 'evt_paper_lions_past', artist_id: 'art_paper_lions', position: 0, billing_note: null, set_time: null },
    { event_id: 'evt_paper_lions_past', artist_id: 'art_ledger', position: 1, billing_note: null, set_time: null },

    { event_id: 'evt_spring_session_past', artist_id: 'art_glass_hearts', position: 0, billing_note: null, set_time: null },
    { event_id: 'evt_spring_session_past', artist_id: 'art_northern_static', position: 1, billing_note: null, set_time: null },
    { event_id: 'evt_spring_session_past', artist_id: 'art_saltwater_parade', position: 2, billing_note: null, set_time: null },
    { event_id: 'evt_spring_session_past', artist_id: 'art_mara_veil', position: 3, billing_note: null, set_time: null },
  ];

  // -------------------------------------------------------------------------
  // Ticket types
  // -------------------------------------------------------------------------
  const ticketTypes: TicketTypeRow[] = [
    // The Glass Hearts - selling fast
    { id: 'tt_gh_early', event_id: 'evt_glass_hearts_nov', name: 'Early Bird', description: 'Limited allocation, first 60 only.', price_in_pence: 700, capacity: 60, max_per_order: 6, sales_open_at: null, sales_close_at: londonAt(now, 5, '23:59'), position: 0, visibility: 'public' },
    { id: 'tt_gh_ga', event_id: 'evt_glass_hearts_nov', name: 'General Admission', description: 'Standing, unreserved.', price_in_pence: 1000, capacity: 140, max_per_order: 6, sales_open_at: null, sales_close_at: null, position: 1, visibility: 'public' },
    { id: 'tt_gh_guest', event_id: 'evt_glass_hearts_nov', name: 'Guest list', description: null, price_in_pence: 0, capacity: 20, max_per_order: null, sales_open_at: null, sales_close_at: null, position: 2, visibility: 'hidden' },

    // LEDGER - sold out
    { id: 'tt_led_ga', event_id: 'evt_ledger_oct', name: 'General Admission', description: 'Standing. The room holds ninety and that is the lot.', price_in_pence: 800, capacity: 82, max_per_order: 4, sales_open_at: null, sales_close_at: null, position: 0, visibility: 'public' },
    { id: 'tt_led_guest', event_id: 'evt_ledger_oct', name: 'Guest list', description: null, price_in_pence: 0, capacity: 8, max_per_order: null, sales_open_at: null, sales_close_at: null, position: 1, visibility: 'hidden' },

    // Northern Static - mixed
    { id: 'tt_ns_early', event_id: 'evt_northern_static_oct', name: 'Early Bird', description: 'Gone. Kept here so you can see it sold.', price_in_pence: 900, capacity: 80, max_per_order: 6, sales_open_at: null, sales_close_at: null, position: 0, visibility: 'public' },
    { id: 'tt_ns_ga', event_id: 'evt_northern_static_oct', name: 'General Admission', description: 'Standing, unreserved.', price_in_pence: 1300, capacity: 240, max_per_order: 8, sales_open_at: null, sales_close_at: null, position: 1, visibility: 'public' },
    { id: 'tt_ns_guest', event_id: 'evt_northern_static_oct', name: 'Guest list', description: null, price_in_pence: 0, capacity: 30, max_per_order: null, sales_open_at: null, sales_close_at: null, position: 2, visibility: 'hidden' },

    // Saltwater Parade - postponed
    { id: 'tt_sw_ga', event_id: 'evt_saltwater_nov', name: 'General Admission', description: null, price_in_pence: 1400, capacity: 300, max_per_order: 8, sales_open_at: null, sales_close_at: null, position: 0, visibility: 'public' },
    { id: 'tt_sw_seated', event_id: 'evt_saltwater_nov', name: 'Seated balcony', description: 'Numbered seat, balcony level.', price_in_pence: 1800, capacity: 140, max_per_order: 6, sales_open_at: null, sales_close_at: null, position: 1, visibility: 'public' },

    // Velvet Antler - last few
    { id: 'tt_va_ga', event_id: 'evt_velvet_antler_dec', name: 'General Admission', description: 'Standing, unreserved.', price_in_pence: 1200, capacity: 200, max_per_order: 6, sales_open_at: null, sales_close_at: null, position: 0, visibility: 'public' },
    { id: 'tt_va_guest', event_id: 'evt_velvet_antler_dec', name: 'Guest list', description: null, price_in_pence: 0, capacity: 20, max_per_order: null, sales_open_at: null, sales_close_at: null, position: 1, visibility: 'hidden' },

    // Winter All-Dayer - not yet on sale
    { id: 'tt_wa_early', event_id: 'evt_winter_allday', name: 'Early Bird', description: 'Eighty tickets. On sale with the line-up announcement.', price_in_pence: 1800, capacity: 80, max_per_order: 6, sales_open_at: londonAt(now, 12, '10:00'), sales_close_at: null, position: 0, visibility: 'public' },
    { id: 'tt_wa_ga', event_id: 'evt_winter_allday', name: 'General Admission', description: 'All six bands, in and out all day.', price_in_pence: 2400, capacity: 250, max_per_order: 8, sales_open_at: londonAt(now, 12, '10:00'), sales_close_at: null, position: 1, visibility: 'public' },

    // Paper Lions January - cancelled
    { id: 'tt_pl_ga', event_id: 'evt_paper_lions_jan', name: 'General Admission', description: null, price_in_pence: 700, capacity: 85, max_per_order: 4, sales_open_at: null, sales_close_at: null, position: 0, visibility: 'public' },

    // Brass Tacks NYE - draft
    { id: 'tt_bt_ga', event_id: 'evt_brass_tacks_nye', name: 'General Admission', description: null, price_in_pence: 2200, capacity: 380, max_per_order: 8, sales_open_at: null, sales_close_at: null, position: 0, visibility: 'public' },
    { id: 'tt_bt_seated', event_id: 'evt_brass_tacks_nye', name: 'Seated balcony', description: null, price_in_pence: 2600, capacity: 90, max_per_order: 6, sales_open_at: null, sales_close_at: null, position: 1, visibility: 'public' },

    // Completed events
    { id: 'tt_hc_ga', event_id: 'evt_hollow_coast_past', name: 'General Admission', description: null, price_in_pence: 1200, capacity: 330, max_per_order: 8, sales_open_at: null, sales_close_at: null, position: 0, visibility: 'public' },
    { id: 'tt_hc_seated', event_id: 'evt_hollow_coast_past', name: 'Seated balcony', description: null, price_in_pence: 1600, capacity: 140, max_per_order: 6, sales_open_at: null, sales_close_at: null, position: 1, visibility: 'public' },
    { id: 'tt_bp_ga', event_id: 'evt_brass_tacks_past', name: 'General Admission', description: null, price_in_pence: 1500, capacity: 330, max_per_order: 8, sales_open_at: null, sales_close_at: null, position: 0, visibility: 'public' },
    { id: 'tt_pp_ga', event_id: 'evt_paper_lions_past', name: 'General Admission', description: null, price_in_pence: 600, capacity: 85, max_per_order: 4, sales_open_at: null, sales_close_at: null, position: 0, visibility: 'public' },
    { id: 'tt_ss_ga', event_id: 'evt_spring_session_past', name: 'All-day ticket', description: null, price_in_pence: 1500, capacity: 200, max_per_order: 6, sales_open_at: null, sales_close_at: null, position: 0, visibility: 'public' },
  ];

  return { venues, artists, events, eventArtists, ticketTypes };
}
