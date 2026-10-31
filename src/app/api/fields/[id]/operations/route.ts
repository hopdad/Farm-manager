/**
 * GET /api/fields/<id>/operations[?cropYear=YYYY]: the field's operations of one crop year
 * (FieldOperationsResponse; slice 1f, docs/contracts-1f.md §5.1). Viewer and up, `no-store`.
 * Handler: ./handler.ts.
 */
import { getPool } from '@/db/client';
import { handleFieldOperations } from './handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handleFieldOperations(request, id, getPool());
}
