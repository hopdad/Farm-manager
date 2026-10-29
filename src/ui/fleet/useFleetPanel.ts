'use client';
/**
 * React side of the fleet panel feed (./feed.ts): state for the screens, plus `apply` for a
 * change this device just saved (shown before its realtime event arrives).
 */
import { useEffect, useRef, useState } from 'react';
import { resolveRealtimeClient } from '../map/fleet/realtime';
import { type FleetPanelFeed, startFleetPanelFeed } from './feed';
import { initialPanelState, type PanelAction, type PanelState } from './model';

export function useFleetPanel(): { state: PanelState; apply(action: PanelAction): void } {
  const [state, setState] = useState<PanelState>(initialPanelState);
  const feed = useRef<FleetPanelFeed | null>(null);
  useEffect(() => {
    const f = startFleetPanelFeed({
      onState: setState,
      realtimeFor: (config) => resolveRealtimeClient(config),
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
