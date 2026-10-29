/**
 * The M1 migration (db/migrations/0003_m1_see_it.sql) as the app sees it, running as farm_app:
 * field soils rebuilt on every boundary version, parcel acreage, the new MVT layers, the layer
 * registry rows, and the constraints the builders rely on.
 */
import type { MultiLineString } from 'geojson';
import { describe, expect, test } from 'vitest';
import { decodeMvt } from '../../tools/gis/mvt';
import { setupTestDb } from '../test/db';
import {
  ADRIAN_QUARTER_SECTION,
  HALF_MILE_M,
  insertField,
  squareMultiPolygon,
  tileFor,
} from '../test/fixtures';
import { fieldBoundaries, parcelImports, parcels, tileLines } from './schema';

const t = setupTestDb(import.meta.url);

const [swLng, swLat] = ADRIAN_QUARTER_SECTION.coordinates[0]?.[0]?.[0] ?? [0, 0];
const SW = { lng: swLng ?? 0, lat: swLat ?? 0 };

/** A soil map unit with one polygon (as postgres: the gis:soils loader's role). */
async function insertSoil(mukey: string, geom: object, nccpi: number | null = 0.62) {
  await t().admin.query(
    `insert into gis.soil_mapunits (mukey, areasymbol, musym, muname, dominant_component,
            drainage_class, hydgrp, farmland_class, nccpi)
     values ($1, 'MI091', $2, $3, 'Blount', 'Somewhat poorly drained', 'C/D',
             'Prime farmland if drained', $4)
     on conflict (mukey) do nothing`,
    [mukey, `B${mukey}`, `Blount loam ${mukey}`, nccpi],
  );
  await t().admin.query(
    `insert into gis.soil_polygons (mukey, areasymbol, geom, source_id)
     values ($1, 'MI091', extensions.ST_Multi(extensions.ST_SetSRID(
               extensions.ST_GeomFromGeoJSON($2), 4326)), $3)`,
    [mukey, JSON.stringify(geom), `test:${mukey}:${Math.random()}`],
  );
}

async function fieldSoils(boundaryId: string) {
  const r = await t().pool.query<{ mukey: string; acres: string; pct: string }>(
    'select mukey, acres, pct from gis.field_soils where boundary_id = $1 order by mukey',
    [boundaryId],
  );
  return r.rows.map((x) => ({ mukey: x.mukey, acres: Number(x.acres), pct: Number(x.pct) }));
}

describe('gis.field_soils', () => {
  test('a new boundary version gets its soils at once (trigger, as farm_app)', async () => {
    // West half of the quarter section is mukey 100, east half 200, plus a far-away polygon.
    const half = squareMultiPolygon(SW.lng, SW.lat, HALF_MILE_M);
    const ring = half.coordinates[0]?.[0] ?? [];
    const midLng = ((ring[0]?.[0] ?? 0) + (ring[1]?.[0] ?? 0)) / 2;
    const west = {
      type: 'Polygon',
      coordinates: [
        [
          [SW.lng - 0.01, SW.lat - 0.01],
          [midLng, SW.lat - 0.01],
          [midLng, SW.lat + 0.02],
          [SW.lng - 0.01, SW.lat + 0.02],
          [SW.lng - 0.01, SW.lat - 0.01],
        ],
      ],
    };
    const east = {
      type: 'Polygon',
      coordinates: [
        [
          [midLng, SW.lat - 0.01],
          [SW.lng + 0.03, SW.lat - 0.01],
          [SW.lng + 0.03, SW.lat + 0.02],
          [midLng, SW.lat + 0.02],
          [midLng, SW.lat - 0.01],
        ],
      ],
    };
    await insertSoil('100', west, 0.5);
    await insertSoil('200', east, 0.8);
    await insertSoil('900', squareMultiPolygon(-83.5, 41.7, 500), 0.1);

    const { boundaryId, fieldId } = await insertField(t().db, { geom: ADRIAN_QUARTER_SECTION });
    if (!boundaryId) throw new Error('no boundary');
    const rows = await fieldSoils(boundaryId);
    expect(rows.map((r) => r.mukey)).toEqual(['100', '200']);
    for (const r of rows) {
      expect(r.pct).toBeGreaterThan(49);
      expect(r.pct).toBeLessThan(51);
      expect(r.acres).toBeGreaterThan(78);
      expect(r.acres).toBeLessThan(82);
    }

    // A new version (the west half only) gets its own rows; the old version keeps its own.
    const cut = new Date();
    await t().pool.query(
      `update farm.field_boundaries set valid = tstzrange(lower(valid), $2::timestamptz, '[)')
        where id = $1`,
      [boundaryId, cut.toISOString()],
    );
    const westHalf = squareMultiPolygon(SW.lng, SW.lat, HALF_MILE_M / 2);
    const [next] = await t()
      .db.insert(fieldBoundaries)
      .values({
        fieldId,
        geom: westHalf,
        source: 'drawn',
        valid: { from: cut, to: null },
      })
      .returning({ id: fieldBoundaries.id });
    if (!next) throw new Error('no new version');
    const nextRows = await fieldSoils(next.id);
    expect(nextRows.map((r) => r.mukey)).toEqual(['100']);
    expect(nextRows[0]?.pct).toBeCloseTo(100, 0);
    expect((await fieldSoils(boundaryId)).length).toBe(2);
  });

  test('editing a geometry rebuilds; closing a version does not', async () => {
    const { boundaryId } = await insertField(t().db, {
      geom: squareMultiPolygon(SW.lng + 0.001, SW.lat + 0.001, 200),
    });
    if (!boundaryId) throw new Error('no boundary');
    const before = await fieldSoils(boundaryId);
    expect(before.map((r) => r.mukey)).toEqual(['100']);
    const far = squareMultiPolygon(-83.5, 41.7, 200);
    await t().pool.query(
      `update farm.field_boundaries
          set geom = extensions.ST_Multi(extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON($2), 4326))
        where id = $1`,
      [boundaryId, JSON.stringify(far)],
    );
    expect((await fieldSoils(boundaryId)).map((r) => r.mukey)).toEqual(['900']);
    const stamp = await t().pool.query<{ c: Date }>(
      'select computed_at as c from gis.field_soils where boundary_id = $1',
      [boundaryId],
    );
    await t().pool.query(
      `update farm.field_boundaries set valid = tstzrange(lower(valid), now() + interval '1 day', '[)')
        where id = $1`,
      [boundaryId],
    );
    const again = await t().pool.query<{ c: Date }>(
      'select computed_at as c from gis.field_soils where boundary_id = $1',
      [boundaryId],
    );
    expect(again.rows[0]?.c.getTime()).toBe(stamp.rows[0]?.c.getTime());
  });

  test('farm_app can rebuild one boundary or all of them (after a soils load)', async () => {
    const { boundaryId } = await insertField(t().db, {
      geom: squareMultiPolygon(SW.lng + 0.002, SW.lat + 0.002, 150),
    });
    if (!boundaryId) throw new Error('no boundary');
    await t().pool.query('delete from gis.field_soils where boundary_id = $1', [boundaryId]);
    const one = await t().pool.query<{ n: number }>('select gis.rebuild_field_soils($1) as n', [
      boundaryId,
    ]);
    expect(one.rows[0]?.n).toBe(1);
    const all = await t().pool.query<{ n: number }>('select gis.rebuild_all_field_soils() as n');
    expect(all.rows[0]?.n).toBeGreaterThanOrEqual(4);
    // Not callable by anyone else (revoked from PUBLIC).
    const acl = await t().admin.query<{ ok: boolean }>(
      `select has_function_privilege('public', 'gis.rebuild_field_soils(uuid)', 'execute') as ok`,
    );
    expect(acl.rows[0]?.ok).toBe(false);
  });
});

describe('gis.parcels', () => {
  test('gis_acres follows the geometry; farm_app writes through the trigger', async () => {
    const [imp] = await t()
      .db.insert(parcelImports)
      .values({ source: 'synthetic', countyFips: '26091', licenseNote: 'synthetic fixture' })
      .returning({ id: parcelImports.id });
    if (!imp) throw new Error('no import');
    const [p] = await t()
      .db.insert(parcels)
      .values({
        importId: imp.id,
        countyFips: '26091',
        parcelNo: 'XA0-123-4567-00',
        ownerName: 'Example Owner',
        ownerMailing: '1 Main St, Adrian MI',
        geom: ADRIAN_QUARTER_SECTION,
      })
      .returning({ gisAcres: parcels.gisAcres, acres: parcels.acres });
    expect(p?.gisAcres).toBeCloseTo(160, 0);
    expect(p?.acres).toBeNull();
    await expect(
      t().pool.query(
        `insert into gis.parcels (import_id, county_fips, parcel_no, geom)
         select import_id, county_fips, parcel_no, geom from gis.parcels limit 1`,
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });
});

describe('MVT layers', () => {
  const inside = { lng: SW.lng + 0.004, lat: SW.lat + 0.003 };
  const mvt = async (fn: string, z: number) => {
    const { x, y } = tileFor(inside.lng, inside.lat, z);
    const r = await t().pool.query<{ m: Buffer }>(`select app.${fn}($1, $2, $3) as m`, [z, x, y]);
    return r.rows[0]?.m ?? Buffer.alloc(0);
  };

  test('app.mvt_soils: layer soils with the map unit properties; empty below z10', async () => {
    const layers = decodeMvt(new Uint8Array(await mvt('mvt_soils', 14)));
    expect(layers.map((l) => l.name)).toEqual(['soils']);
    const f = layers[0]?.features.find((x) => x.properties.mukey === '100');
    expect(f?.properties).toMatchObject({
      mukey: '100',
      musym: 'B100',
      muname: 'Blount loam 100',
      drainage_class: 'Somewhat poorly drained',
      hydgrp: 'C/D',
      farmland_class: 'Prime farmland if drained',
      nccpi: 0.5,
    });
    expect((await mvt('mvt_soils', 9)).length).toBe(0);
  });

  test('app.mvt_parcels: owner fields (private layer); empty below z12', async () => {
    const layers = decodeMvt(new Uint8Array(await mvt('mvt_parcels', 14)));
    expect(layers.map((l) => l.name)).toEqual(['parcels']);
    const props = layers[0]?.features[0]?.properties;
    expect(props).toMatchObject({
      county_fips: '26091',
      parcel_no: 'XA0-123-4567-00',
      owner_name: 'Example Owner',
      owner_mailing: '1 Main St, Adrian MI',
    });
    expect(props?.acres).toBeCloseTo(160, 0);
    expect((await mvt('mvt_parcels', 11)).length).toBe(0);
  });

  test('app.mvt_tile_lines: line features with size, depth and date; empty below z12', async () => {
    const line: MultiLineString = {
      type: 'MultiLineString',
      coordinates: [
        [
          [SW.lng + 0.001, SW.lat + 0.003],
          [SW.lng + 0.008, SW.lat + 0.003],
        ],
      ],
    };
    const { fieldId } = await insertField(t().db);
    await t().db.insert(tileLines).values({
      fieldId,
      geom: line,
      kind: 'main',
      sizeIn: 6,
      depthFt: 3.5,
      installedOn: '2019-05-02',
      origin: 'installer_drawing',
      source: 'import',
      sourceId: 'test-line-1',
    });
    const layers = decodeMvt(new Uint8Array(await mvt('mvt_tile_lines', 15)));
    expect(layers.map((l) => l.name)).toEqual(['tile_lines']);
    const f = layers[0]?.features[0];
    expect(f?.type).toBe('LineString');
    expect(f?.properties).toMatchObject({
      field_id: fieldId,
      kind: 'main',
      origin: 'installer_drawing',
      size_in: 6,
      depth_ft: 3.5,
      installed_on: '2019-05-02',
    });
    expect((await mvt('mvt_tile_lines', 11)).length).toBe(0);
  });
});

describe('gis.map_layers', () => {
  test('the migration registers the MVT layers with their cache policies', async () => {
    const r = await t().pool.query(
      `select key, kind, url_or_key, cache_policy, default_visible from gis.map_layers order by key`,
    );
    expect(r.rows).toEqual([
      {
        key: 'fields',
        kind: 'mvt',
        url_or_key: '/api/tiles/fields',
        cache_policy: 'private',
        default_visible: true,
      },
      {
        key: 'parcels',
        kind: 'mvt',
        url_or_key: '/api/tiles/parcels',
        cache_policy: 'private',
        default_visible: false,
      },
      {
        key: 'soils',
        kind: 'mvt',
        url_or_key: '/api/tiles/soils',
        cache_policy: 'public',
        default_visible: false,
      },
      {
        key: 'tile_lines',
        kind: 'mvt',
        url_or_key: '/api/tiles/tile_lines',
        cache_policy: 'private',
        default_visible: false,
      },
    ]);
  });

  test.each([
    ["insert into gis.map_layers (key, kind, url_or_key) values ('Bad-Key', 'mvt', 'x')", '23514'],
    ["insert into gis.map_layers (key, kind, url_or_key) values ('ok', 'geojson', 'x')", '23514'],
    [
      "insert into gis.map_layers (key, kind, url_or_key, minzoom, maxzoom) values ('ok', 'xyz', 'x', 14, 12)",
      '23514',
    ],
  ])('rejects %s', async (sql, code) => {
    await expect(t().pool.query(sql)).rejects.toMatchObject({ code });
  });
});

describe('1a/1b constraints', () => {
  async function party(name: string): Promise<string> {
    const r = await t().pool.query<{ id: string }>(
      `insert into farm.parties (kind, display_name, roles) values ('person', $1, '{crew}') returning id`,
      [name],
    );
    return r.rows[0]?.id as string;
  }

  test('app users: one per party, known roles only', async () => {
    const p = await party('Dana');
    await t().pool.query(`insert into farm.app_users (party_id, role) values ($1, 'operator')`, [
      p,
    ]);
    await expect(
      t().pool.query(`insert into farm.app_users (party_id, role) values ($1, 'viewer')`, [p]),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      t().pool.query(`insert into farm.app_users (party_id, role) values ($1, 'admin')`, [
        await party('Eve'),
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  test('a device on its own is never a manager', async () => {
    await t().pool.query(
      `insert into farm.devices (kind, name, role) values ('wall', 'Shop wall', 'viewer')`,
    );
    await expect(
      t().pool.query(
        `insert into farm.devices (kind, name, role) values ('cab_ipad', 'Cab 1', 'manager')`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      t().pool.query(`insert into farm.devices (kind, name) values ('tablet', 'X')`),
    ).rejects.toMatchObject({ code: '23514' });
  });

  test('one open geofence visit per machine and geofence', async () => {
    const m = await t().pool.query<{ id: string }>(
      `insert into farm.machines (kind, unit_no) values ('semi', 'S9') returning id`,
    );
    const polygon = {
      type: 'Polygon',
      coordinates: squareMultiPolygon(SW.lng, SW.lat, 100).coordinates[0],
    };
    const g = await t().pool.query<{ id: string }>(
      `insert into farm.geofences (kind, name, geom) values ('elevator', 'Elevator',
         extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON($1), 4326)) returning id`,
      [JSON.stringify(polygon)],
    );
    const ids = [m.rows[0]?.id, g.rows[0]?.id];
    await t().pool.query(
      `insert into farm.geofence_visits (machine_id, geofence_id, entered_at) values ($1, $2, now() - interval '1 hour')`,
      ids,
    );
    await expect(
      t().pool.query(
        `insert into farm.geofence_visits (machine_id, geofence_id, entered_at) values ($1, $2, now())`,
        ids,
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await t().pool.query(
      `update farm.geofence_visits set exited_at = now() - interval '30 minutes' where machine_id = $1`,
      [ids[0]],
    );
    await t().pool.query(
      `insert into farm.geofence_visits (machine_id, geofence_id, entered_at) values ($1, $2, now())`,
      ids,
    );
  });

  test('spray assessments: whole hours; a re-run with the same inputs is a no-op', async () => {
    const { fieldId } = await insertField(t().db);
    const ins = (hour: string, issued: string | null) =>
      t().pool.query(
        `insert into farm.spray_assessments (field_id, for_hour, verdict, rules_version, forecast_issued_at)
         values ($1, $2, 'go', 'v0-00000000', $3)
         on conflict on constraint spray_assessments_run_key do nothing`,
        [fieldId, hour, issued],
      );
    expect((await ins('2026-11-30T13:00:00Z', null)).rowCount).toBe(1);
    expect((await ins('2026-11-30T13:00:00Z', null)).rowCount).toBe(0);
    expect((await ins('2026-11-30T13:00:00Z', '2026-11-30T11:02:00Z')).rowCount).toBe(1);
    await expect(ins('2026-11-30T13:30:00Z', null)).rejects.toMatchObject({ code: '23514' });
  });

  test('weather grid ids are <WFO>/<x>,<y>', async () => {
    await t().pool.query(
      `insert into farm.weather_grids (id, wfo, grid_x, grid_y) values ('DTX/31,40', 'DTX', 31, 40)`,
    );
    await expect(
      t().pool.query(
        `insert into farm.weather_grids (id, wfo, grid_x, grid_y) values ('DTX-32-40', 'DTX', 32, 40)`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  test('a boundary change request is resolved with a resolution, or not at all', async () => {
    const { fieldId } = await insertField(t().db);
    await t().pool.query(
      `insert into farm.boundary_change_requests (field_id, note) values ($1, 'move the north edge')`,
      [fieldId],
    );
    await expect(
      t().pool.query(
        `update farm.boundary_change_requests set resolved_at = now() where field_id = $1`,
        [fieldId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await t().pool.query(
      `update farm.boundary_change_requests set resolved_at = now(), resolution = 'done in Ops Center'
        where field_id = $1`,
      [fieldId],
    );
  });
});
