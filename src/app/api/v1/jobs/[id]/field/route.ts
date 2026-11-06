/**
 * PUT /api/v1/jobs/<id>/field <- SetJobFieldBody (a field id, or the drop point) ->
 * JobResponse | 409 | 422 not on a field (ROLE_FOR.planJobs): a card dropped on the map.
 * Logic: ../../handler.ts.
 */
import { getPool } from '@/db/client';
import { handleSetJobField } from '../../handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handleSetJobField(request, id, getPool());
}
