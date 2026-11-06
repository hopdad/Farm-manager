/**
 * POST /api/v1/jobs/<id>/assignments <- AssignJobBody (a machine or a person chip) ->
 * JobResponse | 409 | 422 (ROLE_FOR.planJobs): a card dropped on a chip. Logic:
 * ../../handler.ts.
 */
import { getPool } from '@/db/client';
import { handleAssignJob } from '../../handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handleAssignJob(request, id, getPool());
}
