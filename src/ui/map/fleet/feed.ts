/**
 * The fleet feed behind useFleet (framework-free, unit-tested): GET /api/fleet snapshots plus
 * live `fleet`/`tick` events, applied to a FleetModel.
 *
 *  - `onResync` (after every (re)connect, a `seq` gap or an `invalidate`) refetches the snapshot;
 *    overlapping refetches merge into one more fetch after the current one.
 *  - Realtime may not connect at all (/api/realtime 404, NEXT_PUBLIC_REALTIME=supabase before MD,
 *    a proxy that buffers SSE): the first snapshot loads after `graceMs` anyway, and every
 *    `pollMs` the snapshot is refetched for as long as `realtime.connected()` is false, so the
 *    map degrades to polling instead of staying blank or frozen.
 *  - Every `pollMs` staleness is re-evaluated against the browser clock (contracts §7), so
 *    "trucks API down" turns the trucks stale even when no tick arrives.
 *  - A failed snapshot while realtime can't deliver either (the farm PC is unreachable) reports
 *    `unavailable` with `offlineSince` (the first failure), even with markers on the map: they
 *    stay as last known positions, and the status strip says since when. A snapshot that
 *    succeeds, or a tick, clears it.
 */
import { fleetTickSchema } from '../../../domain/fleet';
import type { FleetModel } from './model';
import type { ResolvedRealtime } from './realtime';

export const FLEET_SNAPSHOT_URL = '/api/fleet';
/** Staleness re-check period (contracts §7: 5-10 s); also the snapshot poll while realtime is down. */
export const STALE_CHECK_MS = 5_000;
/** Load the snapshot this long after subscribing if realtime hasn't resynced (it normally does). */
export const FIRST_SNAPSHOT_GRACE_MS = 1_500;

export type FleetConnection = 'loading' | 'live' | 'unavailable';

/** What the feed reports; the hook adds counts and the machine list from the model. */
export interface FleetFeedPatch {
  connection?: FleetConnection;
  lastSnapshotAt?: number | null;
  lastTickAt?: number | null;
  error?: string | null;
  /** Wall clock (ms) of the first failure since the feed last heard from the server; null when fine. */
  offlineSince?: number | null;
}

export interface FleetFeedOptions {
  model: FleetModel;
  realtime: ResolvedRealtime;
  /** Something the screens show changed (counts, the list, the connection). */
  onChange(patch: FleetFeedPatch): void;
  fetch?: typeof globalThis.fetch;
  graceMs?: number;
  pollMs?: number;
  /** Animation clock (performance.now()); tests inject one. */
  animationNow?: () => number;
  /** Wall clock for lastSnapshotAt / lastTickAt. */
  wallNow?: () => number;
}

/** Start the feed. Returns stop(). */
export function startFleetFeed(opts: FleetFeedOptions): () => void {
  const { model, realtime, onChange } = opts;
  const doFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const animationNow = opts.animationNow ?? (() => performance.now());
  const wallNow = opts.wallNow ?? (() => Date.now());
  let disposed = false;
  let inflight = false;
  let again = false;
  let loaded = false;
  let offlineSince: number | null = null;
  const abort = new AbortController();
  const report = (patch: FleetFeedPatch) => {
    if (!disposed) onChange(patch);
  };

  async function refetch(): Promise<void> {
    if (inflight) {
      again = true;
      return;
    }
    inflight = true;
    try {
      do {
        again = false;
        const res = await doFetch(FLEET_SNAPSHOT_URL, {
          cache: 'no-store',
          headers: { accept: 'application/json' },
          signal: abort.signal,
        });
        if (!res.ok) throw new Error(`GET ${FLEET_SNAPSHOT_URL} → HTTP ${res.status}`);
        const parsed = fleetTickSchema.safeParse(await res.json());
        if (!parsed.success) throw new Error(`GET ${FLEET_SNAPSHOT_URL}: unexpected response`);
        if (disposed) return;
        model.applySnapshot(parsed.data.machines, animationNow());
        loaded = true;
        offlineSince = null;
        report({ connection: 'live', lastSnapshotAt: wallNow(), error: null, offlineSince: null });
      } while (again && !disposed);
    } catch (e) {
      if (disposed || abort.signal.aborted) return;
      const error = (e as Error).message;
      console.warn('[fleet] snapshot failed:', error);
      // Live only while events still arrive and there is something to show; otherwise the
      // screens say the fleet is not updating (and since when).
      const live = model.size > 0 && realtime.connected();
      if (!live) offlineSince ??= wallNow();
      report({
        connection: live ? 'live' : 'unavailable',
        error,
        offlineSince: live ? null : offlineSince,
      });
    } finally {
      inflight = false;
    }
  }

  const unsubscribe = realtime.client.subscribe(
    'fleet',
    (evt) => {
      if (evt.event !== 'tick') return; // 'invalidate' → onResync refetches
      const parsed = fleetTickSchema.safeParse(evt.payload);
      if (!parsed.success) {
        console.warn('[fleet] ignoring a malformed tick');
        return;
      }
      model.applyTick(parsed.data.machines, animationNow());
      offlineSince = null;
      report({ connection: 'live', lastTickAt: wallNow(), offlineSince: null });
    },
    { onResync: () => void refetch() },
  );
  const first = setTimeout(() => {
    if (!loaded && !inflight) void refetch();
  }, opts.graceMs ?? FIRST_SNAPSHOT_GRACE_MS);
  const timer = setInterval(() => {
    if (!realtime.connected()) void refetch();
    if (model.refreshStaleness()) report({});
  }, opts.pollMs ?? STALE_CHECK_MS);

  return () => {
    disposed = true;
    abort.abort();
    unsubscribe();
    clearTimeout(first);
    clearInterval(timer);
  };
}
