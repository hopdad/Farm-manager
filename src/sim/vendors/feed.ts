/**
 * Cursor-feed arithmetic shared by the stand-in's feeds (Samsara locations/stats). Pure.
 *
 * Samples sit on an epoch-aligned wall-clock grid (`intervalMs`), so the same request always
 * yields the same instants. A cursor is a watermark: "every grid instant <= t was delivered".
 *  - No cursor: the single latest instant (Samsara: "the first call returns the latest location
 *    for each vehicle along with an initial cursor").
 *  - Cursor t: instants in (t, now], at most `perPage` of them; `hasNextPage` when more remain.
 *  - A cursor older than `maxCatchUpMs` resumes from now − maxCatchUpMs.
 */

export interface FeedWindowInput {
  afterMs: number | null;
  nowMs: number;
  intervalMs: number;
  /** Max instants in one page (>= 1). */
  perPage: number;
  maxCatchUpMs: number;
}

export interface FeedWindow {
  instants: number[];
  /** Watermark to return as endCursor (unchanged when nothing new). */
  endMs: number;
  hasNextPage: boolean;
}

const floorTo = (t: number, step: number) => Math.floor(t / step) * step;

export function feedWindow(input: FeedWindowInput): FeedWindow {
  const { nowMs, intervalMs } = input;
  const perPage = Math.max(1, Math.floor(input.perPage));
  const last = floorTo(nowMs, intervalMs);
  if (input.afterMs === null) {
    return { instants: [last], endMs: last, hasNextPage: false };
  }
  const start = Math.max(input.afterMs, nowMs - input.maxCatchUpMs);
  const first = floorTo(start, intervalMs) + intervalMs;
  if (first > last) return { instants: [], endMs: input.afterMs, hasNextPage: false };
  const count = Math.floor((last - first) / intervalMs) + 1;
  const take = Math.min(count, perPage);
  const instants = Array.from({ length: take }, (_, i) => first + i * intervalMs);
  return {
    instants,
    endMs: instants[instants.length - 1] as number,
    hasNextPage: count > take,
  };
}

/** Opaque feed cursor: base64url of `{ v: 1, t }`. */
export function encodeFeedCursor(t: number): string {
  return Buffer.from(JSON.stringify({ v: 1, t }), 'utf8').toString('base64url');
}

/** The watermark of a cursor, or null when it isn't one of ours. */
export function decodeFeedCursor(cursor: string): number | null {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      v &&
      typeof v === 'object' &&
      (v as { v?: unknown }).v === 1 &&
      Number.isSafeInteger((v as { t?: unknown }).t)
    ) {
      return (v as { t: number }).t;
    }
  } catch {
    // fall through
  }
  return null;
}

/** Deterministic Fisher-Yates shuffle (out_of_order fault). */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed >>> 0 || 1;
  const rand = () => {
    // xorshift32
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x1_0000_0000;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  // A shuffle of >= 2 distinct items that changed nothing isn't "out of order": rotate.
  if (out.length > 1 && out.every((v, i) => v === items[i])) out.push(out.shift() as T);
  return out;
}

export const round = (v: number, decimals: number) => {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
};
