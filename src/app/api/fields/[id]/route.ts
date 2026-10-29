/**
 * GET /api/fields/<id>: everything the field panel shows, as one FieldDetail (plan 1a "tap a
 * field"; docs/contracts-m1.md §5.1). Private (requireRole('viewer') first), `no-store`, one
 * query. Logic: ../handler.ts.
 */
import { getPool } from '@/db/client';
import { handleFieldDetail } from '../handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handleFieldDetail(id, getPool());
}
