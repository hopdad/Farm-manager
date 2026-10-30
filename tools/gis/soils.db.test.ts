/**
 * `pnpm gis:soils` against a real database (farm_app, like the CLI): the committed fixture over
 * the seeded demo farm, then the per-boundary clip (gis.field_soils, migration 0003's trigger and
 * gis.rebuild_field_soils), idempotency, retiring what a survey drops, the fixture guard, the
 * registry row and tile version, the soils MVT, and the realtime messages a load sends.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { TILE_LAYERS } from '../../src/app/api/tiles/layers';
import { fieldSoils, soilsLayerInfo } from '../../src/db/queries/soils';
import { demoId } from '../../src/domain/ids';
import { summarizeFieldSoils } from '../../src/domain/soils';
import { buildDemoFarm } from '../../src/sim/farm/build';
import { setupTestDb } from '../../src/test/db';
import { squareMultiPolygon, tileFor } from '../../src/test/fixtures';
import { seedDemo } from '../seed/demo';
import { createFakeSda } from './soils-fake-sda';
import { fetchSoilsRun } from './soils-fetch';
import { buildFixtureDatabase, FIXTURE_LIMITS, FIXTURE_NOTE } from './soils-fixture';
import { loadSoilsRun, PER_FIELD_PUBLISH_MAX, soilsVersion } from './soils-load';
import { openRun, type SoilsRun } from './soils-raw';

const t = setupTestDb(import.meta.url);
const farm = buildDemoFarm(1);
const FIXTURE_DIR = path.join(import.meta.dirname, 'fixtures', 'soils');
let fixture: SoilsRun;
let tmp: string;

beforeAll(async () => {
  await seedDemo(t().pool, { seed: 1 });
  fixture = await openRun(FIXTURE_DIR);
  tmp = await mkdtemp(path.join(tmpdir(), 'farm-soils-db-'));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** Centre of a demo field's bbox (inside the fixture's coverage, unlike the road entrance). */
function centerOf(field: (typeof farm.fields)[number]): [number, number] {
  const ring = field.boundary.coordinates[0]?.[0] ?? [];
  const xs = ring.map((c) => c[0] as number);
  const ys = ring.map((c) => c[1] as number);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

/** Per current boundary: summed pct and acres vs the boundary's acres. */
async function sums() {
  const r = await t().pool.query<{
    field_id: string;
    pct: string;
    acres: string;
    boundary_acres: string;
    n: string;
  }>(
    `select b.field_id::text, coalesce(sum(fs.pct), 0)::text as pct,
            coalesce(sum(fs.acres), 0)::text as acres, b.acres::text as boundary_acres,
            count(fs.mukey)::text as n
       from farm.current_boundaries b
       left join gis.field_soils fs on fs.boundary_id = b.id
      group by b.field_id, b.acres`,
  );
  return r.rows.map((x) => ({
    fieldId: x.field_id,
    pct: Number(x.pct),
    acres: Number(x.acres),
    boundaryAcres: Number(x.boundary_acres),
    n: Number(x.n),
  }));
}

/** Collect app.publish notifications while `fn` runs. */
async function listen<T>(fn: () => Promise<T>): Promise<{
  result: T;
  messages: { topic: string; event: string; payload: Record<string, unknown> }[];
}> {
  const client = new pg.Client({ connectionString: t().appUrl });
  await client.connect();
  const messages: { topic: string; event: string; payload: Record<string, unknown> }[] = [];
  client.on('notification', (n) => {
    if (n.channel === 'app_events' && n.payload) messages.push(JSON.parse(n.payload));
  });
  await client.query('listen app_events');
  try {
    const result = await fn();
    // Notifications are delivered on commit; give the socket a moment.
    for (let i = 0; i < 50 && messages.length === 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 50));
    return { result, messages };
  } finally {
    await client.end();
  }
}

describe('gis:soils load (fixture) over the demo farm', () => {
  test('first load: map units, polygons, registry row, and field soils summing to 100 % per field', async () => {
    const { result: report, messages } = await listen(() => loadSoilsRun(t().pool, fixture));
    expect(report.fixture).toBe(true);
    expect(report.version).toBe(soilsVersion(fixture));
    expect(report.version).toMatch(/^fixture-[0-9a-f]{12}$/);
    expect(report.mapunits.inserted).toBe(14);
    expect(report.polygons.inserted).toBeGreaterThan(400);
    expect(report.polygons.invalid).toBe(0);

    const s = await sums();
    expect(s).toHaveLength(farm.fields.length);
    for (const f of s) {
      expect(f.n, f.fieldId).toBeGreaterThanOrEqual(1);
      expect(Math.abs(f.pct - 100), `${f.fieldId} pct ${f.pct}`).toBeLessThan(0.05);
      expect(Math.abs(f.acres - f.boundaryAcres) / f.boundaryAcres).toBeLessThan(0.001);
    }
    expect(report.changedFields.sort()).toEqual(s.map((x) => x.fieldId).sort());

    // Realtime: the layer and each field whose soils changed (40 ≤ the per-field cap).
    expect(farm.fields.length).toBeLessThanOrEqual(PER_FIELD_PUBLISH_MAX);
    expect(messages).toContainEqual(
      expect.objectContaining({
        topic: 'layers',
        event: 'updated',
        payload: expect.objectContaining({ key: 'soils', version: report.version }),
      }),
    );
    const fieldMsgs = messages.filter((m) => m.topic === 'fields' && m.event === 'updated');
    expect(fieldMsgs.map((m) => m.payload.fieldId).sort()).toEqual(report.changedFields.sort());
    expect(fieldMsgs.every((m) => JSON.stringify(m.payload.parts) === '["soils"]')).toBe(true);

    const info = await soilsLayerInfo(t().pool);
    expect(info).toMatchObject({ version: report.version, fixture: true, mapunits: 14 });
    expect(info.sourceVintage).toMatch(/Synthetic/);
    const row = await t().pool.query(
      `select attribution, meta from gis.map_layers where key = 'soils'`,
    );
    expect(row.rows[0].attribution).toMatch(/synthetic/i);
    expect(row.rows[0].meta).toMatchObject({ fixture: true, areas: ['MI091', 'MI115'] });
    // The tiles route's version is the loader's (so ?v= changes with the data).
    expect(await TILE_LAYERS.soils.version(t().pool)).toBe(report.version);
  });

  test('the app query reads a field’s soils, largest first, and the summary weights NCCPI', async () => {
    const field = farm.fields[0];
    if (!field) throw new Error('no demo field');
    const rows = await fieldSoils(t().pool, field.id);
    expect(rows.length).toBeGreaterThan(0);
    for (let i = 1; i < rows.length; i++) {
      expect((rows[i - 1] as { acres: number }).acres).toBeGreaterThanOrEqual(
        (rows[i] as { acres: number }).acres,
      );
    }
    expect(rows[0]).toMatchObject({
      mukey: expect.stringMatching(/^999/),
      muname: expect.any(String),
    });
    const summary = summarizeFieldSoils(rows);
    expect(summary.coveredPct).toBeCloseTo(100, 0);
    const rated = rows.filter((r) => r.nccpi !== null);
    if (rated.length) {
      const expected =
        rated.reduce((n, r) => n + (r.nccpi as number) * r.acres, 0) /
        rated.reduce((n, r) => n + r.acres, 0);
      expect(summary.weightedNccpi).toBeCloseTo(expected, 2);
    }
  });

  test('a second load changes nothing: no row rewritten, same version, nothing published per field', async () => {
    const before = await t().pool.query(
      `select string_agg(xmin::text, ',' order by id) as x from gis.soil_polygons`,
    );
    const { result: report, messages } = await listen(() => loadSoilsRun(t().pool, fixture));
    const after = await t().pool.query(
      `select string_agg(xmin::text, ',' order by id) as x from gis.soil_polygons`,
    );
    expect(after.rows[0].x).toBe(before.rows[0].x);
    expect(report.mapunits).toEqual({ inserted: 0, updated: 0, unchanged: 14, deleted: 0 });
    expect(report.polygons.inserted + report.polygons.updated + report.polygons.deleted).toBe(0);
    expect(report.changedFields).toEqual([]);
    expect(messages.filter((m) => m.topic === 'fields')).toEqual([]);
  });

  test('the MVT has soils at z12 over a demo field and nothing below z10', async () => {
    const field = farm.fields[0];
    if (!field) throw new Error('no demo field');
    const [lng, lat] = centerOf(field);
    const z12 = tileFor(lng, lat, 12);
    const r = await t().pool.query<{ mvt: Buffer }>('select app.mvt_soils($1, $2, $3) as mvt', [
      z12.z,
      z12.x,
      z12.y,
    ]);
    expect(r.rows[0]?.mvt.length).toBeGreaterThan(100);
    const z9 = tileFor(lng, lat, 9);
    const low = await t().pool.query<{ mvt: Buffer }>('select app.mvt_soils($1, $2, $3) as mvt', [
      z9.z,
      z9.x,
      z9.y,
    ]);
    expect(low.rows[0]?.mvt.length).toBe(0);
  });
});

describe('field soils follow boundary versions (migration 0003 trigger)', () => {
  const fieldOf = () => {
    const f = farm.fields[1];
    if (!f) throw new Error('no demo field');
    return f;
  };

  test('a new boundary version gets its soils at once; closing the old one leaves them alone', async () => {
    const field = fieldOf();
    const oldId = demoId(`boundary:${field.key}`);
    const stamp = await t().pool.query(
      `select max(computed_at) as c, count(*) as n from gis.field_soils where boundary_id = $1`,
      [oldId],
    );
    const [lng, lat] = centerOf(field);
    const geom = squareMultiPolygon(lng, lat, 300);
    const client = await t().pool.connect();
    let newId: string;
    try {
      await client.query('begin');
      await client.query(
        `update farm.field_boundaries set valid = tstzrange(lower(valid), now()) where id = $1`,
        [oldId],
      );
      const ins = await client.query<{ id: string }>(
        `insert into farm.field_boundaries (field_id, geom, valid, source)
         values ($1, extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON($2), 4326), tstzrange(now(), null), 'import')
         returning id`,
        [field.id, JSON.stringify(geom)],
      );
      newId = ins.rows[0]?.id as string;
      await client.query('commit');
    } finally {
      client.release();
    }
    const fresh = await t().pool.query<{ pct: string; n: string }>(
      `select sum(pct)::text as pct, count(*)::text as n from gis.field_soils where boundary_id = $1`,
      [newId],
    );
    expect(Number(fresh.rows[0]?.n)).toBeGreaterThanOrEqual(1);
    expect(Math.abs(Number(fresh.rows[0]?.pct) - 100)).toBeLessThan(0.05);
    // The closed version keeps its soils, untouched (history).
    const old = await t().pool.query(
      `select max(computed_at) as c, count(*) as n from gis.field_soils where boundary_id = $1`,
      [oldId],
    );
    expect(old.rows[0]).toEqual(stamp.rows[0]);
    // And the app reads the current version's soils.
    const rows = await fieldSoils(t().pool, field.id);
    expect(rows.reduce((n, r) => n + r.pct, 0)).toBeCloseTo(100, 0);
  });

  test('changing a boundary geometry recomputes; a boundary off the soils has none', async () => {
    const field = fieldOf();
    const cur = await t().pool.query<{ id: string }>(
      `select id from farm.current_boundaries where field_id = $1`,
      [field.id],
    );
    const id = cur.rows[0]?.id as string;
    // Far outside the fixture (Lake Erie): no soils.
    await t().pool.query(
      `update farm.field_boundaries set geom = extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON($2), 4326) where id = $1`,
      [id, JSON.stringify(squareMultiPolygon(-83.2, 41.75, 300))],
    );
    const none = await t().pool.query(
      `select count(*)::int as n from gis.field_soils where boundary_id = $1`,
      [id],
    );
    expect(none.rows[0].n).toBe(0);
    expect(await fieldSoils(t().pool, field.id)).toEqual([]);
    // Back over the fixture: recomputed, sums to 100 again.
    const [lng, lat] = centerOf(field);
    await t().pool.query(
      `update farm.field_boundaries set geom = extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON($2), 4326) where id = $1`,
      [id, JSON.stringify(squareMultiPolygon(lng, lat, 250))],
    );
    const back = await t().pool.query<{ pct: string }>(
      `select sum(pct)::text as pct from gis.field_soils where boundary_id = $1`,
      [id],
    );
    expect(Math.abs(Number(back.rows[0]?.pct) - 100)).toBeLessThan(0.05);
  });
});

describe('reloads', () => {
  test('a survey that drops a map unit retires it, its polygons, and its field soils', async () => {
    const db = buildFixtureDatabase();
    const gone = db.mapunit.find((m) => m.musym === 'Le');
    if (!gone) throw new Error('fixture has no Le');
    db.mapunit = db.mapunit.filter((m) => m !== gone);
    db.component = db.component.filter((c) => c.mukey !== gone.mukey);
    const goneKeys = db.mupolygon.filter((p) => p.mukey === gone.mukey).length;
    db.mupolygon = db.mupolygon.filter((p) => p.mukey !== gone.mukey);
    const sda = createFakeSda(db);
    const res = await fetchSoilsRun({
      areas: ['MI091', 'MI115'],
      rawRoot: tmp,
      client: { fetch: sda.fetch, retries: 0 },
      limits: FIXTURE_LIMITS,
      fixtureNote: FIXTURE_NOTE,
    });
    const report = await loadSoilsRun(t().pool, await openRun(res.dir));
    expect(report.mapunits.deleted).toBe(1);
    expect(report.polygons.deleted).toBe(goneKeys);
    expect(report.version).not.toBe(soilsVersion(fixture));
    const left = await t().pool.query(
      `select count(*)::int as n from gis.field_soils where mukey = $1`,
      [gone.mukey],
    );
    expect(left.rows[0].n).toBe(0);
    // Put the full fixture back.
    const back = await loadSoilsRun(t().pool, fixture);
    expect(back.mapunits.inserted).toBe(1);
  });

  test('the synthetic fixture never replaces real SSURGO data unless forced', async () => {
    await t().pool.query(
      `update gis.map_layers set meta = meta || '{"fixture": false}'::jsonb where key = 'soils'`,
    );
    await expect(loadSoilsRun(t().pool, fixture)).rejects.toThrow(/real SSURGO soils/);
    const forced = await loadSoilsRun(t().pool, fixture, { force: true });
    expect(forced.fixture).toBe(true);
    expect((await soilsLayerInfo(t().pool)).fixture).toBe(true);
  });

  test('a corrupted cache file is refused before anything is written', async () => {
    const db = buildFixtureDatabase();
    const sda = createFakeSda(db);
    const res = await fetchSoilsRun({
      areas: ['MI115'],
      rawRoot: tmp,
      client: { fetch: sda.fetch, retries: 0 },
      limits: FIXTURE_LIMITS,
      fixtureNote: FIXTURE_NOTE,
    });
    const { writeFile } = await import('node:fs/promises');
    const stats = res.index.files.find((f) => f.kind === 'stats');
    if (!stats) throw new Error('no stats file');
    await writeFile(path.join(res.dir, stats.file), '{}');
    const before = await soilsLayerInfo(t().pool);
    await expect(loadSoilsRun(t().pool, await openRun(res.dir))).rejects.toThrow(
      /does not match run\.json/,
    );
    expect(await soilsLayerInfo(t().pool)).toEqual(before);
  });
});
