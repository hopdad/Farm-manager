/**
 * Fault cleanup for specs that raise codes in a stand-in (1f review): close what was raised
 * through the stand-in's own "closed" record and wait until the app has applied it (one job
 * run), and only then wipe the stand-in. Wiping first ("no fault records at all") sends no
 * closed record, so the code would stay open in the dev database the specs run against.
 */
import { expect } from '@playwright/test';
import type pg from 'pg';

/** Resolves once no code of `sources` last seen since `since` is still open in the app. */
export async function waitForFaultsClosed(
  db: pg.Pool,
  sources: readonly string[],
  since: Date,
  timeoutMs = 60_000,
): Promise<void> {
  await expect
    .poll(
      async () =>
        (
          await db.query<{ source: string; code: string }>(
            `select source, code from farm.machine_faults
              where cleared_at is null and source = any($1::text[]) and last_seen_at >= $2
              order by source, code`,
            [sources, new Date(since.getTime() - 5_000)],
          )
        ).rows.map((r) => `${r.source} ${r.code}`),
      {
        timeout: timeoutMs,
        intervals: [2_000],
        message: `the app closed the codes raised in the ${sources.join('/')} stand-in`,
      },
    )
    .toEqual([]);
}
