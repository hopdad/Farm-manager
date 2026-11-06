/**
 * The farm's wall clock (America/Detroit) for the job form's window inputs: a
 * `<input type="datetime-local">` holds 'YYYY-MM-DDTHH:mm' with no zone, and the API wants ISO
 * instants with an offset (contracts-2a §5.3). Pure (Intl only), the same in the browser on any
 * device clock and on the server, so a phone set to another zone still plans in farm time.
 *
 * Daylight saving: a time in the spring-forward gap (2:30 AM on the second Sunday of March)
 * doesn't exist and moves forward an hour; a time in the fall-back hour takes the first (EDT)
 * reading. Deterministic either way.
 */
import { FARM_TIME_ZONE } from '../../../domain/farm';

const PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: FARM_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

interface Wall {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
}

function wallOf(ms: number): Wall & { ss: number } {
  const p: Record<string, number> = {};
  for (const part of PARTS.formatToParts(ms)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return {
    y: p.year ?? 0,
    m: p.month ?? 1,
    d: p.day ?? 1,
    hh: (p.hour ?? 0) % 24,
    mm: p.minute ?? 0,
    ss: p.second ?? 0,
  };
}

/** The farm's UTC offset at an instant, in minutes (-240 in summer, -300 in winter). */
export function farmOffsetMinutes(ms: number): number {
  const w = wallOf(ms);
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm, w.ss);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** 'YYYY-MM-DDTHH:mm' farm time -> the instant, or null when it isn't one. */
export function farmLocalToDate(local: string): Date | null {
  const m = LOCAL_RE.exec(local.trim());
  if (!m) return null;
  const [y, mo, d, hh, mm] = m.slice(1).map(Number) as [number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mm > 59) return null;
  const naive = Date.UTC(y, mo - 1, d, hh, mm);
  if (new Date(naive).getUTCDate() !== d) return null;
  // Try the earlier offset first (EDT in the fall-back hour), then the other one.
  for (const offset of [-240, -300]) {
    const ms = naive - offset * 60_000;
    if (farmOffsetMinutes(ms) === offset) return new Date(ms);
  }
  // The spring-forward gap: no such wall time; standard time's reading (an hour later on the
  // clock).
  return new Date(naive + 300 * 60_000);
}

/** The instant as 'YYYY-MM-DDTHH:mm' farm time (what a datetime-local input shows). */
export function dateToFarmLocal(at: Date | string): string {
  const w = wallOf(typeof at === 'string' ? Date.parse(at) : at.getTime());
  const two = (n: number) => String(n).padStart(2, '0');
  return `${w.y}-${two(w.m)}-${two(w.d)}T${two(w.hh)}:${two(w.mm)}`;
}

/** The instant as ISO with the farm's offset: '2026-11-06T08:00:00-05:00'. */
export function toFarmIso(at: Date): string {
  const off = farmOffsetMinutes(at.getTime());
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  const zone = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${dateToFarmLocal(at)}:00${zone}`;
}
