/**
 * Which realtime client the map subscribes with. Normally the platform's (getRealtimeClient(),
 * one shared EventSource per tab, built by the runtime agent). Outside production an e2e test
 * may install `window.__farmTestRealtime` before the page loads (Playwright addInitScript) to
 * drive `fleet` events deterministically; the SSE wire format itself is covered by the
 * realtime e2e specs.
 */
import type { AppEnv } from '../../../config';
import { getRealtimeClient } from '../../../platform/realtime/client';
import type { RealtimeClient } from '../../../platform/realtime/types';

declare global {
  interface Window {
    __farmTestRealtime?: RealtimeClient;
  }
}

export function resolveRealtimeClient(appEnv: AppEnv): RealtimeClient {
  if (appEnv !== 'production' && typeof window !== 'undefined' && window.__farmTestRealtime) {
    return window.__farmTestRealtime;
  }
  return getRealtimeClient();
}
