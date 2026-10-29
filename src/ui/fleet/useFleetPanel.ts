'use client';
/**
 * React side of the fleet panel feed (./feed.ts): state for the screens, plus `apply` for a
 * change this device just saved (shown before its realtime event arrives).
 *
 * The panel subscribes through the PLATFORM realtime client (one shared EventSource per tab
 * locally), never the map's e2e test double (window.__farmTestRealtime): specs that drive the
 * map's feed through that double count its subscriptions, and the panel must not add one.
 */
import { useEffect, useRef, useState } from 'react';
import { getRealtimeClient, getSseRealtimeClient } from '../../platform/realtime/client';
import type { FleetPanelData } from './contract';
import { type FleetPanelFeed, type PanelRealtime, startFleetPanelFeed } from './feed';
import { initialPanelState, type PanelAction, type PanelState } from './model';

export function useFleetPanel(): { state: PanelState; apply(action: PanelAction): void } {
  const [state, setState] = useState<PanelState>(initialPanelState);
  const feed = useRef<FleetPanelFeed | null>(null);
  useEffect(() => {
    const f = startFleetPanelFeed({
      onState: setState,
      realtimeFor: platformRealtime,
    });
    feed.current = f;
    return () => {
      f.stop();
      feed.current = null;
    };
  }, []);
  return { state, apply: (action) => feed.current?.dispatch(action) };
}

/** Re-render every `ms` (ages, staleness). */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** The platform client for the server's adapter, and whether it can deliver right now. */
function platformRealtime(config: FleetPanelData['config']): PanelRealtime {
  const client = getRealtimeClient(config.realtime);
  if (config.realtime !== 'sse') return { client, connected: () => false };
  return { client, connected: () => getSseRealtimeClient()?.state === 'ready' };
}
