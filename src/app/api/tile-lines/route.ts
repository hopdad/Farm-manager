/**
 * GET /api/tile-lines?bbox=w,s,e,n | ?fieldId=<uuid> (viewer+) and POST /api/tile-lines
 * (manager+: the draw tool's new line). Logic and rules: ./handler.ts.
 */
import { getPool } from '@/db/client';
import { handleCreateTileLine, handleListTileLines } from './handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request): Promise<Response> {
  return handleListTileLines(request, getPool());
}

export function POST(request: Request): Promise<Response> {
  return handleCreateTileLine(request, getPool());
}
