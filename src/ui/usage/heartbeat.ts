/**
 * The board's usage heartbeat, framework-free (./UsageHeartbeat.tsx wraps it for React;
 * ./heartbeat.test.ts drives it with fakes). Decision 2a-11, docs/contracts-2a.md §7.7:
 *
 *  - while the page is visible it posts POST /api/v1/usage `{ route }` at once and then every
 *    `intervalMs` (USAGE_HEARTBEAT_MS, 4 minutes: under the 5-minute bucket, so timer drift
 *    never skips a bucket);
 *  - a hidden page (another tab, the screen off) posts nothing; coming back visible posts at
 *    once when the last beat is at least `intervalMs` old (the timer kept running meanwhile);
 *  - never two requests at once; a failed post is dropped (the next beat comes anyway);
 *  - a 401 (signed out: the page goes to /login on its next navigation) stops it.
 * The server records a beat only for a session with a person: an unattended wall answers
 * `recorded: false` and logs no board time.
 */
import { USAGE_HEARTBEAT_MS } from '../../domain/work-jobs';
import { USAGE_URL, type UsageHeartbeatBody } from '../work/contract';

export interface HeartbeatDocument {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', fn: () => void): void;
  removeEventListener(type: 'visibilitychange', fn: () => void): void;
}

export interface HeartbeatTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface UsageHeartbeatOptions {
  route: UsageHeartbeatBody['route'];
  fetch: typeof fetch;
  document: HeartbeatDocument;
  timers?: HeartbeatTimers;
  intervalMs?: number;
  /** Milliseconds clock (Date.now). */
  now?: () => number;
}

/** Start beating; returns stop(). */
export function startUsageHeartbeat(opts: UsageHeartbeatOptions): () => void {
  const intervalMs = opts.intervalMs ?? USAGE_HEARTBEAT_MS;
  const timers: HeartbeatTimers = opts.timers ?? {
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>),
  };
  const now = opts.now ?? Date.now;
  const body = JSON.stringify({ route: opts.route } satisfies UsageHeartbeatBody);
  let stopped = false;
  let inFlight = false;
  let last = Number.NEGATIVE_INFINITY;

  const visible = () => opts.document.visibilityState === 'visible';

  const beat = () => {
    if (stopped || inFlight || !visible()) return;
    inFlight = true;
    last = now();
    opts
      .fetch(USAGE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        credentials: 'same-origin',
        cache: 'no-store',
      })
      .then((res) => {
        if (res.status === 401) stop();
      })
      .catch(() => {})
      .finally(() => {
        inFlight = false;
      });
  };

  const onVisibility = () => {
    if (visible() && now() - last >= intervalMs) beat();
  };

  const handle = timers.setInterval(beat, intervalMs);
  opts.document.addEventListener('visibilitychange', onVisibility);
  beat();

  function stop() {
    if (stopped) return;
    stopped = true;
    timers.clearInterval(handle);
    opts.document.removeEventListener('visibilitychange', onVisibility);
  }
  return stop;
}
