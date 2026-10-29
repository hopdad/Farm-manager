'use client';
/**
 * The fleet feed for the board and /m: GET /api/fleet snapshot (built by the vendors agent),
 * then live `fleet`/`tick` events from the realtime client (NEXT_PUBLIC_REALTIME picks the
 * adapter), with `onResync` refetching the snapshot, a snapshot poll while realtime is down, and
 * staleness re-evaluated every 5 s against the browser clock. The logic lives in ./feed.ts.
 *
 * The FleetModel is mutable and read by the map's animation loop directly; React state only
 * carries what the screens show (counts, the list, connection status), updated per tick.
 */
import { useEffect, useMemo, useState } from 'react';
import type { PublicConfig } from '../../../config';
import { type FleetConnection, startFleetFeed } from './feed';
import { type FleetCounts, type FleetFrame, FleetModel } from './model';
import { resolveRealtimeClient } from './realtime';

export interface FleetStatus {
  connection: FleetConnection;
  counts: FleetCounts;
  /** Machines (sorted), refreshed on every change but not per animation frame. */
  machines: FleetFrame[];
  lastSnapshotAt: number | null;
  lastTickAt: number | null;
  error: string | null;
}

export function useFleet(opts: {
  appEnv: PublicConfig['appEnv'];
  realtime: PublicConfig['realtime'];
  staleAfterSeconds: number;
  deereStaleAfterSeconds: number;
}): {
  model: FleetModel;
  status: FleetStatus;
} {
  const { appEnv, realtime, staleAfterSeconds, deereStaleAfterSeconds } = opts;
  const model = useMemo(
    () => new FleetModel({ staleAfterSeconds, deereStaleAfterSeconds }),
    [staleAfterSeconds, deereStaleAfterSeconds],
  );
  const [status, setStatus] = useState<FleetStatus>({
    connection: 'loading',
    counts: { total: 0, stale: 0, down: 0 },
    machines: [],
    lastSnapshotAt: null,
    lastTickAt: null,
    error: null,
  });

  useEffect(
    () =>
      startFleetFeed({
        model,
        realtime: resolveRealtimeClient({ appEnv, realtime }),
        onChange: (patch) => {
          const machines = model.frame(Number.POSITIVE_INFINITY);
          setStatus((s) => ({ ...s, ...patch, counts: model.counts(), machines }));
        },
      }),
    [appEnv, realtime, model],
  );

  return { model, status };
}
