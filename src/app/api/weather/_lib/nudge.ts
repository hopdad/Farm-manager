/**
 * Run weather.nws now (after the spray thresholds or the simulated weather changed), the same
 * way the clock does: through POST /api/jobs/weather.nws's handler, in-process (job lease, 202,
 * the work in `after()`, one ingest.job_runs row). A run already in flight answers 'busy': the
 * next scheduled run (30 s in the demo cadence, 30 min live) picks the change up.
 * Server only (server actions and route handlers).
 */
import { after } from 'next/server';
import { createJobLogger } from '@/app/api/jobs/_lib/logger';
import { handleJobPost } from '@/app/api/jobs/_lib/run-job';
import { getConfig } from '@/config';
import { getJobsDb, getJobsPool, getPool } from '@/db/client';
import { registry } from '@/jobs/registry';

export const WEATHER_JOB = 'weather.nws';

export type NudgeOutcome = 'accepted' | 'busy' | 'paused' | 'failed';

export async function nudgeWeatherJob(): Promise<NudgeOutcome> {
  const cfg = getConfig();
  try {
    const res = await handleJobPost(
      new Request(`${cfg.PUBLIC_URL}/api/jobs/${WEATHER_JOB}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.JOBS_SECRET}` },
      }),
      WEATHER_JOB,
      {
        registry,
        secret: cfg.JOBS_SECRET,
        pool: getPool(),
        jobsPool: getJobsPool(),
        jobsDb: getJobsDb(),
        schedule: (task) => after(task),
        logger: (job) => createJobLogger(job, cfg.LOG_LEVEL),
      },
    );
    const body = (await res.json()) as { accepted?: boolean; skipped?: 'busy' | 'paused' };
    return body.accepted ? 'accepted' : (body.skipped ?? 'failed');
  } catch (e) {
    console.error('[weather] could not start weather.nws:', (e as Error).message);
    return 'failed';
  }
}

/** One line for the admin notice. */
export function nudgeText(o: NudgeOutcome): string {
  switch (o) {
    case 'accepted':
      return 'the weather job is re-assessing now';
    case 'busy':
      return 'the weather job is running; its next run picks this up';
    case 'paused':
      return 'the job clock is paused: verdicts update when it runs again';
    default:
      return 'the weather job could not start: verdicts update at its next run';
  }
}
