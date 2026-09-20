/**
 * Availability is the rule that decides what a customer is told about tickets
 * and whether they can reach a checkout at all. It is pure, so it gets the
 * most thorough tests in the project.
 *
 * The cases below are the ones that matter commercially:
 *  - reserved stock must not be sellable (this is how overselling starts)
 *  - a closed sale window beats remaining stock
 *  - a cancelled event is never purchasable regardless of inventory
 */
import { describe, expect, it } from 'vitest';
import {
  AVAILABILITY_PRESENTATION,
  AVAILABILITY_SHORT,
  deriveAvailability,
  inventoryFor,
  isPurchasable,
  rollUpAvailability,
} from '../src/lib/availability.ts';
import type { AvailabilityState, TicketType } from '../src/types/domain.ts';

const NOW = new Date('2026-06-15T12:00:00Z');

function inventory(capacity: number, sold = 0, reserved = 0) {
  return {
    ticketTypeId: 'tt_test',
    capacity,
    sold,
    reserved,
    available: Math.max(0, capacity - sold - reserved),
  };
}

describe('deriveAvailability', () => {
  it('reports plenty of stock as available', () => {
    expect(deriveAvailability({ inventory: inventory(100, 10) }, NOW)).toBe('available');
  });

  it('switches to selling fast at 35% remaining', () => {
    // 100 capacity, 66 sold -> 34 left -> 34% -> selling fast.
    expect(deriveAvailability({ inventory: inventory(100, 66) }, NOW)).toBe('selling-fast');
    // 65 sold -> 35 left -> 35% -> still selling fast (boundary is inclusive).
    expect(deriveAvailability({ inventory: inventory(100, 65) }, NOW)).toBe('selling-fast');
    // 64 sold -> 36 left -> 36% -> available.
    expect(deriveAvailability({ inventory: inventory(100, 64) }, NOW)).toBe('available');
  });

  it('switches to last few at 12% remaining', () => {
    expect(deriveAvailability({ inventory: inventory(200, 176) }, NOW)).toBe('last-few');
    expect(deriveAvailability({ inventory: inventory(200, 170) }, NOW)).toBe('selling-fast');
  });

  it('uses the absolute threshold for small rooms', () => {
    // 10 left out of 400 is only 2.5%, but the absolute rule catches it anyway.
    expect(deriveAvailability({ inventory: inventory(400, 390) }, NOW)).toBe('last-few');
    // And a tiny room with 8 of 90 left is last few, not selling fast.
    expect(deriveAvailability({ inventory: inventory(90, 82) }, NOW)).toBe('last-few');
  });

  it('reports sold out when nothing is left', () => {
    expect(deriveAvailability({ inventory: inventory(50, 50) }, NOW)).toBe('sold-out');
  });

  it('counts reserved stock against availability', () => {
    // This is the oversell guard: four tickets held by an in-flight checkout
    // are NOT available, even though they have not been paid for.
    expect(deriveAvailability({ inventory: inventory(50, 46, 4) }, NOW)).toBe('sold-out');
    expect(deriveAvailability({ inventory: inventory(50, 40, 10) }, NOW)).not.toBe('available');
  });

  it('respects a sale window that has not opened', () => {
    expect(
      deriveAvailability(
        { inventory: inventory(100), salesOpenAt: '2026-07-01T09:00:00Z' },
        NOW,
      ),
    ).toBe('not-yet-on-sale');
  });

  it('respects a sale window that has closed', () => {
    expect(
      deriveAvailability(
        { inventory: inventory(100), salesCloseAt: '2026-06-01T09:00:00Z' },
        NOW,
      ),
    ).toBe('sales-closed');
  });

  it('puts the sale window ahead of remaining stock', () => {
    // Plenty left, but sales have closed. The customer must not see "available".
    const state = deriveAvailability(
      { inventory: inventory(100, 1), salesCloseAt: '2026-06-01T09:00:00Z' },
      NOW,
    );
    expect(state).toBe('sales-closed');
    expect(isPurchasable(state)).toBe(false);
  });

  it('treats a non-sellable event as unavailable whatever the stock says', () => {
    const state = deriveAvailability({ inventory: inventory(500), eventSellable: false }, NOW);
    expect(state).toBe('unavailable');
    expect(isPurchasable(state)).toBe(false);
  });

  it('treats a zero capacity allocation as unavailable, not sold out', () => {
    expect(deriveAvailability({ inventory: inventory(0) }, NOW)).toBe('unavailable');
  });
});

describe('isPurchasable', () => {
  it('allows exactly the three on-sale states', () => {
    const purchasable: AvailabilityState[] = ['available', 'selling-fast', 'last-few'];
    const blocked: AvailabilityState[] = [
      'sold-out',
      'not-yet-on-sale',
      'sales-closed',
      'unavailable',
    ];
    purchasable.forEach((state) => expect(isPurchasable(state)).toBe(true));
    blocked.forEach((state) => expect(isPurchasable(state)).toBe(false));
  });
});

describe('rollUpAvailability', () => {
  it('lets one available type carry a whole event', () => {
    // Early bird gone, general admission on sale -> the gig is on sale.
    expect(rollUpAvailability(['sold-out', 'available'])).toBe('available');
  });

  it('prefers the healthiest purchasable state', () => {
    expect(rollUpAvailability(['last-few', 'selling-fast', 'available'])).toBe('available');
    expect(rollUpAvailability(['last-few', 'selling-fast'])).toBe('selling-fast');
  });

  it('reports sold out when everything has gone', () => {
    expect(rollUpAvailability(['sold-out', 'sold-out'])).toBe('sold-out');
  });

  it('prefers sold out over a softer non-purchasable reason', () => {
    expect(rollUpAvailability(['sold-out', 'sales-closed'])).toBe('sold-out');
  });

  it('reports on sale soon when nothing has opened yet', () => {
    expect(rollUpAvailability(['not-yet-on-sale', 'not-yet-on-sale'])).toBe('not-yet-on-sale');
  });

  it('treats an event with no ticket types as unavailable', () => {
    expect(rollUpAvailability([])).toBe('unavailable');
  });
});

describe('presentation', () => {
  it('gives every state a distinct label, so colour is never the only signal', () => {
    const states = Object.keys(AVAILABILITY_PRESENTATION) as AvailabilityState[];
    const labels = states.map((state) => AVAILABILITY_PRESENTATION[state].label);
    const shorts = states.map((state) => AVAILABILITY_SHORT[state]);
    expect(new Set(labels).size).toBe(states.length);
    expect(new Set(shorts).size).toBe(states.length);
  });

  it('gives every state a non-empty description for assistive technology', () => {
    for (const presentation of Object.values(AVAILABILITY_PRESENTATION)) {
      expect(presentation.description.length).toBeGreaterThan(0);
    }
  });
});

describe('inventoryFor', () => {
  const ticketType = { id: 'tt_x', capacity: 100 } as TicketType;

  it('floors availability at zero when oversold', () => {
    // Should never happen, but if the data is wrong the UI must not show a
    // negative number of tickets.
    expect(inventoryFor(ticketType, 105, 0).available).toBe(0);
  });

  it('subtracts both sold and reserved', () => {
    expect(inventoryFor(ticketType, 60, 5).available).toBe(35);
  });
});
