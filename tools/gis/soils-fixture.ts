/**
 * The committed SYNTHETIC soils fixture (tools/gis/fixtures/soils), for demos, CI and e2e when
 * Soil Data Access can't be reached (it answers 403 at the build machine's proxy). Owner: soils.
 *
 *   pnpm exec tsx tools/gis/soils-fixture.ts --write     regenerate it (after the demo fields move)
 *
 * What it is, honestly:
 *  - The SHAPES of everything are real: the fixture is produced by the real download code
 *    (./soils-fetch.ts) talking to a fake SDA (./soils-fake-sda.ts) that answers the real queries
 *    in SDA's documented JSON+COLUMNNAME format, so the files are exactly what a live run writes
 *    and the loader reads them through the same path.
 *  - The DATA is not survey data. Map unit keys, polygon keys and component keys are fictional
 *    (they start with 999, far above real SSURGO keys); polygons are a jittered grid of ~370 m
 *    cells around the demo farm's fields; map unit names and component attributes (drainage
 *    class, hydrologic group, NCCPI) are typical values for real SE Michigan soil series
 *    (Blount, Pewamo, Glynwood, Hoytville, Lenawee, Toledo, …), not their survey values.
 * run.json carries a `fixture` note saying so, the loader marks the layer "synthetic test
 * fixture" and refuses to load it over real SSURGO data. A real `pnpm gis:soils` replaces it.
 *
 * A unit test regenerates it in memory and compares it with the committed files, and checks that
 * every demo field is fully covered (so gis.field_soils sums to 100 % for each).
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { SOIL_SURVEY_AREAS } from '../../src/domain/soils';
import { isMainModule } from '../../src/lib/proc';
import { buildSimFarm, type SimField } from '../../src/sim';
import { createFakeSda, type FakeSdaDatabase } from './soils-fake-sda';
import { fetchSoilsRun } from './soils-fetch';
import type { BatchLimits } from './soils-plan';
import { RUN_INDEX_FILE } from './soils-raw';

export const FIXTURE_NOTE =
  'SYNTHETIC test fixture: SDA-shaped replies with fictional keys (999…) and grid polygons around the demo fields; ' +
  'series attributes are typical values, not survey data. Never load it over real SSURGO (pnpm gis:soils replaces it).';
/**
 * The fixture's files are SDA replies byte for byte, checksummed in run.json: Biome must never
 * reformat them. Biome honours `.ignore` files (vcs.useIgnoreFile); git does not, so the files
 * stay committed.
 */
export const FIXTURE_IGNORE_FILE = '.ignore';
export const FIXTURE_IGNORE_TEXT =
  '# Byte-exact SDA replies, checksummed in run.json: formatters must not touch them (Biome honours .ignore).\n*\n';
/** The fixture's fixed clock (its files must be byte-identical when regenerated). */
export const FIXTURE_NOW = new Date('2026-10-29T00:00:00.000Z');
export const FIXTURE_SDA_URL = 'https://SDMDataAccess.sc.egov.usda.gov/Tabular/post.rest';

/** Grid: origin and cell size in degrees (~373 m × 378 m at 41.9° N). */
const ORIGIN: [number, number] = [-84.3, 41.6];
const CELL: [number, number] = [0.0045, 0.0034];
/** Cells beyond a field's bbox (≥ the 0.2-cell corner jitter, so the field is always covered). */
const MARGIN_CELLS = 0.6;
/** Polygon batches small enough that the fixture has several files per area, like a county. */
export const FIXTURE_LIMITS: BatchLimits = {
  maxBytes: 64 * 1024,
  maxRows: 120,
  maxMukeys: 4,
  componentMukeys: 5,
};

interface UnitSpec {
  musym: string;
  muname: string;
  farmlndcl: string;
  weight: number;
  /** [series, pct, drainage, hydgrp, nccpi | null, kind]. */
  components: [string, number, string | null, string | null, number | null, string][];
}

const SERIES = 'Series';
const MISC = 'Miscellaneous area';

/** Typical SE Michigan series per county (illustrative attributes, see header). */
const UNITS: Record<string, UnitSpec[]> = {
  MI091: [
    {
      musym: 'BnB',
      muname: 'Blount loam, 1 to 4 percent slopes',
      farmlndcl: 'Prime farmland if drained',
      weight: 26,
      components: [
        ['Blount', 85, 'Somewhat poorly drained', 'C/D', 0.62, SERIES],
        ['Pewamo', 10, 'Very poorly drained', 'C/D', 0.66, SERIES],
        ['Glynwood', 5, 'Moderately well drained', 'C/D', 0.58, SERIES],
      ],
    },
    {
      musym: 'Pe',
      muname: 'Pewamo silty clay loam, 0 to 1 percent slopes',
      farmlndcl: 'Prime farmland if drained',
      weight: 20,
      components: [
        ['Pewamo', 90, 'Very poorly drained', 'C/D', 0.68, SERIES],
        ['Blount', 10, 'Somewhat poorly drained', 'C/D', 0.61, SERIES],
      ],
    },
    {
      musym: 'GlB',
      muname: 'Glynwood loam, 2 to 6 percent slopes',
      farmlndcl: 'All areas are prime farmland',
      weight: 16,
      components: [
        ['Glynwood', 85, 'Moderately well drained', 'C/D', 0.59, SERIES],
        ['Blount', 15, 'Somewhat poorly drained', 'C/D', 0.62, SERIES],
      ],
    },
    {
      musym: 'Ho',
      muname: 'Hoytville clay loam, 0 to 1 percent slopes',
      farmlndcl: 'Prime farmland if drained',
      weight: 10,
      components: [
        ['Hoytville', 90, 'Very poorly drained', 'C/D', 0.64, SERIES],
        ['Nappanee', 10, 'Somewhat poorly drained', 'C/D', 0.53, SERIES],
      ],
    },
    {
      musym: 'Le',
      muname: 'Lenawee silty clay loam, 0 to 1 percent slopes',
      farmlndcl: 'Prime farmland if drained',
      weight: 9,
      components: [['Lenawee', 95, 'Poorly drained', 'C/D', 0.63, SERIES]],
    },
    {
      musym: 'MoC2',
      muname: 'Morley loam, 6 to 12 percent slopes, eroded',
      farmlndcl: 'Farmland of local importance',
      weight: 7,
      components: [
        ['Morley', 85, 'Moderately well drained', 'C', 0.48, SERIES],
        ['Blount', 15, 'Somewhat poorly drained', 'C/D', 0.6, SERIES],
      ],
    },
    {
      musym: 'DeA',
      muname: 'Del Rey silt loam, 0 to 2 percent slopes',
      farmlndcl: 'Prime farmland if drained',
      weight: 10,
      components: [
        ['Del Rey', 85, 'Somewhat poorly drained', 'C/D', 0.61, SERIES],
        ['Lenawee', 15, 'Poorly drained', 'C/D', 0.63, SERIES],
      ],
    },
    {
      musym: 'W',
      muname: 'Water',
      farmlndcl: 'Not prime farmland',
      weight: 2,
      components: [['Water', 100, null, null, null, MISC]],
    },
  ],
  MI115: [
    {
      musym: 'To',
      muname: 'Toledo silty clay, 0 to 1 percent slopes',
      farmlndcl: 'Prime farmland if drained',
      weight: 26,
      components: [['Toledo', 90, 'Very poorly drained', 'C/D', 0.55, SERIES]],
    },
    {
      musym: 'NnA',
      muname: 'Nappanee silty clay loam, 0 to 3 percent slopes',
      farmlndcl: 'Farmland of local importance',
      weight: 18,
      components: [
        ['Nappanee', 85, 'Somewhat poorly drained', 'D', 0.52, SERIES],
        ['Hoytville', 15, 'Very poorly drained', 'C/D', 0.64, SERIES],
      ],
    },
    {
      musym: 'Ho',
      muname: 'Hoytville silty clay loam, 0 to 1 percent slopes',
      farmlndcl: 'Prime farmland if drained',
      weight: 20,
      components: [['Hoytville', 90, 'Very poorly drained', 'C/D', 0.65, SERIES]],
    },
    {
      musym: 'BlA',
      muname: 'Blount silt loam, 0 to 2 percent slopes',
      farmlndcl: 'Prime farmland if drained',
      weight: 16,
      components: [
        ['Blount', 85, 'Somewhat poorly drained', 'C/D', 0.63, SERIES],
        ['Pewamo', 15, 'Very poorly drained', 'C/D', 0.67, SERIES],
      ],
    },
    {
      musym: 'SeA',
      muname: 'Selfridge loamy sand, 0 to 3 percent slopes',
      farmlndcl: 'Farmland of local importance',
      weight: 10,
      components: [['Selfridge', 90, 'Somewhat poorly drained', 'A/D', 0.42, SERIES]],
    },
    {
      musym: 'Gr',
      muname: 'Granby loamy sand',
      farmlndcl: 'Farmland of local importance',
      weight: 10,
      components: [['Granby', 90, 'Very poorly drained', 'A/D', 0.36, SERIES]],
    },
  ],
};

const AREA_NAMES: Record<string, string> = {
  MI091: 'Lenawee County, Michigan',
  MI115: 'Monroe County, Michigan',
};
const COUNTY_AREA: Record<SimField['countyFips'], string> = { '26091': 'MI091', '26115': 'MI115' };

/** Deterministic hash of a string → [0, 1) (FNV-1a then an integer finaliser). */
function hash01(...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  for (const ch of parts.join('|')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 0x1_0000_0000;
}

const fmt = (n: number) => n.toFixed(6);

function corner(i: number, j: number): [number, number] {
  return [
    ORIGIN[0] + (i + (hash01('cx', i, j) - 0.5) * 0.4) * CELL[0],
    ORIGIN[1] + (j + (hash01('cy', i, j) - 0.5) * 0.4) * CELL[1],
  ];
}

/** Midpoint of the edge (i,j)-(i+1,j), nudged north/south. */
function hMid(i: number, j: number): [number, number] {
  const a = corner(i, j);
  const b = corner(i + 1, j);
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + (hash01('h', i, j) - 0.5) * 0.3 * CELL[1]];
}

/** Midpoint of the edge (i,j)-(i,j+1), nudged east/west. */
function vMid(i: number, j: number): [number, number] {
  const a = corner(i, j);
  const b = corner(i, j + 1);
  return [(a[0] + b[0]) / 2 + (hash01('v', i, j) - 0.5) * 0.3 * CELL[0], (a[1] + b[1]) / 2];
}

/** The cell's ring, counter-clockwise; neighbours share every vertex of a common edge. */
export function cellRing(i: number, j: number): [number, number][] {
  const ring = [
    corner(i, j),
    hMid(i, j),
    corner(i + 1, j),
    vMid(i + 1, j),
    corner(i + 1, j + 1),
    hMid(i, j + 1),
    corner(i, j + 1),
    vMid(i, j),
  ];
  return [...ring, ring[0] as [number, number]];
}

function pick<T extends { weight: number }>(items: readonly T[], u: number): T {
  const total = items.reduce((n, x) => n + x.weight, 0);
  let acc = 0;
  for (const x of items) {
    acc += x.weight / total;
    if (u < acc) return x;
  }
  return items[items.length - 1] as T;
}

function fieldBbox(f: SimField): [number, number, number, number] {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const poly of f.boundary.coordinates)
    for (const ring of poly)
      for (const [x, y] of ring) {
        w = Math.min(w, x as number);
        e = Math.max(e, x as number);
        s = Math.min(s, y as number);
        n = Math.max(n, y as number);
      }
  return [w, s, e, n];
}

/** Grid cells (i, j) whose nominal square meets the bbox grown by MARGIN_CELLS. */
export function cellsCovering(b: [number, number, number, number]): [number, number][] {
  const i0 = Math.floor((b[0] - ORIGIN[0]) / CELL[0] - MARGIN_CELLS);
  const i1 = Math.floor((b[2] - ORIGIN[0]) / CELL[0] + MARGIN_CELLS);
  const j0 = Math.floor((b[1] - ORIGIN[1]) / CELL[1] - MARGIN_CELLS);
  const j1 = Math.floor((b[3] - ORIGIN[1]) / CELL[1] + MARGIN_CELLS);
  const out: [number, number][] = [];
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) out.push([i, j]);
  return out;
}

/** The synthetic SSURGO tables around the demo farm's fields. */
export function buildFixtureDatabase(
  fields: readonly SimField[] = buildSimFarm().fields,
): FakeSdaDatabase {
  const db: FakeSdaDatabase = {
    sacatalog: SOIL_SURVEY_AREAS.map((a) => ({
      areasymbol: a,
      areaname: AREA_NAMES[a] ?? a,
      saverest: '10/29/2026 12:00:00 AM',
    })),
    mapunit: [],
    component: [],
    mupolygon: [],
  };
  const mukeyOf = new Map<string, string>();
  SOIL_SURVEY_AREAS.forEach((area, ai) => {
    (UNITS[area] ?? []).forEach((u, ui) => {
      const mukey = `9990${ai + 1}${String(ui + 1).padStart(3, '0')}`;
      mukeyOf.set(`${area}:${u.musym}`, mukey);
      db.mapunit.push({
        mukey,
        areasymbol: area,
        musym: u.musym,
        muname: u.muname,
        farmlndcl: u.farmlndcl,
      });
      u.components.forEach(([name, pct, drainage, hydgrp, nccpi, kind], ci) => {
        db.component.push({
          mukey,
          cokey: `${mukey}${ci + 1}`,
          compname: name,
          comppct_r: pct,
          majcompflag: pct >= 15 ? 'Yes' : 'No',
          compkind: kind,
          drainagecl: drainage,
          hydgrp,
          nccpi,
        });
      });
    });
  });

  // Each grid cell once, in the county of the first field (by key) that needs it.
  const cells = new Map<string, { i: number; j: number; area: string }>();
  for (const f of [...fields].sort((a, b) => a.key.localeCompare(b.key))) {
    const area = COUNTY_AREA[f.countyFips];
    for (const [i, j] of cellsCovering(fieldBbox(f))) {
      const k = `${i},${j}`;
      if (!cells.has(k)) cells.set(k, { i, j, area });
    }
  }
  let n = 0;
  for (const { i, j, area } of [...cells.values()].sort((a, b) => a.i - b.i || a.j - b.j)) {
    const units = UNITS[area] ?? [];
    // Patches: 2×2-cell blocks share a unit; a quarter of the cells pick their own.
    const own = hash01('own', i, j) < 0.25;
    const u = own
      ? pick(units, hash01('cell', i, j))
      : pick(units, hash01('block', Math.floor(i / 2), Math.floor(j / 2)));
    const ring = cellRing(i, j)
      .map(([x, y]) => `${fmt(x)} ${fmt(y)}`)
      .join(', ');
    db.mupolygon.push({
      mupolygonkey: `99${String(++n).padStart(8, '0')}`,
      mukey: mukeyOf.get(`${area}:${u.musym}`) as string,
      wkt: `POLYGON ((${ring}))`,
    });
  }
  return db;
}

/** Build the fixture run into `dir` (a fresh directory): the files a live run would write. */
export async function writeFixtureRun(rawRootDir: string): Promise<string> {
  const sda = createFakeSda(buildFixtureDatabase());
  const res = await fetchSoilsRun({
    areas: [...SOIL_SURVEY_AREAS],
    rawRoot: rawRootDir,
    client: { url: FIXTURE_SDA_URL, fetch: sda.fetch, retries: 0 },
    limits: FIXTURE_LIMITS,
    now: () => FIXTURE_NOW,
    fixtureNote: FIXTURE_NOTE,
  });
  return res.dir;
}

/** The fixture's files (name → text), regenerated in a temp directory. */
export async function generateFixtureFiles(): Promise<Map<string, string>> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'soils-fixture-'));
  try {
    const dir = await writeFixtureRun(tmp);
    const out = new Map<string, string>();
    for (const name of (await readdir(dir)).sort()) {
      out.set(name, await readFile(path.join(dir, name), 'utf8'));
    }
    return out;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { write: { type: 'boolean', default: false } },
    strict: true,
  });
  const files = await generateFixtureFiles();
  const target = path.join(process.cwd(), 'tools', 'gis', 'fixtures', 'soils');
  if (!values.write) {
    for (const [name, text] of files) console.log(`${name}  ${text.length} bytes`);
    console.log('(dry run: --write replaces tools/gis/fixtures/soils)');
    return;
  }
  await rm(target, { recursive: true, force: true });
  const { mkdir } = await import('node:fs/promises');
  await mkdir(target, { recursive: true });
  for (const [name, text] of files) await writeFile(path.join(target, name), text);
  await writeFile(path.join(target, FIXTURE_IGNORE_FILE), FIXTURE_IGNORE_TEXT);
  console.log(`wrote ${files.size} files (${RUN_INDEX_FILE} last listed) to ${target}`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
