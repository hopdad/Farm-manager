/**
 * GET /api/weather/spray/<fieldId>: one field's verdicts with reasons for the current hour and
 * the 12 after it (FieldSprayResponse), for the field panel's Spray tab. Needs a session
 * (viewer); `no-store`. Handler: ../../handler.ts.
 */
import { getPool } from '@/db/client';
import { handleFieldSpray } from '../../handler';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ fieldId: string }> },
): Promise<Response> {
  const { fieldId } = await ctx.params;
  return handleFieldSpray(getPool(), fieldId);
}
