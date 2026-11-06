/**
 * POST /api/v1/jobs/reorder <- ReorderJobsBody (every open job of a lane, in its new order) ->
 * BoardSnapshot | 409 | 422 not_in_lane (ROLE_FOR.planJobs). Logic: ../handler.ts.
 */
import { getPool } from '@/db/client';
import { handleReorderJobs } from '../handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleReorderJobs(request, getPool());
}
