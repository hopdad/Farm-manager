/** Display formatting for the board (pure). Times show in America/Detroit (plan §1). */
import type { Activity, PositionSource } from '../../domain/fleet';

export const FARM_TIME_ZONE = 'America/Detroit';

/** "12 s ago", "5 min ago", "2 h ago", "3 d ago"; future or invalid → "just now" / "unknown". */
export function formatAge(ts: string, now: number): string {
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return 'unknown';
  const s = Math.round((now - t) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** "90 s", "10 min", "2 h". */
export function formatDuration(seconds: number): string {
  if (seconds < 120) return `${Math.round(seconds)} s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}

const clockFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: FARM_TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
});
const dateFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: FARM_TIME_ZONE,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});

export function formatClock(d: Date): { time: string; date: string } {
  // ICU puts a narrow no-break space before AM/PM; keep plain spaces for consistent rendering.
  const plain = (x: string) => x.replace(/\s/g, ' ');
  return { time: plain(clockFmt.format(d)), date: plain(dateFmt.format(d)) };
}

export const ACTIVITY_LABELS: Record<Activity, string> = {
  working: 'Working',
  transport: 'On the road',
  idle: 'Idle',
  queued: 'In line',
};

export const SOURCE_LABELS: Record<PositionSource, string> = {
  eld: 'ELD',
  deere_working: 'Deere (last working position)',
  cab_device: 'Cab device',
  manual: 'Manual',
};

/** Compass point for a heading: N, NE, E, … */
export function compassPoint(heading: number): string {
  const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return points[Math.round((((heading % 360) + 360) % 360) / 45) % 8] as string;
}
