/**
 * DELETE /api/v1/jobs/<id>/assignments/<aid>?version=N[&part=machine|person] -> JobResponse |
 * 409 (ROLE_FOR.planJobs): the × on an assignment chip. Logic: ../../../handler.ts.
 */
import { getPool } from '@/db/client';
import { handleUnassignJob } from '../../../handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string; assignmentId: string }> },
) {
  const { id, assignmentId } = await ctx.params;
  return handleUnassignJob(request, id, assignmentId, getPool());
}
