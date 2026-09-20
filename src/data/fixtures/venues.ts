/**
 * Mock venues. Replaced by the D1 `venues` table in AMPED-02B.
 *
 * These are invented rooms in real North West towns. Nothing here refers to a
 * real business; addresses are deliberately non-existent.
 */

import type { Venue } from '@/types/domain.ts';
import { FIXTURE_EPOCH } from '../clock.ts';

const base = { createdAt: FIXTURE_EPOCH, updatedAt: FIXTURE_EPOCH };

export const VENUES: Venue[] = [
  {
    ...base,
    id: 'ven_lomax',
    name: 'The Lomax Rooms',
    slug: 'the-lomax-rooms',
    addressLine1: '14 Sedgewick Street',
    city: 'Preston',
    postcode: 'PR1 4AQ',
    capacity: 220,
    standardNotes:
      'Downstairs bar is open from 18:00 and serves until close. Cloakroom is £1 a coat, cash or card. The smoking area is through the side door on Sedgewick Street.',
    accessibilityInfo:
      'Step-free entrance from Sedgewick Street with a level route to the main room and the accessible toilet. No lift to the balcony. Personal assistants come in free of charge - email us before the day and we will add them to the door list.',
    websiteUrl: 'https://example.com/lomax-rooms',
    mapUrl: 'https://www.openstreetmap.org/search?query=Preston%20PR1',
  },
  {
    ...base,
    id: 'ven_ironworks',
    name: 'Ironworks Social',
    slug: 'ironworks-social',
    addressLine1: 'Unit 3, Canal Side Works',
    addressLine2: 'Bispham Road',
    city: 'Blackpool',
    postcode: 'FY2 0HA',
    capacity: 350,
    standardNotes:
      'Big room, concrete floor, proper PA. Parking on Bispham Road is free after 18:00. The 14 bus stops two minutes from the door.',
    accessibilityInfo:
      'Fully step-free throughout, including the bar and toilets. Two accessible viewing spaces at the front of house desk - reserve one when you book by emailing tickets@ampedupmusic.co.uk.',
    mapUrl: 'https://www.openstreetmap.org/search?query=Blackpool%20FY2',
  },
  {
    ...base,
    id: 'ven_cellar',
    name: 'The Cellar at Hartley Street',
    slug: 'the-cellar-hartley-street',
    addressLine1: '2b Hartley Street',
    city: 'Lancaster',
    postcode: 'LA1 1XP',
    capacity: 90,
    standardNotes:
      'Small, low ceiling, very loud. Earplugs are free on the bar. Gets warm - the cloakroom is worth using.',
    accessibilityInfo:
      'The room is down twelve steps with a handrail and there is currently no step-free route. We are honest about this rather than vague: if stairs are a problem, the same bills usually play The Lomax Rooms within a couple of months and we will happily let you know when.',
    mapUrl: 'https://www.openstreetmap.org/search?query=Lancaster%20LA1',
  },
  {
    ...base,
    id: 'ven_parr_hall',
    name: 'Parr Street Hall',
    slug: 'parr-street-hall',
    addressLine1: 'Parr Street',
    city: 'Warrington',
    postcode: 'WA1 2AX',
    capacity: 480,
    standardNotes:
      'Seated balcony, standing floor. Doors are on Parr Street; the box office window is to the left of the main entrance.',
    accessibilityInfo:
      'Step-free entrance and lift to the balcony. Six wheelchair spaces on the balcony with a companion seat each. Hearing loop covers the stalls and balcony.',
    websiteUrl: 'https://example.com/parr-street-hall',
    mapUrl: 'https://www.openstreetmap.org/search?query=Warrington%20WA1',
  },
];

export const VENUES_BY_ID = new Map(VENUES.map((v) => [v.id, v]));
