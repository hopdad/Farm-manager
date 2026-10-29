/**
 * gis:parcels against a real database (as farm_app): the synthetic fixture loads, a re-run
 * changes nothing, a newer file updates in place and --replace retires parcels; duplicate
 * numbers merge into one row; the tiles' version moves only with the data; `layers`/`fields`
 * are published; the private parcels MVT carries owner names only in its owners variant; and
 * the field-parcels query redacts owners below manager.
 */
import type { Polygon } from 'geojson';
import { describe, expect, test } from 'vitest';
import { TILE_LAYERS } from '../../src/app/api/tiles/layers';
import {
  fieldParcels,
  PARCEL_OWNERS_MIN_ROLE,
  parcelById,
  parcelTileSql,
} from '../../src/db/queries/parcels';
import { parcelId } from '../../src/domain/parcels';
import { setupTestDb } from '../../src/test/db';
import { insertField, squareMultiPolygon, tileFor } from '../../src/test/fixtures';
import { decodeMvt } from './mvt';
import { loadSyntheticParcels } from './parcels';
import type { VectorFeature } from './parcels-io';
import { loadParcels, type ParcelImportMeta } from './parcels-load';
import { mapParcelFeatures } from './parcels-map';
import { buildSyntheticParcels } from './parcels-synthetic';

const t = setupTestDb(import.meta.url);

const rect = (w: number, s: number, e: number, n: number): Polygon => ({
  type: 'Polygon',
  coordinates: [
    [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
      [w, s],
    ],
  ],
});

const meta = (sha: string, over: Partial<ParcelImportMeta> = {}): ParcelImportMeta => ({
  source: 'test-county',
  countyFips: '26091',
  receivedOn: '2027-01-05',
  licenseNote: 'test data',
  fileName: 'test.geojson',
  sha256: sha.padEnd(64, '0'),
  vintage: 'Test county',
  ...over,
});

const feature = (pin: string, owner: string, g: Polygon): VectorFeature => ({
  geometry: g,
  properties: {
    PIN: pin,
    OWNER_NAME: owner,
    MAIL_ADDR: '1 Test Rd',
    MAIL_CITY: 'Adrian',
    MAIL_STATE: 'MI',
    MAIL_ZIP: '49221',
    ACRES: 40,
  },
  layer: 'test',
});

async function seq(topic: string): Promise<number> {
  const r = await t().pool.query<{ seq: string }>(
    'select seq from app.topic_seq where topic = $1',
    [topic],
  );
  return Number(r.rows[0]?.seq ?? 0);
}

async function mvtLayers(sql: string, lng: number, lat: number, z = 14) {
  const { x, y } = tileFor(lng, lat, z);
  const r = await t().pool.query<{ mvt: Buffer }>(sql, [z, x, y]);
  return decodeMvt(new Uint8Array(r.rows[0]?.mvt ?? Buffer.alloc(0)));
}

describe('the synthetic fixture (D7)', () => {
  test('loads every parcel once; a second run reuses the import and changes nothing', async () => {
    const before = await seq('layers');
    const first = await loadSyntheticParcels(t().pool);
    const n = buildSyntheticParcels().features.length;
    expect(first).toMatchObject({ inserted: n, updated: 0, reusedImport: false, deleted: 0 });
    expect(await seq('layers')).toBe(before + 1);
    const v1 = await TILE_LAYERS.parcels.version(t().pool);

    const again = await loadSyntheticParcels(t().pool);
    expect(again).toMatchObject({
      inserted: 0,
      updated: 0,
      unchanged: n,
      reusedImport: true,
      importId: first.importId,
    });
    expect(await TILE_LAYERS.parcels.version(t().pool)).toBe(v1);
    expect(await seq('layers')).toBe(before + 1); // nothing changed, nothing published

    const imp = await t().pool.query(
      'select source, license_note, feature_count from gis.parcel_imports',
    );
    expect(imp.rows).toEqual([expect.objectContaining({ source: 'synthetic', feature_count: n })]);
    const row = await t().pool.query<{ source_vintage: string; meta: Record<string, unknown> }>(
      `select source_vintage, meta from gis.map_layers where key = 'parcels'`,
    );
    expect(row.rows[0]?.source_vintage).toMatch(/Synthetic/);
    expect(row.rows[0]?.meta).toMatchObject({ source: 'synthetic', importId: first.importId });
    await t().admin.query('delete from gis.parcel_imports');
  });
});

describe('county files', () => {
  test('upsert by normalized number, merge duplicates, update in place, --replace retires', async () => {
    const A = rect(-84.06, 41.89, -84.055, 41.893);
    const A2 = rect(-84.055, 41.89, -84.05, 41.893);
    const B = rect(-84.05, 41.89, -84.045, 41.893);
    const C = rect(-84.045, 41.89, -84.04, 41.893);
    const file1 = mapParcelFeatures(
      [
        feature('xa0-1', 'Pat Example', A),
        feature(' XA0-1 ', 'Pat Example', A2),
        feature('XA0-2', 'Sam Example', B),
        feature('XA0-3', 'Lee Example', C),
      ],
      { countyFips: '26091' },
    );
    expect(file1.merged).toBe(1);
    const r1 = await loadParcels(t().pool, file1.records, meta('a1'));
    expect(r1).toMatchObject({ inserted: 3, updated: 0, stale: 0 });
    const merged = await t().pool.query<{
      id: string;
      parcel_no: string;
      gis_acres: string;
      n: number;
    }>(
      `select id::text, parcel_no, gis_acres::text, extensions.ST_NumGeometries(geom) as n
         from gis.parcels where parcel_no = 'XA0-1'`,
    );
    expect(merged.rows[0]).toMatchObject({ id: parcelId('26091', 'XA0-1'), n: 1 }); // unioned
    expect(Number(merged.rows[0]?.gis_acres)).toBeGreaterThan(0);

    const v1 = await TILE_LAYERS.parcels.version(t().pool);
    // A newer file: XA0-2 sold, XA0-3 gone.
    const file2 = mapParcelFeatures(
      [
        feature('XA0-1', 'Pat Example', A),
        feature('XA0-1', 'Pat Example', A2),
        feature('XA0-2', 'New Owner LLC', B),
      ],
      { countyFips: '26091' },
    );
    const kept = await loadParcels(t().pool, file2.records, meta('a2'));
    expect(kept).toMatchObject({ inserted: 0, updated: 2, stale: 1, deleted: 0 });
    expect(await TILE_LAYERS.parcels.version(t().pool)).not.toBe(v1);
    const replaced = await loadParcels(t().pool, file2.records, meta('a2'), { replace: true });
    expect(replaced).toMatchObject({ reusedImport: true, inserted: 0, updated: 0, deleted: 1 });
    const left = await t().pool.query<{ parcel_no: string; owner_name: string }>(
      'select parcel_no, owner_name from gis.parcels order by parcel_no',
    );
    expect(left.rows).toEqual([
      { parcel_no: 'XA0-1', owner_name: 'Pat Example' },
      { parcel_no: 'XA0-2', owner_name: 'New Owner LLC' },
    ]);
  });

  test('a failed load leaves nothing behind (one transaction)', async () => {
    const before = await t().pool.query('select count(*)::int as n from gis.parcel_imports');
    const bad = mapParcelFeatures([feature('Z-1', 'X', rect(-84, 41.9, -83.99, 41.91))], {
      countyFips: '26091',
    });
    const broken = [{ ...bad.records[0], countyFips: 'bad' } as (typeof bad.records)[number]];
    await expect(loadParcels(t().pool, broken, meta('bad'))).rejects.toThrow();
    const after = await t().pool.query('select count(*)::int as n from gis.parcel_imports');
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});

describe('who sees owners', () => {
  test('the owners variant of the MVT carries names; the other leaves them out', async () => {
    const withOwners = await mvtLayers(parcelTileSql(true), -84.0525, 41.8915);
    const without = await mvtLayers(parcelTileSql(false), -84.0525, 41.8915);
    const props = (layers: typeof withOwners) => layers[0]?.features.map((f) => f.properties) ?? [];
    expect(props(withOwners).length).toBeGreaterThan(0);
    expect(props(withOwners).some((p) => p.owner_name === 'Pat Example')).toBe(true);
    expect(props(without).length).toBe(props(withOwners).length);
    for (const p of props(without)) {
      expect(p).not.toHaveProperty('owner_name');
      expect(p).not.toHaveProperty('owner_mailing');
      expect(p).toHaveProperty('parcel_no');
    }
    // Below z12 both are empty (no county-wide clip).
    expect((await mvtLayers(parcelTileSql(false), -84.0525, 41.8915, 11)).length).toBe(0);
  });

  test('fieldParcels: overlap per parcel, owners only for managers', async () => {
    const { fieldId } = await insertField(t().db, {
      name: 'Parcel test 40',
      geom: squareMultiPolygon(-84.0595, 41.8902, 300),
    });
    expect(PARCEL_OWNERS_MIN_ROLE).toBe('manager');
    const manager = await fieldParcels(t().pool, fieldId, 'manager');
    expect(manager.length).toBeGreaterThan(0);
    expect(manager[0]).toMatchObject({
      parcelNo: 'XA0-1',
      ownerName: 'Pat Example',
      importSource: 'test-county',
    });
    expect(manager[0]?.overlapAcres).toBeGreaterThan(5);
    expect(manager[0]?.overlapPct).toBeGreaterThan(50);
    const viewer = await fieldParcels(t().pool, fieldId, 'viewer');
    expect(viewer[0]).toMatchObject({ parcelNo: 'XA0-1', ownerName: null, ownerMailing: null });
    expect(await parcelById(t().pool, parcelId('26091', 'XA0-1'), 'driver')).toMatchObject({
      ownerName: null,
    });
    expect(await parcelById(t().pool, parcelId('26091', 'XA0-1'), 'owner')).toMatchObject({
      ownerName: 'Pat Example',
      acres: 40,
    });
    expect(await parcelById(t().pool, '00000000-0000-4000-8000-000000000000', 'owner')).toBeNull();
  });
});

describe('a real county file and the D7 fixture', () => {
  test('a real file retires the synthetic parcels of its counties, without --replace', async () => {
    const synthetic = await loadSyntheticParcels(t().pool);
    const count = async (county: string) => {
      const r = await t().pool.query<{ n: number }>(
        `select count(*)::int as n from gis.parcels p join gis.parcel_imports i on i.id = p.import_id
          where i.source = 'synthetic' and p.county_fips = $1`,
        [county],
      );
      return r.rows[0]?.n ?? 0;
    };
    const monroe = await count('26115');
    expect(await count('26091')).toBeGreaterThan(0);
    expect(monroe).toBeGreaterThan(0);

    const real = mapParcelFeatures(
      [feature('LEN-1', 'Real Owner', rect(-84.06, 41.89, -84.055, 41.893))],
      { countyFips: '26091' },
    );
    const before = await seq('fields');
    const r = await loadParcels(t().pool, real.records, meta('b1', { source: 'lenawee-county' }));
    expect(r.syntheticRetired).toBe(synthetic.inserted - monroe);
    expect(r).toMatchObject({ inserted: 1, deleted: 0 });
    expect(await count('26091')).toBe(0);
    expect(await count('26115')).toBe(monroe); // another county's fixture stays
    expect(await seq('fields')).toBeGreaterThanOrEqual(before);
    const imports = await t().pool.query<{ source: string }>(
      `select source from gis.parcel_imports where source in ('lenawee-county', 'synthetic')
        order by source`,
    );
    expect(imports.rows.map((x) => x.source)).toEqual(['lenawee-county', 'synthetic']);
    await t().admin.query(
      `delete from gis.parcel_imports where source in ('lenawee-county', 'synthetic')`,
    );
  });
});
