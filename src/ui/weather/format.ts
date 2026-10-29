/** Display formatting for the weather strip and the spray views (pure; America/Detroit). */
import type { SprayVerdict } from '../../domain/weather';
import { FARM_TIME_ZONE } from './strip-model';

/** Verdict colours: the map layer, the strip and the field tab use the same three. */
export const SPRAY_COLORS: Record<SprayVerdict, string> = {
  go: '#22c55e',
  caution: '#f59e0b',
  no_go: '#ef4444',
};

const POINTS = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
];

/** The direction the wind blows FROM, as a 16-point compass name ('' when unknown). */
export function windFrom(dir: number | null): string {
  if (dir === null || !Number.isFinite(dir)) return '';
  return POINTS[Math.round((((dir % 360) + 360) % 360) / 22.5) % 16] as string;
}

export const fmtTemp = (f: number | null): string => (f === null ? '--' : `${Math.round(f)}°`);
export const fmtMph = (v: number | null): string => (v === null ? '--' : `${Math.round(v)}`);
export const fmtPct = (v: number | null): string => (v === null ? '--' : `${Math.round(v)}%`);

/** Rain amount: '0.12"', '<0.01"' for a trace, '0"' for none. */
export function fmtRain(inches: number | null): string {
  if (inches === null) return '--';
  if (inches <= 0) return '0"';
  if (inches < 0.01) return '<0.01"';
  return `${inches.toFixed(2)}"`;
}

const hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: FARM_TIME_ZONE, hour: 'numeric' });
const clockFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: FARM_TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
});

/** '3 PM' (plain spaces; ICU uses a narrow no-break space before AM/PM). */
export const fmtHour = (iso: string): string => hourFmt.format(new Date(iso)).replace(/\s/g, ' ');
export const fmtClock = (iso: string): string => clockFmt.format(new Date(iso)).replace(/\s/g, ' ');

/** '5 min ago', '3 h ago', '2 d ago'. */
export function fmtAgeMinutes(minutes: number): string {
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${Math.round(minutes)} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} d ago`;
}

/** Minutes between an ISO instant and `now` (ms). */
export const minutesSince = (iso: string, now: number): number =>
  Math.max(0, (now - Date.parse(iso)) / 60_000);
