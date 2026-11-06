/**
 * Keeps one field's jobs fresh for the field panel's Jobs tab (job-forms; docs/contracts-2a.md
 * §7.3), framework-free (./useFieldJobs.ts wraps it for React; ./loader.test.ts drives it with
 * fakes). The pattern of src/ui/fields/detail-loader.ts and operations.ts:
 *
 *  - loads GET /api/v1/jobs?fieldId=<id> (the board snapshot narrowed to this field: its open
 *    jobs and those done today) and checks it against boardSnapshotSchema;
 *  - refetches on realtime `jobs`/`updated` whose `fieldIds` names this field (a job moved off
 *    it names it too, §6), and in `onResync` (every (re)connect, a `seq` gap, `jobs`/`invalidate`);
 *  - polls every `pollMs` while realtime can't deliver;
 *  - never runs two requests at once (a trigger during a request queues exactly one more), and
 *    reports a new state only when the answer changed.
 *
 * The tab gets no config (src/ui/fields/tabs.ts), so the realtime adapter and the app's
 * environment come from response headers, as the History tab does: the jobs snapshot's own
 * headers when it carries them, else one HEAD of /api/v1/job-options (job-forms' route, which
 * always does), cached for the page.
 */
import type { RealtimeClient } from '../../../../platform/realtime/types';
import {
  type BoardSnapshot,
  boardSnapshotSchema,
  JOB_OPTIONS_URL,
  type JobView,
  jobsUrl,
} from '../../../work/contract';
import { JOB_FORMS_APP_ENV_HEADER, JOB_FORMS_REALTIME_HEADER } from '../../../work/forms/protocol';

export type FieldJobsStatus = 'loading' | 'ready' | 'denied' | 'error';

export interface FieldJobsState {
  fieldId: string;
  status: FieldJobsStatus;
  /** The field's jobs in board order (lanes, then each lane's order); null until loaded. */
  jobs: JobView[] | null;
  /** The snapshot's viewer hint (`canPlan` shows "New job here"; the server re-checks). */
  viewer: BoardSnapshot['viewer'] | null;
  /** Why the last request failed (the last list stays on screen). */
  error: string | null;
}

export interface RealtimeHeaders {
  realtime: string | null;
  appEnv: string | null;
}

/** Builds the realtime client from the response headers (null: poll only). */
export type RealtimeResolver = (headers: RealtimeHeaders) => {
  client: RealtimeClient;
  connected(): boolean;
} | null;

export interface Timers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface FieldJobsLoaderOptions {
  fieldId: string;
  fetch: typeof fetch;
  realtime: RealtimeResolver;
  onState(state: FieldJobsState): void;
  /** Poll interval while realtime can't deliver (default 15 s, the board's). */
  pollMs?: number;
  timers?: Timers;
  /** The realtime headers when the snapshot has none (default: HEAD /api/v1/job-options). */
  probe?: () => Promise<RealtimeHeaders | null>;
}

export interface FieldJobsLoader {
  refetch(): void;
  stop(): void;
}

export const DEFAULT_POLL_MS = 15_000;

const browserTimers: Timers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

const headersOf = (res: Response): RealtimeHeaders | null => {
  const realtime = res.headers.get(JOB_FORMS_REALTIME_HEADER);
  return realtime ? { realtime, appEnv: res.headers.get(JOB_FORMS_APP_ENV_HEADER) } : null;
};

let probed: Promise<RealtimeHeaders | null> | null = null;

/** HEAD /api/v1/job-options once per page: the realtime adapter and the app's environment. */
export function probeRealtimeHeaders(fetchFn: typeof fetch): Promise<RealtimeHeaders | null> {
  if (!probed) {
    const p = fetchFn(JOB_OPTIONS_URL, {
      method: 'HEAD',
      cache: 'no-store',
      credentials: 'same-origin',
    })
      .then((res) => (res.ok ? headersOf(res) : null))
      .catch(() => null);
    probed = p;
    // Only a good answer is kept: a failed probe is asked again by the next tab.
    void p.then((h) => {
      if (!h && probed === p) probed = null;
    });
  }
  return probed;
}

/** Tests only. */
export function resetRealtimeProbe(): void {
  probed = null;
}

/** The field's jobs from a snapshot, in board order. */
export function jobsOfField(snapshot: BoardSnapshot, fieldId: string): JobView[] {
  return snapshot.lanes.flatMap((l) => l.jobs).filter((j) => j.field?.id === fieldId);
}

export function startFieldJobs(o: FieldJobsLoaderOptions): FieldJobsLoader {
  const timers = o.timers ?? browserTimers;
  const probe = o.probe ?? (() => probeRealtimeHeaders(o.fetch));
  let state: FieldJobsState = {
    fieldId: o.fieldId,
    status: 'loading',
    jobs: null,
    viewer: null,
    error: null,
  };
  let stopped = false;
  let inflight: AbortController | null = null;
  let again = false;
  let lastText: string | null = null;
  let subscribing = false;
  let unsubscribe: (() => void) | null = null;
  let connected: () => boolean = () => false;

  const emit = (patch: Partial<FieldJobsState>) => {
    const keys = Object.keys(patch) as (keyof FieldJobsState)[];
    if (keys.every((k) => state[k] === patch[k])) return;
    state = { ...state, ...patch };
    if (!stopped) o.onState(state);
  };

  const subscribe = async (res: Response) => {
    if (subscribing) return;
    subscribing = true;
    const headers = headersOf(res) ?? (await probe());
    if (stopped || !headers) {
      if (!headers) subscribing = false;
      return;
    }
    const rt = o.realtime(headers);
    if (!rt) return;
    connected = rt.connected;
    unsubscribe = rt.client.subscribe(
      'jobs',
      (evt) => {
        if (evt.event === 'updated' && evt.payload.fieldIds.includes(o.fieldId)) void load();
      },
      { onResync: () => void load() },
    );
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
      const res = await o.fetch(jobsUrl({ fieldId: o.fieldId }), {
        signal: ctrl.signal,
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      });
      if (stopped) return;
      if (res.ok) {
        const text = await res.text();
        if (stopped) return;
        void subscribe(res);
        if (text === lastText && state.status === 'ready') {
          emit({ error: null });
        } else {
          const parsed = boardSnapshotSchema.safeParse(JSON.parse(text));
          if (!parsed.success) throw new Error('unexpected response');
          lastText = text;
          emit({
            status: 'ready',
            jobs: jobsOfField(parsed.data, o.fieldId),
            viewer: parsed.data.viewer,
            error: null,
          });
        }
      } else if (res.status === 401 || res.status === 403) {
        emit({ status: 'denied', jobs: null, viewer: null, error: null });
      } else {
        emit({
          status: state.jobs ? 'ready' : 'error',
          error: `the server answered ${res.status}`,
        });
      }
    } catch (e) {
      if (stopped || ctrl.signal.aborted) return;
      emit({
        status: state.jobs ? 'ready' : 'error',
        error:
          e instanceof SyntaxError || (e instanceof Error && e.message === 'unexpected response')
            ? 'unexpected response'
            : 'no connection',
      });
    } finally {
      if (inflight === ctrl) inflight = null;
      if (!stopped && again) {
        again = false;
        void load();
      }
    }
  }

  const poll = timers.setInterval(() => {
    if (!connected()) void load();
  }, o.pollMs ?? DEFAULT_POLL_MS);
  o.onState(state);
  void load();

  return {
    refetch: () => void load(),
    stop() {
      if (stopped) return;
      stopped = true;
      inflight?.abort();
      timers.clearInterval(poll);
      unsubscribe?.();
    },
  };
}
