/**
 * The field panel's query against a real database, as farm_app: one statement builds the whole
 * FieldDetail (party, boundary, five seasons, soils, parcels, notes, lineage, change requests,
 * spray), notes saves are optimistic and publish fields/updated in their transaction, and on a
 * 500-field farm every per-field lookup is an index scan (EXPLAIN).
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { FIELD_PANEL_SEASONS } from '../../domain/fields';
import { LOCAL_NOTIFY_CHANNEL, type NotifyMessage } from '../../platform/realtime/types';
import { setupTestDb } from '../../test/db';
import { ADRIAN_QUARTER_SECTION, insertField, squareMultiPolygon } from '../../test/fixtures';
import type { Queryable } from '../client';
import { FIELD_DETAIL_SQL, fieldDetail, saveFieldNotes } from './fields';

const t = setupTestDb(import.meta.url);

const ring = ADRIAN_QUARTER_SECTION.coordinates[0]?.[0] ?? [];
const [SW_LNG = 0, SW_LAT = 0] = ring[0] ?? [];
const [NE_LNG = 0, NE_LAT = 0] = ring[2] ?? [];
const MID_LNG = (SW_LNG + NE_LNG) / 2;

/** A rectangle as GeoJSON MultiPolygon text. */
function rect(w: number, s: number, e: number, n: number): string {
  return JSON.stringify({
    type: 'MultiPolygon',
    coordinates: [
      [
        [
          [w, s],
          [e, s],
          [e, n],
          [w, n],
          [w, s],
        ],
      ],
    ],
  });
}
const GEOM = `extensions.ST_Multi(extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON($1), 4326))`;

let listener: pg.Client;
const received: NotifyMessage[] = [];

beforeAll(async () => {
  listener = new pg.Client({ connectionString: t().appUrl });
  await listener.connect();
  listener.on('notification', (n) => {
    if (n.channel === LOCAL_NOTIFY_CHANNEL && n.payload) {
      received.push(JSON.parse(n.payload) as NotifyMessage);
    }
  });
  await listener.query(`listen ${LOCAL_NOTIFY_CHANNEL}`);
});
afterAll(async () => {
  await listener?.end();
});

async function waitForNotice(pred: (m: NotifyMessage) => boolean, ms = 2000) {
  const started = Date.now();
  for (;;) {
    const hit = received.find(pred);
    if (hit) return hit;
    if (Date.now() - started > ms) throw new Error(`no notification within ${ms} ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function party(name: string, kind: 'person' | 'org' = 'person', extra: object = {}) {
  const r = await t().pool.query<{ id: string }>(
    `insert into farm.parties (kind, display_name, phone, email, roles)
     values ($1, $2, $3, $4, $5) returning id`,
    [
      kind,
      name,
      (extra as { phone?: string }).phone ?? null,
      (extra as { email?: string }).email ?? null,
      (extra as { roles?: string[] }).roles ?? [],
    ],
  );
  return r.rows[0]?.id as string;
}

describe('fieldDetail', () => {
  test('one statement returns the whole panel for a rich field', async () => {
    const { pool, db } = t();
    const { fieldId, farmId, boundaryId } = await insertField(db, {
      name: 'Kowalski North',
      geom: ADRIAN_QUARTER_SECTION,
      tenure: 'cash_rent',
    });
    // The panel is read at a fixed instant below: the boundary must already be valid then,
    // whatever the wall clock says when the suite runs.
    await pool.query(
      `update farm.field_boundaries set valid = tstzrange('2026-01-01T00:00:00Z', null)
        where id = $1`,
      [boundaryId],
    );
    const landlord = await party('Ivan Abernath', 'person', {
      phone: '(517) 555-0109',
      email: 'ivan@example.com',
      roles: ['landlord'],
    });
    const client = await party('Halvorsen Bros. Farms', 'org', { roles: ['customer'] });
    await pool.query(
      `update farm.fields set landlord_party_id = $2, deere_field_id = 'deere-f-1' where id = $1`,
      [fieldId, landlord],
    );
    await pool.query('update farm.farms set client_party_id = $2 where id = $1', [farmId, client]);

    // Seven crop years: the panel shows the five newest.
    for (const year of [2019, 2020, 2021, 2022, 2023, 2024, 2025]) {
      await pool.query(
        `insert into farm.field_seasons
           (field_id, crop_year, crop, variety, planted_on, harvested_on, yield_bu_ac, source)
         values ($1, $2, $3, $4, $5, $6, $7, 'import')`,
        [
          fieldId,
          year,
          year % 2 ? 'soybeans' : 'corn',
          `V-${year}`,
          `${year}-05-0${(year % 9) + 1}`,
          year === 2022 ? '2023-01-04' : `${year}-10-15`,
          year % 2 ? 55.5 : 190.25,
        ],
      );
    }

    // Soils: two map units splitting the quarter section west/east (clipped by the SQL rebuild).
    await pool.query(
      `insert into gis.soil_mapunits (mukey, areasymbol, musym, muname, dominant_component,
                                      drainage_class, hydgrp, nccpi)
       values ('100001', 'MI091', 'BnB', 'Blount loam, 2 to 4 percent slopes', 'Blount',
               'Somewhat poorly drained', 'C/D', 0.6123),
              ('100002', 'MI091', 'Pe', 'Pewamo clay loam', 'Pewamo', 'Very poorly drained',
               'C/D', 0.5)`,
    );
    await pool.query(
      `insert into gis.soil_polygons (mukey, areasymbol, geom, source_id)
       values ('100001', 'MI091', ${GEOM}, 'p1'),
              ('100002', 'MI091', extensions.ST_Multi(extensions.ST_SetSRID(
                 extensions.ST_GeomFromGeoJSON($2), 4326)), 'p2')`,
      [
        rect(SW_LNG - 0.01, SW_LAT - 0.01, MID_LNG, NE_LAT + 0.01),
        rect(MID_LNG, SW_LAT - 0.01, NE_LNG + 0.01, NE_LAT + 0.01),
      ],
    );
    await pool.query('select gis.rebuild_field_soils($1)', [boundaryId]);

    // Parcels: west half (with an owner), east half, one sharing only the east fence line, one far away.
    const imp = await pool.query<{ id: string }>(
      `insert into gis.parcel_imports (source, county_fips, received_on)
       values ('synthetic', '26091', '2026-10-01') returning id`,
    );
    const importId = imp.rows[0]?.id;
    const parcel = (no: string, owner: string | null, geom: string) =>
      pool.query(
        `insert into gis.parcels (import_id, county_fips, parcel_no, owner_name, acres, geom)
         values ($2, '26091', $3, $4, 80, ${GEOM})`,
        [geom, importId, no, owner],
      );
    await parcel(
      'XA0-100',
      'Abernath Ivan',
      rect(SW_LNG - 0.001, SW_LAT - 0.001, MID_LNG, NE_LAT + 0.001),
    );
    await parcel('XA0-200', null, rect(MID_LNG, SW_LAT - 0.001, NE_LNG + 0.003, NE_LAT + 0.001));
    await parcel('XA0-300', 'Fence Line', rect(NE_LNG, SW_LAT, NE_LNG + 0.01, NE_LAT));
    await parcel('XA0-900', 'Far Away', rect(-83.5, 41.7, -83.49, 41.71));

    // Lineage: split from an older field, merged into a newer one.
    const { fieldId: parentId } = await insertField(db, { name: 'Old Kowalski' });
    const { fieldId: childId } = await insertField(db, { name: 'Kowalski Big' });
    await pool.query(
      `insert into farm.field_lineage (parent_field_id, child_field_id, kind, effective_on)
       values ($1, $2, 'split', '2024-03-01'), ($2, $3, 'merge', '2026-04-01')`,
      [parentId, fieldId, childId],
    );

    // One open and one resolved "change this in Ops Center" request.
    await pool.query(
      `insert into farm.boundary_change_requests (field_id, note, resolved_at, resolution)
       values ($1, 'move the north line', null, null), ($1, 'old', now(), 'done in Ops Center')`,
      [fieldId],
    );

    // Spray: the current hour twice (the newest wins), and the previous hour.
    const now = new Date('2026-10-29T14:25:00Z');
    await pool.query(
      `insert into farm.spray_assessments
         (field_id, for_hour, verdict, reasons, rules_version, assessed_at, forecast_issued_at)
       values ($1, '2026-10-29T14:00:00Z', 'go', '[]', 'v0-a', '2026-10-29T13:00:00Z', null),
              ($1, '2026-10-29T14:00:00Z', 'caution', $2, 'v0-b', '2026-10-29T13:30:00Z',
               '2026-10-29T12:00:00Z'),
              ($1, '2026-10-29T13:00:00Z', 'no_go', '[]', 'v0-b', '2026-10-29T13:30:00Z', null)`,
      [
        fieldId,
        JSON.stringify([
          {
            code: 'wind_caution',
            verdict: 'caution',
            message: 'Wind 9 mph',
            value: 9,
            threshold: 8,
          },
        ]),
      ],
    );

    // Count round trips.
    let statements = 0;
    const counting: Queryable = {
      query: ((text: string, values?: unknown[]) => {
        statements++;
        return pool.query(text, values);
      }) as pg.Pool['query'],
    };
    const d = await fieldDetail(counting, fieldId, now);
    expect(statements).toBe(1);
    if (!d) throw new Error('no detail');

    expect(d.field).toEqual({
      id: fieldId,
      name: 'Kowalski North',
      farmId,
      farmName: 'Home farm',
      tenure: 'cash_rent',
      acres: expect.closeTo(160, 0),
      countyFips: '26091',
      landlord: {
        id: landlord,
        displayName: 'Ivan Abernath',
        kind: 'person',
        phone: '(517) 555-0109',
        email: 'ivan@example.com',
      },
      customer: {
        id: client,
        displayName: 'Halvorsen Bros. Farms',
        kind: 'org',
        phone: null,
        email: null,
      },
      deereFieldId: 'deere-f-1',
      active: true,
    });
    expect(d.boundary).toMatchObject({
      id: boundaryId,
      source: 'import',
      sourceRef: null,
      editable: false,
      readOnlyReason: expect.stringMatching(/Operations Center/),
    });
    expect(d.boundary?.acres).toBe(d.field.acres);
    expect(d.boundary?.validFrom).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const [w, s, e, n] = d.boundary?.bbox ?? [];
    expect(w).toBeCloseTo(SW_LNG, 5);
    expect(s).toBeCloseTo(SW_LAT, 5);
    expect(e).toBeCloseTo(NE_LNG, 5);
    expect(n).toBeCloseTo(NE_LAT, 5);

    expect(d.seasons).toHaveLength(FIELD_PANEL_SEASONS);
    expect(d.seasons.map((x) => x.cropYear)).toEqual([2025, 2024, 2023, 2022, 2021]);
    expect(d.seasons[0]).toEqual({
      cropYear: 2025,
      crop: 'soybeans',
      variety: 'V-2025',
      plantedOn: '2025-05-01',
      harvestedOn: '2025-10-15',
      yieldBuAc: 55.5,
      source: 'import',
    });
    expect(d.seasons[3]).toMatchObject({ harvestedOn: '2023-01-04', yieldBuAc: 190.25 });

    expect(d.soils.map((x) => x.mukey).sort()).toEqual(['100001', '100002']);
    const blount = d.soils.find((x) => x.mukey === '100001');
    expect(blount).toMatchObject({
      musym: 'BnB',
      dominantComponent: 'Blount',
      drainageClass: 'Somewhat poorly drained',
      nccpi: 0.612,
      pct: expect.closeTo(50, 0),
    });
    expect(blount?.acres).toBeCloseTo(80, 0);
    expect(d.soilsSummary?.coveredPct).toBeCloseTo(100, 0);
    expect(d.soilsSummary?.weightedNccpi).toBeCloseTo(0.556, 2);

    expect(d.parcels.map((p) => p.parcelNo)).toHaveLength(2);
    expect(d.parcels.map((p) => p.parcelNo).sort()).toEqual(['XA0-100', 'XA0-200']);
    const west = d.parcels.find((p) => p.parcelNo === 'XA0-100');
    expect(west).toMatchObject({
      countyFips: '26091',
      ownerName: 'Abernath Ivan',
      acres: 80,
      importSource: 'synthetic',
      receivedOn: '2026-10-01',
      overlapPct: expect.closeTo(50, 0),
    });
    expect(west?.overlapAcres).toBeCloseTo(80, 0);
    expect(west?.gisAcres).toBeGreaterThan(80);

    expect(d.lineage).toEqual({
      parents: [
        { fieldId: parentId, name: 'Old Kowalski', kind: 'split', effectiveOn: '2024-03-01' },
      ],
      children: [
        { fieldId: childId, name: 'Kowalski Big', kind: 'merge', effectiveOn: '2026-04-01' },
      ],
    });
    expect(d.openBoundaryRequests).toBe(1);
    expect(d.spray).toEqual({
      fieldId,
      forHour: '2026-10-29T14:00:00.000Z',
      verdict: 'caution',
      reasons: [
        { code: 'wind_caution', verdict: 'caution', message: 'Wind 9 mph', value: 9, threshold: 8 },
      ],
      rulesVersion: 'v0-b',
      forecastIssuedAt: '2026-10-29T12:00:00.000Z',
      assessedAt: '2026-10-29T13:30:00.000Z',
    });
    expect(d.openJobs).toEqual({ count: 0, placeholder: true });
    expect(d.notes).toMatchObject({ text: null, updatedAt: null, updatedByName: null });
    expect(d.notes.version).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);

    // An hour with no assessment: no verdict.
    expect((await fieldDetail(pool, fieldId, new Date('2026-10-29T16:05:00Z')))?.spray).toBeNull();
  });

  test('a field with no boundary, seasons or parties; an editable non-Deere boundary', async () => {
    const { pool, db } = t();
    const bare = await insertField(db, { name: 'Prospect', tenure: 'owned' });
    const d = await fieldDetail(pool, bare.fieldId);
    expect(d).toMatchObject({
      field: { name: 'Prospect', acres: null, landlord: null, customer: null, deereFieldId: null },
      boundary: null,
      seasons: [],
      soils: [],
      soilsSummary: null,
      parcels: [],
      lineage: { parents: [], children: [] },
      openBoundaryRequests: 0,
      spray: null,
    });

    const drawn = await insertField(db, {
      name: 'Drawn',
      geom: squareMultiPolygon(-83.9, 41.8, 400),
    });
    expect((await fieldDetail(pool, drawn.fieldId))?.boundary).toMatchObject({
      editable: true,
      readOnlyReason: null,
    });
  });

  test('the boundary version current at `now`', async () => {
    const { pool, db } = t();
    const { fieldId, boundaryId } = await insertField(db, {
      name: 'Versions',
      geom: squareMultiPolygon(-83.95, 41.82, 400),
    });
    await pool.query(
      `update farm.field_boundaries set valid = tstzrange('2020-01-01', '2026-01-01', '[)')
        where id = $1`,
      [boundaryId],
    );
    const r = await pool.query<{ id: string }>(
      `insert into farm.field_boundaries (field_id, geom, source, valid)
       values ($1, ${GEOM.replace('$1', '$2')}, 'drawn', tstzrange('2026-01-01', null, '[)'))
       returning id`,
      [fieldId, JSON.stringify(squareMultiPolygon(-83.95, 41.82, 600))],
    );
    const newId = r.rows[0]?.id;
    const before = await fieldDetail(pool, fieldId, new Date('2025-06-01T00:00:00Z'));
    const after = await fieldDetail(pool, fieldId, new Date('2026-06-01T00:00:00Z'));
    expect(before?.boundary?.id).toBe(boundaryId);
    expect(after?.boundary?.id).toBe(newId);
    expect(after?.boundary?.validFrom).toBe('2026-01-01T00:00:00.000Z');
    expect(after?.field.acres).toBeGreaterThan(before?.field.acres ?? Infinity);
    expect(await fieldDetail(pool, fieldId, new Date('2019-01-01T00:00:00Z'))).toMatchObject({
      boundary: null,
      field: { acres: null },
    });
  });

  test('unknown and malformed ids are null, never a database error', async () => {
    const { pool } = t();
    expect(await fieldDetail(pool, '00000000-0000-4000-8000-000000000000')).toBeNull();
    expect(await fieldDetail(pool, 'not-a-uuid')).toBeNull();
    expect(await fieldDetail(pool, "'; drop table farm.fields; --")).toBeNull();
  });
});

describe('saveFieldNotes', () => {
  test('saves, moves the version, names the editor and publishes fields/updated', async () => {
    const { pool, db } = t();
    const { fieldId } = await insertField(db, { name: 'Notes' });
    const dana = await party('Dana Ruiz');
    const u = await pool.query<{ id: string }>(
      `insert into farm.app_users (party_id, role) values ($1, 'manager') returning id`,
      [dana],
    );
    const appUserId = u.rows[0]?.id ?? null;
    const before = await fieldDetail(pool, fieldId);
    if (!before) throw new Error('no field');

    const r = await saveFieldNotes(db, {
      fieldId,
      text: 'Gate code 1234',
      version: before.notes.version,
      appUserId,
    });
    expect(r.status).toBe('saved');
    if (r.status !== 'saved') return;
    expect(r.notes).toMatchObject({ text: 'Gate code 1234', updatedByName: 'Dana Ruiz' });
    expect(r.notes.version).not.toBe(before.notes.version);
    expect(Date.parse(r.notes.updatedAt ?? '')).toBeGreaterThan(Date.now() - 60_000);

    const msg = await waitForNotice(
      (m) => m.topic === 'fields' && m.event === 'updated' && m.payload.fieldId === fieldId,
    );
    expect(msg.payload).toMatchObject({ fieldId, parts: ['notes'] });

    // The panel now reads what was saved, with the same version.
    const after = await fieldDetail(pool, fieldId);
    expect(after?.notes).toEqual(r.notes);

    // Clearing is a save too.
    const cleared = await saveFieldNotes(db, {
      fieldId,
      text: null,
      version: r.notes.version,
      appUserId: null,
    });
    expect(cleared).toMatchObject({ status: 'saved', notes: { text: null, updatedByName: null } });
  });

  test('a stale version is a conflict: nothing written, nothing published', async () => {
    const { pool, db } = t();
    const { fieldId } = await insertField(db, { name: 'Conflict' });
    const v0 = (await fieldDetail(pool, fieldId))?.notes.version ?? '';
    const first = await saveFieldNotes(db, {
      fieldId,
      text: 'first',
      version: v0,
      appUserId: null,
    });
    expect(first.status).toBe('saved');
    await waitForNotice((m) => m.topic === 'fields' && m.payload.fieldId === fieldId);
    const seen = received.length;
    const second = await saveFieldNotes(db, {
      fieldId,
      text: 'second',
      version: v0,
      appUserId: null,
    });
    expect(second).toMatchObject({ status: 'conflict', notes: { text: 'first' } });
    expect((await fieldDetail(pool, fieldId))?.notes.text).toBe('first');
    await new Promise((res) => setTimeout(res, 150));
    expect(
      received.slice(seen).filter((m) => m.topic === 'fields' && m.payload.fieldId === fieldId),
    ).toEqual([]);
  });

  test('two saves racing on one version: exactly one wins', async () => {
    const { pool, db } = t();
    const { fieldId } = await insertField(db, { name: 'Race' });
    const v0 = (await fieldDetail(pool, fieldId))?.notes.version ?? '';
    const results = await Promise.all(
      ['a', 'b', 'c'].map((text) =>
        saveFieldNotes(db, { fieldId, text, version: v0, appUserId: null }),
      ),
    );
    expect(results.filter((r) => r.status === 'saved')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'conflict')).toHaveLength(2);
  });

  test('unknown fields', async () => {
    const { db } = t();
    const v = '2026-10-29T13:55:00.123456Z';
    expect(
      await saveFieldNotes(db, {
        fieldId: '00000000-0000-4000-8000-000000000000',
        text: 'x',
        version: v,
        appUserId: null,
      }),
    ).toEqual({ status: 'not_found' });
    expect(
      await saveFieldNotes(db, { fieldId: 'nope', text: 'x', version: v, appUserId: null }),
    ).toEqual({ status: 'not_found' });
  });
});

describe('the plan on a 500-field farm', () => {
  /** Tables that grow with fields × years or hours: never read whole for one field. */
  const BIG_TABLES = [
    'fields',
    'field_boundaries',
    'field_seasons',
    'field_soils',
    'parcels',
    'spray_assessments',
  ];
  /** Every table the statement reads per field (lineage and change requests stay small). */
  const PER_FIELD_TABLES = [...BIG_TABLES, 'field_lineage', 'boundary_change_requests'];

  interface PlanNode {
    'Node Type': string;
    'Relation Name'?: string;
    'Index Name'?: string;
    Plans?: PlanNode[];
  }
  function walk(node: PlanNode, out: PlanNode[] = []): PlanNode[] {
    out.push(node);
    for (const p of node.Plans ?? []) walk(p, out);
    return out;
  }
  function seqScansOf(nodes: PlanNode[], tables: string[]): string[] {
    return nodes
      .filter((n) => n['Node Type'] === 'Seq Scan' && tables.includes(n['Relation Name'] ?? ''))
      .map((n) => n['Relation Name'] ?? '');
  }
  async function explain(
    params: unknown[],
    noSeqScan: boolean,
  ): Promise<{ Plan: PlanNode; 'Execution Time': number }> {
    const client = await t().pool.connect();
    try {
      await client.query('begin');
      if (noSeqScan) await client.query('set local enable_seqscan = off');
      const r = await client.query<{
        'QUERY PLAN': [{ Plan: PlanNode; 'Execution Time': number }];
      }>(`explain (analyze, format json) ${FIELD_DETAIL_SQL}`, params);
      const plan = r.rows[0]?.['QUERY PLAN'][0];
      if (!plan) throw new Error('no plan');
      return plan;
    } finally {
      await client.query('rollback').catch(() => {});
      client.release();
    }
  }

  test('every per-field lookup uses an index', async () => {
    const { admin, pool } = t();
    const N = 500;
    // A grid of 500 fields east of the other tests' fields, each with a boundary, six seasons,
    // a parcel under it, soils rows, 13 hours of verdicts; plus lineage and change requests.
    await admin.query(`
      with fa as (insert into farm.farms (name) values ('Bulk farm') returning id),
      fl as (
        insert into farm.fields (farm_id, name, tenure, county_fips, source, source_id)
        select fa.id, 'Bulk ' || g, 'owned', '26115', 'test', 'bulk:' || g
          from fa, generate_series(1, ${N}) g
        returning id, source_id)
      insert into farm.field_boundaries (field_id, geom, source)
      select fl.id,
             extensions.ST_Multi(extensions.ST_MakeEnvelope(
               -83.6 + (n % 25) * 0.006, 41.75 + (n / 25) * 0.006,
               -83.6 + (n % 25) * 0.006 + 0.005, 41.75 + (n / 25) * 0.006 + 0.005, 4326)),
             'import'
        from (select id, substr(source_id, 6)::int - 1 as n from fl) fl`);
    await admin.query(`
      insert into farm.field_seasons (field_id, crop_year, crop, yield_bu_ac, source)
      select f.id, y, 'corn', 180, 'import'
        from farm.fields f, generate_series(2020, 2025) y
       where f.source = 'test'`);
    await admin.query(`
      insert into farm.spray_assessments (field_id, for_hour, verdict, rules_version)
      select f.id, date_trunc('hour', now(), 'UTC') + h * interval '1 hour', 'go', 'v0-x'
        from farm.fields f, generate_series(0, 12) h
       where f.source = 'test'`);
    await admin.query(`
      insert into gis.soil_mapunits (mukey, areasymbol, muname)
      select 'bulk' || g, 'MI115', 'Bulk unit ' || g from generate_series(1, 50) g`);
    await admin.query(`
      insert into gis.field_soils (boundary_id, mukey, acres, pct)
      select b.id, 'bulk' || (1 + (abs(hashtext(b.id::text)) + k) % 50), 20, 30
        from farm.field_boundaries b
        join farm.fields f on f.id = b.field_id and f.source = 'test',
             generate_series(0, 2) k`);
    await admin.query(`
      with imp as (insert into gis.parcel_imports (source, county_fips) values ('synthetic', '26115')
                   returning id)
      insert into gis.parcels (import_id, county_fips, parcel_no, geom)
      select imp.id, '26115', 'BULK-' || b.id, b.geom
        from imp, farm.field_boundaries b
        join farm.fields f on f.id = b.field_id and f.source = 'test'`);
    await admin.query(`
      insert into farm.field_lineage (parent_field_id, child_field_id, kind, effective_on)
      select a.id, b.id, 'split', '2025-01-01'
        from (select id, row_number() over (order by id) r from farm.fields where source = 'test') a
        join (select id, row_number() over (order by id) r from farm.fields where source = 'test') b
          on b.r = a.r + 1
       where a.r % 3 = 0`);
    await admin.query(`
      insert into farm.boundary_change_requests (field_id, note)
      select id, 'bulk' from farm.fields where source = 'test' and abs(hashtext(id::text)) % 5 = 0`);
    await admin.query('analyze');

    const target = await pool.query<{ id: string }>(
      `select id from farm.fields where source = 'test' order by source_id limit 1 offset 250`,
    );
    const fieldId = target.rows[0]?.id;
    const params = [fieldId, new Date().toISOString()];

    // As planned: the big tables are reached through their indexes.
    const plan = await explain(params, false);
    const nodes = walk(plan.Plan);
    expect(seqScansOf(nodes, BIG_TABLES)).toEqual([]);
    const indexes = new Set(nodes.map((n) => n['Index Name']).filter(Boolean));
    for (const idx of [
      'fields_pkey',
      'field_boundaries_no_overlap',
      'field_seasons_field_id_crop_year_key',
      'field_soils_pkey',
      'spray_assessments_field_id_for_hour_idx',
      'parcels_geom_gist',
    ]) {
      expect(indexes, `plan uses ${idx}`).toContain(idx);
    }
    console.log(
      `[fields.db.test] FieldDetail on a ${N}-field farm: ${plan['Execution Time'].toFixed(2)} ms`,
    );

    // And every per-field lookup HAS an index (the planner may still prefer a scan of a small
    // table, e.g. a few hundred lineage rows; with sequential scans off it must not need one).
    const forced = await explain(params, true);
    expect(seqScansOf(walk(forced.Plan), PER_FIELD_TABLES)).toEqual([]);

    const d = await fieldDetail(pool, fieldId ?? '');
    expect(d?.seasons).toHaveLength(FIELD_PANEL_SEASONS);
    expect(d?.soils).toHaveLength(3);
    expect(d?.parcels.length).toBeGreaterThanOrEqual(1);
    expect(d?.parcels[0]?.overlapPct).toBeCloseTo(100, 0);
    expect(d?.spray?.verdict).toBe('go');
  });
});
