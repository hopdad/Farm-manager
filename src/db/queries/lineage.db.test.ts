/** Split and merge with lineage (plan 1c), D6 refusals, and what they leave behind. */
import type { LineString, MultiPolygon } from 'geojson';
import { describe, expect, test } from 'vitest';
import { asMultiPolygon } from '../../../tools/import/boundary-file';
import { rectangle } from '../../../tools/import/testing/shapefile';
import { localParts } from '../../sim/time';
import { setupTestDb } from '../../test/db';
import {
  adjacentFields,
  defaultPieceNames,
  effectiveInstant,
  mergeFields,
  previewMerge,
  previewSplit,
  splitField,
} from './lineage';
import { fieldHistory } from './seasons';

const t = setupTestDb(import.meta.url);
const actor = { appUserId: null, displayName: 'Test manager' };
const pad = (n: number) => String(n).padStart(2, '0');
const p = localParts(Date.now());
const TODAY = `${p.y}-${pad(p.m)}-${pad(p.d)}`;

let x0 = -84.4;
const spot = () => {
  x0 += 0.05;
  return x0;
};

/** Metres -> degrees of longitude near 41.9 N. */
const dLng = (m: number) => m / (111_320 * Math.cos((41.9 * Math.PI) / 180));

async function makeField(
  name: string,
  geom: MultiPolygon,
  opts: { farmId?: string; deere?: string; from?: string } = {},
): Promise<{ id: string; farmId: string }> {
  const { pool } = t();
  const farmId =
    opts.farmId ??
    (await pool.query<{ id: string }>(`insert into farm.farms (name) values ('F') returning id`))
      .rows[0]?.id;
  const f = await pool.query<{ id: string }>(
    `insert into farm.fields (farm_id, name, tenure, deere_field_id, county_fips)
     values ($1, $2, 'cash_rent', $3, '26091') returning id`,
    [farmId, name, opts.deere ?? null],
  );
  const id = f.rows[0]?.id as string;
  await pool.query(
    `insert into farm.field_boundaries (field_id, geom, source, valid)
     values ($1, extensions.ST_Multi(extensions.ST_GeomFromGeoJSON($2)), 'drawn',
             tstzrange(coalesce($3::timestamptz, now()), null, '[)'))`,
    [id, JSON.stringify(geom), opts.from ?? null],
  );
  return { id, farmId: farmId as string };
}

const sq = (lng: number, w = 805, h = 805) => asMultiPolygon(rectangle(lng, 41.9, w, h));
const vertical = (lng: number): LineString => ({
  type: 'LineString',
  coordinates: [
    [lng, 41.89],
    [lng, 41.92],
  ],
});

describe('split', () => {
  test('a line across a 160 makes two fields; the parent ends with lineage and history', async () => {
    const { pool } = t();
    const x = spot();
    const { id } = await makeField('Split 160', sq(x), { from: '2020-01-01' });
    await pool.query(
      `insert into farm.field_seasons (field_id, crop_year, crop) values ($1, 2024, 'corn')`,
      [id],
    );
    const line = vertical(x + dLng(402));
    const preview = await previewSplit(pool, id, line);
    expect(preview).toHaveLength(2);
    for (const piece of preview) expect(piece.acres).toBeCloseTo(80, 0);
    // West piece first.
    expect(preview[0]?.label[0]).toBeLessThan(preview[1]?.label[0] ?? 0);

    const r = await splitField(pool, {
      fieldId: id,
      line,
      names: defaultPieceNames('Split 160', 2),
      effectiveOn: TODAY,
      actor,
    });
    expect(r.childIds).toHaveLength(2);
    const fields = await pool.query(
      `select name, active, tenure, county_fips, source from farm.fields
        where id = any ($1::uuid[]) order by name`,
      [[id, ...r.childIds]],
    );
    expect(fields.rows).toEqual([
      {
        name: 'Split 160',
        active: false,
        tenure: 'cash_rent',
        county_fips: '26091',
        source: 'app',
      },
      {
        name: 'Split 160 A',
        active: true,
        tenure: 'cash_rent',
        county_fips: '26091',
        source: 'app',
      },
      {
        name: 'Split 160 B',
        active: true,
        tenure: 'cash_rent',
        county_fips: '26091',
        source: 'app',
      },
    ]);
    const current = await pool.query('select 1 from farm.current_boundaries where field_id = $1', [
      id,
    ]);
    expect(current.rowCount).toBe(0);
    const h = await fieldHistory(pool, r.childIds[0] as string);
    expect(h?.ancestors[0]).toMatchObject({ name: 'Split 160', kind: 'split', effectiveOn: TODAY });
    expect(h?.ancestors[0]?.seasons.map((s) => s.cropYear)).toEqual([2024]);
  });

  test('refusals: a line short of the edge, a Deere field, a taken name, a stale piece count', async () => {
    const { pool } = t();
    const x = spot();
    const { id, farmId } = await makeField('Refuse 80', sq(x, 400, 805));
    const short: LineString = {
      type: 'LineString',
      coordinates: [
        [x + dLng(200), 41.89],
        [x + dLng(200), 41.9 + 0.001],
      ],
    };
    await expect(previewSplit(pool, id, short)).rejects.toThrow(/all the way across/);
    const deere = await makeField('JD 80', sq(spot()), { deere: 'jd-77' });
    await expect(previewSplit(pool, deere.id, vertical(x0 + dLng(400)))).rejects.toMatchObject({
      code: 'read_only',
    });
    await makeField('Taken', sq(spot(), 100, 100), { farmId });
    await expect(
      splitField(pool, {
        fieldId: id,
        line: vertical(x + dLng(200)),
        names: ['Taken', 'Other'],
        effectiveOn: TODAY,
        actor,
      }),
    ).rejects.toThrow(/already has a field named 'Taken'/);
    await expect(
      splitField(pool, {
        fieldId: id,
        line: vertical(x + dLng(200)),
        names: ['Only one'],
        effectiveOn: TODAY,
        actor,
      }),
    ).rejects.toMatchObject({ code: 'stale' });
    // A date before the current boundary started.
    await expect(
      splitField(pool, {
        fieldId: id,
        line: vertical(x + dLng(200)),
        names: ['X', 'Y'],
        effectiveOn: '2001-01-01',
        actor,
      }),
    ).rejects.toThrow(/pick a later date/);
    // Nothing changed.
    const f = await pool.query('select active from farm.fields where id = $1', [id]);
    expect(f.rows[0]?.active).toBe(true);
  });
});

describe('merge', () => {
  test('two touching fields become one; a 3 m gap is closed; 50 m is refused', async () => {
    const { pool } = t();
    const x = spot();
    const a = await makeField('West 80', sq(x, 402, 805), { from: '2020-01-01' });
    const b = await makeField('East 80', sq(x + dLng(402), 402, 805), {
      farmId: a.farmId,
      from: '2020-01-01',
    });
    const far = await makeField('Far 80', sq(x + dLng(1000), 402, 805), { farmId: a.farmId });
    const adj = await adjacentFields(pool, a.id);
    expect(adj.map((f) => [f.name, f.sameFarm, f.editable])).toEqual([['East 80', true, true]]);
    await expect(previewMerge(pool, a.id, far.id)).rejects.toThrow(/not next to each other/);

    const shape = await previewMerge(pool, a.id, b.id);
    expect(shape.geometry.coordinates).toHaveLength(1);
    expect(shape.acres).toBeCloseTo(160, 0);
    const r = await mergeFields(pool, {
      fieldIds: [a.id, b.id],
      name: 'Whole 160',
      effectiveOn: '2024-06-01',
      actor,
    });
    expect(r.acres).toBeCloseTo(160, 0);
    const lin = await pool.query(
      `select kind, effective_on::text as on from farm.field_lineage where child_field_id = $1`,
      [r.childId],
    );
    expect(lin.rows).toEqual([
      { kind: 'merge', on: '2024-06-01' },
      { kind: 'merge', on: '2024-06-01' },
    ]);
    // The parents' versions end at Detroit midnight of that day.
    const ended = await pool.query<{ upper: Date }>(
      `select upper(valid) as upper from farm.field_boundaries where field_id = $1`,
      [a.id],
    );
    expect(ended.rows[0]?.upper.toISOString()).toBe('2024-06-01T04:00:00.000Z');

    const y = spot();
    const c = await makeField('Gap W', sq(y, 402, 805));
    const d = await makeField('Gap E', sq(y + dLng(405), 402, 805), { farmId: c.farmId });
    const gap = await previewMerge(pool, c.id, d.id);
    expect(gap.geometry.coordinates).toHaveLength(1);
    expect(gap.acres).toBeGreaterThan(159);
  });

  test('different farms and Deere fields are refused', async () => {
    const { pool } = t();
    const x = spot();
    const a = await makeField('A', sq(x, 402, 805));
    const b = await makeField('B', sq(x + dLng(402), 402, 805));
    await expect(
      mergeFields(pool, { fieldIds: [a.id, b.id], name: 'AB', effectiveOn: TODAY, actor }),
    ).rejects.toThrow(/different farms/);
    const y = spot();
    const c = await makeField('C', sq(y, 402, 805));
    const d = await makeField('D', sq(y + dLng(402), 402, 805), {
      farmId: c.farmId,
      deere: 'jd-d',
    });
    await expect(
      mergeFields(pool, { fieldIds: [c.id, d.id], name: 'CD', effectiveOn: TODAY, actor }),
    ).rejects.toMatchObject({ code: 'read_only' });
  });
});

describe('effectiveInstant', () => {
  test('today is now; earlier days are Detroit midnight; the future is refused', () => {
    const now = new Date('2026-10-29T15:00:00Z');
    expect(effectiveInstant('2026-10-29', now)).toBe(now);
    expect(effectiveInstant('2026-01-02', now).toISOString()).toBe('2026-01-02T05:00:00.000Z');
    expect(() => effectiveInstant('2026-10-30', now)).toThrow(/future/);
    expect(() => effectiveInstant('10/1/2026', now)).toThrow(/not a date/);
  });
});
