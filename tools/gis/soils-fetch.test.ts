import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createFakeSda, type FakeSdaDatabase, type FakeSdaOptions } from './soils-fake-sda';
import { fetchSoilsRun } from './soils-fetch';
import { buildFixtureDatabase } from './soils-fixture';
import { toPolygonRows } from './soils-model';
import type { BatchLimits } from './soils-plan';
import { openRun, RUN_INDEX_FILE } from './soils-raw';
import { parseSdaBody, sdaRecords } from './soils-sda';

let db: FakeSdaDatabase;
let root: string;
beforeAll(() => {
  db = buildFixtureDatabase();
});
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'farm-soils-fetch-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const NOW = new Date('2026-10-29T12:00:00Z');
const LIMITS: BatchLimits = { maxBytes: 200_000, maxRows: 400, maxMukeys: 20, componentMukeys: 3 };

async function fetchWith(
  options: FakeSdaOptions = {},
  limits: BatchLimits = LIMITS,
  areas = ['MI091', 'MI115'],
) {
  const sda = createFakeSda(db, options);
  const logs: string[] = [];
  const res = await fetchSoilsRun({
    areas,
    rawRoot: root,
    client: { url: 'https://sda.invalid/Tabular/post.rest', fetch: sda.fetch, retries: 0 },
    limits,
    now: () => NOW,
    log: (m) => logs.push(m),
  });
  return { res, sda, logs };
}

/** Every polygon key in the run's polygon files (with repeats, if any). */
async function polygonKeys(dir: string): Promise<string[]> {
  const run = await openRun(dir);
  const keys: string[] = [];
  for (const f of run.index.files.filter((x) => x.kind === 'polygons')) {
    keys.push(
      ...toPolygonRows(sdaRecords(parseSdaBody(await run.read(f)))).map((r) => r.mupolygonkey),
    );
  }
  return keys;
}

const allKeys = () => db.mupolygon.map((p) => p.mupolygonkey).sort();

describe('fetchSoilsRun', () => {
  test('writes every reply verbatim, an index last, and manifest entries', async () => {
    const { res, sda } = await fetchWith();
    expect(path.relative(root, res.dir)).toBe(path.join('soils', '2026-10-29'));
    expect(res.splits).toBe(0);
    const names = (await readdir(res.dir)).sort();
    expect(names).toContain(RUN_INDEX_FILE);
    expect(names).toContain('survey.json');
    expect(names).toContain('MI091.stats.json');
    expect(names).toContain('MI115.components.001.json');
    expect(res.index.files.map((f) => f.file).sort()).toEqual(
      names.filter((n) => n !== RUN_INDEX_FILE),
    );
    // Components in batches of 3 map units: MI091 has 8 → 3 files.
    expect(
      res.index.files.filter((f) => f.area === 'MI091' && f.kind === 'components'),
    ).toHaveLength(3);
    // Every polygon exactly once.
    expect((await polygonKeys(res.dir)).sort()).toEqual(allKeys());
    // The queries recorded are the ones sent.
    expect(res.index.files.map((f) => f.query)).toEqual(
      expect.arrayContaining(sda.queries.filter((q) => /mupolygon AS p/.test(q))),
    );
    const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
    expect(manifest.entries).toHaveLength(res.index.files.length);
    expect(manifest.entries[0]).toMatchObject({
      source: 'soils',
      url: 'https://sda.invalid/Tabular/post.rest',
      method: 'POST',
    });
    expect(
      manifest.entries.every((e: { path: string }) => e.path.startsWith('soils/2026-10-29/')),
    ).toBe(true);
  });

  test('a silently empty reply (a limit hit) splits the batch until every polygon arrives', async () => {
    const { res, logs } = await fetchWith({ silentRowLimit: 25 });
    expect(res.splits).toBeGreaterThan(0);
    expect(logs.some((l) => /came back short/.test(l))).toBe(true);
    expect((await polygonKeys(res.dir)).sort()).toEqual(allKeys());
  });

  test('a failing multi-unit request (ServiceException) is split to single units', async () => {
    const { res } = await fetchWith({ failInListOver: 1 });
    expect(res.splits).toBeGreaterThan(0);
    expect((await polygonKeys(res.dir)).sort()).toEqual(allKeys());
  });

  test('map units too big for one reply are read in keyset pages', async () => {
    const small: BatchLimits = { maxBytes: 4_000, maxRows: 12, maxMukeys: 2, componentMukeys: 10 };
    const { res, sda } = await fetchWith({}, small);
    expect(sda.queries.some((q) => q.startsWith('SELECT TOP '))).toBe(true);
    const keys = await polygonKeys(res.dir);
    expect(keys.length).toBe(new Set(keys).size);
    expect(keys.sort()).toEqual(allKeys());
  });

  test('pages shrink when they come back short of the count', async () => {
    const small: BatchLimits = { maxBytes: 4_000, maxRows: 12, maxMukeys: 2, componentMukeys: 10 };
    const { res } = await fetchWith({ silentRowLimit: 5 }, small);
    expect((await polygonKeys(res.dir)).sort()).toEqual(allKeys());
  });

  test('one area only', async () => {
    const { res } = await fetchWith({}, LIMITS, ['mi115']);
    expect(res.index.areas).toEqual(['MI115']);
    expect(res.index.files.some((f) => f.area === 'MI091')).toBe(false);
  });

  test('a failed download leaves no run behind', async () => {
    await expect(fetchWith({ maintenance: true })).rejects.toMatchObject({ kind: 'unavailable' });
    expect(await readdir(path.join(root, 'soils'))).toEqual([]);
  });

  test('an unknown survey area fails before any map unit query', async () => {
    const sda = createFakeSda(db);
    await expect(
      fetchSoilsRun({
        areas: ['MI999'],
        rawRoot: root,
        client: { fetch: sda.fetch, retries: 0 },
        now: () => NOW,
      }),
    ).rejects.toThrow(/no survey area MI999/);
    expect(sda.queries).toHaveLength(1);
  });
});
