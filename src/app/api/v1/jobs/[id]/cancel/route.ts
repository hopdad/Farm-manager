/**
 * POST /api/v1/jobs/<id>/cancel <- CancelJobBody -> JobResponse | 409 | 422 (ROLE_FOR.planJobs).
 * FOUNDATION STUB (slice 2a; docs/contracts-2a.md §5): answers 501 until jobs-api replaces
 * it with its handler (keep this file thin: runtime, dynamic, then the handler).
 */
import { notBuiltYet } from '@/platform/http/not-built';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(): Promise<Response> {
  return notBuiltYet('api/v1/jobs/[id]/cancel');
}
