/**
 * The fleet panel's data feed (framework-free; src/ui/fleet/feed.test.ts): GET /api/machines,
 * then the realtime `fleet` topic: `tick` moves machines between groups, `machine` patches one
 * machine's down state at once (the wall shows a phone's "down" within the 2 s target), and
 * `onResync` (reconnect, seq gap, `invalidate`) refetches. While realtime can't deliver (SSE
 * reconnecting, /api/realtime unavailable) the list is refetched every `pollMs`, so the panel
 * degrades to polling instead of going stale; a tick that disagrees with what we know (a status
 * change we never heard of, a new machine) also triggers a refetch.
 *
 * Realtime needs the server's config (which adapter), so the subscription starts after the
 * first snapshot.
 */
import { fleetTickSchema } from '../../domain/fleet';
import type { RealtimeClient } from '../../platform/realtime/types';
import { type FleetPanelData, fleetPanelDataSchema, MACHINES_URL } from './contract';
import { initialPanelState, type PanelAction, type PanelState, reducePanel } from './model';

/** Snapshot poll while realtime is down (and the tick re-check of ages). */
export const PANEL_POLL_MS = 5_000;

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
        } else if (evt.event === 'tick') {
          const parsed = fleetTickSchema.safeParse(evt.payload);
          if (parsed.success) dispatch({ type: 'tick', tick: parsed.data });
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
        dispatch({ type: 'snapshot', data: parsed.data });
        subscribe(parsed.data.config);
      } while (again && !stopped);
    } catch (e) {
      if (stopped || abort.signal.aborted) return;
      dispatch({ type: 'error', message: (e as Error).message });
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
