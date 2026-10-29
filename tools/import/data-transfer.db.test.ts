/**
 * The plan 1c done-when, as a test: data:export -> db:reset -> re-sync -> data:import leaves
 * hand-entered data unchanged, including references to synced rows (here the demo seed stands
 * in for a sync: its rows carry deterministic ids, as synced rows do).
 */
import type pg from 'pg';
import { describe, expect, test } from 'vitest';
import { importBoundaries, requestBoundaryChange } from '../../src/db/queries/boundaries';
import { splitField } from '../../src/db/queries/lineage';
import {
  createParty,
  setFarmClient,
  setFieldLandlord,
  validateParty,
} from '../../src/db/queries/parties';
import { importSeasons } from '../../src/db/queries/seasons';
import { localParts } from '../../src/sim/time';
import { setupTestDb } from '../../src/test/db';
import { seedDemo } from '../seed/demo';
import { asMultiPolygon } from './boundary-file';
import { checkExportDoc, type ExportDoc, exportData, importData, TABLES } from './data-transfer';
import { parseSeasonsCsv } from './seasons-csv';
import { rectangle } from './testing/shapefile';

const t = setupTestDb(import.meta.url);
const actor = { appUserId: null, displayName: 'Derrick' };
const pad = (n: number) => String(n).padStart(2, '0');
const lp = localParts(Date.now());
const TODAY = `${lp.y}-${pad(lp.m)}-${pad(lp.d)}`;

/** What db:reset + the demo seed leave: every farm row gone, the demo farm back. */
async function resetAndResync(admin: pg.Pool, pool: pg.Pool): Promise<void> {
  const r = await admin.query<{ t: string }>(
    `select format('%I.%I', schemaname, tablename) as t from pg_tables where schemaname in ('farm', 'ingest')`,
  );
  await admin.query(`truncate ${r.rows.map((x) => x.t).join(', ')} cascade`);
  await admin.query(`delete from app.settings where key <> 'clock.paused'`);
  await seedDemo(pool, { seed: 1, eldVendor: 'samsara' });
}

const withoutStamp = (d: ExportDoc) => ({ ...d, exportedAt: 'x' });

describe('data:export / data:import', () => {
  test('round trip through a reset, with references to synced rows', async () => {
    const { pool, admin } = t();
    await seedDemo(pool, { seed: 1, eldVendor: 'samsara' });

    // Hand-entered data of every kind, some of it pointing at demo (synced) rows.
    const landlord = validateParty({
      displayName: 'River Bend Land LLC',
      kind: 'org',
      roles: 'landlord',
    });
    const customer = validateParty({
      displayName: 'Piotrowski Farms',
      kind: 'org',
      roles: 'customer',
    });
    if (!landlord.ok || !customer.ok) throw new Error('fixture');
    const landlordId = await createParty(pool, landlord.value, actor);
    const joan = validateParty({
      displayName: 'Joan Albrecht',
      roles: 'landlord',
      orgId: landlordId,
    });
    if (!joan.ok) throw new Error('fixture');
    await createParty(pool, joan.value, actor);
    const customerId = await createParty(pool, customer.value, actor);

    const someDemoField = (
      await pool.query<{ id: string }>(
        `select id from farm.fields where source = 'demo' and tenure = 'owned' order by name limit 1`,
      )
    ).rows[0]?.id;
    if (!someDemoField) throw new Error('no demo field');
    await setFieldLandlord(pool, { fieldId: someDemoField, partyId: landlordId, actor });
    await pool.query(
      `update farm.fields set notes = 'Wet corner by the creek', notes_updated_at = now() where id = $1`,
      [someDemoField],
    );
    const demoFarm = await pool.query<{ id: string }>(
      `select farm_id as id from farm.fields where id = $1`,
      [someDemoField],
    );
    await setFarmClient(pool, {
      farmId: demoFarm.rows[0]?.id as string,
      partyId: customerId,
      actor,
    });
    await requestBoundaryChange(pool, { fieldId: someDemoField, note: 'Waterway moved', actor });

    const imported = await importBoundaries(pool, [
      {
        name: 'Prospect 160',
        nameSource: 'attribute',
        farmName: 'Prospects',
        clientName: null,
        deereFieldId: null,
        geometry: asMultiPolygon(rectangle(-84.45, 41.7, 805, 805)),
        featureCount: 1,
        sourceRef: 'test.zip',
      },
    ]);
    const prospect = imported.items[0]?.fieldId as string;
    const seasons = parseSeasonsCsv(
      [
        'field,crop_year,crop,variety,planted_on,harvested_on,yield_bu_ac',
        'Prospect 160,2024,corn,,,,190',
        `${(await pool.query<{ name: string }>('select name from farm.fields where id = $1', [someDemoField])).rows[0]?.name},2019,wheat,,,,80`,
      ].join('\n'),
      2026,
    );
    expect(seasons.errors).toEqual([]);
    expect((await importSeasons(pool, seasons.rows)).written).toBe(true);
    const split = await splitField(pool, {
      fieldId: prospect,
      line: {
        type: 'LineString',
        coordinates: [
          [-84.45 + 0.0048, 41.69],
          [-84.45 + 0.0048, 41.72],
        ],
      },
      names: ['Prospect West', 'Prospect East'],
      effectiveOn: TODAY,
      actor,
    });
    expect(split.childIds).toHaveLength(2);
    await pool.query(
      `insert into app.settings (key, value) values ('spray.thresholds', '{"isDefault": false}')
       on conflict (key) do update set value = excluded.value`,
    );

    const first = await exportData(pool);
    expect(first.tables['farm.parties']).toHaveLength(3);
    expect(first.tables['farm.fields']).toHaveLength(3);
    expect(first.tables['farm.field_boundaries']).toHaveLength(3);
    expect(first.tables['farm.field_seasons']).toHaveLength(2);
    expect(first.tables['farm.field_lineage']).toHaveLength(2);
    expect(first.tables['farm.boundary_change_requests']).toHaveLength(1);
    expect(first.tables['app.settings']).toHaveLength(1);
    // Nothing from the demo farm, except the hand-entered overlays on it.
    expect(first.tables['farm.parties']?.every((p) => p.source !== 'demo')).toBe(true);
    expect(first.overlays['farm.fields']).toEqual([
      expect.objectContaining({
        id: someDemoField,
        landlord_party_id: landlordId,
        notes: 'Wet corner by the creek',
      }),
    ]);
    expect(first.overlays['farm.farms']).toEqual([
      { id: demoFarm.rows[0]?.id, client_party_id: customerId },
    ]);
    // A file is JSON in and out.
    const file = JSON.parse(JSON.stringify(first));

    await resetAndResync(admin, pool);
    const gone = await pool.query(`select 1 from farm.parties where source = 'app'`);
    expect(gone.rowCount).toBe(0);

    const report = await importData(pool, file);
    expect(report.errors).toEqual([]);
    expect(report.written).toBe(true);
    expect(report.tables['farm.parties']).toEqual({
      inserted: 3,
      updated: 0,
      unchanged: 0,
      failed: 0,
    });
    expect(report.overlays['farm.fields']?.updated).toBe(1);

    const second = await exportData(pool);
    expect(withoutStamp(second)).toEqual(withoutStamp(first));

    // The demo season for 2019 gave way? No: the demo seed has 2021-2025 only, so both stay.
    const s = await pool.query(
      `select source from farm.field_seasons where field_id = $1 order by crop_year`,
      [someDemoField],
    );
    expect(s.rows.map((r) => r.source)).toEqual(['import', 'demo', 'demo', 'demo', 'demo', 'demo']);
    // Soils, acres and the current-boundary view follow on their own.
    const current = await pool.query(
      `select f.name from farm.current_boundaries b join farm.fields f on f.id = b.field_id
        where f.source = 'app' order by f.name`,
    );
    expect(current.rows.map((r) => r.name)).toEqual(['Prospect East', 'Prospect West']);

    // Importing again changes nothing.
    const again = await importData(pool, file);
    for (const c of Object.values(again.tables)) {
      expect(c.inserted + c.updated + c.failed).toBe(0);
    }
    expect(again.overlays['farm.fields']).toMatchObject({ updated: 0, unchanged: 1 });
  });

  test('all or nothing, dry run, and refusing what is not an export', async () => {
    const { pool } = t();
    const doc = await exportData(pool);
    const bad = {
      ...doc,
      tables: {
        ...doc.tables,
        'farm.parties': [
          {
            id: '4b7f1c52-8e0a-5d3b-9a61-2f0c8d4e7a10',
            kind: 'person',
            display_name: 'Ok',
            roles: [],
            source: 'app',
          },
          {
            id: '4b7f1c52-8e0a-5d3b-9a61-2f0c8d4e7a11',
            kind: 'robot',
            display_name: 'Bad',
            roles: [],
            source: 'app',
          },
        ],
      },
    };
    const r = await importData(pool, bad);
    expect(r.written).toBe(false);
    expect(r.errors, JSON.stringify(r.errors)).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({
      table: 'farm.parties',
      id: '4b7f1c52-8e0a-5d3b-9a61-2f0c8d4e7a11',
    });
    expect(r.errors[0]?.message).toMatch(/parties_kind_check/);
    const none = await pool.query(`select 1 from farm.parties where display_name = 'Ok'`);
    expect(none.rowCount).toBe(0);
    const partial = await importData(pool, bad, { partial: true });
    expect(partial.written).toBe(true);
    const one = await pool.query(`select 1 from farm.parties where display_name = 'Ok'`);
    expect(one.rowCount).toBe(1);
    const dry = await importData(
      pool,
      {
        ...bad,
        tables: { 'farm.parties': [{ ...bad.tables['farm.parties'][0], display_name: 'Changed' }] },
      },
      { dryRun: true },
    );
    expect(dry).toMatchObject({ written: false, tables: { 'farm.parties': { updated: 1 } } });

    expect(() => checkExportDoc({ format: 'nope' })).toThrow(/not a farm-ops data export/);
    expect(() => checkExportDoc({ ...doc, version: 99 })).toThrow(/newer/);
    expect(() => checkExportDoc({ ...doc, tables: { 'farm.secrets': [] } })).toThrow(
      /unknown table/,
    );
    expect(TABLES.map((s) => s.table)).toContain('farm.field_boundaries');
  });

  test('a reading by a person who is not in the database comes back without that link', async () => {
    const { pool, admin } = t();
    // A demo crew member's sign-in (seeded again by db:reset) and a test sign-in (not).
    const crew = await pool.query<{ id: string }>(
      `select id::text from farm.parties where source = 'demo' and 'crew' = any(roles) limit 1`,
    );
    const userId = '0f9d3c1e-5b7a-5c2d-8e4f-6a1b2c3d4e5f';
    await admin.query(
      `insert into farm.app_users (id, party_id, role, source, source_id)
       values ($1::uuid, $2::uuid, 'driver', 'e2e', 'user:driver')`,
      [userId, crew.rows[0]?.id],
    );
    await pool.query(
      `insert into farm.soil_temp_readings (observed_at, temp_f, source, entered_by)
       values (now(), 51.5, 'manual', $1::uuid)`,
      [userId],
    );
    const doc = await exportData(pool);
    const reading = doc.tables['farm.soil_temp_readings']?.find((r) => r.temp_f === 51.5);
    expect(reading?.entered_by).toBe(userId);

    await resetAndResync(admin, pool);
    const r = await importData(pool, doc);
    expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
    expect(r.written).toBe(true);
    expect(r.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'farm.soil_temp_readings',
          message: expect.stringMatching(/entered_by: the person .* is not in this database/),
        }),
      ]),
    );
    const back = await pool.query<{ entered_by: string | null }>(
      `select entered_by::text from farm.soil_temp_readings where temp_f = 51.5`,
    );
    expect(back.rows).toEqual([{ entered_by: null }]);
  });
});
