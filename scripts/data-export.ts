/**
 * pnpm data:export [--out <file.json>]
 *
 * Writes the data you entered by hand or imported (parties, your own fields and boundary
 * versions, crop history, splits and merges, Ops Center change requests, people and devices,
 * hand-entered machines, geofences, soil readings, tile lines, the spray thresholds) to one JSON
 * file, plus the values you set on synced rows (landlords, notes, hidden fields). Demo and
 * simulator rows are never in it. Default file: .data/exports/farm-data-<date>-<time>.json
 * (.data is never committed). Run it before `pnpm db:reset`; `pnpm data:import <file>` puts it
 * back. See tools/import/data-transfer.ts for exactly what is included.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { getConfig } from '../src/config';
import { createPool } from '../src/db/client';
import { isMainModule } from '../src/lib/proc';
import { localParts } from '../src/sim/time';
import { exportData } from '../tools/import/data-transfer';

export class UsageError extends Error {}

const USAGE = 'usage: pnpm data:export [--out <file.json>]';

const pad = (n: number) => String(Math.floor(n)).padStart(2, '0');

/** .data/exports/farm-data-20261029-0715.json (local time, sorts by date). */
export function defaultExportPath(projectDir: string, now: Date = new Date()): string {
  const p = localParts(now.getTime());
  const stamp = `${p.y}${pad(p.m)}${pad(p.d)}-${pad(p.hh)}${pad(p.mm)}${pad(p.ss)}`;
  return path.join(projectDir, '.data', 'exports', `farm-data-${stamp}.json`);
}

export function parseExportArgs(argv: string[]): { out: string | null } {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: { out: { type: 'string' }, help: { type: 'boolean', short: 'h', default: false } },
    });
  } catch (e) {
    throw new UsageError(`${(e as Error).message}\n${USAGE}`);
  }
  if (parsed.values.help) throw new UsageError(USAGE);
  const out = parsed.values.out;
  return { out: typeof out === 'string' && out.trim() ? out.trim() : null };
}

async function main(): Promise<void> {
  let args: { out: string | null };
  try {
    args = parseExportArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 2;
    return;
  }
  const cfg = getConfig();
  const file = args.out ? path.resolve(args.out) : defaultExportPath(cfg.projectDir);
  const pool = createPool({ max: 2, applicationName: 'farm-export' });
  try {
    const doc = await exportData(pool);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(doc, null, 1)}\n`, 'utf8');
    const lines = [
      ...Object.entries(doc.tables).map(([t, rows]) => `  ${t.padEnd(40)} ${rows.length}`),
      ...Object.entries(doc.overlays).map(
        ([t, rows]) => `  ${`${t} (values on synced rows)`.padEnd(40)} ${rows.length}`,
      ),
    ];
    console.log(`[export] ${file}\n${lines.join('\n')}`);
  } finally {
    await pool.end();
  }
}

if (isMainModule(import.meta.url)) {
  try {
    await main();
  } catch (e) {
    console.error(`[export] error: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
