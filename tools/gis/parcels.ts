/**
 * `pnpm gis:parcels <file | ArcGIS layer URL> [options]`: load a county or vendor parcel file
 * into gis.parcels (plan 1d, D7; docs/contracts-m1.md §3.1, §5.3, §13).
 *
 *   pnpm gis:parcels lenawee-parcels.zip --county 26091 --source lenawee-county --received-on 2027-01-05
 *   (a real county or vendor file retires the synthetic demo parcels of its counties)
 *   pnpm gis:parcels https://<host>/arcgis/rest/services/<svc>/FeatureServer/0 --county 26091 --source lenawee-county
 *   pnpm gis:parcels --fixture         the synthetic demo parcels (fictional owners; D7 default)
 *   pnpm gis:parcels --write-fixture   regenerate tools/gis/fixtures/parcels/synthetic-parcels.geojson
 *
 * Inputs: GeoJSON, a zipped shapefile, a .shp with its .dbf/.prj, a GeoPackage (GDAL in Docker),
 * an ArcGIS FeatureServer/MapServer layer URL (paged; the download is kept in data/raw/parcels).
 * Parcel data with owner names is PRIVATE: it lives only in the database (served by the private
 * parcels tiles and session-checked routes) and in gitignored data/raw; never commit a real file.
 *
 * Options:
 *   --county <fips>        5-digit county FIPS for every feature (26091 Lenawee, 26115 Monroe);
 *                          else a county column (COUNTY_FIPS, FIPS, GEOID, …) must exist
 *   --source <name>        who the file came from (gis.parcel_imports.source), default 'county'
 *   --received-on <date>   when it arrived (YYYY-MM-DD)
 *   --license <text>       licence / terms note kept with the import
 *   --map <col=ATTR,…>     name the attribute of a column: parcel, owner, owner2, mailing,
 *                          mailCity, mailState, mailZip, address, acres, county. Quote it in
 *                          PowerShell (--map 'parcel=PIN,owner=OWNER1'), or repeat --map
 *   --replace              delete parcels of the file's counties that the file no longer has
 *   --dry-run              read and map only; print what would be loaded
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type pg from 'pg';
import { getConfig } from '../../src/config';
import { createPool } from '../../src/db/client';
import { isMainModule } from '../../src/lib/proc';
import { describeError } from './http';
import { newRunDir, rawRelative, rawRoot, recordDownloads, sha256Hex } from './naip-raw';
import { parseGeoJsonText, readVectorInput, VectorInputError } from './parcels-io';
import { type LoadSummary, loadParcels } from './parcels-load';
import {
  type ColumnMap,
  type MapResult,
  mapParcelFeatures,
  PARCEL_COLUMNS,
  parseColumnMap,
  splitMapPositionals,
} from './parcels-map';
import {
  SYNTHETIC_LICENSE,
  SYNTHETIC_PARCELS_FILE,
  SYNTHETIC_SOURCE,
  syntheticParcelsText,
} from './parcels-synthetic';

export const USAGE = `usage: pnpm gis:parcels <file | ArcGIS layer URL> [--county 26091] [--source lenawee-county]
                        [--received-on YYYY-MM-DD] [--license "..."] [--map 'parcel=PIN,owner=OWNER1']
                        [--replace] [--dry-run]
       pnpm gis:parcels --fixture          load the synthetic demo parcels (fictional owners)
       pnpm gis:parcels --write-fixture    regenerate the committed synthetic fixture`;

export interface ParcelsArgs {
  input: string | null;
  fixture: boolean;
  writeFixture: boolean;
  county?: string;
  source: string;
  receivedOn: string | null;
  license: string;
  columns: ColumnMap;
  replace: boolean;
  dryRun: boolean;
  help: boolean;
}

export function parseParcelsArgs(argv: readonly string[]): ParcelsArgs {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      fixture: { type: 'boolean', default: false },
      'write-fixture': { type: 'boolean', default: false },
      county: { type: 'string' },
      source: { type: 'string' },
      'received-on': { type: 'string' },
      license: { type: 'string' },
      map: { type: 'string', multiple: true },
      replace: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  // PowerShell may hand an unquoted `--map a=X,b=Y` on as separate arguments.
  const split = splitMapPositionals(positionals, PARCEL_COLUMNS);
  if (split.rest.length > 1) throw new Error('give one file or URL at a time');
  const input = split.rest[0] ?? null;
  const mapSpec = [...(values.map ?? []), ...split.map].join(',');
  const fixture = values.fixture === true;
  const writeFixture = values['write-fixture'] === true;
  const help = values.help === true;
  if (!help && !fixture && !writeFixture && !input) throw new Error('no file or URL given');
  if ((fixture || writeFixture) && input) throw new Error('--fixture takes no file');
  const receivedOn = values['received-on'] ?? null;
  if (receivedOn !== null && !/^\d{4}-\d{2}-\d{2}$/.test(receivedOn)) {
    throw new Error('--received-on must be YYYY-MM-DD');
  }
  if (values.county !== undefined && !/^\d{5}$/.test(values.county)) {
    throw new Error('--county must be a 5-digit FIPS code (26091 Lenawee, 26115 Monroe)');
  }
  const source = values.source ?? (fixture ? SYNTHETIC_SOURCE : 'county');
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(source)) {
    throw new Error('--source must be a short lower-case name, e.g. lenawee-county or regrid');
  }
  return {
    input,
    fixture,
    writeFixture,
    county: values.county,
    source,
    receivedOn,
    license: values.license ?? (fixture ? SYNTHETIC_LICENSE : ''),
    columns: mapSpec ? parseColumnMap(mapSpec) : {},
    replace: values.replace === true,
    dryRun: values['dry-run'] === true,
    help,
  };
}

function describeMapping(m: MapResult): string[] {
  const cols = Object.entries(m.columns)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  const s = m.skipped;
  const lines = [
    `${m.featureCount} features → ${m.records.length} parcels (${m.merged} combined from several features)`,
    `columns used: ${cols || '(none)'}`,
  ];
  const skippedTotal = s.noNumber + s.notPolygon + s.noCounty + s.empty;
  if (skippedTotal > 0) {
    lines.push(
      `skipped ${skippedTotal}: ${s.noNumber} without a parcel number, ${s.notPolygon} not polygons, ${s.noCounty} without a county, ${s.empty} empty`,
    );
    for (const e of m.examples) lines.push(`  e.g. ${e}`);
  }
  return lines;
}

function describeLoad(r: LoadSummary, replace: boolean): string[] {
  return [
    `import ${r.importId}${r.reusedImport ? ' (same file as before: reused)' : ''}`,
    `${r.inserted} new, ${r.updated} updated, ${r.unchanged} unchanged`,
    replace
      ? `${r.deleted} parcels the file no longer has were deleted`
      : r.stale > 0
        ? `${r.stale} parcels of these counties are not in this file (kept; --replace deletes them)`
        : 'no other parcels in these counties',
    ...(r.syntheticRetired > 0
      ? [`${r.syntheticRetired} synthetic (made-up) demo parcels of these counties were retired`]
      : []),
    `${r.fieldsAffected} fields' parcels changed; tiles version ${r.version}`,
  ];
}

/** Load the committed synthetic fixture (demo seed, bootstrap, e2e). */
export async function loadSyntheticParcels(
  pool: pg.Pool,
  projectDir: string = process.cwd(),
  log: (msg: string) => void = () => {},
): Promise<LoadSummary> {
  const file = path.join(projectDir, SYNTHETIC_PARCELS_FILE);
  const text = await readFile(file, 'utf8');
  const mapped = mapParcelFeatures(parseGeoJsonText(text, file));
  return loadParcels(
    pool,
    mapped.records,
    {
      source: SYNTHETIC_SOURCE,
      countyFips: null,
      receivedOn: null,
      licenseNote: SYNTHETIC_LICENSE,
      fileName: path.basename(file),
      sha256: sha256Hex(text),
      notes: 'D7 default: synthetic parcels until a county or vendor file arrives',
      vintage: 'Synthetic demo parcels (fictional owners)',
      attribution: 'Parcels: synthetic demo data',
    },
    { replace: true, log },
  );
}

export async function runParcels(
  args: ParcelsArgs,
  log = (m: string) => console.log(m),
): Promise<void> {
  const cfg = getConfig();
  const say = (m: string) => log(`[gis:parcels] ${m}`);
  if (args.writeFixture) {
    const file = path.join(cfg.projectDir, SYNTHETIC_PARCELS_FILE);
    await writeFile(file, syntheticParcelsText());
    say(`wrote ${SYNTHETIC_PARCELS_FILE}`);
    return;
  }
  const pool = createPool({ connectionString: cfg.DATABASE_URL, max: 2 });
  try {
    if (args.fixture) {
      const r = await loadSyntheticParcels(pool, cfg.projectDir, say);
      for (const l of describeLoad(r, true)) say(l);
      return;
    }
    const input = args.input as string;
    say(`reading ${input}`);
    const src = await readVectorInput(input, { log: say });
    if (src.downloaded !== null) {
      const root = rawRoot(cfg.projectDir);
      const dir = await newRunDir(root, 'parcels', new Date());
      const file = path.join(dir, `${src.sha256.slice(0, 8)}.geojson`);
      await writeFile(file, src.downloaded);
      await recordDownloads(root, [
        {
          source: 'parcels',
          path: rawRelative(root, file),
          url: input,
          method: 'GET',
          requestSha256: null,
          fetchedAt: new Date().toISOString(),
          sha256: src.sha256,
          bytes: src.bytes,
          licence: args.license || 'see gis.parcel_imports.license_note',
        },
      ]);
      say(`kept the download as data/raw/${rawRelative(root, file)}`);
    }
    const mapped = mapParcelFeatures(src.features, {
      countyFips: args.county,
      columns: args.columns,
    });
    for (const l of describeMapping(mapped)) say(l);
    if (mapped.records.length === 0) throw new Error('nothing to load');
    if (args.dryRun) {
      say('dry run: nothing written');
      return;
    }
    const counties = [...new Set(mapped.records.map((r) => r.countyFips))];
    const r = await loadParcels(
      pool,
      mapped.records,
      {
        source: args.source,
        countyFips: counties.length === 1 ? (counties[0] as string) : null,
        receivedOn: args.receivedOn,
        licenseNote: args.license,
        fileName: src.name,
        sha256: src.sha256,
        vintage: `${args.source}${args.receivedOn ? `, received ${args.receivedOn}` : ''}`,
        attribution: null,
      },
      { replace: args.replace, log: say },
    );
    for (const l of describeLoad(r, args.replace)) say(l);
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  let args: ParcelsArgs;
  try {
    args = parseParcelsArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${(e as Error).message}\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  await runParcels(args);
}

if (isMainModule(import.meta.url)) {
  main().then(
    () => process.exit(0),
    (e: unknown) => {
      const msg = e instanceof VectorInputError ? e.message : describeError(e);
      console.error(`[gis:parcels] FAILED: ${msg}`);
      console.error('[gis:parcels] nothing was changed (the load is one transaction).');
      process.exit(1);
    },
  );
}
