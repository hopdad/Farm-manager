/**
 * Boundary import, drawn edits and Ops Center change requests against a real database
 * (plan 1c; D6).
 */
import type { MultiPolygon } from 'geojson';
import { describe, expect, test } from 'vitest';
import { asMultiPolygon } from '../../../tools/import/boundary-file';
import { rectangle } from '../../../tools/import/testing/shapefile';
import { setupTestDb } from '../../test/db';
import {
  type IncomingBoundary,
  importBoundaries,
  listChangeRequests,
  resolveChangeRequest,
  saveDrawnBoundary,
} from './boundaries';
import { FieldDataError } from './boundaries-sql';

const t = setupTestDb(import.meta.url);

const rect = (lng: number, lat: number, w: number, h: number): MultiPolygon =>
  asMultiPolygon(rectangle(lng, lat, w, h));

let lngCursor = -84.3;
/** A spot of its own for each test (tests share one database). */
function spot(): number {
  lngCursor += 0.05;
  return lngCursor;
}

const incoming = (name: string, geometry: MultiPolygon, extra: Partial<IncomingBoundary> = {}) =>
  ({
    name,
    nameSource: 'attribute',
    farmName: null,
    clientName: null,
    deereFieldId: null,
    geometry,
    featureCount: 1,
    sourceRef: `test.zip: ${name}`,
    ...extra,
  }) satisfies IncomingBoundary;

const actor = { appUserId: null, displayName: 'Test manager' };

async function versions(fieldId: string) {
  const r = await t().pool.query<{ source: string; open: boolean; acres: number }>(
    `select source, upper_inf(valid) as open, acres::float8 as acres
       from farm.field_boundaries where field_id = $1 order by lower(valid)`,
    [fieldId],
  );
  return r.rows;
}

async function seq(topic: string): Promise<number> {
  const r = await t().pool.query<{ seq: string }>(
    'select seq from app.topic_seq where topic = $1',
    [topic],
  );
  return Number(r.rows[0]?.seq ?? 0);
}

describe('importBoundaries', () => {
  test('creates, then finds unchanged, then versions a changed shape (one transaction each)', async () => {
    const { pool } = t();
    const x = spot();
    const before = await seq('fields');
    const first = await importBoundaries(pool, [
      incoming('Import North 160', rect(x, 41.9, 805, 805), { farmName: 'Import farm A' }),
    ]);
    expect(first.counts).toEqual({ create: 1, update: 0, unchanged: 0, skip: 0 });
    expect(first.farmsCreated).toEqual(['Import farm A']);
    const item = first.items[0];
    expect(item?.action).toBe('create');
    expect(Math.abs((item?.acresAfter ?? 0) - 160) / 160).toBeLessThan(0.01);
    const fieldId = item?.fieldId as string;
    expect(await seq('fields')).toBeGreaterThan(before);
    const f = await pool.query('select tenure, source, active from farm.fields where id = $1', [
      fieldId,
    ]);
    expect(f.rows[0]).toEqual({ tenure: 'owned', source: 'import', active: true });

    const again = await importBoundaries(pool, [
      incoming('import  north 160', rect(x, 41.9, 805, 805), { farmName: 'IMPORT FARM A' }),
    ]);
    expect(again.items[0]).toMatchObject({ action: 'unchanged', fieldId, matchedBy: 'name' });

    const changed = await importBoundaries(pool, [
      incoming('Import North 160', rect(x, 41.9, 805, 402)),
    ]);
    expect(changed.items[0]).toMatchObject({ action: 'update', fieldId, matchedBy: 'name' });
    expect(changed.items[0]?.acresAfter).toBeCloseTo(80, 0);
    const v = await versions(fieldId);
    expect(v.map((r) => [r.source, r.open])).toEqual([
      ['import', false],
      ['import', true],
    ]);
  });

  test('dry run reports the same plan and writes nothing', async () => {
    const { pool } = t();
    const x = spot();
    const dry = await importBoundaries(pool, [incoming('Dry 40', rect(x, 41.9, 400, 400))], {
      dryRun: true,
    });
    expect(dry).toMatchObject({ dryRun: true, counts: { create: 1 } });
    const r = await pool.query(`select 1 from farm.fields where name = 'Dry 40'`);
    expect(r.rowCount).toBe(0);
  });

  test('same name but elsewhere is a conflict; a renamed field is found by its shape', async () => {
    const { pool } = t();
    const x = spot();
    const made = await importBoundaries(pool, [incoming('Kowalski', rect(x, 41.9, 500, 500))]);
    const fieldId = made.items[0]?.fieldId;
    const moved = await importBoundaries(pool, [
      incoming('Kowalski', rect(x + 0.02, 41.9, 500, 500)),
    ]);
    expect(moved.items[0]).toMatchObject({ action: 'skip', fieldId });
    expect(moved.items[0]?.reason).toMatch(/overlaps this one by only 0%/);

    const renamed = await importBoundaries(pool, [
      incoming('Kowalski West', rect(x, 41.9, 500, 495)),
    ]);
    expect(renamed.items[0]).toMatchObject({ action: 'update', fieldId, matchedBy: 'shape' });
    expect(renamed.items[0]?.warnings.join(' ')).toMatch(/matched by shape .* 'Kowalski'/);
  });

  test("D6: a Deere-synced boundary is read-only; a file's Deere id links and matches", async () => {
    const { pool } = t();
    const x = spot();
    const farm = await pool.query<{ id: string }>(
      `insert into farm.farms (name, source) values ('Deere farm', 'deere') returning id`,
    );
    const field = await pool.query<{ id: string }>(
      `insert into farm.fields (farm_id, name, tenure, deere_field_id, source)
       values ($1, 'Synced 80', 'owned', 'jd-1', 'deere') returning id`,
      [farm.rows[0]?.id],
    );
    const fieldId = field.rows[0]?.id as string;
    await pool.query(
      `insert into farm.field_boundaries (field_id, geom, source)
       values ($1, extensions.ST_Multi(extensions.ST_GeomFromGeoJSON($2)), 'deere')`,
      [fieldId, JSON.stringify(rect(x, 41.9, 400, 800))],
    );
    const r = await importBoundaries(pool, [
      incoming('Synced 80', rect(x, 41.9, 400, 700), { deereFieldId: 'jd-1' }),
    ]);
    expect(r.items[0]).toMatchObject({ action: 'skip', fieldId, matchedBy: 'deere_id' });
    expect(r.items[0]?.reason).toMatch(/Operations Center/);
    expect((await versions(fieldId)).length).toBe(1);

    // A field this import created gets linked to the Deere id the file carries…
    const y = spot();
    const created = await importBoundaries(pool, [incoming('Ops 40', rect(y, 41.9, 400, 400))]);
    const opsId = created.items[0]?.fieldId as string;
    const linked = await importBoundaries(pool, [
      incoming('Ops 40', rect(y, 41.9, 400, 380), { deereFieldId: 'jd-2' }),
    ]);
    expect(linked.items[0]).toMatchObject({ action: 'update', fieldId: opsId, matchedBy: 'name' });
    const f = await pool.query('select deere_field_id from farm.fields where id = $1', [opsId]);
    expect(f.rows[0]?.deere_field_id).toBe('jd-2');
    // …and later exports find it by that id (the import wrote this boundary, so it may update).
    const byId = await importBoundaries(pool, [
      incoming('Renamed in Ops', rect(y, 41.9, 400, 360), { deereFieldId: 'jd-2' }),
    ]);
    expect(byId.items[0]).toMatchObject({
      action: 'update',
      fieldId: opsId,
      matchedBy: 'deere_id',
    });
    // But the app's own editor treats it as Deere's now.
    const save = await saveDrawnBoundary(pool, {
      fieldId: opsId,
      geometry: rect(y, 41.9, 300, 300),
      actor,
      expectedBoundaryId: null,
    });
    expect(save.kind).toBe('change_request');
  });

  test('a customer client makes a custom farm; slivers, bad dates and duplicates are skipped', async () => {
    const { pool } = t();
    await pool.query(
      `insert into farm.parties (kind, display_name, roles) values ('org', 'Rietzel Farms LLC', '{customer}')`,
    );
    const x = spot();
    const r = await importBoundaries(pool, [
      incoming('Rietzel East', rect(x, 41.9, 400, 400), {
        farmName: 'Rietzel',
        clientName: 'rietzel farms llc',
      }),
      incoming('Sliver', rect(x + 0.01, 41.9, 10, 10)),
      incoming('Twin', rect(x + 0.02, 41.9, 400, 400)),
      incoming('Twin', rect(x + 0.02, 41.9, 400, 400)),
    ]);
    expect(r.items.map((i) => i.action)).toEqual(['create', 'skip', 'create', 'skip']);
    expect(r.items[1]?.reason).toMatch(/only 0.0\d ac/);
    expect(r.items[3]?.reason).toMatch(/same field as 'Twin'/);
    const f = await pool.query(
      `select f.tenure, fa.client_party_id is not null as custom
         from farm.fields f join farm.farms fa on fa.id = f.farm_id where f.id = $1`,
      [r.items[0]?.fieldId],
    );
    expect(f.rows[0]).toEqual({ tenure: 'custom', custom: true });

    const old = await importBoundaries(
      pool,
      [incoming('Rietzel East', rect(x, 41.9, 400, 300), { farmName: 'Rietzel' })],
      { effectiveAt: new Date('2001-01-01T05:00:00Z') },
    );
    expect(old.items[0]?.action).toBe('skip');
    expect(old.items[0]?.reason).toMatch(/must start after it/);
  });

  test('--hide-demo deactivates the demo fields', async () => {
    const { pool } = t();
    const farm = await pool.query<{ id: string }>(
      `insert into farm.farms (name, source, source_id) values ('Demo', 'demo', 'farm:x') returning id`,
    );
    await pool.query(
      `insert into farm.fields (farm_id, name, tenure, source, source_id) values ($1, 'Demo 1', 'owned', 'demo', 'field:x')`,
      [farm.rows[0]?.id],
    );
    const r = await importBoundaries(pool, [incoming('Mine', rect(spot(), 41.9, 300, 300))], {
      hideDemo: true,
    });
    expect(r.demoHidden).toBeGreaterThanOrEqual(1);
    const left = await pool.query(`select 1 from farm.fields where source = 'demo' and active`);
    expect(left.rowCount).toBe(0);
  });
});

describe('drawn edits and change requests', () => {
  test('a non-Deere field takes a drawn version; a stale editor is refused', async () => {
    const { pool } = t();
    const x = spot();
    const made = await importBoundaries(pool, [incoming('Draw 40', rect(x, 41.9, 400, 400))]);
    const fieldId = made.items[0]?.fieldId as string;
    const boundaryId = made.items[0]?.boundaryId as string;
    const saved = await saveDrawnBoundary(pool, {
      fieldId,
      geometry: rect(x, 41.9, 400, 200),
      actor,
      expectedBoundaryId: boundaryId,
    });
    expect(saved).toMatchObject({ kind: 'version' });
    if (saved.kind !== 'version') throw new Error('version expected');
    expect(saved.acres).toBeCloseTo(19.8, 0);
    expect((await versions(fieldId)).map((v) => v.source)).toEqual(['import', 'drawn']);
    await expect(
      saveDrawnBoundary(pool, {
        fieldId,
        geometry: rect(x, 41.9, 400, 100),
        actor,
        expectedBoundaryId: boundaryId,
      }),
    ).rejects.toMatchObject({ code: 'stale' });
    await expect(
      saveDrawnBoundary(pool, {
        fieldId,
        geometry: rect(x, 41.9, 5, 5),
        actor,
        expectedBoundaryId: saved.boundaryId,
      }),
    ).rejects.toBeInstanceOf(FieldDataError);
  });

  test('a Deere field: the drawing becomes a request that can be resolved', async () => {
    const { pool } = t();
    const farm = await pool.query<{ id: string }>(
      `insert into farm.farms (name) values ('Deere 2') returning id`,
    );
    const field = await pool.query<{ id: string }>(
      `insert into farm.fields (farm_id, name, tenure, deere_field_id) values ($1, 'JD', 'owned', 'jd-9') returning id`,
      [farm.rows[0]?.id],
    );
    const fieldId = field.rows[0]?.id as string;
    const saved = await saveDrawnBoundary(pool, {
      fieldId,
      geometry: rect(spot(), 41.9, 300, 300),
      actor,
      expectedBoundaryId: null,
      note: 'Waterway moved east',
    });
    expect(saved.kind).toBe('change_request');
    const open = await listChangeRequests(pool, fieldId);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ note: 'Waterway moved east', hasDrawing: true });
    await resolveChangeRequest(pool, { requestId: open[0]?.id as string, resolution: '', actor });
    expect(await listChangeRequests(pool, fieldId)).toEqual([]);
    const all = await listChangeRequests(pool, fieldId, { includeResolved: true });
    expect(all[0]?.resolution).toBe('done in Operations Center');
    await expect(
      resolveChangeRequest(pool, { requestId: open[0]?.id as string, resolution: 'x', actor }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});
