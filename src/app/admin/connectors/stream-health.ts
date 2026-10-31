/**
 * The state badge of one connector stream on /admin/connectors (pure; ./stream-health.test.ts).
 * 1f review: "stale" is judged against the stream's own schedule, not a flat 10 minutes, so the
 * hourly vehicle lists and Terminal's provider catalog (paced with minIntervalSeconds, so their
 * sync_state.next_run_at says when they are due) and the slower jobs (fleet.aemp every 15 min,
 * deere.fields hourly) read "ok" while they are on schedule, and "stale" only once overdue.
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

/** Per source, the slowest cadence (s) of the jobs that sync it (registry schedules). */
export function sourceCadences(registry: JobRegistry, now: Date): Record<string, number> {
  const out: Record<string, number> = {};
  for (const def of Object.values(registry)) {
    if (!def?.connector) continue;
    const secs = scheduleSeconds(def, now);
    if (!secs) continue;
    const source = sourceOfConnector(def.connector);
    out[source] = Math.max(out[source] ?? 0, secs);
  }
  return out;
}

/**
 * ok / failing / not run yet / stale for one stream. A stream with a future-looking
 * `next_run_at` (paced: minIntervalSeconds, Retry-After) is stale only once that time has passed
 * by more than a margin; any other is stale once its last OK run is older than twice its
 * source's slowest job cadence (never under STREAM_STALE_MIN_SECONDS).
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
