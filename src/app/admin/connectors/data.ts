/**
 * Read model of /admin/connectors (server only): per connector stream its mode, lease, last OK,
 * last error, raw-event counts and counters; per registered job its schedule, lease and recent
 * runs; the dead-lettered raw events (the latest 25 and the total); and the job clock's pause
 * flag. The 1f sync-health parts (calls, budget, OAuth, orgs) are in ./health.ts.
 * Sources: ingest.sync_state, ingest.job_runs, ingest.raw_events, app.settings.
 */
import { type Executor, exec, toDate } from '../../../db/exec';
import { JOB_LEASE_SOURCE } from '../../../db/leases';
import { readClockPaused } from '../../../db/settings';
import {
  type ConnectorModes,
  demoCadenceApplies,
  type ValidJob,
  validateRegistry,
} from '../../../jobs/schedule';
import type { JobRegistry } from '../../../jobs/types';
import { deadCounts } from './dead-letters';

export interface RawCounts {
  pending: number;
  dead: number;
  processed24h: number;
  landed24h: number;
  lastFetchedAt: Date | null;
}

export interface StreamRow {
  source: string;
  stream: string;
  mode: string;
  leaseUntil: Date | null;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  lastOkAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  /** Numeric entries of sync_state.extra (call counters and the like). */
  counters: Record<string, number>;
  /** What a stream's extra says in words (1f.2: CNH's EULA list, AEMP provider errors, …). */
  notes: string[];
  raw: RawCounts;
}

export interface JobRunSummary {
  startedAt: Date;
  finishedAt: Date | null;
  ok: boolean | null;
  items: number | null;
  note: string | null;
  error: string | null;
}

export interface JobRow {
  name: string;
  /** Registered in src/jobs/registry.ts (else: only history in ingest.job_runs). */
  registered: boolean;
  schedule: string | null;
  host: string | null;
  budgetMs: number | null;
  /** The job lease ('job', name) is held: a run is in flight. */
  running: boolean;
  lastRun: JobRunSummary | null;
  lastOkAt: Date | null;
  lastFailure: { at: Date; error: string | null } | null;
  runs1h: number;
  runs24h: number;
  failed24h: number;
  items24h: number;
}

export interface DeadEvent {
  id: string;
  source: string;
  stream: string;
  externalId: string;
  attempts: number;
  lastError: string | null;
  fetchedAt: Date | null;
}

export interface ConnectorsSnapshot {
  at: Date;
  clockPaused: boolean;
  streams: StreamRow[];
  jobs: JobRow[];
  /** The 25 most recent dead-lettered events (`deadTotal` counts them all). */
  dead: DeadEvent[];
  /** Every dead-lettered event (1f: the page shows the total, not just the latest 25). */
  deadTotal: number;
  deadByStream: { source: string; stream: string; count: number }[];
  /** validateRegistry's message when the registry is invalid. */
  registryError: string | null;
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

function counters(extra: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!extra || typeof extra !== 'object') return out;
  const walk = (obj: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
      else if (v && typeof v === 'object' && !Array.isArray(v) && !prefix) {
        walk(v as Record<string, unknown>, key);
      }
    }
  };
  walk(extra as Record<string, unknown>, '');
  return out;
}

const MAX_NOTES = 6;

/**
 * The lists the part B jobs keep in sync_state.extra, in words (leniently: anything else is
 * ignored): CNH's VINs without an accepted EULA (`needsEula`), an AEMP provider's last error or
 * note (`providers`, e.g. Deere's "approve the org at …"), and Geotab's limited-scope fallback
 * (`scopeFallback` = 1).
 */
export function streamNotes(extra: unknown): string[] {
  if (!extra || typeof extra !== 'object') return [];
  const e = extra as { needsEula?: unknown; providers?: unknown; scopeFallback?: unknown };
  const out: string[] = [];
  if (Array.isArray(e.needsEula)) {
    for (const v of e.needsEula) {
      const r = v as { vin?: unknown; reason?: unknown };
      if (typeof r?.vin === 'string') {
        out.push(
          `VIN ${r.vin} skipped: ${typeof r.reason === 'string' ? r.reason : 'EULA not accepted'} (accept CNH's EULA for it in FieldOps)`,
        );
      }
    }
  }
  if (e.providers && typeof e.providers === 'object' && !Array.isArray(e.providers)) {
    for (const [id, v] of Object.entries(e.providers as Record<string, unknown>)) {
      const p = v as { error?: unknown; note?: unknown } | null;
      if (typeof p?.error === 'string' && p.error) out.push(`${id}: ${p.error}`);
      else if (typeof p?.note === 'string' && p.note) out.push(`${id}: ${p.note}`);
    }
  }
  if (e.scopeFallback === 1 || e.scopeFallback === true) {
    out.push(
      'limited-scope user: last known positions only (DeviceStatusInfo); give the service user whole-fleet scope for trails',
    );
  }
  return out.length > MAX_NOTES
    ? [...out.slice(0, MAX_NOTES), `and ${out.length - MAX_NOTES} more`]
    : out;
}

/**
 * 'every 30 s' or '<cron> UTC'; with the demo cadence on (and the job's connector sim, replay or
 * off): 'every 5 s (demo; every 30 s)'.
 */
export function describeJobSchedule(
  j: ValidJob,
  opts: { demo?: boolean; modes?: ConnectorModes } = {},
): string {
  const text = (s: ValidJob['schedule']) =>
    s.kind === 'every' ? `every ${s.seconds} s` : `${s.expr} UTC`;
  if (demoCadenceApplies(j, opts.demo === true, opts.modes) && j.demoSchedule) {
    return `${text(j.demoSchedule)} (demo; ${text(j.schedule)})`;
  }
  return text(j.schedule);
}

export async function loadConnectorsSnapshot(
  ex: Executor,
  registry: JobRegistry,
  opts: { demoCadence?: boolean; modes?: ConnectorModes } = {},
): Promise<ConnectorsSnapshot> {
  let valid: ValidJob[] = [];
  let registryError: string | null = null;
  try {
    valid = validateRegistry(registry);
  } catch (e) {
    registryError = (e as Error).message;
  }

  const [clockPaused, state, raw, runs, last, failures, dead, deadAll] = await Promise.all([
    readClockPaused(ex),
    exec<Record<string, unknown>>(
      ex,
      `select source, stream, mode, lease_until, next_run_at, last_run_at, last_ok_at,
              last_error, last_error_at, extra
         from ingest.sync_state order by source, stream`,
    ),
    exec<Record<string, unknown>>(
      ex,
      `select source, stream,
              count(*) filter (where status = 'pending') as pending,
              count(*) filter (where status = 'dead') as dead,
              count(*) filter (where status = 'processed' and processed_at > now() - interval '24 hours') as processed_24h,
              count(*) filter (where fetched_at > now() - interval '24 hours') as landed_24h,
              max(fetched_at) as last_fetched_at
         from ingest.raw_events
        where status <> 'processed' or fetched_at > now() - interval '24 hours'
           or processed_at > now() - interval '24 hours'
        group by source, stream`,
    ),
    exec<Record<string, unknown>>(
      ex,
      `select job,
              count(*) filter (where started_at > now() - interval '1 hour') as runs_1h,
              count(*) as runs_24h,
              count(*) filter (where ok is not true) as failed_24h,
              coalesce(sum(items), 0) as items_24h,
              max(finished_at) filter (where ok) as last_ok_at
         from ingest.job_runs
        where started_at > now() - interval '24 hours'
        group by job`,
    ),
    exec<Record<string, unknown>>(
      ex,
      `select distinct on (job) job, started_at, finished_at, ok, items, note, error
         from ingest.job_runs order by job, started_at desc`,
    ),
    exec<Record<string, unknown>>(
      ex,
      `select distinct on (job) job, started_at, error
         from ingest.job_runs where ok is not true order by job, started_at desc`,
    ),
    exec<Record<string, unknown>>(
      ex,
      `select id, source, stream, external_id, attempts, last_error, fetched_at
         from ingest.raw_events where status = 'dead' order by fetched_at desc limit 25`,
    ),
    deadCounts(ex),
  ]);

  const rawBy = new Map(
    raw.rows.map((r) => [
      `${r.source}|${r.stream}`,
      {
        pending: num(r.pending),
        dead: num(r.dead),
        processed24h: num(r.processed_24h),
        landed24h: num(r.landed_24h),
        lastFetchedAt: toDate(r.last_fetched_at),
      } satisfies RawCounts,
    ]),
  );
  const emptyRaw: RawCounts = {
    pending: 0,
    dead: 0,
    processed24h: 0,
    landed24h: 0,
    lastFetchedAt: null,
  };
  const now = Date.now();
  const jobLeases = new Map<string, boolean>();
  const streams: StreamRow[] = [];
  const seenStreams = new Set<string>();
  for (const r of state.rows) {
    const leaseUntil = toDate(r.lease_until);
    if (r.source === JOB_LEASE_SOURCE) {
      jobLeases.set(String(r.stream), !!leaseUntil && leaseUntil.getTime() > now);
      continue;
    }
    const key = `${r.source}|${r.stream}`;
    seenStreams.add(key);
    streams.push({
      source: String(r.source),
      stream: String(r.stream),
      mode: String(r.mode),
      leaseUntil,
      nextRunAt: toDate(r.next_run_at),
      lastRunAt: toDate(r.last_run_at),
      lastOkAt: toDate(r.last_ok_at),
      lastError: (r.last_error as string | null) ?? null,
      lastErrorAt: toDate(r.last_error_at),
      counters: counters(r.extra),
      notes: streamNotes(r.extra),
      raw: rawBy.get(key) ?? emptyRaw,
    });
  }
  // Raw events for a stream that has no sync_state row (e.g. a webhook inbox).
  for (const [key, counts] of rawBy) {
    if (seenStreams.has(key)) continue;
    const [source = '', stream = ''] = key.split('|');
    streams.push({
      source,
      stream,
      mode: '-',
      leaseUntil: null,
      nextRunAt: null,
      lastRunAt: null,
      lastOkAt: null,
      lastError: null,
      lastErrorAt: null,
      counters: {},
      notes: [],
      raw: counts,
    });
  }

  const runsBy = new Map(runs.rows.map((r) => [String(r.job), r]));
  const lastBy = new Map(last.rows.map((r) => [String(r.job), r]));
  const failBy = new Map(failures.rows.map((r) => [String(r.job), r]));
  const names = [
    ...new Set([...valid.map((j) => j.name), ...lastBy.keys(), ...jobLeases.keys()]),
  ].sort();
  const validBy = new Map(valid.map((j) => [j.name, j]));
  const jobs: JobRow[] = names.map((name) => {
    const v = validBy.get(name);
    const s = runsBy.get(name);
    const l = lastBy.get(name);
    const f = failBy.get(name);
    return {
      name,
      registered: !!v,
      schedule: v ? describeJobSchedule(v, { demo: opts.demoCadence, modes: opts.modes }) : null,
      host: v?.host ?? null,
      budgetMs: v?.budgetMs ?? null,
      running: jobLeases.get(name) ?? false,
      lastRun: l
        ? {
            startedAt: toDate(l.started_at) as Date,
            finishedAt: toDate(l.finished_at),
            ok: (l.ok as boolean | null) ?? null,
            items: l.items === null || l.items === undefined ? null : num(l.items),
            note: (l.note as string | null) ?? null,
            error: (l.error as string | null) ?? null,
          }
        : null,
      lastOkAt: s ? toDate(s.last_ok_at) : null,
      lastFailure: f
        ? { at: toDate(f.started_at) as Date, error: (f.error as string | null) ?? null }
        : null,
      runs1h: num(s?.runs_1h),
      runs24h: num(s?.runs_24h),
      failed24h: num(s?.failed_24h),
      items24h: num(s?.items_24h),
    };
  });

  return {
    at: new Date(),
    clockPaused,
    streams,
    jobs,
    dead: dead.rows.map((r) => ({
      id: String(r.id),
      source: String(r.source),
      stream: String(r.stream),
      externalId: String(r.external_id),
      attempts: num(r.attempts),
      lastError: (r.last_error as string | null) ?? null,
      fetchedAt: toDate(r.fetched_at),
    })),
    deadTotal: deadAll.total,
    deadByStream: deadAll.byStream,
    registryError,
  };
}
