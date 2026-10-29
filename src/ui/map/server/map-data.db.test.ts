/** The board's server-side data: the fields' extent (as farm_app) and the initial camera. */
import { describe, expect, test } from 'vitest';
import { BASEMAP_BBOX } from '../../../platform/storage/basemap';
import { setupTestDb } from '../../../test/db';
import { ADRIAN_QUARTER_SECTION, insertField, squareMultiPolygon } from '../../../test/fixtures';
import { fieldsExtent, initialBoundsFor } from './map-data';

const t = setupTestDb(import.meta.url);

describe('map page data', () => {
  test('no fields → no extent → the camera starts on the basemap area', async () => {
    expect(await fieldsExtent(t().pool)).toBeNull();
    expect(initialBoundsFor(null)).toEqual([...BASEMAP_BBOX]);
  });

  test('the extent covers every active field with a current boundary', async () => {
    const { db, pool } = t();
    await insertField(db, { geom: ADRIAN_QUARTER_SECTION, name: 'A' });
    const far = await insertField(db, { geom: squareMultiPolygon(-83.5, 41.95, 500), name: 'B' });
    const e = await fieldsExtent(pool);
    expect(e?.[0]).toBeCloseTo(-84.06, 4);
    expect(e?.[1]).toBeCloseTo(41.89, 4);
    expect(e?.[2]).toBeGreaterThan(-83.5);
    expect(e?.[3]).toBeGreaterThan(41.95);
    await pool.query('update farm.fields set active = false where id = $1', [far.fieldId]);
    const e2 = await fieldsExtent(pool);
    expect(e2?.[2]).toBeLessThan(-84.0);
  });

  test('initialBoundsFor pads the extent and never zooms into a single tiny field', () => {
    const b = initialBoundsFor([-84.0, 41.9, -83.99, 41.905]);
    expect(b[2] - b[0]).toBeGreaterThanOrEqual(0.02);
    expect(b[3] - b[1]).toBeGreaterThanOrEqual(0.02);
    const wide = initialBoundsFor([-84.2, 41.8, -83.6, 42.0]);
    expect(wide[0]).toBeLessThan(-84.2);
    expect(wide[2]).toBeGreaterThan(-83.6);
  });
});
