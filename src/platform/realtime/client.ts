/**
 * Browser realtime client: PLACEHOLDER. The realtime agent replaces this file with the SSE
 * implementation (one shared EventSource per tab, `seq` tracking, `onResync`), keeping this
 * export so UI code written against it doesn't change.
 */
import type { RealtimeClient } from './types';

export function getRealtimeClient(): RealtimeClient {
  return {
    subscribe(_topic, _onEvent, opts) {
      // No live updates yet: ask the caller to load its snapshot once.
      queueMicrotask(() => opts.onResync());
      return () => {};
    },
  };
}
