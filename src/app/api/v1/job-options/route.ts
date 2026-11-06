/**
 * GET /api/v1/job-options -> JobOptionsResponse: active products, customers, fields with a
 * current boundary, crop years for the job form (viewer; docs/contracts-2a.md §5.2). HEAD: the
 * same headers (the realtime mode for the field panel's Jobs tab), no body. Logic: ./handler.ts.
 */
import { getPool } from '@/db/client';
import { handleJobOptions, handleJobOptionsHead } from './handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return handleJobOptions(getPool());
}

export async function HEAD(): Promise<Response> {
  return handleJobOptionsHead();
}
