/**
 * Keeps one field's FieldDetail fresh for the open panel (framework-free; ./useFieldDetail.ts
 * wraps it for React, ./detail-loader.test.ts drives it with fakes):
 *
 *  - loads GET /api/fields/<id> at once (one request: the tap-to-panel budget is 200 ms), and
 *    shows a cached copy first when this tab opened the field before (then revalidates);
 *  - refetches on realtime `fields`/`updated` for this field, and in `onResync` (every
 *    (re)connect, `seq` gap, `invalidate`), so a notes edit on one screen reaches the others
 *    within the 2 s target;
 *  - polls every `pollMs` while realtime can't deliver (SSE reconnecting, no adapter yet);
 *  - never runs two requests at once: a trigger during a request queues exactly one more, so the
 *    last answer always reflects the last change; stale answers of a stopped loader are dropped;
 *  - reports a new state only when something changed (an identical refetch renders nothing).
 */
import type { FieldDetail } from '../../domain/fields';
import { isRole, type Role } from '../../platform/auth/types';
import type { RealtimeClient } from '../../platform/realtime/types';
import { FIELD_ROLE_HEADER, fieldDetailUrl } from './protocol';

export type FieldDetailStatus = 'loading' | 'ready' | 'not_found' | 'denied' | 'error';

export interface FieldDetailState {
  fieldId: string;
  status: FieldDetailStatus;
  /** The latest detail (kept while a refetch runs or after a failed one). */
  detail: FieldDetail | null;
  /** The session's role as the server reported it (UI hints only). */
  role: Role;
  /** Why the last request failed (shown as a "couldn't refresh" note while `detail` stays). */
  error: string | null;
}

export interface ResolvedRealtimeLike {
  client: RealtimeClient;
  /** Can live events arrive right now? False: poll. */
  connected(): boolean;
}

export interface IntervalTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface FieldDetailLoaderOptions {
  fieldId: string;
  fetch: typeof fetch;
  realtime: ResolvedRealtimeLike | null;
  onState(state: FieldDetailState): void;
  /** Poll interval while realtime is down (default 15 s). */
  pollMs?: number;
  timers?: IntervalTimers;
  cache?: FieldDetailCache;
}

export interface FieldDetailLoader {
  /** Load now (or once more after the request in flight). */
  refetch(): void;
  stop(): void;
}

export const DEFAULT_POLL_MS = 15_000;

/** A small LRU of the details this tab has seen (instant re-open; always revalidated). */
export class FieldDetailCache {
  private readonly entries = new Map<string, { detail: FieldDetail; role: Role }>();
  constructor(private readonly max = 24) {}
  get(fieldId: string) {
    const hit = this.entries.get(fieldId);
    if (hit) {
      this.entries.delete(fieldId);
      this.entries.set(fieldId, hit);
    }
    return hit;
  }
  set(fieldId: string, value: { detail: FieldDetail; role: Role }): void {
    this.entries.delete(fieldId);
    this.entries.set(fieldId, value);
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
  delete(fieldId: string): void {
    this.entries.delete(fieldId);
  }
  get size(): number {
    return this.entries.size;
  }
}

/** One cache per tab. */
export const sharedDetailCache = new FieldDetailCache();

export function initialDetailState(
  fieldId: string,
  cache: FieldDetailCache = sharedDetailCache,
): FieldDetailState {
  const hit = cache.get(fieldId);
  return {
    fieldId,
    status: hit ? 'ready' : 'loading',
    detail: hit?.detail ?? null,
    role: hit?.role ?? 'viewer',
    error: null,
  };
}

const defaultTimers: IntervalTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

function looksLikeDetail(v: unknown, fieldId: string): v is FieldDetail {
  const d = v as Partial<FieldDetail> | null;
  return (
    typeof d === 'object' &&
    d !== null &&
    d.field?.id?.toLowerCase() === fieldId.toLowerCase() &&
    Array.isArray(d.seasons) &&
    typeof d.notes?.version === 'string'
  );
}

class UnexpectedResponse extends Error {
  constructor() {
    super('unexpected response');
  }
}

function parseDetail(text: string, fieldId: string): FieldDetail {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new UnexpectedResponse();
  }
  if (!looksLikeDetail(body, fieldId)) throw new UnexpectedResponse();
  return body;
}

/** A User Timing mark (the e2e suite and the browser's performance panel read them). */
export function markTiming(name: string, fieldId: string): void {
  try {
    performance.mark(name, { detail: { fieldId } });
  } catch {
    // No User Timing L3 (old browsers): nothing to measure with.
  }
}

export function startFieldDetail(opts: FieldDetailLoaderOptions): FieldDetailLoader {
  const { fieldId } = opts;
  const cache = opts.cache ?? sharedDetailCache;
  const timers = opts.timers ?? defaultTimers;
  let state = initialDetailState(fieldId, cache);
  let inflight: AbortController | null = null;
  let again = false;
  let stopped = false;
  let lastText: string | null = null;

  const emit = (patch: Partial<FieldDetailState>) => {
    const keys = Object.keys(patch) as (keyof FieldDetailState)[];
    if (keys.every((k) => state[k] === patch[k])) return;
    state = { ...state, ...patch };
    if (!stopped) opts.onState(state);
  };

  async function load(): Promise<void> {
    if (stopped) return;
    if (inflight) {
      again = true;
      return;
    }
    const ctrl = new AbortController();
    inflight = ctrl;
    try {
      const res = await opts.fetch(fieldDetailUrl(fieldId), {
        signal: ctrl.signal,
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      });
      if (stopped) return;
      if (res.ok) {
        const text = await res.text();
        if (stopped) return;
        const header = res.headers.get(FIELD_ROLE_HEADER);
        const role: Role = isRole(header) ? header : 'viewer';
        // A refetch that changed nothing (the resync right after subscribing, an update to a
        // part this field doesn't show) keeps the same objects: no re-render.
        if (text === lastText && role === state.role && state.status === 'ready') {
          emit({ error: null });
        } else {
          const body = parseDetail(text, fieldId);
          lastText = text;
          cache.set(fieldId, { detail: body, role });
          markTiming('field-panel:data', fieldId);
          emit({ status: 'ready', detail: body, role, error: null });
        }
      } else if (res.status === 404) {
        cache.delete(fieldId);
        emit({ status: 'not_found', detail: null, error: null });
      } else if (res.status === 401 || res.status === 403) {
        cache.delete(fieldId);
        emit({ status: 'denied', detail: null, error: null });
      } else {
        emit({
          status: state.detail ? 'ready' : 'error',
          error: `the server answered ${res.status}`,
        });
      }
    } catch (e) {
      if (stopped || ctrl.signal.aborted) return;
      emit({
        status: state.detail ? 'ready' : 'error',
        error:
          e instanceof Error && e.message === 'unexpected response' ? e.message : 'no connection',
      });
    } finally {
      if (inflight === ctrl) inflight = null;
      if (!stopped) {
        if (again) {
          again = false;
          void load();
        }
      }
    }
  }

  const unsubscribe = opts.realtime?.client.subscribe(
    'fields',
    (evt) => {
      if (evt.event === 'updated' && evt.payload.fieldId === fieldId) void load();
    },
    { onResync: () => void load() },
  );
  const poll = timers.setInterval(() => {
    if (!opts.realtime?.connected()) void load();
  }, opts.pollMs ?? DEFAULT_POLL_MS);

  opts.onState(state);
  void load();

  return {
    refetch: () => void load(),
    stop() {
      if (stopped) return;
      stopped = true;
      inflight?.abort();
      unsubscribe?.();
      timers.clearInterval(poll);
    },
  };
}
