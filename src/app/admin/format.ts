/**
 * Display helpers for the admin pages: times in America/Detroit (plan §1: stored in UTC, shown
 * in Detroit time) and short relative ages. Pure; safe on server and client.
 */
export const DISPLAY_TIME_ZONE = 'America/Detroit';

const timeFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: DISPLAY_TIME_ZONE,
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
});

/** 'Oct 29, 10:07:12 AM' in Detroit time; '-' for null. */
export function detroitTime(d: Date | string | null | undefined): string {
  if (!d) return '-';
  const date = typeof d === 'string' ? new Date(d) : d;
  return Number.isNaN(date.getTime()) ? '-' : timeFmt.format(date);
}

/** '12 s ago', '3 min ago', '2 h ago', '4 d ago'; 'in 20 s' for the future; '-' for null. */
export function ago(d: Date | string | null | undefined, now: Date = new Date()): string {
  if (!d) return '-';
  const date = typeof d === 'string' ? new Date(d) : d;
  const ms = now.getTime() - date.getTime();
  if (Number.isNaN(ms)) return '-';
  const future = ms < 0;
  const s = Math.round(Math.abs(ms) / 1000);
  const text =
    s < 60
      ? `${s} s`
      : s < 3600
        ? `${Math.round(s / 60)} min`
        : s < 86_400
          ? `${Math.round(s / 3600)} h`
          : `${Math.round(s / 86_400)} d`;
  return future ? `in ${text}` : `${text} ago`;
}

/** Shorten a long error for a table cell (the full text goes in a title attribute). */
export function short(text: string | null | undefined, max = 140): string {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
