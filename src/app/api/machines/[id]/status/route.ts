/**
 * POST /api/machines/<id>/status `{ status: 'down', reason }` | `{ status: 'active' }`: mark a
 * machine down or back up from a phone (ROLE_FOR.markMachineDown, checked first on the server);
 * publishes `fleet`/`machine` + `fleet`/`invalidate` on commit. Logic: ../../handler.ts.
 */
import { getDb } from '@/db/client';
import { handleSetMachineStatus } from '../../handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handleSetMachineStatus(request, id, getDb());
}
