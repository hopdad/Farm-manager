/**
 * app.settings 'clock.paused' (docs/contracts.md §4): the JOB clock is paused. Read by
 * POST /api/jobs/<name> (answers `202 { skipped: 'paused' }`), by tools/clock before every fire,
 * and shown/toggled on /admin/connectors. A missing key means the default, false.
 *
 * Pausing the job clock is not pausing the simulation: the stand-in's own clock
 * (POST /_control/clock) freezes machines; this stops the syncs (data goes stale).
 */
import { publish } from '../platform/realtime/publish';
import type { Db, DbTx } from './client';
import { type Executor, exec } from './exec';

export const CLOCK_PAUSED_KEY = 'clock.paused';

/** The stored value, leniently: jsonb true (or the string 'true') is paused. */
export function isPausedValue(value: unknown): boolean {
  return value === true || value === 'true';
}

export async function readClockPaused(ex: Executor): Promise<boolean> {
  const r = await exec<{ value: unknown }>(ex, 'select value from app.settings where key = $1', [
    CLOCK_PAUSED_KEY,
  ]);
  return isPausedValue(r.rows[0]?.value);
}

/** Store the flag and publish `admin`/`clock { paused }` in one transaction (delivered on commit). */
export async function setClockPaused(db: Db, paused: boolean): Promise<void> {
  await db.transaction(async (tx: DbTx) => {
    await exec(
      tx,
      `insert into app.settings (key, value, updated_at) values ($1, $2::jsonb, now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [CLOCK_PAUSED_KEY, JSON.stringify(paused)],
    );
    await publish('admin', 'clock', { paused }, tx);
  });
}
