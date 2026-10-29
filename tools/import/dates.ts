/**
 * Calendar dates typed by people (seasons CSVs, effective dates, forms): ISO 2025-05-03, or the
 * US M/D/YYYY that Excel writes when it saves a CSV on Derrick's PC. Two-digit years and
 * day-first dates are refused (2/3/25 could be either), never guessed. Pure.
 */
import { localParts, localToUtc } from '../../src/sim/time';

export type DateParse = { ok: true; value: string } | { ok: false; error: string };

const pad = (n: number) => String(n).padStart(2, '0');

function valid(y: number, m: number, d: number): boolean {
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1) return false;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= last;
}

/** 'YYYY-MM-DD' from ISO or M/D/YYYY text (a trailing midnight time is ignored). */
export function parseDate(raw: string): DateParse {
  const s = raw.trim().replace(/[ T]0?0:00(:00(\.0+)?)?Z?$/, '');
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return valid(y, mo, d)
      ? { ok: true, value: `${y}-${pad(mo)}-${pad(d)}` }
      : { ok: false, error: `'${raw}' is not a real date` };
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) {
    const [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return valid(y, mo, d)
      ? { ok: true, value: `${y}-${pad(mo)}-${pad(d)}` }
      : { ok: false, error: `'${raw}' is not a real date (month/day/year)` };
  }
  if (/^\d{1,2}\/\d{1,2}\/\d{2}$/.test(s)) {
    return { ok: false, error: `'${raw}': write the year in full (5/3/2025 or 2025-05-03)` };
  }
  return { ok: false, error: `'${raw}' is not a date (use 2025-05-03 or 5/3/2025)` };
}

/** The instant a local (America/Detroit) calendar day starts. */
export function detroitMidnight(isoDate: string): Date {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return new Date(localToUtc(y, m, d));
}

/** Today's date in America/Detroit, 'YYYY-MM-DD'. */
export function detroitToday(now: Date = new Date()): string {
  const p = localParts(now.getTime());
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}
