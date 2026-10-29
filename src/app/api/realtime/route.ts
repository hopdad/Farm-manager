/**
 * GET /api/realtime?topics=fleet,admin: server-sent events from the local LISTEN app_events
 * connection (src/platform/realtime/hub.ts, sse.ts). Local adapter only: with
 * NEXT_PUBLIC_REALTIME=supabase (production) clients use Supabase Broadcast and this answers 404.
 * Never redirects (plan §1: no proxy on /api/realtime).
 */
import { getConfig } from '@/config';
import { getRealtimeHub } from '@/platform/realtime/hub';
import { handleRealtimeRequest } from '@/platform/realtime/sse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  if (getConfig().NEXT_PUBLIC_REALTIME !== 'sse') {
    return Response.json(
      { error: 'the SSE realtime adapter is off (NEXT_PUBLIC_REALTIME is not sse)' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return handleRealtimeRequest(req, { hub: getRealtimeHub() });
}
