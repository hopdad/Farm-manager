/**
 * PATCH /api/tile-lines/<id> { version, …changes } and DELETE /api/tile-lines/<id>?version=
 * (manager+). Logic and rules: ../handler.ts.
 */
import { getPool } from '@/db/client';
import { handleDeleteTileLine, handleUpdateTileLine } from '../handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  return handleUpdateTileLine(request, id, getPool());
}

export async function DELETE(request: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  return handleDeleteTileLine(request, id, getPool());
}
