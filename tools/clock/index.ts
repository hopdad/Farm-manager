/**
 * pnpm clock: the local job clock on its own (`pnpm dev` starts it too, once /api/health answers).
 *
 *   pnpm clock                         fire every registered job on its UTC schedule
 *   pnpm clock --hosts=pc              only jobs with host 'pc' (default CLOCK_HOSTS = app,pc)
 *   pnpm clock --url=http://127.0.0.1:3000   app base URL (default PUBLIC_URL, localhost -> 127.0.0.1)
 *   pnpm clock --once                  fire every job once, print the results, exit
 *   pnpm clock --list                  print the schedule and exit
 *
 * Reads src/jobs/registry.ts through validateRegistry (src/jobs/schedule.ts); with
 * JOBS_DEMO_CADENCE=on, jobs that declare `demoEvery` fire at that faster cadence. Honors
 * app.settings 'clock.paused' (toggle it on /admin/connectors), re-read before each fire.
 * With CLOCK=pgcron the database's pg_cron drives the jobs and this process stays idle.
 * `--parent=<pid>` (used by tools/dev.ts) exits when that process is gone, so a crashed
 * launcher never leaves a clock behind.
 */
import pg from 'pg';
import { getConfig } from '../../src/config';
import { readClockPaused } from '../../src/db/settings';
import { clockSchedule, type ValidJob, validateRegistry } from '../../src/jobs/schedule';
import type { JobHost, JobRegistry } from '../../src/jobs/types';
import { isMainModule } from '../../src/lib/proc';
import { type ClockLog, describeSchedule, JobClock } from './clock';

export interface ClockArgs {
  url?: string;
  hosts?: JobHost[];
  once: boolean;
  list: boolean;
  parent?: number;
  help: boolean;
}

export class ClockUsageError extends Error {}

const USAGE =
  'usage: pnpm clock [--url=http://127.0.0.1:3000] [--hosts=app,pc] [--once] [--list] [--parent=<pid>]';

export function parseClockArgs(argv: string[]): ClockArgs {
  const out: ClockArgs = { once: false, list: false, help: false };
  for (const arg of argv) {
    const [flag, value] = arg.includes('=')
      ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
      : [arg, undefined];
    switch (flag) {
      case '--url':
        if (!value || !URL.canParse(value))
          throw new ClockUsageError(`--url needs a URL\n${USAGE}`);
        out.url = value;
        break;
      case '--hosts': {
        const hosts = (value ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (!hosts.length || hosts.some((h) => h !== 'app' && h !== 'pc')) {
          throw new ClockUsageError(`--hosts takes app, pc or app,pc\n${USAGE}`);
        }
        out.hosts = hosts as JobHost[];
        break;
      }
      case '--once':
        out.once = true;
        break;
      case '--list':
        out.list = true;
        break;
      case '--parent': {
        const pid = Number(value);
        if (!Number.isInteger(pid) || pid <= 0)
          throw new ClockUsageError(`--parent needs a pid\n${USAGE}`);
        out.parent = pid;
        break;
      }
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        throw new ClockUsageError(`unknown argument '${arg}'\n${USAGE}`);
    }
  }
  return out;
}

/** The app's base URL from PUBLIC_URL; `localhost` becomes 127.0.0.1 (Next on 0.0.0.0 is IPv4). */
export function clockBaseUrl(publicUrl: string): string {
  const u = new URL(publicUrl);
  if (u.hostname === 'localhost') u.hostname = '127.0.0.1';
  return u.origin;
}

/**
 * Validate the registry (throws one error listing every problem) and keep the given hosts.
 * With `demo` (JOBS_DEMO_CADENCE=on) a job's `demoEvery` replaces its schedule.
 */
export function selectJobs(
  reg: JobRegistry,
  hosts: readonly JobHost[],
  opts: { demo?: boolean } = {},
): ValidJob[] {
  return validateRegistry(reg)
    .filter((j) => hosts.includes(j.host))
    .map((j) => ({ ...j, schedule: clockSchedule(j, opts.demo === true) }));
}

/** Console logger; under the launcher (`--parent`) it adds no prefix (the launcher does). */
export function makeLog(level: string, prefixed = true): ClockLog {
  const debug = level === 'debug';
  const p = prefixed ? '[clock] ' : '';
  return {
    debug: (m) => {
      if (debug) console.log(`${p}${m}`);
    },
    info: (m) => console.log(`${p}${m}`),
    warn: (m) => console.warn(`${p}${m}`),
    error: (m) => console.error(`${p}${m}`),
  };
}

function printSchedule(clock: JobClock, log: ClockLog): void {
  for (const { job, next } of clock.nextRuns()) {
    log.info(
      `  ${job.name.padEnd(18)} ${describeSchedule(job).padEnd(28)} host ${job.host}  next ${next?.toISOString() ?? 'never'}`,
    );
  }
}

function parentAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function main(argv: string[]): Promise<number> {
  const args = parseClockArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const cfg = getConfig();
  const log = makeLog(cfg.LOG_LEVEL, args.parent === undefined);
  // Imported here so a broken job module fails with a clear message instead of at load.
  const { registry } = await import('../../src/jobs/registry');
  const hosts = args.hosts ?? cfg.CLOCK_HOSTS;
  const demo = cfg.JOBS_DEMO_CADENCE;
  const jobs = selectJobs(registry, hosts, { demo });
  const baseUrl = args.url ? new URL(args.url).origin : clockBaseUrl(cfg.PUBLIC_URL);

  const pool = new pg.Pool({
    connectionString: cfg.DATABASE_URL,
    max: 1,
    application_name: 'farm-clock',
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  pool.on('error', (e) => log.warn(`database connection error: ${e.message}`));
  const clock = new JobClock({
    jobs,
    baseUrl,
    secret: cfg.JOBS_SECRET,
    isPaused: () => readClockPaused(pool),
    log,
  });

  if (args.list) {
    log.info(`${jobs.length} job(s) for hosts ${hosts.join(',')}:`);
    printSchedule(clock, log);
    await pool.end();
    return 0;
  }
  if (args.once) {
    let failed = 0;
    for (const job of jobs) {
      const o = await clock.fire(job);
      if (o.kind === 'http-error' || o.kind === 'unreachable') failed++;
      log.info(`${job.name}: ${JSON.stringify(o)}`);
    }
    await pool.end();
    return failed ? 1 : 0;
  }

  let stopping = false;
  const stop = async (why: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`stopping (${why})`);
    clock.stop();
    await pool.end().catch(() => {});
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
    process.on(sig, () => void stop(sig));
  }
  if (args.parent) {
    const parent = args.parent;
    setInterval(() => {
      if (!parentAlive(parent)) void stop(`launcher ${parent} is gone`);
    }, 2_000).unref();
  }

  if (cfg.CLOCK === 'pgcron') {
    log.info('CLOCK=pgcron: pg_cron in the database fires the jobs; this clock stays idle.');
    setInterval(() => {}, 60_000);
    return 0;
  }
  if (!jobs.length) {
    log.info(
      `no jobs for hosts ${hosts.join(',')} in src/jobs/registry.ts yet; idling (restart after adding jobs)`,
    );
    setInterval(() => {}, 60_000);
    return 0;
  }
  log.info(
    `firing ${jobs.length} job(s) at ${baseUrl}/api/jobs/<name> (UTC schedules${demo ? '; JOBS_DEMO_CADENCE=on: demo cadence' : ''}):`,
  );
  printSchedule(clock, log);
  clock.start();
  return 0;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code !== 0) process.exitCode = code;
    },
    (e: Error) => {
      console.error(`[clock] ${e instanceof ClockUsageError ? '' : 'error: '}${e.message}`);
      process.exitCode = e instanceof ClockUsageError ? 2 : 1;
    },
  );
}
