/**
 * The layer registry feed behind the rail (framework-free, unit-tested): GET /api/layers on
 * start, again on realtime `layers`/`updated` and on every resync (reconnect, seq gap,
 * invalidate), with overlapping refetches merged into one more after the current one. While
 * realtime can't deliver (SSE down, the Supabase adapter before MD) it polls slowly; a failed
 * fetch keeps the last good list and retries.
 */
import { z } from 'zod';
import {
  type MapLayersResponse,
  mapLayerRowSchema,
  type ResolvedMapLayer,
} from '../../../domain/map-layers';
import type { ResolvedRealtime } from '../fleet/realtime';

export const LAYERS_URL = '/api/layers';
/** Retry after a failed fetch. */
export const LAYERS_RETRY_MS = 15_000;
/** Poll while realtime is not connected (layers change rarely: after a gis:* build). */
export const LAYERS_POLL_MS = 60_000;

const resolvedSchema = mapLayerRowSchema.extend({ url: z.string().min(1) });

/** The response's valid layers (a malformed entry is dropped, not fatal). */
export function parseLayersResponse(body: unknown): MapLayersResponse {
  const list = (body as { layers?: unknown })?.layers;
  if (!Array.isArray(list)) throw new Error('GET /api/layers: no layers array');
  const layers: ResolvedMapLayer[] = [];
  for (const item of list) {
    const r = resolvedSchema.safeParse(item);
    if (r.success) layers.push(r.data);
    else console.warn('[layer rail] dropped a malformed layer row', r.error.issues[0]?.message);
  }
  return { layers };
}

export interface LayersFeedOptions {
  realtime: ResolvedRealtime;
  onLayers(layers: ResolvedMapLayer[]): void;
  /** null clears a previous error. */
  onError(message: string | null): void;
  fetch?: typeof globalThis.fetch;
  retryMs?: number;
  pollMs?: number;
}

export function startLayersFeed(opts: LayersFeedOptions): () => void {
  const doFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const retryMs = opts.retryMs ?? LAYERS_RETRY_MS;
  const pollMs = opts.pollMs ?? LAYERS_POLL_MS;
  const abort = new AbortController();
  let disposed = false;
  let inflight = false;
  let again = false;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const load = async (): Promise<void> => {
    if (disposed) return;
    if (inflight) {
      again = true;
      return;
    }
    inflight = true;
    if (retry) {
      clearTimeout(retry);
      retry = null;
    }
    try {
      const res = await doFetch(LAYERS_URL, { cache: 'no-store', signal: abort.signal });
      if (!res.ok) throw new Error(`GET ${LAYERS_URL} → HTTP ${res.status}`);
      const body = parseLayersResponse(await res.json());
      if (!disposed) {
        opts.onLayers(body.layers);
        opts.onError(null);
      }
    } catch (e) {
      if (disposed) return;
      opts.onError((e as Error).message || 'layer list unavailable');
      retry = setTimeout(() => void load(), retryMs);
    } finally {
      inflight = false;
      if (again && !disposed) {
        again = false;
        void load();
      }
    }
  };

  const unsubscribe = opts.realtime.client.subscribe(
    'layers',
    (evt) => {
      if (evt.event === 'updated') void load();
    },
    { onResync: () => void load() },
  );
  const poll = setInterval(() => {
    if (!opts.realtime.connected()) void load();
  }, pollMs);
  void load();

  return () => {
    disposed = true;
    abort.abort();
    unsubscribe();
    clearInterval(poll);
    if (retry) clearTimeout(retry);
  };
}
