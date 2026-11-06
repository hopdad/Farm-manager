/**
 * GET /api/v1/crew -> CrewResponse: crew people with initials, app role, active (viewer); the
 * job board's person chips. Logic: ./handler.ts.
 */
import { getPool } from '@/db/client';
import { handleCrew } from './handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return handleCrew(getPool());
}
