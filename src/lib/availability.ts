/**
 * Availability derivation.
 *
 * This is the single source of truth for what a customer is told about
 * tickets. It is pure, exhaustively tested, and used identically by the event
 * page, the gig cards, the /tickets index and the admin gig list, so the site
 * can never contradict itself.
 *
 * Deliberate design decisions:
 *  - Exact remaining counts are never returned to the public layer. The
 *    thresholds are proportional so a 50-capacity back room and a 400-capacity
 *    hall behave sensibly with the same rules.
 *  - Sale windows beat stock. A ticket type with stock but a closed sale
 *    window is `sales-closed`, not `available`.
 *  - `reserved` counts against availability immediately. Someone mid-checkout
 *    is holding that ticket; showing it as available is how you oversell.
 */

import type { AvailabilityState, IsoDateTime, TicketInventory, TicketType } from '@/types/domain.ts';

/** Below this proportion of the allocation remaining, show "Selling fast". */
export const SELLING_FAST_THRESHOLD = 0.35;
/** Below this proportion, show "Last few". */
export const LAST_FEW_THRESHOLD = 0.12;
/** ...or below this absolute count, whichever triggers first. */
export const LAST_FEW_ABSOLUTE = 10;

export interface AvailabilityInput {
  inventory: TicketInventory;
  salesOpenAt?: IsoDateTime;
  salesCloseAt?: IsoDateTime;
  /** A cancelled or draft event is never on sale, whatever the stock says. */
  eventSellable?: boolean;
}

export function deriveAvailability(input: AvailabilityInput, now: Date = new Date()): AvailabilityState {
  const { inventory, salesOpenAt, salesCloseAt, eventSellable = true } = input;

  if (!eventSellable) return 'unavailable';
  if (inventory.capacity <= 0) return 'unavailable';

  const t = now.getTime();
  if (salesOpenAt && Date.parse(salesOpenAt) > t) return 'not-yet-on-sale';
  if (salesCloseAt && Date.parse(salesCloseAt) <= t) return 'sales-closed';

  const available = Math.max(0, inventory.available);
  if (available <= 0) return 'sold-out';

  const proportion = available / inventory.capacity;
  if (available <= LAST_FEW_ABSOLUTE || proportion <= LAST_FEW_THRESHOLD) return 'last-few';
  if (proportion <= SELLING_FAST_THRESHOLD) return 'selling-fast';
  return 'available';
}

/** Only these two states let a customer actually reach a checkout. */
export function isPurchasable(state: AvailabilityState): boolean {
  return state === 'available' || state === 'selling-fast' || state === 'last-few';
}

/**
 * Roll several ticket types up into one headline state for a card or listing.
 *
 * The best state across the types wins, because "Available" is true if ANY
 * type is available. The exception is that everything sold out reads as
 * sold out rather than as the mildest remaining non-purchasable state.
 */
const RANK: Record<AvailabilityState, number> = {
  available: 0,
  'selling-fast': 1,
  'last-few': 2,
  'not-yet-on-sale': 3,
  'sales-closed': 4,
  'sold-out': 5,
  unavailable: 6,
};

export function rollUpAvailability(states: readonly AvailabilityState[]): AvailabilityState {
  if (states.length === 0) return 'unavailable';
  const purchasable = states.filter(isPurchasable);
  if (purchasable.length > 0) {
    return purchasable.reduce((best, s) => (RANK[s] < RANK[best] ? s : best), purchasable[0]!);
  }
  // Nothing buyable. Prefer the most informative reason.
  if (states.includes('sold-out')) return 'sold-out';
  if (states.includes('not-yet-on-sale')) return 'not-yet-on-sale';
  if (states.includes('sales-closed')) return 'sales-closed';
  return 'unavailable';
}

export interface AvailabilityPresentation {
  label: string;
  /** Longer form for screen readers and tooltips. */
  description: string;
  tone: 'go' | 'warn' | 'urgent' | 'stop' | 'muted';
}

/**
 * Presentation is table-driven so status is never communicated by colour
 * alone: every state has distinct wording as well as a distinct tone.
 */
export const AVAILABILITY_PRESENTATION: Record<AvailabilityState, AvailabilityPresentation> = {
  available: { label: 'Tickets available', description: 'On sale now.', tone: 'go' },
  'selling-fast': { label: 'Selling fast', description: 'On sale and going quickly.', tone: 'warn' },
  'last-few': { label: 'Last few', description: 'Only a small number left.', tone: 'urgent' },
  'sold-out': { label: 'Sold out', description: 'None left.', tone: 'stop' },
  'not-yet-on-sale': { label: 'On sale soon', description: 'Not on sale yet.', tone: 'muted' },
  'sales-closed': { label: 'Sales closed', description: 'Online sales have closed.', tone: 'muted' },
  unavailable: { label: 'Unavailable', description: 'Not available.', tone: 'muted' },
};

/** Short label used on compact cards where the full phrase will not fit. */
export const AVAILABILITY_SHORT: Record<AvailabilityState, string> = {
  available: 'Available',
  'selling-fast': 'Selling fast',
  'last-few': 'Last few',
  'sold-out': 'Sold out',
  'not-yet-on-sale': 'Soon',
  'sales-closed': 'Closed',
  unavailable: 'Unavailable',
};

/** Convenience used by the fixture services and later by the D1 repositories. */
export function inventoryFor(ticketType: TicketType, sold: number, reserved: number): TicketInventory {
  return {
    ticketTypeId: ticketType.id,
    capacity: ticketType.capacity,
    sold,
    reserved,
    available: Math.max(0, ticketType.capacity - sold - reserved),
  };
}
