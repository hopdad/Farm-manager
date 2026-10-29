/**
 * Which realtime client the map subscribes with. Normally the platform's
 * (getRealtimeClient(kind), kind = NEXT_PUBLIC_REALTIME from publicConfig; locally one shared
 * EventSource per tab, built by the runtime agent). Outside production an e2e test may install
 * `window.__farmTestRealtime` before the page loads (Playwright addInitScript) to drive `fleet`
 * events deterministically; the SSE wire format itself is covered by the realtime e2e specs.
 *
 * `connected()` says whether live events can arrive right now. While they can't (SSE still
 * connecting or reconnecting, /api/realtime answering 404, the Supabase adapter not built yet),
 * the fleet hook polls GET /api/fleet instead of leaving the map blank or frozen.
 */
import type { PublicConfig } from '../../../config';
import { getRealtimeClient, getSseRealtimeClient } from '../../../platform/realtime/client';
import type { RealtimeClient } from '../../../platform/realtime/types';

declare global {
  interface Window {
    __farmTestRealtime?: RealtimeClient;
  }
}

export interface ResolvedRealtime {
  client: RealtimeClient;
  /** Can live events arrive right now? False: poll the snapshot. */
  connected(): boolean;
}

export function resolveRealtimeClient(
  cfg: Pick<PublicConfig, 'appEnv' | 'realtime'>,
): ResolvedRealtime {
  if (cfg.appEnv !== 'production' && typeof window !== 'undefined' && window.__farmTestRealtime) {
    return { client: window.__farmTestRealtime, connected: () => true };
  }
  const client = getRealtimeClient(cfg.realtime);
  if (cfg.realtime !== 'sse') return { client, connected: () => false };
  return { client, connected: () => getSseRealtimeClient()?.state === 'ready' };
}
