'use client';
/**
 * React side of the fleet panel feed (./feed.ts): state for the screens, plus `apply` for a
 * change this device just saved (shown before its realtime event arrives).
 *
 * 1f: every component of a page that follows the fleet panel's data (the panel itself, the phone
 * machine card's fault tag) shares ONE feed: the first `useFleetPanel` starts it, the last one to
 * unmount stops it, so a second reader adds no fetch and no subscription.
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

interface SharedFeed {
  feed: FleetPanelFeed;
  state: PanelState;
  listeners: Set<(state: PanelState) => void>;
  refs: number;
}

let shared: SharedFeed | null = null;

function acquireFeed(): SharedFeed {
  if (!shared) {
    const s: SharedFeed = {
      state: initialPanelState,
      listeners: new Set(),
      refs: 0,
      feed: null as unknown as FleetPanelFeed,
    };
    shared = s;
    s.feed = startFleetPanelFeed({
      onState: (next) => {
        s.state = next;
        for (const l of s.listeners) l(next);
      },
      realtimeFor: platformRealtime,
    });
  }
  shared.refs++;
  return shared;
}

function releaseFeed(s: SharedFeed): void {
  s.refs--;
  if (s.refs > 0) return;
  s.feed.stop();
  if (shared === s) shared = null;
}

export function useFleetPanel(): { state: PanelState; apply(action: PanelAction): void } {
  const [state, setState] = useState<PanelState>(initialPanelState);
  const feed = useRef<SharedFeed | null>(null);
  useEffect(() => {
    const s = acquireFeed();
    feed.current = s;
    s.listeners.add(setState);
    setState(s.state);
    return () => {
      s.listeners.delete(setState);
      releaseFeed(s);
      feed.current = null;
    };
  }, []);
  return { state, apply: (action) => feed.current?.feed.dispatch(action) };
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
