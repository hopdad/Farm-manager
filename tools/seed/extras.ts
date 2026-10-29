/**
 * What `pnpm db:seed demo` adds after the demo farm (./demo.ts) since M1, so a fresh bootstrap or
 * `pnpm db:reset` shows every M1 layer and can sign in without any GIS step or network:
 *
 *  - demo people (slice 1a): sign-ins for the demo crew with PINs derived from SESSION_SECRET
 *    (src/platform/auth/demo.ts; existing rows are left alone, so changes made in the app stick);
 *  - soils (1c): the newest complete real SSURGO download in data/raw/soils when there is one
 *    (`pnpm gis:soils --offline`), else the committed SYNTHETIC fixture around the demo fields.
 *    Only when the database has no soils yet: a load never replaces real survey data;
 *  - parcels (1d, D7 default): the synthetic parcel fixture, unless a real county or vendor file
 *    has been imported (its `--replace` would retire real parcels of the same counties);
 *  - the online NAIP layer row (1d): no network, only the registry row the rail needs. Only when
 *    it is missing, so a later `pnpm gis:naip` keeps its vintage.
 *
 * Each step is idempotent and skipped when its data is already there; a re-run writes nothing.
 */
import path from 'node:path';
import type pg from 'pg';
import { exec } from '../../src/db/exec';
import { formatDemoPins, listDemoPeople, seedDemoPeople } from '../../src/platform/auth/demo';
import { writeOnlineRow } from '../gis/naip-build';
import { loadSyntheticParcels } from '../gis/parcels';
import { SYNTHETIC_SOURCE } from '../gis/parcels-synthetic';
import { FIXTURE_DIR } from '../gis/soils';
import { loadSoilsRun } from '../gis/soils-load';
import { listRuns, openRun, rawRoot } from '../gis/soils-raw';

export interface ExtrasReport {
  people: { inserted: number; existing: number; skipped: number };
  /** What happened to soils: 'kept' (already loaded), 'ssurgo-cache' or 'fixture'. */
  soils: { action: 'kept' | 'ssurgo-cache' | 'fixture'; detail: string };
  parcels: { action: 'kept' | 'synthetic' | 'real-import'; detail: string };
  naip: { action: 'kept' | 'online-row' };
}

export interface ExtrasOptions {
  /** SESSION_SECRET: the demo PINs are derived from it. */
  secret: string;
  projectDir: string;
  /** Look for a real SSURGO download in data/raw/soils first (default true; tests: false). */
  soilsCache?: boolean;
  log?: (msg: string) => void;
}

async function scalar<T>(pool: pg.Pool, sql: string, values: unknown[] = []): Promise<T> {
  const r = await exec<{ v: T }>(pool, sql, values);
  return r.rows[0]?.v as T;
}

/** Soils: keep what is loaded; else the newest real download, else the synthetic fixture. */
async function seedSoils(pool: pg.Pool, opts: ExtrasOptions): Promise<ExtrasReport['soils']> {
  const polygons = await scalar<number>(pool, 'select count(*)::int as v from gis.soil_polygons');
  if (polygons > 0) {
    const fixture = await scalar<string | null>(
      pool,
      `select meta->>'fixture' as v from gis.map_layers where key = 'soils'`,
    );
    return {
      action: 'kept',
      detail: `${polygons} polygons already loaded${fixture === 'true' ? ' (synthetic fixture)' : ''}`,
    };
  }
  const runs =
    opts.soilsCache === false
      ? []
      : (await listRuns(rawRoot(opts.projectDir))).filter((r) => !r.index.fixture);
  const cached = runs[0];
  const run = cached
    ? await openRun(cached.dir)
    : await openRun(path.join(opts.projectDir, FIXTURE_DIR));
  const report = await loadSoilsRun(pool, run, { log: opts.log });
  return cached
    ? {
        action: 'ssurgo-cache',
        detail: `real SSURGO from data/raw/soils/${cached.name} (${report.polygons.inserted} polygons)`,
      }
    : {
        action: 'fixture',
        detail: `SYNTHETIC fixture (${report.polygons.inserted} polygons): run \`pnpm gis:soils\` once for real SSURGO`,
      };
}

/** Parcels (D7): the synthetic fixture until a real file has been imported. */
async function seedParcels(pool: pg.Pool, opts: ExtrasOptions): Promise<ExtrasReport['parcels']> {
  const real = await scalar<number>(
    pool,
    'select count(*)::int as v from gis.parcel_imports where source <> $1',
    [SYNTHETIC_SOURCE],
  );
  if (real > 0) {
    return {
      action: 'real-import',
      detail: 'a county or vendor parcel file is loaded; left alone',
    };
  }
  const s = await loadSyntheticParcels(pool, opts.projectDir, opts.log);
  if (s.inserted === 0 && s.updated === 0 && s.deleted === 0) {
    return { action: 'kept', detail: `${s.unchanged} synthetic parcels already loaded` };
  }
  return {
    action: 'synthetic',
    detail: `${s.inserted + s.updated} SYNTHETIC parcels (fictional owners; D7: \`pnpm gis:parcels <file>\` loads a real one)`,
  };
}

/** The demo extras; the caller owns the pool. */
export async function seedDemoExtras(pool: pg.Pool, opts: ExtrasOptions): Promise<ExtrasReport> {
  const people = await seedDemoPeople(pool, opts.secret);
  const soils = await seedSoils(pool, opts);
  const parcels = await seedParcels(pool, opts);
  const hasNaip = await scalar<boolean>(
    pool,
    `select exists (select 1 from gis.map_layers where key = 'naip') as v`,
  );
  if (!hasNaip) await writeOnlineRow(pool);
  return { people, soils, parcels, naip: { action: hasNaip ? 'kept' : 'online-row' } };
}

/** Report lines for the seed's output (two-space indent like formatSeedReport). */
export async function formatExtrasReport(
  pool: pg.Pool,
  r: ExtrasReport,
  secret: string,
): Promise<string[]> {
  const lines = [
    `  demo people        ${String(r.people.inserted).padStart(4)} inserted ${String(r.people.existing).padStart(4)} existing`,
    `  soils              ${r.soils.detail}`,
    `  parcels            ${r.parcels.detail}`,
    `  NAIP online layer  ${r.naip.action === 'kept' ? 'registered' : 'registered now (online only)'}`,
  ];
  const pins = formatDemoPins(await listDemoPeople(pool, secret));
  if (pins.length) {
    lines.push('  demo PINs (this install; switch them off on /admin/people before real use):');
    for (let i = 0; i < pins.length; i += 3) lines.push(`    ${pins.slice(i, i + 3).join(' · ')}`);
  }
  return lines;
}
