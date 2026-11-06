'use client';
/**
 * React wrapper of ./loader.ts: the open field's jobs, kept fresh by realtime `jobs`/`updated`
 * (the adapter named by the response headers; outside production an e2e test may install
 * `window.__farmTestRealtime`), with a poll while realtime is down.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveRealtimeClient } from '../../../map/fleet/realtime';
import {
  type FieldJobsLoader,
  type FieldJobsState,
  type RealtimeResolver,
  startFieldJobs,
} from './loader';

const resolveRealtime: RealtimeResolver = ({ realtime, appEnv }) =>
  resolveRealtimeClient({
    realtime: realtime === 'supabase' ? 'supabase' : 'sse',
    appEnv: appEnv === 'production' ? 'production' : appEnv === 'test' ? 'test' : 'development',
  });

const loading = (fieldId: string): FieldJobsState => ({
  fieldId,
  status: 'loading',
  jobs: null,
  viewer: null,
  error: null,
});

export function useFieldJobs(fieldId: string): { state: FieldJobsState; refetch(): void } {
  const [state, setState] = useState<FieldJobsState>(() => loading(fieldId));
  const loader = useRef<FieldJobsLoader | null>(null);
  useEffect(() => {
    const l = startFieldJobs({
      fieldId,
      fetch: (input, init) => fetch(input, init),
      realtime: resolveRealtime,
      onState: setState,
    });
    loader.current = l;
    return () => {
      l.stop();
      if (loader.current === l) loader.current = null;
    };
  }, [fieldId]);
  const refetch = useCallback(() => loader.current?.refetch(), []);
  // Until the new field's loader reports, never show the previous field's jobs.
  return { state: state.fieldId === fieldId ? state : loading(fieldId), refetch };
}
