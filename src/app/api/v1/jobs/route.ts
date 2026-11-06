/**
 * GET /api/v1/jobs[?fieldId=] -> BoardSnapshot (viewer): every open job plus the day's done
 * ones, in the four lanes (the field panel's Jobs tab passes `fieldId`).
 * POST /api/v1/jobs <- CreateJobBody -> 201 JobResponse (ROLE_FOR.planJobs).
 * Contract: src/ui/work/contract.ts (docs/contracts-2a.md §5). Logic: ./handler.ts.
 */
import { getPool } from '@/db/client';
import { handleBoardSnapshot, handleCreateJob } from './handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return handleBoardSnapshot(request, getPool());
}

export async function POST(request: Request): Promise<Response> {
  return handleCreateJob(request, getPool());
}
