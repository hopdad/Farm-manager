/**
 * POST /admin/connectors/dead-letters: requeue or discard dead-lettered events (manager only;
 * a viewer or driver gets 403). Logic: ./handler.ts.
 */
import { getDb } from '@/db/client';
import { handleDeadLetters } from './handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleDeadLetters(request, getDb());
}
