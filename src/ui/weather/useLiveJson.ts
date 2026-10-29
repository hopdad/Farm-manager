'use client';
/**
 * Load a JSON view and keep it current: refetch when an event arrives on its realtime topics
 * (debounced), on every resync (reconnect, seq gap, invalidate) and every `pollMs` as a
 * fallback. The response names the realtime adapter (`realtime`), so components subscribe
 * without reading config. Through the PLATFORM realtime client (one EventSource per tab).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getRealtimeClient } from '../../platform/realtime/client';
import type { Topic } from '../../platform/realtime/types';
import type { RealtimeKind } from './contract';

export interface LiveJson<T> {
  data: T | null;
  /** Last error (HTTP status text, 'offline'); the last good data stays. */
  error: string | null;
  status: number | null;
  refetch(): void;
}

const DEBOUNCE_MS = 300;
/** A resync right after subscribing repeats the load that just happened: skip it. */
const FIRST_RESYNC_GRACE_MS = 2_000;

export function useLiveJson<T extends { realtime: RealtimeKind }>(
  url: string | null,
  topics: readonly Topic[],
  pollMs = 60_000,
): LiveJson<T> {
  const [state, setState] = useState<Omit<LiveJson<T>, 'refetch'>>({
    data: null,
    error: null,
    status: null,
  });
  const refetchRef = useRef<() => void>(() => {});
  const key = topics.join(',');

  useEffect(() => {
    if (!url) return;
    let stopped = false;
    let ctrl: AbortController | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let unsubs: (() => void)[] | null = null;
    let subscribedAt = 0;

    const load = async () => {
      ctrl?.abort();
      const mine = new AbortController();
      ctrl = mine;
      try {
        const res = await fetch(url, { cache: 'no-store', signal: mine.signal });
        const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
        if (stopped || mine.signal.aborted) return;
        if (!res.ok || !body) {
          setState((s) => ({
            ...s,
            error: body?.error ?? `HTTP ${res.status}`,
            status: res.status,
          }));
          return;
        }
        setState({ data: body, error: null, status: res.status });
        subscribe(body.realtime);
      } catch {
        if (!stopped && !mine.signal.aborted) {
          setState((s) => ({ ...s, error: 'offline', status: null }));
        }
      }
    };
    const refetch = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        void load();
      }, DEBOUNCE_MS);
    };
    const subscribe = (kind: RealtimeKind) => {
      if (unsubs) return;
      subscribedAt = Date.now();
      const rt = getRealtimeClient(kind);
      unsubs = (key.split(',').filter(Boolean) as Topic[]).map((topic) =>
        rt.subscribe(topic, () => refetch(), {
          onResync: () => {
            if (Date.now() - subscribedAt > FIRST_RESYNC_GRACE_MS) refetch();
          },
        }),
      );
    };

    refetchRef.current = refetch;
    void load();
    const poll = setInterval(() => void load(), pollMs);
    return () => {
      stopped = true;
      ctrl?.abort();
      clearInterval(poll);
      if (debounce) clearTimeout(debounce);
      for (const off of unsubs ?? []) off();
      refetchRef.current = () => {};
    };
  }, [url, key, pollMs]);

  const refetch = useCallback(() => refetchRef.current(), []);
  return { ...state, refetch };
}

/** Re-render every `ms` (ages). */
export function useNowTick(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
