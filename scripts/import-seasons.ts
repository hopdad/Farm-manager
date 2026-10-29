/**
 * pnpm import:seasons <csv> [--dry-run] [--replace-deere]
 *
 * Crop history from a CSV (plan 1c): one row per field and crop year, columns
 *   field, crop_year, crop, variety, planted_on, harvested_on, yield_bu_ac
 * (template: tools/import/templates/seasons.csv; an optional `farm` column tells apart two
 * fields with the same name). Dates as 2025-05-03 or 5/3/2025 (how Excel saves them).
 *
 * All or nothing: if any row has a problem, nothing is written and every problem is listed by
 * line number. A row for a field and year that already has a season replaces it (seasons that
 * came from Operations Center only with --replace-deere). --dry-run shows what would change.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createPool } from '../src/db/client';
import { importSeasons, type SeasonImportReport } from '../src/db/queries/seasons';
import { isMainModule } from '../src/lib/proc';
import { localParts } from '../src/sim/time';
import { CsvError, decodeCsvBytes } from '../tools/import/csv';
import { table } from '../tools/import/report';
import { parseSeasonsCsv, type RowProblem } from '../tools/import/seasons-csv';

export class UsageError extends Error {}

const USAGE = 'usage: pnpm import:seasons <file.csv> [--dry-run] [--replace-deere]';

export function parseImportSeasonsArgs(argv: string[]): {
  file: string;
  dryRun: boolean;
  replaceDeere: boolean;
} {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        'dry-run': { type: 'boolean', default: false },
        'replace-deere': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (e) {
    throw new UsageError(`${(e as Error).message}\n${USAGE}`);
  }
  if (parsed.values.help || parsed.positionals.length !== 1) throw new UsageError(USAGE);
  return {
    file: parsed.positionals[0] as string,
    dryRun: parsed.values['dry-run'] === true,
    replaceDeere: parsed.values['replace-deere'] === true,
  };
}

export function formatSeasonProblems(errors: RowProblem[], warnings: RowProblem[]): string {
  const lines = [
    ...errors.map((e) => `  line ${e.line}: ${e.message}`),
    ...warnings.map((w) => `  line ${w.line} (note): ${w.message}`),
  ];
  return lines.join('\n');
}

export function formatSeasonReport(r: SeasonImportReport): string {
  const rows = r.rows.map((x) => [
    String(x.line),
    x.action,
    x.fieldName ?? x.field,
    x.farmName ?? '',
    String(x.cropYear),
    x.message ?? '',
  ]);
  const c = r.counts;
  const tail = r.written
    ? `${c.insert} added, ${c.update} replaced, ${c.unchanged} unchanged`
    : r.dryRun && c.error === 0
      ? `DRY RUN (nothing written): ${c.insert} would be added, ${c.update} replaced, ${c.unchanged} unchanged`
      : `NOTHING WRITTEN: fix the ${c.error} row(s) marked error and run it again`;
  return `${table(['line', 'action', 'field', 'farm', 'year', 'problem'], rows)}\n${tail}`;
}

async function main(): Promise<void> {
  let args: ReturnType<typeof parseImportSeasonsArgs>;
  try {
    args = parseImportSeasonsArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 2;
    return;
  }
  const text = decodeCsvBytes(await readFile(path.resolve(args.file)));
  const year = localParts(Date.now()).y;
  const parsed = parseSeasonsCsv(text, year);
  if (parsed.errors.length || parsed.warnings.length) {
    console.log(formatSeasonProblems(parsed.errors, parsed.warnings));
  }
  if (parsed.errors.length) {
    console.error(
      `[seasons] ${parsed.errors.length} problem(s) in ${args.file}; nothing was written`,
    );
    process.exitCode = 1;
    return;
  }
  const pool = createPool({ max: 2, applicationName: 'farm-import' });
  try {
    const report = await importSeasons(pool, parsed.rows, {
      dryRun: args.dryRun,
      replaceDeere: args.replaceDeere,
    });
    console.log(formatSeasonReport(report));
    if (report.counts.error) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (isMainModule(import.meta.url)) {
  try {
    await main();
  } catch (e) {
    console.error(`[seasons] ${e instanceof CsvError ? '' : 'error: '}${(e as Error).message}`);
    process.exitCode = 1;
  }
}
