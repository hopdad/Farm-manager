'use client';
/**
 * The fleet feed for the board and /m: GET /api/fleet snapshot (built by the vendors agent),
 * then live `fleet`/`tick` events from the realtime client, with `onResync` refetching the
 * snapshot (after every (re)connect, a `seq` gap or an `invalidate`). Staleness is re-evaluated
 * every 5 s against the browser clock (contracts §7), so "trucks API down" turns the trucks stale
 * even when no tick arrives.
 *
 * The FleetModel is mutable and read by the map's animation loop directly; React state only
 * carries what the screens show (counts, the list, connection status), updated per tick.
 */
import { useEffect, useMemo, useState } from 'react';
import type { AppEnv } from '../../../config';
import { fleetTickSchema } from '../../../domain/fleet';
import { type FleetCounts, type FleetFrame, FleetModel } from './model';
import { resolveRealtimeClient } from './realtime';

export const FLEET_SNAPSHOT_URL = '/api/fleet';
/** Staleness re-check period (contracts §7: 5-10 s). */
export const STALE_CHECK_MS = 5_000;

export type FleetConnection = 'loading' | 'live' | 'unavailable';

export interface FleetStatus {
  connection: FleetConnection;
  counts: FleetCounts;
  /** Machines (sorted), refreshed on every change but not per animation frame. */
  machines: FleetFrame[];
  lastSnapshotAt: number | null;
  lastTickAt: number | null;
  error: string | null;
}

export function useFleet(opts: { appEnv: AppEnv; staleAfterSeconds: number }): {
  model: FleetModel;
  status: FleetStatus;
} {
  const { appEnv, staleAfterSeconds } = opts;
  const model = useMemo(() => new FleetModel({ staleAfterSeconds }), [staleAfterSeconds]);
  const [status, setStatus] = useState<FleetStatus>({
    connection: 'loading',
    counts: { total: 0, stale: 0, down: 0 },
    machines: [],
    lastSnapshotAt: null,
    lastTickAt: null,
    error: null,
  });

  useEffect(() => {
    let disposed = false;
    let inflight = false;
    let again = false;
    const abort = new AbortController();
    const publish = (patch: Partial<FleetStatus>) => {
      if (disposed) return;
      const machines = model.frame(Number.POSITIVE_INFINITY);
      setStatus((s) => ({ ...s, ...patch, counts: model.counts(), machines }));
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
          const res = await fetch(FLEET_SNAPSHOT_URL, {
            cache: 'no-store',
            headers: { accept: 'application/json' },
            signal: abort.signal,
          });
          if (!res.ok) throw new Error(`GET ${FLEET_SNAPSHOT_URL} → HTTP ${res.status}`);
          const parsed = fleetTickSchema.safeParse(await res.json());
          if (!parsed.success) throw new Error(`GET ${FLEET_SNAPSHOT_URL}: unexpected response`);
          model.applySnapshot(parsed.data.machines, performance.now());
          publish({ connection: 'live', lastSnapshotAt: Date.now(), error: null });
        } while (again && !disposed);
      } catch (e) {
        if (disposed || abort.signal.aborted) return;
        const error = (e as Error).message;
        console.warn('[fleet] snapshot failed:', error);
        publish({ connection: model.size > 0 ? 'live' : 'unavailable', error });
      } finally {
        inflight = false;
      }
    }

    const unsubscribe = resolveRealtimeClient(appEnv).subscribe(
      'fleet',
      (evt) => {
        if (evt.event !== 'tick') return; // 'invalidate' → onResync refetches
        const parsed = fleetTickSchema.safeParse(evt.payload);
        if (!parsed.success) {
          console.warn('[fleet] ignoring a malformed tick');
          return;
        }
        model.applyTick(parsed.data.machines, performance.now());
        publish({ connection: 'live', lastTickAt: Date.now() });
      },
      { onResync: () => void refetch() },
    );
    const timer = setInterval(() => {
      if (model.refreshStaleness()) publish({});
    }, STALE_CHECK_MS);
    return () => {
      disposed = true;
      abort.abort();
      unsubscribe();
      clearInterval(timer);
    };
  }, [appEnv, model]);

  return { model, status };
}
