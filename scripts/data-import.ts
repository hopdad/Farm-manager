/**
 * pnpm data:import <file.json> [--dry-run] [--partial] [--target local]
 *
 * Puts a `pnpm data:export` file back: every row is upserted by its id, in one transaction, so
 * running it twice changes nothing and a failure writes nothing (--partial keeps the rows that
 * worked). Run it after `pnpm db:reset` and the syncs (the demo seed on the PC): the rows it
 * restores point at synced rows by their deterministic ids. --dry-run reports without writing.
 *
 * --target: `local` (default, DATABASE_URL). `prod` arrives at milestone MD (session pooler,
 * plan §6 MD "Data"); until then it is refused.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { getConfig } from '../src/config';
import { assertLocalUrl } from '../src/db/admin';
import { createPool } from '../src/db/client';
import { isMainModule } from '../src/lib/proc';
import { ExportFormatError, type ImportReport, importData } from '../tools/import/data-transfer';
import { table } from '../tools/import/report';

export class UsageError extends Error {}

const USAGE = 'usage: pnpm data:import <file.json> [--dry-run] [--partial] [--target local]';

export function parseImportArgs(argv: string[]): {
  file: string;
  dryRun: boolean;
  partial: boolean;
} {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        'dry-run': { type: 'boolean', default: false },
        partial: { type: 'boolean', default: false },
        target: { type: 'string', default: 'local' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (e) {
    throw new UsageError(`${(e as Error).message}\n${USAGE}`);
  }
  if (parsed.values.help || parsed.positionals.length !== 1) throw new UsageError(USAGE);
  if (parsed.values.target !== 'local') {
    throw new UsageError(
      `--target=${String(parsed.values.target)}: only 'local' until milestone MD (production import goes through the session pooler then)`,
    );
  }
  return {
    file: parsed.positionals[0] as string,
    dryRun: parsed.values['dry-run'] === true,
    partial: parsed.values.partial === true,
  };
}

export function formatImportReport(r: ImportReport): string {
  const rows = [
    ...Object.entries(r.tables),
    ...Object.entries(r.overlays).map(([t, c]) => [`${t} (synced rows)`, c] as const),
  ]
    .filter(([, c]) => c.inserted + c.updated + c.unchanged + c.failed > 0)
    .map(([t, c]) => [
      t,
      String(c.inserted),
      String(c.updated),
      String(c.unchanged),
      String(c.failed),
    ]);
  const out = [table(['table', 'added', 'updated', 'unchanged', 'failed'], rows)];
  for (const e of r.errors) out.push(`  error  ${e.table} ${e.id}: ${e.message}`);
  for (const w of r.warnings) out.push(`  note   ${w.table} ${w.id}: ${w.message}`);
  out.push(
    r.written
      ? 'Imported.'
      : r.dryRun
        ? 'DRY RUN: nothing written.'
        : 'NOTHING WRITTEN: fix the errors (or use --partial to keep what worked).',
  );
  return out.join('\n');
}

async function main(): Promise<void> {
  let args: ReturnType<typeof parseImportArgs>;
  try {
    args = parseImportArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 2;
    return;
  }
  const text = await readFile(path.resolve(args.file), 'utf8');
  let doc: unknown;
  try {
    // A file saved again on Windows (PowerShell 5.1 Set-Content -Encoding UTF8, Notepad's
    // "UTF-8 with BOM") starts with a BOM, which JSON.parse refuses.
    doc = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (e) {
    throw new ExportFormatError(`${args.file} is not JSON (${(e as Error).message})`);
  }
  // --target local means this PC's database (production arrives at MD with its own target).
  assertLocalUrl(getConfig().DATABASE_URL, 'data:import --target local');
  const pool = createPool({ max: 2, applicationName: 'farm-import' });
  try {
    const report = await importData(pool, doc, { dryRun: args.dryRun, partial: args.partial });
    console.log(formatImportReport(report));
    if (report.errors.length) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (isMainModule(import.meta.url)) {
  try {
    await main();
  } catch (e) {
    console.error(
      `[import] ${e instanceof ExportFormatError ? '' : 'error: '}${(e as Error).message}`,
    );
    process.exitCode = 1;
  }
}
