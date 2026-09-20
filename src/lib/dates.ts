/**
 * Date and time formatting, always in Europe/London.
 *
 * Storage is UTC; display is London. Doing this in one place means British
 * Summer Time is handled once rather than being got subtly wrong on each page,
 * which matters when a doors time of 19:30 is the difference between a full
 * room and a queue outside a locked door.
 */

const TZ = 'Europe/London';

function fmt(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, ...options });
}

const LONG_DATE = fmt({ weekday: 'long', day: 'numeric', month: 'long' });
const SHORT_DATE = fmt({ day: 'numeric', month: 'short', year: 'numeric' });
const DAY_NUMBER = fmt({ day: '2-digit' });
const MONTH_SHORT = fmt({ month: 'short' });
const WEEKDAY_SHORT = fmt({ weekday: 'short' });
const YEAR = fmt({ year: 'numeric' });
const TIME = fmt({ hour: '2-digit', minute: '2-digit', hour12: false });
const DATE_TIME = fmt({
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/**
 * "Saturday 14 November 2026".
 *
 * Composed from the long date plus the year rather than taken straight from
 * Intl, because en-GB inserts a comma after the weekday once a year is
 * included and the rest of the site does not use one. One house style.
 */
export function formatFullDate(iso: string): string {
  const date = new Date(iso);
  return `${LONG_DATE.format(date)} ${YEAR.format(date)}`;
}

/** "Saturday 14 November" - the year is noise for an event three weeks away. */
export function formatLongDate(iso: string): string {
  return LONG_DATE.format(new Date(iso));
}

/** "14 Nov 2026" */
export function formatShortDate(iso: string): string {
  return SHORT_DATE.format(new Date(iso));
}

/** "19:30" - 24 hour, because a gig listing is not the place for am/pm ambiguity. */
export function formatTime(iso: string): string {
  return TIME.format(new Date(iso));
}

/** "Sat 14 Nov, 19:30" */
export function formatDateTime(iso: string): string {
  return DATE_TIME.format(new Date(iso));
}

/** Parts for the stacked date block used on posters and cards. */
export interface DateBlockParts {
  weekday: string;
  day: string;
  month: string;
  year: string;
}

export function dateBlockParts(iso: string): DateBlockParts {
  const date = new Date(iso);
  return {
    weekday: WEEKDAY_SHORT.format(date).toUpperCase(),
    day: DAY_NUMBER.format(date),
    month: MONTH_SHORT.format(date).toUpperCase(),
    year: YEAR.format(date),
  };
}

/** A `datetime` attribute value for <time>. Always the raw UTC instant. */
export function machineDate(iso: string): string {
  return new Date(iso).toISOString();
}

/**
 * "Tonight", "Tomorrow", "In 3 days", "In 2 weeks", "Last Saturday".
 * Returns null beyond roughly two months, where a plain date reads better.
 */
export function relativeDayLabel(iso: string, now: Date = new Date()): string | null {
  const days = calendarDaysBetween(now, new Date(iso));
  if (days === 0) return 'Tonight';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  if (days > 1 && days <= 6) return `In ${days} days`;
  if (days === 7) return 'Next week';
  if (days > 7 && days <= 60) {
    const weeks = Math.round(days / 7);
    return `In ${weeks} weeks`;
  }
  if (days < -1 && days >= -6) return `${Math.abs(days)} days ago`;
  return null;
}

/**
 * Whole calendar days between two instants, evaluated in Europe/London.
 * A gig at 23:00 tonight and one at 00:30 tomorrow are different days even
 * though they are 90 minutes apart, and customers think in calendar days.
 */
export function calendarDaysBetween(from: Date, to: Date): number {
  const a = londonMidnight(from);
  const b = londonMidnight(to);
  return Math.round((b - a) / 86_400_000);
}

function londonMidnight(date: Date): number {
  // en-CA gives YYYY-MM-DD, which Date.parse treats as UTC midnight.
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(date);
  return Date.parse(`${ymd}T00:00:00Z`);
}

/**
 * Has this event finished?
 *
 * Uses the curfew when one is recorded, otherwise assumes a gig runs four
 * hours past the advertised start. A night should not jump into Past Gigs at
 * 19:31 just because the first band walked on.
 */
const ASSUMED_RUN_TIME_MS = 4 * 60 * 60 * 1000;

export function hasFinished(startsAt: string, endsAt: string | undefined, now: Date = new Date()): boolean {
  const end = endsAt ? Date.parse(endsAt) : Date.parse(startsAt) + ASSUMED_RUN_TIME_MS;
  return end < now.getTime();
}

/** Human duration for reservation countdowns, e.g. "29 minutes". */
export function minutesUntil(iso: string, now: Date = new Date()): number {
  return Math.max(0, Math.round((Date.parse(iso) - now.getTime()) / 60_000));
}
