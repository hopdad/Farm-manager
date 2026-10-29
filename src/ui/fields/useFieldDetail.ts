'use client';
/**
 * React wrapper of ./detail-loader.ts: the open field's FieldDetail, kept fresh by realtime
 * `fields`/`updated` (NEXT_PUBLIC_REALTIME picks the adapter; outside production an e2e test may
 * install `window.__farmTestRealtime`), with a poll while realtime is down.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PublicConfig } from '../../config';
import { resolveRealtimeClient } from '../map/fleet/realtime';
import {
  type FieldDetailLoader,
  type FieldDetailState,
  initialDetailState,
  startFieldDetail,
} from './detail-loader';

export type FieldPanelConfig = Pick<PublicConfig, 'appEnv' | 'realtime'>;

export function useFieldDetail(
  fieldId: string,
  config: FieldPanelConfig,
): { state: FieldDetailState; refetch(): void } {
  const [state, setState] = useState<FieldDetailState>(() => initialDetailState(fieldId));
  const loader = useRef<FieldDetailLoader | null>(null);
  const { appEnv, realtime } = config;

  useEffect(() => {
    const l = startFieldDetail({
      fieldId,
      fetch: (input, init) => fetch(input, init),
      realtime: resolveRealtimeClient({ appEnv, realtime }),
      onState: setState,
    });
    loader.current = l;
    return () => {
      l.stop();
      if (loader.current === l) loader.current = null;
    };
  }, [fieldId, appEnv, realtime]);

  const refetch = useCallback(() => loader.current?.refetch(), []);
  // Until the new field's loader reports, never show the previous field's data.
  const current = state.fieldId === fieldId ? state : initialDetailState(fieldId);
  return { state: current, refetch };
}
