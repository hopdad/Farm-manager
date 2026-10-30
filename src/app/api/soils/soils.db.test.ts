/**
 * The soil map's routes against a real database (soil map Phase A), under chosen sessions:
 *
 *  - GET /api/soils/labels: ONE label point per soil polygon (a big L-shaped map unit spanning
 *    many tiles gets one, inside it, at the same spot whatever the bbox), only polygons that
 *    meet the bbox, small ones skipped at low zoom, largest first, capped (`truncated`), cache
 *    headers, refusals (401 signed out, 400 bad query).
 *  - GET /api/soils/mapunits/<mukey>: the map unit with its components, 404, 400.
 */
import type { MultiPolygon } from 'geojson';
import { beforeAll, describe, expect, test } from 'vitest';
import { geosHasInscribedCircle } from '@/db/queries/soils-labels';
import { makeSession, runWithSession } from '@/platform/auth/testing';
import { ROLES, type Role } from '@/platform/auth/types';
import { setupTestDb } from '@/test/db';
import { squareMultiPolygon } from '@/test/fixtures';
import type { SoilLabelsResponse } from '@/ui/map/layers/soils-labels';
import type { MapUnitDetail } from '@/ui/soils/protocol';
import { handleMapUnit, handleSoilLabels } from './handler';

const t = setupTestDb(import.meta.url);

const as = <T>(role: Role | null, fn: () => Promise<T>) =>
  runWithSession(role === null ? null : makeSession({ role }), fn);

/** The test area, around the demo farm (Lenawee County). */
const BBOX = '-84.20,41.80,-83.90,41.95';

const L_SHAPE: MultiPolygon = {
  type: 'MultiPolygon',
  coordinates: [
    [
      [
        [-84.18, 41.81],
        [-84.0, 41.81],
        [-84.0, 41.83],
        [-84.16, 41.83],
        [-84.16, 41.94],
        [-84.18, 41.94],
        [-84.18, 41.81],
      ],
    ],
  ],
};

async function insertUnit(mukey: string, musym: string, muname: string, components: unknown[]) {
  await t().pool.query(
    `insert into gis.soil_mapunits (mukey, areasymbol, musym, muname, dominant_component,
       drainage_class, hydgrp, farmland_class, nccpi, components, survey_version)
     values ($1, 'MI091', $2, $3, $4, 'Somewhat poorly drained', 'C/D',
       'Prime farmland if drained', 0.622, $5::jsonb, 'MI091 2025-09-05')`,
    [
      mukey,
      musym,
      muname,
      (components[0] as { name?: string } | undefined)?.name ?? null,
      JSON.stringify(components),
    ],
  );
}

async function insertPolygon(mukey: string, sourceId: string, geom: MultiPolygon): Promise<string> {
  const r = await t().pool.query<{ id: string }>(
    `insert into gis.soil_polygons (mukey, areasymbol, geom, source, source_id)
     values ($1, 'MI091', extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON($2), 4326), 'ssurgo', $3)
     returning id::text`,
    [mukey, JSON.stringify(geom), sourceId],
  );
  return r.rows[0]?.id ?? '';
}

const ids: Record<string, string> = {};

beforeAll(async () => {
  await insertUnit('100001', 'BnB', 'Blount loam, 1 to 4 percent slopes', [
    {
      name: 'Pewamo',
      pct: 10,
      major: false,
      drainageClass: 'Very poorly drained',
      hydgrp: 'C/D',
      nccpi: 0.66,
    },
    {
      name: 'Blount',
      pct: 85,
      major: true,
      drainageClass: 'Somewhat poorly drained',
      hydgrp: 'C/D',
      nccpi: 0.62,
    },
    {
      name: 'Glynwood',
      pct: 5,
      major: false,
      drainageClass: 'Moderately well drained',
      hydgrp: 'C/D',
      nccpi: 0.58,
    },
  ]);
  await insertUnit('100002', 'Pe', 'Pewamo silty clay loam, 0 to 1 percent slopes', [
    {
      name: 'Pewamo',
      pct: 90,
      major: true,
      drainageClass: 'Very poorly drained',
      hydgrp: 'C/D',
      nccpi: 0.67,
    },
  ]);
  ids.big = await insertPolygon('100001', 'big', L_SHAPE);
  ids.mid = await insertPolygon('100002', 'mid', squareMultiPolygon(-84.05, 41.88, 900));
  // Crosses the bbox's east edge (-83.90).
  ids.edge = await insertPolygon('100002', 'edge', squareMultiPolygon(-83.905, 41.86, 1500));
  ids.outside = await insertPolygon('100001', 'outside', squareMultiPolygon(-83.5, 41.6, 900));
  // About 6 m on a side: too small to label at z13, labelled at z18.
  ids.tiny = await insertPolygon('100002', 'tiny', squareMultiPolygon(-84.1, 41.9, 6));
  // A row of squares of growing size (for the cap): 100 m to 290 m.
  for (let i = 0; i < 20; i++) {
    ids[`sq${i}`] = await insertPolygon(
      i % 2 ? '100001' : '100002',
      `sq${i}`,
      squareMultiPolygon(-84.12 + i * 0.006, 41.86, 100 + i * 10),
    );
  }
});

async function labels(qs: string, opts: { limit?: number } = {}, role: Role | null = 'viewer') {
  const res = await as(role, () =>
    handleSoilLabels(new Request(`http://localhost:3121/api/soils/labels?${qs}`), t().pool, opts),
  );
  return res;
}

async function labelsBody(qs: string, opts: { limit?: number } = {}) {
  const res = await labels(qs, opts);
  expect(res.status).toBe(200);
  return (await res.json()) as SoilLabelsResponse;
}

async function inside(polygonId: string, [lng, lat]: [number, number]): Promise<boolean> {
  const r = await t().pool.query<{ inside: boolean }>(
    `select extensions.ST_Contains(geom, extensions.ST_SetSRID(extensions.ST_MakePoint($2, $3), 4326)) as inside
       from gis.soil_polygons where id = $1::uuid`,
    [polygonId, lng, lat],
  );
  return r.rows[0]?.inside === true;
}

describe('GET /api/soils/labels', () => {
  test('one point per polygon that meets the bbox, each inside its polygon', async () => {
    const body = await labelsBody(`bbox=${BBOX}&z=13`);
    expect(body.type).toBe('FeatureCollection');
    expect(body.truncated).toBe(false);
    const got = body.features.map((f) => f.id);
    // No repeats: one feature per polygon.
    expect(new Set(got).size).toBe(got.length);
    const want = [
      ids.big,
      ids.mid,
      ids.edge,
      ...Array.from({ length: 20 }, (_, i) => ids[`sq${i}`]),
    ];
    expect(new Set(got)).toEqual(new Set(want));
    expect(got).not.toContain(ids.outside);
    for (const f of body.features) {
      expect(f.geometry.type).toBe('Point');
      expect(await inside(f.id, f.geometry.coordinates), f.id).toBe(true);
    }
    const big = body.features.find((f) => f.id === ids.big);
    expect(big?.properties).toEqual({
      mukey: '100001',
      musym: 'BnB',
      muname: 'Blount loam, 1 to 4 percent slopes',
      rank: 0,
    });
  });

  test('the L-shaped map unit’s point is in its roomiest part, and never moves as the map pans', async () => {
    const a = (await labelsBody(`bbox=${BBOX}&z=13`)).features.find((f) => f.id === ids.big);
    // Another bbox that only catches the L's foot.
    const b = (await labelsBody('bbox=-84.10,41.80,-83.95,41.835&z=13')).features.find(
      (f) => f.id === ids.big,
    );
    expect(a?.geometry.coordinates).toEqual(b?.geometry.coordinates);
    // The L's centroid (about -84.13, 41.85) is outside it; a label there would float in the
    // corner. The inscribed-circle centre sits inside an arm.
    if (!a) throw new Error('no label for the L');
    expect(await inside(a.id, a.geometry.coordinates)).toBe(true);
    expect(await geosHasInscribedCircle(t().pool)).toBe(true);
  });

  test('small polygons are labelled only once they are big enough on screen', async () => {
    const z13 = await labelsBody(`bbox=${BBOX}&z=13`);
    expect(z13.features.map((f) => f.id)).not.toContain(ids.tiny);
    const z18 = await labelsBody('bbox=-84.102,41.899,-84.098,41.901&z=18');
    expect(z18.features.map((f) => f.id)).toContain(ids.tiny);
  });

  test('capped: the largest first, ranked, and `truncated` says so', async () => {
    const all = await labelsBody(`bbox=${BBOX}&z=13`);
    const capped = await labelsBody(`bbox=${BBOX}&z=13`, { limit: 5 });
    expect(capped.limit).toBe(5);
    expect(capped.truncated).toBe(true);
    expect(capped.features.map((f) => f.id)).toEqual(all.features.slice(0, 5).map((f) => f.id));
    expect(capped.features.map((f) => f.properties.rank)).toEqual([0, 1, 2, 3, 4]);
    // Largest first: the L, then the edge square (1.5 km), the mid square (900 m), then the row.
    expect(all.features.slice(0, 3).map((f) => f.id)).toEqual([ids.big, ids.edge, ids.mid]);
    expect(all.features.slice(3, 6).map((f) => f.id)).toEqual([ids.sq19, ids.sq18, ids.sq17]);
    const exact = await labelsBody(`bbox=${BBOX}&z=13`, { limit: all.features.length });
    expect(exact.truncated).toBe(false);
  });

  test('cache: private; kept a day when the URL names the soils version', async () => {
    expect((await labels(`bbox=${BBOX}&z=13&v=fixture-1`)).headers.get('cache-control')).toBe(
      'private, max-age=86400',
    );
    const plain = await labels(`bbox=${BBOX}&z=13`);
    expect(plain.headers.get('cache-control')).toBe('private, no-cache');
    expect(plain.headers.get('content-type')).toBe('application/json');
  });

  test('viewer-level: every role may read; signed out is 401', async () => {
    for (const role of ROLES)
      expect((await labels(`bbox=${BBOX}&z=13`, {}, role)).status).toBe(200);
    const res = await labels(`bbox=${BBOX}&z=13`, {}, null);
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test('a bad query is 400 (z below 13, a bbox too wide for the zoom, junk)', async () => {
    for (const qs of [`bbox=${BBOX}&z=12`, 'bbox=-85,41,-83,42.5&z=13', 'bbox=x&z=13', 'z=13']) {
      const res = await labels(qs);
      expect(res.status, qs).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBeTruthy();
    }
  });

  test('empty where there are no soils', async () => {
    const body = await labelsBody('bbox=-86.1,43.1,-86.0,43.2&z=13');
    expect(body.features).toEqual([]);
    expect(body.truncated).toBe(false);
  });
});

describe('GET /api/soils/mapunits/<mukey>', () => {
  test('the map unit with its components, largest first', async () => {
    const res = await as('viewer', () => handleMapUnit('100001', t().pool));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
    const d = (await res.json()) as MapUnitDetail;
    expect(d).toMatchObject({
      mukey: '100001',
      areasymbol: 'MI091',
      musym: 'BnB',
      muname: 'Blount loam, 1 to 4 percent slopes',
      dominantComponent: 'Pewamo',
      drainageClass: 'Somewhat poorly drained',
      hydgrp: 'C/D',
      farmlandClass: 'Prime farmland if drained',
      nccpi: 0.622,
      surveyVersion: 'MI091 2025-09-05',
      synthetic: false,
    });
    expect(d.components.map((c) => [c.name, c.pct, c.major])).toEqual([
      ['Blount', 85, true],
      ['Pewamo', 10, false],
      ['Glynwood', 5, false],
    ]);
  });

  test('404 unknown, 400 malformed, 401 signed out', async () => {
    expect((await as('viewer', () => handleMapUnit('999999', t().pool))).status).toBe(404);
    expect((await as('viewer', () => handleMapUnit('abc', t().pool))).status).toBe(400);
    expect((await as('viewer', () => handleMapUnit("1' or 1=1", t().pool))).status).toBe(400);
    expect((await as(null, () => handleMapUnit('100001', t().pool))).status).toBe(401);
  });
});
