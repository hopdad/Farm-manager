/**
 * GET  /api/weather/soil-temp: the phone form's field list and the latest reading (viewer).
 * POST /api/weather/soil-temp: a manual probe reading (ROLE_FOR.enterSoilTemp, JSON body).
 * Handler: ../handler.ts.
 */
import { getDb, getPool } from '@/db/client';
import { handlePostSoilTemp, handleSoilTempForm } from '../handler';

export const dynamic = 'force-dynamic';

export function GET(): Promise<Response> {
  return handleSoilTempForm(getPool());
}

export function POST(request: Request): Promise<Response> {
  return handlePostSoilTemp(request, getDb());
}
