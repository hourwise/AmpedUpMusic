/**
 * Seed-only clock helpers.
 *
 * These are the same rules as `src/data/clock.ts` in the AMPED-01 scaffold:
 * seed dates are offsets from the day the seed runs rather than fixed calendar
 * dates, so the local database never rots - there is always a next gig about a
 * fortnight away and the archive is always genuinely in the past.
 *
 * They are re-implemented here rather than imported. `src/data/` is deleted
 * wholesale in AMPED-03A, and the seed has to outlive it; a seed that imports
 * the fixture layer would take the fixture layer with it.
 *
 * Unlike the fixture version, `now` is a parameter. The seed is then a pure
 * function of a timestamp, which is what lets the schema tests assert exactly
 * what was written.
 */

const TIME_ZONE = 'Europe/London';

/** Milliseconds Europe/London is ahead of UTC at the given instant. */
function londonOffsetMs(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '00';

  // `hour` can come back as "24" for midnight in some runtimes.
  const hour = get('hour') === '24' ? '00' : get('hour');
  const asUtc = Date.parse(
    `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}Z`,
  );
  return asUtc - at.getTime();
}

/**
 * The UTC instant at which the London wall clock reads `hhmm` on the day that
 * is `dayOffset` days from `now`.
 *
 * The offset is resolved twice because the first guess can land on the wrong
 * side of a DST transition; the second pass settles it.
 */
export function londonAt(now: Date, dayOffset: number, hhmm: string): string {
  const day = new Date(now.getTime());
  day.setUTCHours(12, 0, 0, 0);
  day.setUTCDate(day.getUTCDate() + dayOffset);

  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(day);
  let guess = Date.parse(`${ymd}T${hhmm}:00Z`);
  for (let i = 0; i < 2; i += 1) {
    guess = Date.parse(`${ymd}T${hhmm}:00Z`) - londonOffsetMs(new Date(guess));
  }
  return new Date(guess).toISOString();
}

/** An instant `days` days (and optionally `hours`) from `now`. */
export function offsetFrom(now: Date, days: number, hours = 0): string {
  return new Date(now.getTime() + days * 86_400_000 + hours * 3_600_000).toISOString();
}
