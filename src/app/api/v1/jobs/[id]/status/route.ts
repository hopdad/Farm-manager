/**
 * POST /api/v1/jobs/<id>/status <- SetJobStatusBody -> JobResponse | 409 | 403 | 422
 * (ROLE_FOR.updateOwnJobStatus; below planJobs only on your own job). Logic:
 * ../../handler.ts.
 */
import { getPool } from '@/db/client';
import { handleSetJobStatus } from '../../handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handleSetJobStatus(request, id, getPool());
}
