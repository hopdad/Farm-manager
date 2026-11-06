/**
 * GET /api/v1/job-options -> JobOptionsResponse: products, customers, fields, crop years for the job form (viewer).
 * FOUNDATION STUB (slice 2a; docs/contracts-2a.md §5): answers 501 until job-forms replaces
 * it with its handler (keep this file thin: runtime, dynamic, then the handler).
 */
import { notBuiltYet } from '@/platform/http/not-built';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return notBuiltYet('api/v1/job-options');
}
