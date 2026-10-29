/**
 * The fleet panel's data feed (framework-free; src/ui/fleet/feed.test.ts): GET /api/machines,
 * then the realtime `fleet` topic: `tick` moves machines between groups, `machine` patches one
 * machine's down state at once (the wall shows a phone's "down" within the 2 s target), and
 * `onResync` (reconnect, seq gap, `invalidate`) refetches. While realtime can't deliver (SSE
 * reconnecting, /api/realtime unavailable) the list is refetched every `pollMs`, so the panel
 * degrades to polling instead of going stale; a tick that disagrees with what we know (a status
 * change we never heard of, a new machine) also triggers a refetch.
 *
 * Ticks carry positions, not geofence visits: while ticks keep arriving the list is also
 * refetched at most every `placeRefreshMs`, so "At Kestrel Grain" doesn't outlive the visit.
 *
 * A `machine` event that arrives while a snapshot is in flight queues one more fetch: that
 * snapshot may have been read before the change committed and would undo it.
 *
 * When the farm PC can't be reached (fetch fails at the network level) the panel keeps the last
 * list and says since when, instead of the browser's raw "Failed to fetch".
 *
 * Realtime needs the server's config (which adapter), so the subscription starts after the
 * first snapshot.
 */
import { fleetTickSchema } from '../../domain/fleet';
import type { RealtimeClient } from '../../platform/realtime/types';
import { formatClock } from '../board/format';
import { type FleetPanelData, fleetPanelDataSchema, MACHINES_URL } from './contract';
import { initialPanelState, type PanelAction, type PanelState, reducePanel } from './model';

/** Snapshot poll while realtime is down (and the tick re-check of ages). */
export const PANEL_POLL_MS = 5_000;
/** While ticks arrive, refetch at most this often (geofence places, field names). */
export const PLACE_REFRESH_MS = 20_000;

/** The notice while the server can't be reached (`since`: wall ms of the first failure). */
export function unreachableMessage(since: number, haveList: boolean): string {
  const at = formatClock(new Date(since)).time;
  return haveList
    ? `Can't reach the farm PC since ${at}: showing last known positions`
    : `Can't reach the farm PC (since ${at})`;
}

export interface PanelRealtime {
  client: RealtimeClient;
  connected(): boolean;
}

export interface FleetPanelFeedOptions {
  onState(state: PanelState): void;
  /** Builds the realtime client once the config is known (src/ui/map/fleet/realtime.ts). */
  realtimeFor(config: FleetPanelData['config']): PanelRealtime;
  fetch?: typeof globalThis.fetch;
  pollMs?: number;
  placeRefreshMs?: number;
  /** Wall clock (ms) for the place refresh; tests inject one. */
  now?: () => number;
}

export interface FleetPanelFeed {
  /** Apply a change made here (a successful POST) without waiting for its event. */
  dispatch(action: PanelAction): void;
  refetch(): Promise<void>;
  stop(): void;
}

export function startFleetPanelFeed(opts: FleetPanelFeedOptions): FleetPanelFeed {
  const doFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const abort = new AbortController();
  let state = initialPanelState;
  let stopped = false;
  let inflight = false;
  let again = false;
  let realtime: PanelRealtime | null = null;
  const wallNow = opts.now ?? (() => Date.now());
  let lastSnapshotAt = Number.NEGATIVE_INFINITY;
  let unreachableSince: number | null = null;
  let unsubscribe: (() => void) | null = null;

  const dispatch = (action: PanelAction) => {
    if (stopped) return;
    state = reducePanel(state, action);
    opts.onState(state);
    if (state.needsRefetch && action.type !== 'snapshot') void refetch();
  };

  function subscribe(config: FleetPanelData['config']) {
    if (realtime || stopped) return;
    realtime = opts.realtimeFor(config);
    unsubscribe = realtime.client.subscribe(
      'fleet',
      (evt) => {
        if (evt.event === 'machine') {
          dispatch({ type: 'machine', payload: evt.payload });
          // A snapshot already in flight may predate this change: load one more after it.
          if (inflight) again = true;
        } else if (evt.event === 'tick') {
          const parsed = fleetTickSchema.safeParse(evt.payload);
          if (!parsed.success) return;
          dispatch({ type: 'tick', tick: parsed.data });
          if (wallNow() - lastSnapshotAt >= (opts.placeRefreshMs ?? PLACE_REFRESH_MS)) {
            void refetch();
          }
        }
        // 'invalidate' → onResync refetches
      },
      { onResync: () => void refetch() },
    );
  }

  async function refetch(): Promise<void> {
    if (inflight) {
      again = true;
      return;
    }
    inflight = true;
    try {
      do {
        again = false;
        const res = await doFetch(MACHINES_URL, {
          cache: 'no-store',
          headers: { accept: 'application/json' },
          signal: abort.signal,
        });
        if (!res.ok) {
          throw new Error(
            res.status === 401
              ? 'Sign in to see the fleet'
              : res.status === 403
                ? 'This device may not see the fleet'
                : `Fleet unavailable (HTTP ${res.status})`,
          );
        }
        const parsed = fleetPanelDataSchema.safeParse(await res.json());
        if (!parsed.success) throw new Error('Fleet unavailable (unexpected response)');
        if (stopped) return;
        lastSnapshotAt = wallNow();
        unreachableSince = null;
        dispatch({ type: 'snapshot', data: parsed.data });
        subscribe(parsed.data.config);
      } while (again && !stopped);
    } catch (e) {
      if (stopped || abort.signal.aborted) return;
      // fetch() rejects with a TypeError ("Failed to fetch", "Load failed") when the server
      // can't be reached at all; HTTP and parse problems already have readable messages.
      if (e instanceof TypeError) {
        unreachableSince ??= wallNow();
        dispatch({ type: 'error', message: unreachableMessage(unreachableSince, state.loaded) });
      } else {
        dispatch({ type: 'error', message: (e as Error).message });
      }
    } finally {
      inflight = false;
    }
  }

  void refetch();
  const timer = setInterval(() => {
    if (!realtime?.connected()) void refetch();
  }, opts.pollMs ?? PANEL_POLL_MS);

  return {
    dispatch,
    refetch,
    stop() {
      stopped = true;
      abort.abort();
      clearInterval(timer);
      unsubscribe?.();
    },
  };
}
