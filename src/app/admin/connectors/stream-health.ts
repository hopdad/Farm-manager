/**
 * The state badge of one connector stream on /admin/connectors (pure; ./stream-health.test.ts).
 * 1f review: "stale" is judged against the stream's own schedule, not a flat 10 minutes, so the
 * hourly vehicle lists and Terminal's provider catalog (paced with minIntervalSeconds, so their
 * sync_state.next_run_at says when they are due) and the slower jobs (fleet.aemp every 15 min,
 * deere.fields hourly) read "ok" while they are on schedule, and "stale" only once overdue.
 * Round 2: the schedule is that of the job that RUNS the stream (the registry's `streams`), not
 * the slowest job of its source, so samsara/positions (fleet.trucks, 30 s) and deere/locations
 * (fleet.deere, 2 min) still read stale 10 minutes after they stop.
 */
import type { JobRegistry } from '@/jobs/types';
import { scheduleSeconds } from './health';

/** Never call a stream stale sooner than this after its last OK run. */
export const STREAM_STALE_MIN_SECONDS = 600;

export interface StreamTimes {
  mode: string;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  lastOkAt: Date | null;
  lastErrorAt: Date | null;
}

export type HealthKind = 'ok' | 'bad' | 'warn' | 'idle';

/** The connector source a job's mode key serves ('CONNECTOR_SAMSARA' → 'samsara'). */
export function sourceOfConnector(key: string): string {
  const s = key.replace(/^CONNECTOR_/, '').toLowerCase();
  return s === 'weather' ? 'nws' : s;
}

/**
 * The cadence (s) a stream is judged against: the schedule of the job whose registry `streams`
 * name it (the fastest, should two), else the FASTEST job of its source (a stream no job
 * declares warns sooner rather than hiding a stop for an hour); null with no job at all.
 */
export function streamCadences(
  registry: JobRegistry,
  now: Date,
): (source: string, stream: string) => number | null {
  const byStream = new Map<string, number>();
  const bySource = new Map<string, number>();
  const keep = (m: Map<string, number>, k: string, secs: number) =>
    m.set(k, Math.min(m.get(k) ?? secs, secs));
  for (const def of Object.values(registry)) {
    if (!def?.connector) continue;
    const secs = scheduleSeconds(def, now);
    if (!secs) continue;
    const source = sourceOfConnector(def.connector);
    keep(bySource, source, secs);
    for (const stream of def.streams ?? []) keep(byStream, `${source}/${stream}`, secs);
  }
  return (source, stream) => byStream.get(`${source}/${stream}`) ?? bySource.get(source) ?? null;
}

/**
 * ok / failing / not run yet / stale for one stream. A stream with a future-looking
 * `next_run_at` (paced: minIntervalSeconds, Retry-After) is stale only once that time has passed
 * by more than a margin; any other is stale once its last OK run is older than twice the cadence
 * of the job that runs it (`streamCadences`; never under STREAM_STALE_MIN_SECONDS).
 */
export function streamHealth(
  s: StreamTimes,
  now: Date,
  cadenceSeconds: number | null = null,
): { kind: HealthKind; text: string } {
  if (s.mode === 'off') return { kind: 'idle', text: 'off' };
  const okAt = s.lastOkAt?.getTime() ?? 0;
  const errAt = s.lastErrorAt?.getTime() ?? 0;
  if (errAt > okAt) return { kind: 'bad', text: 'failing' };
  if (!okAt) return { kind: 'idle', text: 'not run yet' };
  const margin = Math.max(STREAM_STALE_MIN_SECONDS, cadenceSeconds ?? 0) * 1000;
  const next = s.nextRunAt?.getTime() ?? 0;
  const ran = Math.max(okAt, s.lastRunAt?.getTime() ?? 0);
  if (next > ran) {
    return now.getTime() > next + margin
      ? { kind: 'warn', text: 'stale' }
      : { kind: 'ok', text: 'ok' };
  }
  const limit = Math.max(STREAM_STALE_MIN_SECONDS * 1000, 2 * (cadenceSeconds ?? 0) * 1000);
  return now.getTime() - okAt > limit
    ? { kind: 'warn', text: 'stale' }
    : { kind: 'ok', text: 'ok' };
}
