/** app.mvt_fields(z, x, y): MVT layer 'fields' from current boundaries. */
import { describe, expect, test } from 'vitest';
import { setupTestDb } from '../test/db';
import { ADRIAN_QUARTER_SECTION, insertField, tileFor } from '../test/fixtures';

const t = setupTestDb(import.meta.url);

async function tile(z: number, x: number, y: number): Promise<Buffer> {
  const r = await t().pool.query('select app.mvt_fields($1, $2, $3) as mvt', [z, x, y]);
  return r.rows[0].mvt as Buffer;
}

describe('app.mvt_fields', () => {
  test('a tile containing a seeded boundary is a non-empty MVT with the documented properties', async () => {
    const { fieldId, farmId } = await insertField(t().db, {
      geom: ADRIAN_QUARTER_SECTION,
      name: 'Kowalski North',
      tenure: 'cash_rent',
    });
    const ring = ADRIAN_QUARTER_SECTION.coordinates[0]?.[0]?.[0];
    if (!ring) throw new Error('fixture');
    for (const z of [10, 12, 14]) {
      const { x, y } = tileFor((ring[0] ?? 0) + 0.004, (ring[1] ?? 0) + 0.003, z);
      const mvt = await tile(z, x, y);
      expect(Buffer.isBuffer(mvt)).toBe(true);
      expect(mvt.length).toBeGreaterThan(0);
      const text = mvt.toString('latin1');
      for (const s of [
        'fields',
        'id',
        'name',
        'acres',
        'tenure',
        'farm_id',
        'Kowalski North',
        'cash_rent',
        fieldId,
        farmId,
      ]) {
        expect(text).toContain(s);
      }
    }
  });

  test('a tile far away is empty', async () => {
    const { x, y } = tileFor(-122.4, 37.8, 12);
    expect((await tile(12, x, y)).length).toBe(0);
  });

  test('inactive fields and closed boundary versions are left out', async () => {
    const { pool, db } = t();
    const { fieldId } = await insertField(db, { geom: ADRIAN_QUARTER_SECTION, name: 'Gone' });
    await pool.query('update farm.fields set active = false where id = $1', [fieldId]);
    const closed = await insertField(db, { geom: ADRIAN_QUARTER_SECTION, name: 'Old version' });
    await pool.query(
      `update farm.field_boundaries set valid = tstzrange('2020-01-01', now() - interval '1 day')
        where field_id = $1`,
      [closed.fieldId],
    );
    const ring = ADRIAN_QUARTER_SECTION.coordinates[0]?.[0]?.[0] ?? [0, 0];
    const { x, y } = tileFor((ring[0] ?? 0) + 0.004, (ring[1] ?? 0) + 0.003, 14);
    const text = (await tile(14, x, y)).toString('latin1');
    expect(text).not.toContain('Gone');
    expect(text).not.toContain('Old version');
  });
});
