/**
 * pnpm import:boundaries <file> [options]
 *
 * Field boundaries from an Operations Center shapefile export (.zip, or the .shp with its
 * .dbf/.prj next to it) or a GeoJSON file into boundary versions (plan 1c). Each field in the
 * file is matched to an existing field (same Deere field id; else same name with overlapping
 * shapes; else a shape overlapping 80 %), gets a new version when its shape changed, or becomes
 * a new field. Boundaries a Deere sync owns are left alone (D6). One transaction: a crash
 * writes nothing. Prints what changed; --dry-run prints the same and writes nothing.
 *
 * Options:
 *   --dry-run               show what would change, write nothing
 *   --farm <name>           put every field in this farm (created if missing)
 *   --default-farm <name>   farm for rows that name none (default "Home farm")
 *   --tenure <t>            tenure of new fields: owned, cash_rent, share, custom
 *   --county <fips>         county of new fields (26091 Lenawee, 26115 Monroe)
 *   --effective <date>      versions start that day (America/Detroit), default now
 *   --no-create             only update existing fields
 *   --hide-demo             deactivate the demo farm's fields afterwards
 *   --name-attr <col>       the column holding the field name (default: detected)
 *   --farm-attr / --client-attr / --id-attr <col>   farm, client, Deere field id columns
 *   --min-overlap <0-1>     how much a same-name field must overlap (default 0.5)
 *
 * Writes as farm_app to DATABASE_URL (your PC's database until MD).
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createPool } from '../src/db/client';
import { type BoundaryImportOptions, importBoundaries } from '../src/db/queries/boundaries';
import { TENURES, type Tenure } from '../src/domain/farm';
import { isMainModule } from '../src/lib/proc';
import {
  type AttributeOptions,
  BoundaryFileError,
  type InputFile,
  parseBoundaryFiles,
} from '../tools/import/boundary-file';
import { detroitMidnight, parseDate } from '../tools/import/dates';
import { formatBoundaryReport } from '../tools/import/report';
import { COUNTY_ZIP_LIMITS } from '../tools/import/zip-vectors';

export class UsageError extends Error {}

const USAGE =
  'usage: pnpm import:boundaries <file.zip|file.shp|file.geojson> [--dry-run] [--farm NAME] [--default-farm NAME] [--tenure owned|cash_rent|share|custom] [--county FIPS] [--effective YYYY-MM-DD] [--no-create] [--hide-demo] [--name-attr COL] [--farm-attr COL] [--client-attr COL] [--id-attr COL] [--min-overlap 0.5]';

export interface ImportBoundariesArgs {
  file: string;
  attributes: AttributeOptions;
  options: BoundaryImportOptions;
}

export function parseImportBoundariesArgs(argv: string[]): ImportBoundariesArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        'dry-run': { type: 'boolean', default: false },
        farm: { type: 'string' },
        'default-farm': { type: 'string' },
        tenure: { type: 'string' },
        county: { type: 'string' },
        effective: { type: 'string' },
        'no-create': { type: 'boolean', default: false },
        'hide-demo': { type: 'boolean', default: false },
        'name-attr': { type: 'string' },
        'farm-attr': { type: 'string' },
        'client-attr': { type: 'string' },
        'id-attr': { type: 'string' },
        'min-overlap': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (e) {
    throw new UsageError(`${(e as Error).message}\n${USAGE}`);
  }
  const v = parsed.values as Record<string, string | boolean | undefined>;
  if (v.help || parsed.positionals.length !== 1) throw new UsageError(USAGE);
  const str = (k: string) => {
    const x = v[k];
    return typeof x === 'string' && x.trim() ? x.trim() : undefined;
  };
  const tenure = str('tenure');
  if (tenure && !(TENURES as readonly string[]).includes(tenure)) {
    throw new UsageError(`--tenure must be one of ${TENURES.join(', ')}`);
  }
  const county = str('county');
  if (county && !/^\d{5}$/.test(county)) throw new UsageError('--county is a 5-digit FIPS code');
  let effectiveAt: Date | null = null;
  const eff = str('effective');
  if (eff) {
    const d = parseDate(eff);
    if (!d.ok) throw new UsageError(`--effective: ${d.error}`);
    effectiveAt = detroitMidnight(d.value);
    if (effectiveAt.getTime() > Date.now())
      throw new UsageError('--effective cannot be in the future');
  }
  let minNameOverlap: number | undefined;
  const mo = str('min-overlap');
  if (mo !== undefined) {
    minNameOverlap = Number(mo);
    if (!(minNameOverlap > 0 && minNameOverlap <= 1)) {
      throw new UsageError('--min-overlap is a fraction between 0 and 1');
    }
  }
  return {
    file: parsed.positionals[0] as string,
    attributes: {
      nameAttr: str('name-attr'),
      farmAttr: str('farm-attr'),
      clientAttr: str('client-attr'),
      idAttr: str('id-attr'),
    },
    options: {
      dryRun: v['dry-run'] === true,
      farm: str('farm') ?? null,
      defaultFarm: str('default-farm') ?? null,
      tenure: (tenure as Tenure | undefined) ?? null,
      countyFips: county ?? null,
      effectiveAt,
      create: v['no-create'] !== true,
      hideDemo: v['hide-demo'] === true,
      minNameOverlap,
    },
  };
}

const SIDECARS = new Set(['.dbf', '.prj', '.cpg']);

/** The file, plus a .shp's .dbf/.prj/.cpg next to it (any extension case). */
export async function readInputFiles(file: string): Promise<InputFile[]> {
  const abs = path.resolve(file);
  const bytes = new Uint8Array(await readFile(abs));
  const files: InputFile[] = [{ name: path.basename(abs), bytes }];
  if (path.extname(abs).toLowerCase() !== '.shp') return files;
  const dir = path.dirname(abs);
  const base = path.basename(abs, path.extname(abs)).toLowerCase();
  for (const entry of await readdir(dir)) {
    const ext = path.extname(entry).toLowerCase();
    if (!SIDECARS.has(ext) || path.basename(entry, path.extname(entry)).toLowerCase() !== base) {
      continue;
    }
    files.push({ name: entry, bytes: new Uint8Array(await readFile(path.join(dir, entry))) });
  }
  if (!files.some((f) => f.name.toLowerCase().endsWith('.prj'))) {
    console.warn(
      `[import] ${path.basename(abs)} has no .prj next to it: coordinates must already be longitude/latitude`,
    );
  }
  return files;
}

async function main(): Promise<void> {
  let args: ImportBoundariesArgs;
  try {
    args = parseImportBoundariesArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 2;
    return;
  }
  const files = await readInputFiles(args.file);
  // On the PC a whole-farm export may be big: the county-file limits, not an upload's.
  const parsed = await parseBoundaryFiles(files, args.attributes, COUNTY_ZIP_LIMITS);
  for (const w of parsed.warnings) console.warn(`[import] note: ${w}`);
  if (parsed.errors.length) {
    for (const e of parsed.errors) console.error(`[import] ${e}`);
    console.error(
      `[import] ${parsed.errors.length} problem(s) in the file; nothing was written. Attributes found: ${parsed.attributes.join(', ') || 'none'}`,
    );
    process.exitCode = 1;
    return;
  }
  if (parsed.boundaries.length === 0) {
    console.error('[import] the file holds no field boundaries');
    process.exitCode = 1;
    return;
  }
  console.log(
    `[import] ${parsed.featureCount} feature(s) -> ${parsed.boundaries.length} field(s) from ${args.file}`,
  );
  const pool = createPool({ max: 2, applicationName: 'farm-import' });
  try {
    const report = await importBoundaries(pool, parsed.boundaries, args.options);
    console.log(formatBoundaryReport(report));
  } finally {
    await pool.end();
  }
}

if (isMainModule(import.meta.url)) {
  try {
    await main();
  } catch (e) {
    console.error(
      `[import] ${e instanceof BoundaryFileError ? '' : 'error: '}${(e as Error).message}`,
    );
    process.exitCode = 1;
  }
}
