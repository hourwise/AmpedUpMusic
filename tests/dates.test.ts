/**
 * Dates are formatted in Europe/London from UTC storage. The British Summer
 * Time cases below are the ones that actually bite: a doors time that displays
 * an hour out in July is the difference between a full room and a queue
 * outside a locked door.
 */
import { describe, expect, it } from 'vitest';
import {
  calendarDaysBetween,
  dateBlockParts,
  formatFullDate,
  formatLongDate,
  formatTime,
  hasFinished,
  machineDate,
  minutesUntil,
  relativeDayLabel,
} from '../src/lib/dates.ts';

describe('formatTime in Europe/London', () => {
  it('shows GMT times unchanged in winter', () => {
    expect(formatTime('2026-01-15T19:30:00Z')).toBe('19:30');
  });

  it('shifts to BST in summer', () => {
    // 18:30 UTC in July is 19:30 in London.
    expect(formatTime('2026-07-15T18:30:00Z')).toBe('19:30');
  });

  it('uses a 24 hour clock', () => {
    expect(formatTime('2026-01-15T23:45:00Z')).toBe('23:45');
    expect(formatTime('2026-01-15T00:15:00Z')).toBe('00:15');
  });
});

describe('date formatting', () => {
  it('renders a full British date', () => {
    expect(formatFullDate('2026-11-14T19:30:00Z')).toBe('Saturday 14 November 2026');
  });

  it('drops the year for the near-term label', () => {
    expect(formatLongDate('2026-11-14T19:30:00Z')).toBe('Saturday 14 November');
  });

  it('builds the stacked poster date block', () => {
    const parts = dateBlockParts('2026-11-14T19:30:00Z');
    expect(parts.day).toBe('14');
    expect(parts.month).toBe('NOV');
    expect(parts.weekday).toBe('SAT');
    expect(parts.year).toBe('2026');
  });

  it('assigns a late BST event to the correct London day', () => {
    // 23:30 UTC on 14 July is 00:30 on 15 July in London.
    expect(formatLongDate('2026-07-14T23:30:00Z')).toBe('Wednesday 15 July');
  });

  it('emits a machine-readable UTC instant for <time datetime>', () => {
    expect(machineDate('2026-11-14T19:30:00Z')).toBe('2026-11-14T19:30:00.000Z');
  });
});

describe('calendarDaysBetween', () => {
  it('counts calendar days, not elapsed hours', () => {
    // 90 minutes apart, but two different nights as far as a customer is
    // concerned.
    const from = new Date('2026-03-06T22:00:00Z');
    const to = new Date('2026-03-06T23:30:00Z');
    expect(calendarDaysBetween(from, to)).toBe(0);

    const nextDay = new Date('2026-03-07T00:30:00Z');
    expect(calendarDaysBetween(from, nextDay)).toBe(1);
  });

  it('handles a run across a month boundary', () => {
    expect(
      calendarDaysBetween(new Date('2026-01-30T12:00:00Z'), new Date('2026-02-02T12:00:00Z')),
    ).toBe(3);
  });
});

describe('relativeDayLabel', () => {
  const now = new Date('2026-06-15T12:00:00Z');

  it('names today and tomorrow the way a promoter would', () => {
    expect(relativeDayLabel('2026-06-15T19:30:00Z', now)).toBe('Tonight');
    expect(relativeDayLabel('2026-06-16T19:30:00Z', now)).toBe('Tomorrow');
  });

  it('counts days within the week', () => {
    expect(relativeDayLabel('2026-06-18T19:30:00Z', now)).toBe('In 3 days');
  });

  it('rounds to weeks beyond that', () => {
    expect(relativeDayLabel('2026-06-22T19:30:00Z', now)).toBe('Next week');
    expect(relativeDayLabel('2026-06-29T19:30:00Z', now)).toBe('In 2 weeks');
  });

  it('gives up beyond two months so a plain date is used instead', () => {
    expect(relativeDayLabel('2026-10-01T19:30:00Z', now)).toBeNull();
  });

  it('handles the recent past', () => {
    expect(relativeDayLabel('2026-06-14T19:30:00Z', now)).toBe('Yesterday');
    expect(relativeDayLabel('2026-06-12T19:30:00Z', now)).toBe('3 days ago');
  });
});

describe('hasFinished', () => {
  it('uses the curfew when there is one', () => {
    const now = new Date('2026-06-15T22:00:00Z');
    expect(hasFinished('2026-06-15T19:00:00Z', '2026-06-15T23:00:00Z', now)).toBe(false);
    expect(hasFinished('2026-06-15T19:00:00Z', '2026-06-15T21:00:00Z', now)).toBe(true);
  });

  it('assumes a four hour run when no curfew is recorded', () => {
    const justStarted = new Date('2026-06-15T19:30:00Z');
    // A gig must not drop into Past Gigs half an hour after the first band.
    expect(hasFinished('2026-06-15T19:00:00Z', undefined, justStarted)).toBe(false);

    const wellAfter = new Date('2026-06-15T23:30:00Z');
    expect(hasFinished('2026-06-15T19:00:00Z', undefined, wellAfter)).toBe(true);
  });
});

describe('minutesUntil', () => {
  it('counts down a reservation window', () => {
    const now = new Date('2026-06-15T12:00:00Z');
    expect(minutesUntil('2026-06-15T12:29:00Z', now)).toBe(29);
  });

  it('never returns a negative number', () => {
    const now = new Date('2026-06-15T12:00:00Z');
    expect(minutesUntil('2026-06-15T11:00:00Z', now)).toBe(0);
  });
});
