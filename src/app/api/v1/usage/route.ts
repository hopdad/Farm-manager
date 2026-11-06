/**
 * POST /api/v1/usage <- UsageHeartbeatBody -> UsageHeartbeatResponse: the board's heartbeat
 * (viewer: any session; recorded only for a session with a person). Logic: ./handler.ts.
 */
import { getPool } from '@/db/client';
import { handleUsageHeartbeat } from './handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleUsageHeartbeat(request, getPool());
}
