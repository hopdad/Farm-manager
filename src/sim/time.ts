/**
 * Farm-local time (America/Detroit) without ICU: US Eastern rules since 2007 (EST = UTC-5;
 * EDT = UTC-4 from the second Sunday of March 02:00 local to the first Sunday of November 02:00
 * local). Implemented by hand so the simulator is identical on every machine and Node build.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
export const DAY_MS = 24 * HOUR;

/** Days since 1970-01-01 of a civil date (proleptic Gregorian), month 1-12. */
export function civilDayNumber(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}

/** Civil date of a day number. */
export function civilFromDayNumber(n: number): { y: number; m: number; d: number } {
  const dt = new Date(n * DAY_MS);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** Day of month of the n-th `weekday` (0 = Sunday) of a month. */
function nthWeekday(y: number, m: number, weekday: number, n: number): number {
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
}

/** UTC instants (ms) when daylight time starts and ends in year y. */
function dstBounds(y: number): { start: number; end: number } {
  // 02:00 EST = 07:00 UTC; 02:00 EDT = 06:00 UTC.
  return {
    start: Date.UTC(y, 2, nthWeekday(y, 3, 0, 2), 7),
    end: Date.UTC(y, 10, nthWeekday(y, 11, 0, 1), 6),
  };
}

/** UTC offset of America/Detroit at an instant, in minutes (-300 or -240). */
export function detroitOffsetMinutes(ms: number): number {
  const y = new Date(ms).getUTCFullYear();
  const { start, end } = dstBounds(y);
  return ms >= start && ms < end ? -240 : -300;
}

export interface LocalParts {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  ss: number;
  /** 0 = Sunday */
  dow: number;
  /** Minutes since local midnight (fractional). */
  minuteOfDay: number;
}

/** Local wall-clock parts of an instant. */
export function localParts(ms: number): LocalParts {
  const local = new Date(ms + detroitOffsetMinutes(ms) * MIN);
  const hh = local.getUTCHours();
  const mm = local.getUTCMinutes();
  const ss = local.getUTCSeconds() + local.getUTCMilliseconds() / 1000;
  return {
    y: local.getUTCFullYear(),
    m: local.getUTCMonth() + 1,
    d: local.getUTCDate(),
    hh,
    mm,
    ss,
    dow: local.getUTCDay(),
    minuteOfDay: hh * 60 + mm + ss / 60,
  };
}

/**
 * UTC instant of a local wall-clock time. In the spring-forward gap the EDT reading wins; in the
 * fall-back hour the first (EDT) occurrence wins. Deterministic either way.
 */
export function localToUtc(y: number, m: number, d: number, hh = 0, mm = 0, ss = 0): number {
  const naive = Date.UTC(y, m - 1, d, hh, mm, ss);
  const asEdt = naive + 240 * MIN;
  if (detroitOffsetMinutes(asEdt) === -240) return asEdt;
  return naive + 300 * MIN;
}

/** UTC instant of `minuteOfDay` local minutes on the civil day `dayNumber`. */
export function localDayTime(dayNumber: number, minuteOfDay: number): number {
  const { y, m, d } = civilFromDayNumber(dayNumber);
  const whole = Math.floor(minuteOfDay);
  const secs = Math.round((minuteOfDay - whole) * 60);
  return localToUtc(y, m, d, Math.floor(whole / 60), whole % 60, secs);
}

/** Parse 'HH:MM' into minutes since midnight. */
export function hhmm(text: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!m) throw new RangeError(`not HH:MM: ${text}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export const MS = { MIN, HOUR, DAY: DAY_MS } as const;
