import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { booleanPointInPolygon, point, polygon } from '@turf/turf';
import { describe, expect, test } from 'vitest';
import { buildSimFarm } from '../../src/sim';
import {
  buildFixtureDatabase,
  cellRing,
  FIXTURE_IGNORE_FILE,
  FIXTURE_IGNORE_TEXT,
  FIXTURE_NOTE,
  generateFixtureFiles,
} from './soils-fixture';
import { toPolygonRows } from './soils-model';
import { openRun } from './soils-raw';
import { parseSdaBody, sdaRecords } from './soils-sda';

const FIXTURE_DIR = path.join(import.meta.dirname, 'fixtures', 'soils');

function parseRing(wkt: string): [number, number][] {
  const m = /^POLYGON \(\((.*)\)\)$/.exec(wkt);
  if (!m?.[1]) throw new Error(`not a simple polygon: ${wkt.slice(0, 40)}`);
  return m[1].split(', ').map((p) => p.split(' ').map(Number) as [number, number]);
}

describe('the committed soils fixture', () => {
  test('is exactly what the generator writes (regenerate: pnpm exec tsx tools/gis/soils-fixture.ts --write)', async () => {
    const generated = await generateFixtureFiles();
    const committed = (await readdir(FIXTURE_DIR)).filter((n) => n !== FIXTURE_IGNORE_FILE).sort();
    expect(committed).toEqual([...generated.keys()].sort());
    // Formatters keep out (the files are checksummed byte for byte).
    expect(await readFile(path.join(FIXTURE_DIR, FIXTURE_IGNORE_FILE), 'utf8')).toBe(
      FIXTURE_IGNORE_TEXT,
    );
    for (const name of committed) {
      expect(await readFile(path.join(FIXTURE_DIR, name), 'utf8'), name).toBe(generated.get(name));
    }
  }, 30_000);

  test('says it is synthetic and opens as a complete run with valid checksums', async () => {
    const run = await openRun(FIXTURE_DIR);
    expect(run.index.fixture).toBe(FIXTURE_NOTE);
    expect(run.index.areas).toEqual(['MI091', 'MI115']);
    for (const f of run.index.files) await run.read(f);
  });

  test('keys are fictional (999… prefixes, above any real SSURGO key)', () => {
    const db = buildFixtureDatabase();
    expect(db.mapunit.every((m) => m.mukey.startsWith('999'))).toBe(true);
    expect(db.component.every((c) => c.cokey.startsWith('999'))).toBe(true);
    expect(db.mupolygon.every((p) => p.mupolygonkey.startsWith('99'))).toBe(true);
  });

  test('neighbouring cells share their edge vertices (a gap-free tiling)', () => {
    const a = cellRing(10, 20);
    const east = cellRing(11, 20);
    // a's east edge: SE corner, east mid, NE corner = east's west edge reversed.
    expect([a[2], a[3], a[4]]).toEqual([east[0], east[7], east[6]]);
    const north = cellRing(10, 21);
    expect([a[4], a[5], a[6]]).toEqual([north[2], north[1], north[0]]);
  });

  test('covers every demo field completely (so field_soils sums to 100 %)', async () => {
    const run = await openRun(FIXTURE_DIR);
    const polys = [];
    for (const f of run.index.files.filter((x) => x.kind === 'polygons')) {
      for (const r of toPolygonRows(sdaRecords(parseSdaBody(await run.read(f))))) {
        polys.push(polygon([parseRing(r.wkt)]));
      }
    }
    for (const field of buildSimFarm().fields) {
      const ring = field.boundary.coordinates[0]?.[0] ?? [];
      const xs = ring.map((c) => c[0] as number);
      const ys = ring.map((c) => c[1] as number);
      const [w, e, s, n] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      for (let a = 0; a <= 4; a++) {
        for (let b = 0; b <= 4; b++) {
          const p = point([w + ((e - w) * a) / 4, s + ((n - s) * b) / 4]);
          expect(
            polys.some((poly) => booleanPointInPolygon(p, poly)),
            `${field.name} at ${a},${b}`,
          ).toBe(true);
        }
      }
    }
  }, 30_000);
});
