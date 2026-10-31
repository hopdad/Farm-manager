/**
 * POST /admin/vehicles/kind: set a vehicle's kind by hand (manager only; a viewer or driver gets
 * 403). Logic: ./handler.ts.
 */
import { getDb } from '@/db/client';
import { handleSetVehicleKind } from './handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleSetVehicleKind(request, getDb());
}
