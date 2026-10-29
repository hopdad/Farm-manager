/**
 * farm.field_boundaries: one current version per field (EXCLUDE), the acreage trigger and the
 * farm.current_boundaries view.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { setupTestDb } from '../test/db';
import { ADRIAN_QUARTER_SECTION, insertField, squareMultiPolygon } from '../test/fixtures';
import { currentBoundaries, fieldBoundaries } from './schema';

const t = setupTestDb(import.meta.url);

describe('field boundaries', () => {
  test('acreage trigger: a quarter section near Adrian, MI is 160 ac within 0.5%', async () => {
    const { db } = t();
    const { fieldId } = await insertField(db, { geom: ADRIAN_QUARTER_SECTION });
    const [b] = await db.select().from(fieldBoundaries).where(eq(fieldBoundaries.fieldId, fieldId));
    expect(b?.acres).toBeDefined();
    expect(Math.abs((b?.acres ?? 0) - 160) / 160).toBeLessThan(0.005);
  });

  test('acres follow the geometry on update and ignore hand-written values', async () => {
    const { db } = t();
    const { fieldId } = await insertField(db, { geom: ADRIAN_QUARTER_SECTION });
    // A half-quarter (80 ac): same width, half the height.
    const half = squareMultiPolygon(-84.06, 41.89, 804.672);
    const ring = half.coordinates[0]?.[0];
    if (!ring) throw new Error('fixture');
    const midLat = ((ring[0]?.[1] ?? 0) + (ring[2]?.[1] ?? 0)) / 2;
    for (const p of [ring[2], ring[3]]) if (p) p[1] = midLat;
    await db
      .update(fieldBoundaries)
      .set({ geom: half, acres: 999 })
      .where(eq(fieldBoundaries.fieldId, fieldId));
    const [b] = await db.select().from(fieldBoundaries).where(eq(fieldBoundaries.fieldId, fieldId));
    expect(Math.abs((b?.acres ?? 0) - 80) / 80).toBeLessThan(0.005);
  });

  test('a second overlapping current boundary for the same field is rejected', async () => {
    const { db, pool } = t();
    const { fieldId } = await insertField(db, { geom: ADRIAN_QUARTER_SECTION });
    await expect(
      db.insert(fieldBoundaries).values({ fieldId, geom: ADRIAN_QUARTER_SECTION, source: 'drawn' }),
    ).rejects.toMatchObject({
      cause: { code: '23P01', constraint: 'field_boundaries_no_overlap' },
    });
    // Overlapping closed ranges are rejected too.
    await expect(
      pool.query(
        `insert into farm.field_boundaries (field_id, geom, source, valid)
         values ($1, extensions.ST_Multi(extensions.ST_MakeEnvelope(-84.06, 41.89, -84.05, 41.9, 4326)),
                 'drawn', tstzrange('2020-01-01', '2030-01-01'))`,
        [fieldId],
      ),
    ).rejects.toMatchObject({ code: '23P01' });
  });

  test('versions: close the current one, add the next; the view shows only the new one', async () => {
    const { db } = t();
    const { fieldId, boundaryId } = await insertField(db, { geom: ADRIAN_QUARTER_SECTION });
    const cut = new Date();
    await db
      .update(fieldBoundaries)
      .set({ valid: { from: new Date('2000-01-01T00:00:00Z'), to: cut } })
      .where(eq(fieldBoundaries.id, boundaryId as string));
    const [next] = await db
      .insert(fieldBoundaries)
      .values({
        fieldId,
        geom: squareMultiPolygon(-84.06, 41.89, 600),
        source: 'drawn',
        valid: { from: cut, to: null },
      })
      .returning({ id: fieldBoundaries.id });
    const current = await db
      .select()
      .from(currentBoundaries)
      .where(eq(currentBoundaries.fieldId, fieldId));
    expect(current.map((c) => c.id)).toEqual([next?.id]);
    // Different fields may overlap in time freely.
    const other = await insertField(db, { geom: ADRIAN_QUARTER_SECTION, name: 'Neighbor' });
    expect(other.boundaryId).toBeTruthy();
  });

  test('two fields with current boundaries both appear in the view', async () => {
    const { db } = t();
    const a = await insertField(db, { geom: squareMultiPolygon(-84.2, 41.8, 400), name: 'A' });
    const b = await insertField(db, { geom: squareMultiPolygon(-84.21, 41.8, 400), name: 'B' });
    const rows = await db.select({ fieldId: currentBoundaries.fieldId }).from(currentBoundaries);
    const ids = rows.map((r) => r.fieldId);
    expect(ids).toContain(a.fieldId);
    expect(ids).toContain(b.fieldId);
  });
});
