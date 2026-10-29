/**
 * GET /api/health: liveness + database check. Used by tools/dev.ts (start the clock once it
 * answers), bootstrap's phone check (http://<pc-ip>:3000/api/health) and monitoring.
 * 200 { ok: true, db: true, postgis, time } when the database answers as farm_app;
 * 503 { ok: false, db: false, postgis: null, time, error } otherwise.
 */
import { getPool } from '@/db/client';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const time = new Date().toISOString();
  const headers = { 'cache-control': 'no-store' };
  try {
    const r = await getPool().query<{ postgis: string; db_time: Date }>(
      'select extensions.postgis_lib_version() as postgis, now() as db_time',
    );
    const row = r.rows[0];
    return Response.json(
      { ok: true, db: true, postgis: row?.postgis ?? null, time, dbTime: row?.db_time ?? null },
      { headers },
    );
  } catch (e) {
    return Response.json(
      { ok: false, db: false, postgis: null, time, error: (e as Error).message },
      { status: 503, headers },
    );
  }
}
