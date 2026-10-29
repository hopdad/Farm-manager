/**
 * `pnpm import:tile <file> [options]`: drainage tile as-builts into farm.tile_lines (plan 1d).
 *
 *   pnpm import:tile kowalski-tile.zip --origin installer_drawing --installer "Example Drainage"
 *   pnpm import:tile plow-log.geojson --origin deere_tile_plow --field "Kowalski North 80"
 *
 * Inputs: GeoJSON, a zipped shapefile, a .shp with its .dbf/.prj, a GeoPackage (GDAL in Docker)
 * or an ArcGIS layer URL (tools/gis/parcels-io.ts), with LineString / MultiLineString features.
 * Attributes (size, depth, install date, kind, installer, notes) are detected by name
 * (tools/import/tile-map.ts); `--map 'size=PIPE_DIA,depth=DEPTH_IN'` names them (quote it in
 * PowerShell, or repeat --map). The file NAME
 * identifies the drawing: re-running the same file changes nothing, a corrected file of the same
 * name updates its lines in place (by the features' ID column, else their order), and
 * `--replace` removes lines it no longer has.
 *
 * Options:
 *   --origin <o>          installer_drawing (default) | deere_tile_plow
 *   --field <name|id>     put every line on this field (else each line's own field, by overlap)
 *   --installer <name>    for lines without an installer column
 *   --installed-on <date> YYYY-MM-DD, for lines without a date
 *   --size <in>           pipe size for lines without one
 *   --depth <ft>          depth for lines without one
 *   --kind <k>            main | submain | lateral | unknown, for lines without a kind column
 *   --map <col=ATTR,…>    size, depth, installed, kind, installer, notes
 *   --replace             delete lines imported earlier from a file of this name that are gone
 *   --dry-run             read and map only
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import type pg from 'pg';
import { getConfig } from '../../src/config';
import { createPool } from '../../src/db/client';
import { TILE_KINDS, type TileKind } from '../../src/db/queries/tile-lines-schema';
import { isMainModule } from '../../src/lib/proc';
import { describeError } from '../gis/http';
import { readVectorInput, VectorInputError } from '../gis/parcels-io';
import { splitMapPositionals } from '../gis/parcels-map';
import { loadTileLines } from './tile-load';
import {
  IMPORT_ORIGINS,
  mapTileFeatures,
  parseTileColumnMap,
  TILE_COLUMNS,
  type TileColumnMap,
  type TileMapResult,
} from './tile-map';

export const USAGE = `usage: pnpm import:tile <file> [--origin installer_drawing|deere_tile_plow] [--field <name|id>]
                       [--installer <name>] [--installed-on YYYY-MM-DD] [--size <in>] [--depth <ft>]
                       [--kind main|submain|lateral|unknown] [--map 'size=ATTR,…'] [--replace] [--dry-run]`;

export interface TileArgs {
  input: string;
  origin: (typeof IMPORT_ORIGINS)[number];
  field: string | null;
  installer?: string;
  installedOn?: string;
  sizeIn?: number;
  depthFt?: number;
  kind?: TileKind;
  columns: TileColumnMap;
  replace: boolean;
  dryRun: boolean;
  help: boolean;
}

function positiveNumber(v: string | undefined, what: string, max: number): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > max)
    throw new Error(`${what} must be a number between 0 and ${max}`);
  return n;
}

export function parseTileArgs(argv: readonly string[]): TileArgs {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      origin: { type: 'string' },
      field: { type: 'string' },
      installer: { type: 'string' },
      'installed-on': { type: 'string' },
      size: { type: 'string' },
      depth: { type: 'string' },
      kind: { type: 'string' },
      map: { type: 'string', multiple: true },
      replace: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const help = values.help === true;
  // PowerShell may hand an unquoted `--map a=X,b=Y` on as separate arguments.
  const split = splitMapPositionals(positionals, TILE_COLUMNS);
  if (!help && split.rest.length !== 1) throw new Error('give one file');
  const mapSpec = [...(values.map ?? []), ...split.map].join(',');
  const origin = (values.origin ?? 'installer_drawing') as TileArgs['origin'];
  if (!IMPORT_ORIGINS.includes(origin))
    throw new Error(`--origin must be ${IMPORT_ORIGINS.join(' or ')}`);
  const installedOn = values['installed-on'];
  if (installedOn !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(installedOn)) {
    throw new Error('--installed-on must be YYYY-MM-DD');
  }
  const kind = values.kind as TileKind | undefined;
  if (kind !== undefined && !TILE_KINDS.includes(kind))
    throw new Error(`--kind must be ${TILE_KINDS.join(', ')}`);
  return {
    input: split.rest[0] ?? '',
    origin,
    field: values.field ?? null,
    installer: values.installer,
    installedOn,
    sizeIn: positiveNumber(values.size, '--size (inches)', 120),
    depthFt: positiveNumber(values.depth, '--depth (feet)', 30),
    kind,
    columns: mapSpec ? parseTileColumnMap(mapSpec) : {},
    replace: values.replace === true,
    dryRun: values['dry-run'] === true,
    help,
  };
}

/** A field id from `--field` (an id, or an exact, case-insensitive active field name). */
export async function resolveField(ex: Pick<pg.Pool, 'query'>, field: string): Promise<string> {
  if (/^[0-9a-f-]{36}$/i.test(field)) {
    const r = await ex.query<{ id: string }>(
      'select id::text from farm.fields where id = $1::uuid',
      [field],
    );
    if (r.rows[0]) return r.rows[0].id;
  }
  const r = await ex.query<{ id: string }>(
    'select id::text from farm.fields where active and lower(name) = lower($1) order by name',
    [field.trim()],
  );
  if (r.rows.length === 1) return (r.rows[0] as { id: string }).id;
  throw new Error(
    r.rows.length === 0
      ? `no active field named '${field}'`
      : `${r.rows.length} fields are named '${field}': give its id`,
  );
}

function summaryLines(m: TileMapResult): string[] {
  const cols = Object.entries(m.columns)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  const lines = [
    `${m.featureCount} features → ${m.records.length} tile lines`,
    `columns used: ${cols || '(none)'} (attributes: ${m.attributes.join(', ') || 'none'})`,
  ];
  if (m.skipped.notLine + m.skipped.empty > 0) {
    lines.push(`skipped ${m.skipped.notLine} non-line and ${m.skipped.empty} empty features`);
    for (const e of m.examples) lines.push(`  e.g. ${e}`);
  }
  return lines;
}

export async function runTileImport(
  args: TileArgs,
  log = (m: string) => console.log(m),
): Promise<void> {
  const say = (m: string) => log(`[import:tile] ${m}`);
  const cfg = getConfig();
  const src = await readVectorInput(args.input, { log: say });
  const mapped = mapTileFeatures(src.features, {
    fileKey: path.basename(src.name),
    columns: args.columns,
    defaults: {
      sizeIn: args.sizeIn,
      depthFt: args.depthFt,
      installedOn: args.installedOn,
      installer: args.installer,
      kind: args.kind,
    },
  });
  for (const l of summaryLines(mapped)) say(l);
  if (mapped.records.length === 0) throw new Error('no tile lines in the file');
  if (args.dryRun) {
    say('dry run: nothing written');
    return;
  }
  const pool = createPool({ connectionString: cfg.DATABASE_URL, max: 2 });
  try {
    const fieldId = args.field ? await resolveField(pool, args.field) : null;
    const r = await loadTileLines(
      pool,
      mapped.records,
      { origin: args.origin, sourceRef: path.basename(src.name), fieldId },
      { replace: args.replace },
    );
    say(`${r.inserted} new, ${r.updated} updated, ${r.unchanged} unchanged, ${r.deleted} removed`);
    if (r.noField > 0) say(`${r.noField} lines lie outside every field (kept, with no field)`);
    if (r.version) say(`tile layer version ${r.version}`);
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  let args: TileArgs;
  try {
    args = parseTileArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${(e as Error).message}\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  await runTileImport(args);
}

if (isMainModule(import.meta.url)) {
  main().then(
    () => process.exit(0),
    (e: unknown) => {
      const msg = e instanceof VectorInputError ? e.message : describeError(e);
      console.error(`[import:tile] FAILED: ${msg}`);
      console.error('[import:tile] nothing was changed (the load is one transaction).');
      process.exit(1);
    },
  );
}
