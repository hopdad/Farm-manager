/**
 * POST /api/v1/usage <- UsageHeartbeatBody -> UsageHeartbeatResponse: the board's heartbeat (viewer: any session).
 * FOUNDATION STUB (slice 2a; docs/contracts-2a.md §5): answers 501 until rights-usage replaces
 * it with its handler (keep this file thin: runtime, dynamic, then the handler).
 */
import { notBuiltYet } from '@/platform/http/not-built';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(): Promise<Response> {
  return notBuiltYet('api/v1/usage');
}
