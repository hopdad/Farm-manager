'use client';
/**
 * Keeps a server-rendered admin page current: re-renders it (router.refresh) when an event
 * arrives on its realtime topics (e.g. admin/clock, admin/sync.status) and every `intervalMs`
 * while the tab is visible (not every sync publishes a status event). Shows the connection state.
 */
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  type ConnectionState,
  getRealtimeClient,
  getSseRealtimeClient,
} from '@/platform/realtime/client';
import type { Topic } from '@/platform/realtime/types';
import css from '../admin.module.css';

const LABEL: Record<ConnectionState, string> = {
  idle: 'live updates idle',
  connecting: 'connecting…',
  ready: 'live',
  reconnecting: 'reconnecting…',
  closed: 'live updates off',
};
const COLOR: Record<ConnectionState, string> = {
  idle: '#9db3a6',
  connecting: '#facc15',
  ready: '#4ade80',
  reconnecting: '#f97316',
  closed: '#f87171',
};

export function LiveRefresh({
  topics,
  intervalMs = 10_000,
}: {
  topics: Topic[];
  intervalMs?: number;
}) {
  const router = useRouter();
  const [state, setState] = useState<ConnectionState>('connecting');
  const key = topics.join(',');

  useEffect(() => {
    const mountedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        router.refresh();
      }, 250);
    };
    const rt = getRealtimeClient();
    const offs = (key.split(',') as Topic[]).map((topic) =>
      rt.subscribe(topic, () => refresh(), {
        // The page was just rendered on the server: skip the resync of the first connect.
        onResync: () => {
          if (Date.now() - mountedAt > 2_000) refresh();
        },
      }),
    );
    const sse = getSseRealtimeClient();
    const offState = sse?.onStateChange(setState);
    if (sse) setState(sse.state);
    const iv = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, intervalMs);
    return () => {
      for (const off of offs) off();
      offState?.();
      clearInterval(iv);
      if (timer) clearTimeout(timer);
    };
  }, [router, intervalMs, key]);

  return (
    <span className={css.muted} data-testid="live-state" data-state={state}>
      <span className={css.dot} style={{ background: COLOR[state] }} />
      {LABEL[state]}
    </span>
  );
}
