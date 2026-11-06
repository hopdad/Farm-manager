/**
 * POST /api/v1/jobs/<id>/cancel <- CancelJobBody -> JobResponse | 409 | 422 closed
 * (ROLE_FOR.planJobs). Logic: ../../handler.ts.
 */
import { getPool } from '@/db/client';
import { handleCancelJob } from '../../handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handleCancelJob(request, id, getPool());
}
