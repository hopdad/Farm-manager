/**
 * GET /api/v1/jobs/<id> -> JobResponse (viewer); PATCH <- UpdateJobBody -> JobResponse | 409
 * JobConflictResponse (ROLE_FOR.planJobs). Contract: src/ui/work/contract.ts. Logic:
 * ../handler.ts.
 */
import { getPool } from '@/db/client';
import { handleGetJob, handleUpdateJob } from '../handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handleGetJob(id, getPool());
}

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handleUpdateJob(request, id, getPool());
}
