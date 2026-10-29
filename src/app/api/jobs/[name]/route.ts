/**
 * POST /api/jobs/<name>: scheduled work, fired by tools/clock locally and by Supabase Cron
 * (pg_cron + pg_net) in production. Secret, job lease, 202, then the work in after() within the
 * job's budget (src/app/api/jobs/_lib/run-job.ts; docs/contracts.md §5).
 * Never behind proxy.ts and never a redirect (pg_net doesn't follow them).
 */
import { after } from 'next/server';
import { getConfig } from '@/config';
import { getJobsDb, getJobsPool, getPool } from '@/db/client';
import { registry } from '@/jobs/registry';
import { createJobLogger } from '../_lib/logger';
import { handleJobPost } from '../_lib/run-job';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** MAX_JOB_BUDGET_MS (55 s) plus the release and job_runs insert; Vercel's limit for after(). */
export const maxDuration = 60;

export async function POST(
  req: Request,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  const { name } = await ctx.params;
  const cfg = getConfig();
  return handleJobPost(req, name, {
    registry,
    secret: cfg.JOBS_SECRET,
    pool: getPool(),
    jobsPool: getJobsPool(),
    jobsDb: getJobsDb(),
    schedule: (task) => after(task),
    logger: (job) => createJobLogger(job, cfg.LOG_LEVEL),
  });
}
