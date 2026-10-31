/**
 * The two sync models of the vehicle telematics port (slice 1f.2, docs/contracts-1f.md part B).
 * Every telematics client polls one of these ways; both return a PollResult whose cursor goes
 * into ingest.sync_state.cursor through runSyncStep, so a crash at any point re-runs safely.
 *
 *  1. CURSOR / VERSION FEEDS (`pollVersionFeed`): the vendor hands out a token that means
 *     "everything up to here" (Samsara `pagination.endCursor` → `after`; Geotab GetFeed
 *     `toVersion` → `fromVersion`). The stored cursor IS the vendor's token. Page until the vendor
 *     says there is no more, a page budget or the job's deadline.
 *
 *  2. SNAPSHOT-DIFF POLLING (`pollSnapshotDiff`): the vendor only answers "the current state of
 *     each vehicle" (Motive vehicle lists, AEMP Fleet pages, per-vehicle calls). The cursor
 *     remembers, per vehicle key, the version last emitted (a fingerprint, or a monotonic time),
 *     and a poll returns only the vehicles whose version moved. One global watermark would drop
 *     every vehicle that reports a little later than the fastest one, so it is per key.
 *
 * Pure (no I/O of its own: the caller passes the fetch functions); no Node-only imports.
 * Owned by the foundation (contract file); the shared sync helpers (src/connectors/sync-step.ts,
 * sync-health) stay as they are.
 */
import type { PollResult } from './types';

// ---------------------------------------------------------------------------------------------
// 1. Cursor / version feeds
// ---------------------------------------------------------------------------------------------

export interface VersionFeedPage<T> {
  items: T[];
  /** The vendor's token after this page; null or '' = keep the previous one. */
  next: string | null;
  /** The vendor says more is ready right now (Samsara hasNextPage; Geotab: a full page). */
  hasMore: boolean;
}

export interface VersionFeedOptions<T> {
  /** The stored cursor (null on the first run: the vendor's "from now / latest" call). */
  cursor: string | null;
  fetchPage(token: string | null): Promise<VersionFeedPage<T>>;
  /** Most pages in one poll (default 10); the rest is left for the next run (`hasMore`). */
  maxPages?: number;
  /** Stop paging at this wall time (the job's deadline). */
  deadline?: Date;
  now?: () => Date;
  signal?: AbortSignal;
}

/** Page a cursor/version feed from the stored token. */
export async function pollVersionFeed<T>(opts: VersionFeedOptions<T>): Promise<PollResult<T>> {
  const maxPages = Math.max(1, Math.floor(opts.maxPages ?? 10));
  const now = opts.now ?? (() => new Date());
  let token = opts.cursor;
  const items: T[] = [];
  let hasMore = false;
  for (let page = 0; page < maxPages; page++) {
    const p = await opts.fetchPage(token);
    items.push(...p.items);
    const moved = !!p.next && p.next !== token;
    if (p.next) token = p.next;
    hasMore = p.hasMore;
    // A vendor that says "more" without moving its token would loop forever: stop.
    if (!p.hasMore || !moved) break;
    if (opts.signal?.aborted) break;
    if (opts.deadline && now().getTime() >= opts.deadline.getTime()) break;
  }
  return { items, cursor: token ?? '', hasMore };
}

// ---------------------------------------------------------------------------------------------
// 2. Snapshot-diff polling
// ---------------------------------------------------------------------------------------------

/** Versions compare by inequality (`changed`) or as numbers that only move forward (`newer`). */
export type SnapshotDiffMode = 'changed' | 'newer';

export interface SnapshotDiffOptions<T> {
  cursor: string | null;
  /** The vendor's current state (the caller pages through it). */
  fetchSnapshot(): Promise<T[]>;
  /** Stable key of an item (the vehicle id; `${provider}:${serial}` for AEMP). */
  keyOf(item: T): string;
  /**
   * `changed`: any string (a JSON of the fields that matter is fine: it is hashed);
   * `newer`: a number (epoch ms of the vendor's own reading time).
   */
  versionOf(item: T): string | number;
  mode?: SnapshotDiffMode;
  /** Most keys the cursor keeps (default 5000; the least recently changed are dropped first). */
  maxKeys?: number;
}

export interface SnapshotDiffResult<T> extends PollResult<T> {
  /** Keys the cursor knows that this snapshot no longer lists (kept in the cursor). */
  gone: string[];
}

/** The snapshot-diff cursor: `{"v":1,"seen":{"<key>":"<version>"}}` (insertion = change order). */
export interface SnapshotDiffCursor {
  v: 1;
  seen: Record<string, string>;
}

/** Parse a stored snapshot-diff cursor ('' or anything else: none yet). */
export function parseSnapshotCursor(cursor: string | null): SnapshotDiffCursor {
  if (!cursor?.startsWith('{')) return { v: 1, seen: {} };
  try {
    const parsed = JSON.parse(cursor) as unknown;
    const seen = (parsed as { seen?: unknown } | null)?.seen;
    if (
      (parsed as { v?: unknown } | null)?.v !== 1 ||
      !seen ||
      typeof seen !== 'object' ||
      Array.isArray(seen)
    ) {
      return { v: 1, seen: {} };
    }
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(seen)) if (typeof val === 'string') out[k] = val;
    return { v: 1, seen: out };
  } catch {
    return { v: 1, seen: {} };
  }
}

/** FNV-1a 64-bit as 16 hex digits: short, stable fingerprints for `changed` versions. */
export function fingerprint(s: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

/** One snapshot poll: the items whose version moved since the cursor, and the new cursor. */
export async function pollSnapshotDiff<T>(
  opts: SnapshotDiffOptions<T>,
): Promise<SnapshotDiffResult<T>> {
  const mode = opts.mode ?? 'changed';
  const maxKeys = Math.max(1, Math.floor(opts.maxKeys ?? 5000));
  const prev = parseSnapshotCursor(opts.cursor).seen;
  const seen = new Map(Object.entries(prev));
  const snapshot = await opts.fetchSnapshot();
  const items: T[] = [];
  const present = new Set<string>();
  for (const item of snapshot) {
    const key = opts.keyOf(item);
    present.add(key);
    const raw = opts.versionOf(item);
    const before = seen.get(key);
    let emit: boolean;
    let stored: string;
    if (mode === 'newer') {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) continue; // no usable reading time: skip, never emit twice
      stored = String(n);
      emit = before === undefined || n > Number(before);
    } else {
      stored = fingerprint(String(raw));
      emit = before !== stored;
    }
    if (!emit) continue;
    items.push(item);
    // Re-insert so the Map's order is "least recently changed first" for the cap below.
    seen.delete(key);
    seen.set(key, stored);
  }
  while (seen.size > maxKeys) {
    const oldest = seen.keys().next().value as string;
    seen.delete(oldest);
  }
  const gone = [...seen.keys()].filter((k) => !present.has(k));
  // Nothing moved: the same string as stored (a cursor this module wrote serializes the same).
  const cursor: SnapshotDiffCursor = { v: 1, seen: Object.fromEntries(seen) };
  return { items, cursor: JSON.stringify(cursor), gone };
}
