/**
 * GET /api/pins[?fieldId=<uuid>][&resolved=1] (viewer+): the pins of the "Deere flags" layer and
 * the pin popup (slice 1f). Logic and rules: ./handler.ts.
 */
import { getPool } from '@/db/client';
import { handleListPins } from './handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request): Promise<Response> {
  return handleListPins(request, getPool());
}
