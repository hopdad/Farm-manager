'use client';
/**
 * /admin/realtime: shows what this tab's realtime client sees (connection state, resyncs, the
 * latest events with their per-topic seq). A diagnostics page, and the page the realtime e2e
 * test opens in two browser contexts.
 */
import { useEffect, useState } from 'react';
import {
  type ConnectionState,
  getRealtimeClient,
  getSseRealtimeClient,
  type RealtimeKind,
} from '@/platform/realtime/client';
import type { Topic } from '@/platform/realtime/types';
import css from '../admin.module.css';

interface SeenEvent {
  n: number;
  topic: string;
  event: string;
  seq: number;
  at: string;
  payload: string;
  marker: string | null;
}

const MAX_EVENTS = 50;

export function RealtimeMonitor({
  topics,
  realtime,
}: {
  topics: Topic[];
  /** NEXT_PUBLIC_REALTIME (publicConfig().realtime). */
  realtime: RealtimeKind;
}) {
  const [state, setState] = useState<ConnectionState>('idle');
  const [resyncs, setResyncs] = useState(0);
  const [events, setEvents] = useState<SeenEvent[]>([]);
  const key = topics.join(',');

  useEffect(() => {
    let n = 0;
    const rt = getRealtimeClient(realtime);
    const offs = (key.split(',') as Topic[]).map((topic) =>
      rt.subscribe(
        topic,
        (evt) => {
          const payload = evt.payload as unknown as Record<string, unknown>;
          const marker = typeof payload.event === 'string' ? payload.event : null;
          n += 1;
          const seen: SeenEvent = {
            n,
            topic,
            event: evt.event,
            seq: evt.seq,
            at: new Date().toISOString(),
            payload: JSON.stringify(payload).slice(0, 400),
            marker,
          };
          setEvents((prev) => [seen, ...prev].slice(0, MAX_EVENTS));
        },
        { onResync: () => setResyncs((r) => r + 1) },
      ),
    );
    const sse = realtime === 'sse' ? getSseRealtimeClient() : null;
    const offState = sse?.onStateChange(setState);
    if (sse) setState(sse.state);
    return () => {
      for (const off of offs) off();
      offState?.();
    };
  }, [key, realtime]);

  return (
    <div className={css.stack}>
      <dl className={css.kv}>
        <dt>Connection</dt>
        <dd data-testid="rt-state" data-state={state}>
          {state}
        </dd>
        <dt>Topics</dt>
        <dd className={css.mono}>{key}</dd>
        <dt>Resyncs</dt>
        <dd data-testid="rt-resyncs">{resyncs}</dd>
        <dt>Events</dt>
        <dd data-testid="rt-count">{events.length}</dd>
      </dl>
      <ul className={css.events} data-testid="rt-events">
        {events.map((e) => (
          <li
            key={e.n}
            data-testid="rt-event"
            data-topic={e.topic}
            data-event={e.event}
            data-seq={e.seq}
            data-marker={e.marker ?? undefined}
          >
            <span className={css.mono}>
              {e.topic}/{e.event} #{e.seq}
            </span>{' '}
            <span className={css.muted}>{e.at}</span>
            <div className={css.mono}>{e.payload}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}
