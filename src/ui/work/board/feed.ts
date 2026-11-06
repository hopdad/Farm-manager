/**
 * Keeps the job board's data fresh (framework-free; ./feed.test.ts drives it with fakes), the
 * pattern of src/ui/fields/detail-loader.ts (docs/contracts-2a.md §7.1 "Data"):
 *
 *  - the snapshot (GET /api/v1/jobs) and the crew (GET /api/v1/crew), loaded at once;
 *  - subscribed to the `jobs` realtime topic: `updated` (ids only) and `invalidate` refetch the
 *    snapshot; `onResync` (every (re)connect, a `seq` gap, an invalidate) refetches the snapshot
 *    and the crew, so a drag on one screen reaches the others within the 2 s target;
 *  - polls every `pollMs` (15 s) while realtime can't deliver (SSE reconnecting, no adapter);
 *  - never runs two requests of a kind at once: a trigger during a request queues exactly one
 *    more, so the last answer always reflects the last change; a stopped feed drops answers;
 *  - reports a new state only when something changed (an identical refetch renders nothing).
 */
import type { RealtimeClient } from '../../../platform/realtime/types';
import type { BoardSnapshot, CrewPerson } from '../contract';
import type { BoardApi, ReadResult } from './api';

export type FeedStatus = 'loading' | 'ready' | 'denied' | 'unavailable' | 'error';

export interface FeedState {
  status: FeedStatus;
  /** The latest snapshot (kept while a refetch runs or after a failed one). */
  snapshot: BoardSnapshot | null;
  /** Crew people for the chips (null until loaded; kept after a failed refetch). */
  crew: CrewPerson[] | null;
  /** Why the last snapshot request failed ("couldn't refresh" while `snapshot` stays). */
  error: string | null;
  crewError: string | null;
}

export const INITIAL_FEED_STATE: FeedState = {
  status: 'loading',
  snapshot: null,
  crew: null,
  error: null,
  crewError: null,
};

export interface FeedRealtime {
  client: RealtimeClient;
  /** Can live events arrive right now? False: poll. */
  connected(): boolean;
}

export interface FeedTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface BoardFeedOptions {
  api: Pick<BoardApi, 'snapshot' | 'crew'>;
  realtime: FeedRealtime | null;
  onState(state: FeedState): void;
  /** Poll interval while realtime is down (default 15 s). */
  pollMs?: number;
  timers?: FeedTimers;
}

export interface BoardFeed {
  /** Load the snapshot now (or once more after the request in flight). */
  refetch(): void;
  stop(): void;
}

export const BOARD_POLL_MS = 15_000;

const defaultTimers: FeedTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

/** One coalescing loader: never two requests at once, one more queued while one runs. */
function coalesced<T>(
  run: (signal: AbortSignal) => Promise<ReadResult<T>>,
  onResult: (r: ReadResult<T>) => void,
  isStopped: () => boolean,
): { load(): void; abort(): void } {
  let inflight: AbortController | null = null;
  let again = false;
  async function load(): Promise<void> {
    if (isStopped()) return;
    if (inflight) {
      again = true;
      return;
    }
    const ctrl = new AbortController();
    inflight = ctrl;
    try {
      const r = await run(ctrl.signal);
      if (!isStopped() && !ctrl.signal.aborted) onResult(r);
    } catch {
      // Aborted (stop) or a bug in a parser: the next trigger tries again.
    } finally {
      if (inflight === ctrl) inflight = null;
      if (!isStopped() && again) {
        again = false;
        void load();
      }
    }
  }
  return {
    load: () => void load(),
    abort: () => inflight?.abort(),
  };
}

export function startBoardFeed(opts: BoardFeedOptions): BoardFeed {
  const timers = opts.timers ?? defaultTimers;
  let state: FeedState = INITIAL_FEED_STATE;
  let stopped = false;
  let lastSnapshotText: string | null = null;
  let lastCrewText: string | null = null;

  const emit = (patch: Partial<FeedState>) => {
    const keys = Object.keys(patch) as (keyof FeedState)[];
    if (keys.every((k) => state[k] === patch[k])) return;
    state = { ...state, ...patch };
    if (!stopped) opts.onState(state);
  };

  const jobs = coalesced(
    (signal) => opts.api.snapshot(signal),
    (r) => {
      if (r.ok) {
        // An identical answer (the resync right after subscribing) keeps the same objects.
        const text = JSON.stringify(r.value);
        if (text === lastSnapshotText && state.status === 'ready') {
          emit({ error: null });
          return;
        }
        lastSnapshotText = text;
        emit({ status: 'ready', snapshot: r.value, error: null });
        return;
      }
      if (r.kind === 'denied') {
        lastSnapshotText = null;
        emit({ status: 'denied', snapshot: null, error: null });
        return;
      }
      emit({
        status: state.snapshot ? 'ready' : r.kind === 'unavailable' ? 'unavailable' : 'error',
        error: r.message,
      });
    },
    () => stopped,
  );

  const crew = coalesced(
    (signal) => opts.api.crew(signal),
    (r) => {
      if (r.ok) {
        const text = JSON.stringify(r.value);
        if (text === lastCrewText) {
          emit({ crewError: null });
          return;
        }
        lastCrewText = text;
        emit({ crew: r.value, crewError: null });
        return;
      }
      emit({ crewError: r.message });
    },
    () => stopped,
  );

  const unsubscribe = opts.realtime?.client.subscribe(
    'jobs',
    (evt) => {
      // `updated` names the jobs; the snapshot is one small request, so refetch it whole.
      if (evt.event === 'updated' || evt.event === 'invalidate') jobs.load();
    },
    {
      onResync: () => {
        jobs.load();
        crew.load();
      },
    },
  );
  const poll = timers.setInterval(() => {
    if (opts.realtime?.connected()) return;
    jobs.load();
    crew.load();
  }, opts.pollMs ?? BOARD_POLL_MS);

  opts.onState(state);
  jobs.load();
  crew.load();

  return {
    refetch: () => jobs.load(),
    stop() {
      if (stopped) return;
      stopped = true;
      jobs.abort();
      crew.abort();
      unsubscribe?.();
      timers.clearInterval(poll);
    },
  };
}
