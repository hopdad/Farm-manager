/**
 * The farm.operations writer and reader against a real database: idempotent upserts with
 * deterministic ids (nothing touched when nothing changed), field and machine matching through
 * external refs (and deere_field_id), operator_name, clipping against the boundary version
 * valid at started_at (the current one when none was), the coverage simplified and a 400'd
 * operation stored without coverage, the provisional → final rule and sweep, the field panel's
 * read, `fieldsPerRun` merged into sync_state.extra, the budget readings, and the full-day
 * sprayer payload mapped and upserted in under 10 s.
 */
import { describe, expect, test } from 'vitest';
import { mapDeereOperation } from '../../connectors/deere/ops/mapper';
import type { DeereOperationRaw } from '../../connectors/deere/ops/schemas';
import { externalRef, type NormalizedOperation } from '../../connectors/types';
import { deterministicId } from '../../domain/ids';
import { buildDemoFarm } from '../../sim/farm/build';
import type { SimField } from '../../sim/types';
import { fullDaySprayerCoverage } from '../../sim/vendors/deere/ops-world';
import { setupTestDb } from '../../test/db';
import { insertField, squareMultiPolygon } from '../../test/fixtures';
import { upsertExternalRef } from '../external-refs';
import {
  COVERAGE_TOLERANCE_DEG,
  FINAL_AFTER_MS,
  fieldOperations,
  finalizeOperations,
  operationStatus,
  recordFieldsPerRun,
  storedOperationModified,
  upsertOperation,
} from './operations';
import { readOpsBudget } from './operations-budget';

const t = setupTestDb(import.meta.url);
const NOW = new Date('2026-10-31T13:00:00.000Z');
const SIDE = 400;

let n = 0;
/** A field with a Deere ref (org-x) and its current boundary, at a fresh spot. */
async function deereField(opts: { valid?: [string, string | null] } = {}) {
  n++;
  const lng = -84.2 + n * 0.01;
  const lat = 41.6;
  const geom = squareMultiPolygon(lng, lat, SIDE);
  const ids = await insertField(t().adminDb, { name: `Ops ${n}` });
  const deereFieldId = `df-${n}`;
  await t().admin.query(`update farm.fields set deere_field_id = $2 where id = $1`, [
    ids.fieldId,
    deereFieldId,
  ]);
  const [from, to] = opts.valid ?? ['2020-01-01T00:00:00Z', null];
  await t().admin.query(
    `insert into farm.field_boundaries (field_id, geom, valid, source)
     values ($1, extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON($2), 4326),
             tstzrange($3::timestamptz, $4::timestamptz, '[)'), 'demo')`,
    [ids.fieldId, JSON.stringify(geom), from, to],
  );
  await upsertExternalRef(
    t().adminDb,
    externalRef('deere', 'field', deereFieldId, 'org-x'),
    ids.fieldId,
  );
  return { fieldId: ids.fieldId, deereFieldId, geom, lng, lat };
}

async function machine(unitNo: string, deereId: string, org: string) {
  const id = deterministicId('test-machine', unitNo + n);
  await t().admin.query(
    `insert into farm.machines (id, kind, unit_no, source) values ($1, 'combine', $2, 'demo')`,
    [id, `${unitNo}-${n}`],
  );
  await upsertExternalRef(t().adminDb, externalRef('deere', 'machine', deereId, org), id);
  return id;
}

function op(over: Partial<NormalizedOperation> & { fieldExternalId: string }): NormalizedOperation {
  return {
    source: 'deere',
    sourceOrg: 'org-x',
    externalId: `op-${Math.random().toString(16).slice(2)}`,
    kind: 'harvest',
    cropYear: 2026,
    crop: 'corn',
    startedAt: '2026-10-20T14:00:00.000Z',
    endedAt: '2026-10-20T20:00:00.000Z',
    areaAc: 39.5,
    products: [
      { name: 'NF 108-22', kind: 'seed', rate: null, rateUnit: null, total: null, totalUnit: null },
    ],
    measurements: { areaAc: 39.5, yieldBuAc: 182.4, moisturePct: 18.2 },
    machineExternalIds: [],
    operatorName: 'Dale Mercer',
    coverage: null,
    modifiedAt: '2026-10-20T20:00:00.000Z',
    ...over,
  };
}

async function row(id: string) {
  const r = await t().pool.query(
    `select field_id::text, status, area_reported_ac::float8 as reported,
            area_clipped_ac::float8 as clipped, machine_ids::text[] as machines, operator_name,
            geom is not null as has_geom, extensions.ST_NPoints(geom) as points,
            updated_at, source, source_id, source_org, crop, products, measurements
       from farm.operations where id = $1`,
    [id],
  );
  return r.rows[0];
}

describe('operationStatus (provisional → final)', () => {
  test('final once ended and unchanged for 24 h; running or recently changed is provisional', () => {
    const ended = { endedAt: '2026-10-29T12:00:00Z', modifiedAt: '2026-10-29T12:00:00Z' };
    expect(operationStatus(ended, NOW)).toBe('final');
    expect(operationStatus({ ...ended, modifiedAt: '2026-10-31T01:00:00Z' }, NOW)).toBe(
      'provisional',
    );
    expect(operationStatus({ endedAt: null, modifiedAt: null }, NOW)).toBe('provisional');
    expect(operationStatus({ endedAt: '2026-10-29T12:00:00Z', modifiedAt: null }, NOW)).toBe(
      'final',
    );
    expect(FINAL_AFTER_MS).toBe(86_400_000);
  });
});

describe('upsertOperation', () => {
  test('inserts with a deterministic id, field and machines matched; a re-run changes nothing', async () => {
    const f = await deereField();
    const home = await machine('C1', '111', 'org-home');
    const own = await machine('C2', '222', 'org-x');
    const o = op({
      fieldExternalId: f.deereFieldId,
      machineExternalIds: ['111', '222', '999'],
      coverage: f.geom,
    });
    const first = await upsertOperation(t().pool, o, { now: NOW });
    expect(first).toMatchObject({ changed: true, inserted: true, fieldId: f.fieldId });
    expect(first.id).toBe(deterministicId('deere', o.externalId));
    const r1 = await row(first.id);
    expect(r1).toMatchObject({
      field_id: f.fieldId,
      status: 'final',
      operator_name: 'Dale Mercer',
      source: 'deere',
      source_id: o.externalId,
      source_org: 'org-x',
      crop: 'corn',
      has_geom: true,
    });
    expect(r1.machines.sort()).toEqual([home, own].sort()); // the unknown '999' is left out
    expect(r1.reported).toBeCloseTo(39.5, 4);
    expect(r1.clipped).toBeCloseTo((SIDE * SIDE) / 4046.86, 0);
    expect(r1.measurements).toEqual({ areaAc: 39.5, yieldBuAc: 182.4, moisturePct: 18.2 });

    const again = await upsertOperation(t().pool, o, { now: NOW });
    expect(again).toMatchObject({ changed: false, inserted: false, fieldId: f.fieldId });
    expect((await row(first.id)).updated_at).toEqual(r1.updated_at);

    const edited = await upsertOperation(
      t().pool,
      { ...o, areaAc: 40.1, modifiedAt: '2026-10-31T12:00:00.000Z' },
      { now: NOW },
    );
    expect(edited).toMatchObject({ changed: true, inserted: false });
    expect(await row(first.id)).toMatchObject({ status: 'provisional', reported: 40.1 });
    expect(
      (await storedOperationModified(t().pool, 'deere', [o.externalId, 'nope'])).get(o.externalId),
    ).toBe('2026-10-31T12:00:00.000Z');
  });

  test('clips against the boundary version valid at started_at, else the current one', async () => {
    // 2023 boundary: the whole square; since 2025 the field is the west half only.
    const f = await deereField({ valid: ['2020-01-01T00:00:00Z', '2025-01-01T00:00:00Z'] });
    const ring = f.geom.coordinates[0]?.[0] ?? [];
    const w = ring[0]?.[0] as number;
    const e = ring[1]?.[0] as number;
    const s = ring[0]?.[1] as number;
    const nn = ring[2]?.[1] as number;
    const mid = (w + e) / 2;
    const half = {
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [w, s],
            [mid, s],
            [mid, nn],
            [w, nn],
            [w, s],
          ],
        ],
      ],
    };
    await t().admin.query(
      `insert into farm.field_boundaries (field_id, geom, valid, source)
       values ($1, extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON($2), 4326),
               tstzrange('2025-01-01T00:00:00Z', null, '[)'), 'drawn')`,
      [f.fieldId, JSON.stringify(half)],
    );
    const full = (SIDE * SIDE) / 4046.86;
    const old = await upsertOperation(
      t().pool,
      op({
        fieldExternalId: f.deereFieldId,
        coverage: f.geom,
        startedAt: '2023-10-10T14:00:00Z',
        endedAt: '2023-10-10T18:00:00Z',
        cropYear: 2023,
      }),
      { now: NOW },
    );
    expect((await row(old.id)).clipped).toBeCloseTo(full, 0);
    const recent = await upsertOperation(
      t().pool,
      op({ fieldExternalId: f.deereFieldId, coverage: f.geom }),
      { now: NOW },
    );
    expect((await row(recent.id)).clipped).toBeCloseTo(full / 2, 0);
    // Before any boundary version existed: the current one clips it.
    const ancient = await upsertOperation(
      t().pool,
      op({
        fieldExternalId: f.deereFieldId,
        coverage: f.geom,
        startedAt: '2019-06-01T14:00:00Z',
        endedAt: '2019-06-01T15:00:00Z',
        cropYear: 2019,
      }),
      { now: NOW },
    );
    expect((await row(ancient.id)).clipped).toBeCloseTo(full / 2, 0);
  });

  test('an operation Deere refused coverage for keeps its measured area and no geometry', async () => {
    const f = await deereField();
    const r = await upsertOperation(t().pool, op({ fieldExternalId: f.deereFieldId }), {
      now: NOW,
    });
    expect(await row(r.id)).toMatchObject({ has_geom: false, clipped: null, reported: 39.5 });
  });

  test('an unmapped field is stored with field_id null; deere_field_id alone also matches', async () => {
    const unmapped = await upsertOperation(t().pool, op({ fieldExternalId: 'no-such-field' }), {
      now: NOW,
    });
    expect(unmapped.fieldId).toBeNull();
    expect((await row(unmapped.id)).field_id).toBeNull();
    // A field imported from an Ops Center export: deere_field_id set, no external ref.
    const ids = await insertField(t().adminDb, { name: 'Imported' });
    await t().admin.query(`update farm.fields set deere_field_id = 'imported-1' where id = $1`, [
      ids.fieldId,
    ]);
    const r = await upsertOperation(
      t().pool,
      op({ fieldExternalId: 'imported-1', sourceOrg: 'org-other' }),
      { now: NOW },
    );
    expect(r.fieldId).toBe(ids.fieldId);
  });

  test('coverage is simplified (and overlapping parts unioned) before it is stored', async () => {
    const f = await deereField();
    // The square as 400 overlapping 1 m strips plus a dense outline: one ring when stored.
    const ring = f.geom.coordinates[0]?.[0] ?? [];
    const w = ring[0]?.[0] as number;
    const e = ring[1]?.[0] as number;
    const s = ring[0]?.[1] as number;
    const nn = ring[2]?.[1] as number;
    const strips = Array.from({ length: 400 }, (_, i) => {
      const a = s + ((nn - s) * i) / 400;
      const b = s + ((nn - s) * (i + 1.5)) / 400;
      const top = Math.min(b, nn);
      return [
        [
          [w, a],
          [e, a],
          [e, top],
          [w, top],
          [w, a],
        ],
      ];
    });
    const r = await upsertOperation(
      t().pool,
      op({
        fieldExternalId: f.deereFieldId,
        coverage: { type: 'MultiPolygon', coordinates: strips },
      }),
      { now: NOW },
    );
    const stored = await row(r.id);
    expect(stored.points).toBeLessThan(20);
    expect(stored.clipped).toBeCloseTo((SIDE * SIDE) / 4046.86, 0);
    expect(COVERAGE_TOLERANCE_DEG).toBeLessThan(0.0001);
  });
});

describe('finalizeOperations', () => {
  test('flips operations that aged past 24 h unchanged and names their fields', async () => {
    const f = await deereField();
    const o = op({
      fieldExternalId: f.deereFieldId,
      endedAt: '2026-10-30T20:00:00.000Z',
      modifiedAt: '2026-10-30T20:00:00.000Z',
      startedAt: '2026-10-30T14:00:00.000Z',
    });
    const r = await upsertOperation(t().pool, o, { now: NOW });
    expect((await row(r.id)).status).toBe('provisional');
    expect(await finalizeOperations(t().pool, 'deere', NOW)).not.toContain(f.fieldId);
    const later = new Date(Date.parse('2026-10-31T20:00:01.000Z'));
    expect(await finalizeOperations(t().pool, 'deere', later)).toContain(f.fieldId);
    expect((await row(r.id)).status).toBe('final');
    expect(await finalizeOperations(t().pool, 'deere', later)).not.toContain(f.fieldId);
  });
});

describe('fieldOperations (the field panel read)', () => {
  test("one crop year, oldest first, with machines' unit numbers and coverage flag", async () => {
    const f = await deereField();
    const c = await machine('C9', '909', 'org-x');
    await upsertOperation(
      t().pool,
      op({
        fieldExternalId: f.deereFieldId,
        kind: 'seeding',
        startedAt: '2026-05-06T13:00:00Z',
        endedAt: '2026-05-06T18:00:00Z',
        coverage: f.geom,
      }),
      { now: NOW },
    );
    await upsertOperation(
      t().pool,
      op({ fieldExternalId: f.deereFieldId, machineExternalIds: ['909'] }),
      { now: NOW },
    );
    await upsertOperation(
      t().pool,
      op({
        fieldExternalId: f.deereFieldId,
        cropYear: 2025,
        startedAt: '2025-10-01T13:00:00Z',
        endedAt: '2025-10-01T18:00:00Z',
      }),
      { now: NOW },
    );
    const list = await fieldOperations(t().pool, f.fieldId, 2026);
    expect(list?.map((o) => o.kind)).toEqual(['seeding', 'harvest']);
    expect(list?.[0]).toMatchObject({ hasCoverage: true, status: 'final', cropYear: 2026 });
    expect(list?.[1]).toMatchObject({
      hasCoverage: false,
      operatorName: 'Dale Mercer',
      areaReportedAc: 39.5,
      areaClippedAc: null,
      machines: [{ id: c, unitNo: `C9-${n}` }],
      measurements: { yieldBuAc: 182.4 },
      source: 'deere',
    });
    expect((await fieldOperations(t().pool, f.fieldId, 2025))?.length).toBe(1);
    expect(await fieldOperations(t().pool, f.fieldId, 2024)).toEqual([]);
    expect(await fieldOperations(t().pool, deterministicId('x', 'missing'), 2026)).toBeNull();
    expect(await fieldOperations(t().pool, 'not-a-uuid', 2026)).toBeNull();
  });
});

describe('sync_state.extra and the budget readings', () => {
  test('fieldsPerRun is merged into extra; the budget reads the last full UTC day in its mode', async () => {
    await t().admin.query(
      `insert into ingest.sync_state (source, stream, mode, extra)
       values ('deere', 'operations', 'sandbox',
               '{"callsPerRun": 120, "callsPerRunMode": "sandbox", "other": 1}'),
              ('deere', 'locations', 'sandbox', '{"callsPerRun": 7, "callsPerRunMode": "sandbox"}')
       on conflict (source, stream) do update set extra = excluded.extra`,
    );
    await recordFieldsPerRun(t().pool, 'deere', 'operations', 40);
    const extra = await t().pool.query(
      `select extra from ingest.sync_state where source = 'deere' and stream = 'operations'`,
    );
    expect(extra.rows[0].extra).toEqual({
      callsPerRun: 120,
      callsPerRunMode: 'sandbox',
      other: 1,
      fieldsPerRun: 40,
    });
    await t().admin.query(
      `insert into ingest.api_calls_daily (source, stream, mode, day, calls) values
         ('deere', 'locations', 'sandbox', '2026-10-30', 2000),
         ('deere', 'fields', 'sandbox', '2026-10-30', 300),
         ('deere', 'fields', 'sim', '2026-10-30', 99999),
         ('deere', 'fields', 'sandbox', '2026-10-31', 88888)`,
    );
    const b = await readOpsBudget(t().pool, 'sandbox', NOW);
    expect(b).toEqual({
      lastDay: { locations: 2000, fields: 300 },
      locationsCallsPerRun: 7,
      callsPerRun: 120,
      fieldsPerRun: 40,
    });
    // A measurement made in another mode (sim) never sizes this budget.
    await t().admin.query(
      `update ingest.sync_state set extra = extra || '{"callsPerRunMode": "sim"}'
        where source = 'deere' and stream = 'locations'`,
    );
    expect((await readOpsBudget(t().pool, 'sandbox', NOW)).locationsCallsPerRun).toBeNull();
  });
});

describe('the full-day sprayer payload', () => {
  test('map + upsert of the one item takes under 10 s', async () => {
    const f = await deereField();
    // A full day of passes centred on this field (the stand-in builds it around a demo field).
    const coverage = fullDaySprayerCoverage({
      ...buildDemoFarm(1).fields[3],
      boundary: f.geom,
    } as SimField);
    expect(coverage.coordinates.length).toBeGreaterThan(40_000);
    const raw: DeereOperationRaw = {
      orgId: 'org-x',
      fieldId: f.deereFieldId,
      operation: {
        id: 'full-day-1',
        fieldOperationType: 'application',
        cropSeason: '2026',
        startDate: '2026-10-29T10:00:00.000Z',
        endDate: '2026-10-29T22:00:00.000Z',
        modifiedTime: '2026-10-29T22:30:00.000Z',
        products: { name: 'Tank Mix', tankMix: true },
      },
      measurements: [],
      coverage: {
        multipolygons: coverage.coordinates.map((poly) => ({
          rings: poly.map((r, i) => ({
            type: i === 0 ? ('exterior' as const) : ('interior' as const),
            points: r.map((p) => ({ lat: p[1] as number, lon: p[0] as number })),
          })),
        })),
      },
      coverageStatus: 'ok',
    };
    const payload = JSON.parse(JSON.stringify(raw)) as unknown; // as landed
    const started = performance.now();
    const items = mapDeereOperation(payload);
    expect(items).toHaveLength(1);
    const r = await t().db.transaction((tx) =>
      upsertOperation(tx, items[0] as NormalizedOperation, { now: NOW }),
    );
    const ms = performance.now() - started;
    expect(ms).toBeLessThan(10_000);
    const stored = await row(r.id);
    expect(stored.has_geom).toBe(true);
    expect(stored.points).toBeLessThan(2_000);
    // The day covered ~2 100 acres around the field; the field's own part is the clipped area.
    expect(stored.reported).toBeNull(); // no measurements in this payload
    expect(stored.clipped).toBeCloseTo((SIDE * SIDE) / 4046.86, 0);
  }, 60_000);
});
