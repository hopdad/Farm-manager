/**
 * The local job clock (plan §1 "Scheduled functions"): fires POST <base>/api/jobs/<name> with
 * the bearer secret on each job's UTC schedule, like Supabase Cron + pg_net will in production.
 *
 *  - Schedules come from `validateRegistry` (src/jobs/schedule.ts, the validator jobs:emit-cron
 *    uses too). croner runs with timezone 'UTC'.
 *      cron jobs:  one croner job per entry, the 5-field UTC expression as is;
 *      every jobs: one shared croner tick each second; a job fires on epoch-aligned multiples of
 *                  its interval (the same instants `nextRun()` computes and pg_cron intervals
 *                  approximate), so every clock agrees.
 *  - app.settings 'clock.paused' is re-read before each fire (cached for 500 ms so jobs due in
 *    the same second share one read); while paused nothing is posted. The route checks it too.
 *  - A job whose previous POST is still in flight is skipped for that slot (the route's job lease
 *    would answer busy anyway).
 *  - Requests time out after 5 s (pg_net's timeout_milliseconds in production) and never follow
 *    redirects (the routes must not answer 3xx).
 *  - Logs state changes per job (first success, errors, recovery), not every fire.
 */
import { Cron } from 'croner';
import type { ValidJob } from '../../src/jobs/schedule';

export type ClockLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ClockLog {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface JobClockOptions {
  /** Validated (and host-filtered) jobs. */
  jobs: ValidJob[];
  /** App base URL, e.g. http://127.0.0.1:3000 (no trailing slash needed). */
  baseUrl: string;
  /** JOBS_SECRET. */
  secret: string;
  /** app.settings 'clock.paused'. A rejection counts as "not paused" (the route decides). */
  isPaused(): Promise<boolean>;
  fetch?: typeof fetch;
  log?: ClockLog;
  requestTimeoutMs?: number;
  /** Clock source for every-job alignment (tests). */
  now?: () => number;
}

/** Outcome of one fire, for logs and tests. */
export type FireOutcome =
  | { kind: 'accepted' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'paused' }
  | { kind: 'in-flight' }
  | { kind: 'http-error'; status: number; detail: string }
  | { kind: 'unreachable'; detail: string };

const consoleLog: ClockLog = {
  debug: () => {},
  info: (m) => console.log(`[clock] ${m}`),
  warn: (m) => console.warn(`[clock] ${m}`),
  error: (m) => console.error(`[clock] ${m}`),
};

/** True when an every-N-seconds job is due at this (rounded) epoch second. */
export function everyDue(epochSeconds: number, intervalSeconds: number): boolean {
  return epochSeconds % intervalSeconds === 0;
}

/** Human form of a schedule for logs: 'every 30 s' / 'cron 17 * * * * (UTC)'. */
export function describeSchedule(job: ValidJob): string {
  return job.schedule.kind === 'every'
    ? `every ${job.schedule.seconds} s`
    : `cron ${job.schedule.expr} (UTC)`;
}

/** The URL a job is posted to. */
export function jobUrl(baseUrl: string, name: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/jobs/${encodeURIComponent(name)}`;
}

export class JobClock {
  private readonly opts: JobClockOptions;
  private readonly log: ClockLog;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private readonly crons: Cron[] = [];
  private readonly inFlight = new Set<string>();
  private readonly lastKind = new Map<string, string>();
  private pausedCache: { at: number; value: boolean } | null = null;
  private pausedLogged: boolean | null = null;
  private pauseReadFailed = false;
  private running = false;

  constructor(opts: JobClockOptions) {
    this.opts = opts;
    this.log = opts.log ?? consoleLog;
    this.doFetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const every = this.opts.jobs.filter((j) => j.schedule.kind === 'every');
    if (every.length) {
      this.crons.push(
        new Cron('* * * * * *', { timezone: 'UTC', catch: (e) => this.crashed(e) }, () => {
          const sec = Math.round(this.now() / 1000);
          for (const job of every) {
            if (job.schedule.kind === 'every' && everyDue(sec, job.schedule.seconds)) {
              void this.fire(job);
            }
          }
        }),
      );
    }
    for (const job of this.opts.jobs) {
      if (job.schedule.kind !== 'cron') continue;
      this.crons.push(
        new Cron(job.schedule.expr, { timezone: 'UTC', catch: (e) => this.crashed(e) }, () => {
          void this.fire(job);
        }),
      );
    }
  }

  stop(): void {
    this.running = false;
    for (const c of this.crons.splice(0)) c.stop();
  }

  /** Next fire time per job (for the startup table). */
  nextRuns(): { job: ValidJob; next: Date | null }[] {
    const from = new Date(this.now());
    return this.opts.jobs.map((job) => {
      if (job.schedule.kind === 'every') {
        const step = job.schedule.seconds * 1000;
        return { job, next: new Date((Math.floor(from.getTime() / step) + 1) * step) };
      }
      return {
        job,
        next: new Cron(job.schedule.expr, { timezone: 'UTC', paused: true }).nextRun(from),
      };
    });
  }

  /** Fire one job now (also used by `pnpm clock --once`). */
  async fire(job: ValidJob): Promise<FireOutcome> {
    if (this.inFlight.has(job.name)) {
      this.log.debug(`${job.name}: previous request still in flight; skipping this slot`);
      return { kind: 'in-flight' };
    }
    this.inFlight.add(job.name);
    try {
      if (await this.paused()) return { kind: 'paused' };
      const outcome = await this.post(job);
      this.report(job, outcome);
      return outcome;
    } finally {
      this.inFlight.delete(job.name);
    }
  }

  private async paused(): Promise<boolean> {
    const t = this.now();
    if (this.pausedCache && t - this.pausedCache.at < 500) return this.pausedCache.value;
    let value = false;
    try {
      value = await this.opts.isPaused();
      if (this.pauseReadFailed) this.log.info("reading 'clock.paused' works again");
      this.pauseReadFailed = false;
    } catch (e) {
      if (!this.pauseReadFailed) {
        this.log.warn(
          `could not read app.settings 'clock.paused' (${(e as Error).message}); firing anyway`,
        );
      }
      this.pauseReadFailed = true;
    }
    this.pausedCache = { at: t, value };
    if (this.pausedLogged !== value) {
      if (value) this.log.info("paused (app.settings 'clock.paused' = true): not firing jobs");
      else if (this.pausedLogged !== null) this.log.info('resumed: firing jobs again');
      this.pausedLogged = value;
    }
    return value;
  }

  private async post(job: ValidJob): Promise<FireOutcome> {
    let res: Response;
    try {
      res = await this.doFetch(jobUrl(this.opts.baseUrl, job.name), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.opts.secret}`,
          'content-type': 'application/json',
        },
        body: '{}',
        redirect: 'manual',
        signal: AbortSignal.timeout(this.opts.requestTimeoutMs ?? 5_000),
      });
    } catch (e) {
      const err = e as Error & { cause?: { code?: string; message?: string } };
      return { kind: 'unreachable', detail: err.cause?.code ?? err.cause?.message ?? err.message };
    }
    let body: Record<string, unknown> | null = null;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      body = null;
    }
    if (res.status === 202 && body && typeof body.skipped === 'string') {
      return { kind: 'skipped', reason: body.skipped };
    }
    if (res.status === 202) return { kind: 'accepted' };
    const detail =
      body && typeof body.error === 'string' ? body.error : res.statusText || 'no detail';
    return { kind: 'http-error', status: res.status, detail };
  }

  private report(job: ValidJob, o: FireOutcome): void {
    const key =
      o.kind === 'http-error'
        ? `http-${o.status}`
        : o.kind === 'skipped'
          ? `skipped-${o.reason}`
          : o.kind;
    const prev = this.lastKind.get(job.name);
    this.lastKind.set(job.name, key);
    const changed = prev !== key;
    switch (o.kind) {
      case 'accepted':
        if (changed) this.log.info(`${job.name}: ${prev ? 'firing again' : 'firing'} (202)`);
        else this.log.debug(`${job.name}: 202 accepted`);
        return;
      case 'skipped':
        // 'busy' is normal for a job slower than its interval.
        this.log.debug(`${job.name}: 202 skipped (${o.reason})`);
        return;
      case 'http-error': {
        if (!changed) return;
        const hint =
          o.status === 401
            ? ' (JOBS_SECRET differs between the clock and the app: restart both)'
            : o.status === 404
              ? ' (the app does not know this job: restart pnpm dev after registry changes)'
              : o.status >= 300 && o.status < 400
                ? ' (job routes must never redirect)'
                : '';
        this.log.warn(`${job.name}: HTTP ${o.status} ${o.detail}${hint}`);
        return;
      }
      case 'unreachable':
        if (changed)
          this.log.warn(`${job.name}: app not reachable at ${this.opts.baseUrl} (${o.detail})`);
        return;
      default:
        return;
    }
  }

  private crashed(e: unknown): void {
    this.log.error(`scheduler error: ${(e as Error)?.message ?? String(e)}`);
  }
}
