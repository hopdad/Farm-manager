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
import { usageActorKey } from '../../src/domain/work-jobs';
import {
  DEMO_PEOPLE,
  deactivateDemoPeople,
  demoUserId,
  seedDemoPeople,
} from '../../src/platform/auth/demo';
import { localParts } from '../../src/sim/time';
import { setupTestDb } from '../../src/test/db';
import { seedDemo } from '../seed/demo';
import { asMultiPolygon } from './boundary-file';
import { checkExportDoc, type ExportDoc, exportData, importData, TABLES } from './data-transfer';
import { parseSeasonsCsv } from './seasons-csv';
import { rectangle } from './testing/shapefile';

const t = setupTestDb(import.meta.url);
const actor = { appUserId: null, displayName: 'Derrick' };
const SECRET = 'data-transfer-test-secret-0123456789abcdef';
const pad = (n: number) => String(n).padStart(2, '0');
const lp = localParts(Date.now());
const TODAY = `${lp.y}-${pad(lp.m)}-${pad(lp.d)}`;

/** What db:reset + the demo seed leave: every farm row gone, the demo farm back. */
async function resetAndResync(admin: pg.Pool, pool: pg.Pool): Promise<void> {
  const r = await admin.query<{ t: string }>(
    `select format('%I.%I', schemaname, tablename) as t from pg_tables where schemaname in ('farm', 'ingest')`,
  );
  await admin.query(
    `truncate ${[...r.rows.map((x) => x.t), 'app.usage_events'].join(', ')} cascade`,
  );
  await admin.query(`delete from app.settings where key <> 'clock.paused'`);
  await seedDemo(pool, { seed: 1 });
}

const withoutStamp = (d: ExportDoc) => ({ ...d, exportedAt: 'x' });

describe('data:export / data:import', () => {
  test('round trip through a reset, with references to synced rows', async () => {
    const { pool, admin } = t();
    await seedDemo(pool, { seed: 1 });

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

  test('decision 7: a hand-imported boundary comes back as history under the re-synced Deere one', async () => {
    const { pool, admin } = t();
    await seedDemo(pool, { seed: 1 });
    const field = (
      await pool.query<{ id: string }>(
        `select id from farm.fields where source = 'demo' order by name limit 1`,
      )
    ).rows[0]?.id as string;
    // A boundary imported by hand a month ago, current when exported.
    const importedAt = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const importedId = '00000000-0000-4000-8000-00000000b0b0';
    await admin.query(
      `update farm.field_boundaries set valid = tstzrange(lower(valid), $2::timestamptz, '[)')
        where field_id = $1 and upper_inf(valid)`,
      [field, importedAt],
    );
    await admin.query(
      `insert into farm.field_boundaries (id, field_id, geom, valid, source, source_ref)
       select $2::uuid, field_id, geom, tstzrange($3::timestamptz, null, '[)'), 'import', 'redrawn.zip'
         from farm.field_boundaries where field_id = $1 order by lower(valid) desc limit 1`,
      [field, importedId, importedAt],
    );
    const doc = JSON.parse(JSON.stringify(await exportData(pool)));
    const exported = (doc.tables['farm.field_boundaries'] as Record<string, unknown>[]).find(
      (b) => b.id === importedId,
    ) as { valid: { from: string; to: string | null } } | undefined;
    expect(Date.parse(exported?.valid.from ?? '')).toBe(Date.parse(importedAt));
    expect(exported?.valid.to).toBeNull();

    // db:reset, the demo seed, then deere.fields: the owning org's Deere boundary is current
    // from the sync time and the seeded version is history (the §5.7 writer).
    await resetAndResync(admin, pool);
    const syncedAt = new Date().toISOString();
    await admin.query(
      `update farm.field_boundaries set valid = tstzrange(lower(valid), $2::timestamptz, '[)')
        where field_id = $1 and upper_inf(valid)`,
      [field, syncedAt],
    );
    await admin.query(
      `insert into farm.field_boundaries (field_id, geom, valid, source, source_id, source_ref)
       select field_id, geom, tstzrange($2::timestamptz, null, '[)'), 'deere', 'b-1@0123abcd', 'Deere'
         from farm.field_boundaries where field_id = $1 order by lower(valid) desc limit 1`,
      [field, syncedAt],
    );

    const report = await importData(pool, doc);
    expect(report.errors).toEqual([]);
    const versions = await pool.query<{ source: string; from: Date; to: Date | null }>(
      `select source, lower(valid) as from, upper(valid) as to from farm.field_boundaries
        where field_id = $1 order by lower(valid)`,
      [field],
    );
    expect(
      versions.rows.map((v) => [v.source, v.from.toISOString(), v.to?.toISOString() ?? null]),
    ).toEqual([
      ['demo', expect.any(String), importedAt],
      ['import', importedAt, syncedAt],
      ['deere', syncedAt, null],
    ]);
    // Importing again changes nothing (the stored row already ends at the Deere start).
    const again = await importData(pool, doc);
    expect(again.errors).toEqual([]);
    expect(again.tables['farm.field_boundaries']).toMatchObject({ inserted: 0, failed: 0 });
  });

  test('switched-off demo sign-ins stay off through export, reset and import', async () => {
    const { pool, admin } = t();
    await seedDemo(pool, { seed: 1 });
    await seedDemoPeople(pool, SECRET);
    const amy = demoUserId('crew-amy');
    const dale = demoUserId('crew-dale');
    // Dale got his own PIN and a promotion in the app; then everyone was switched off.
    await pool.query(
      `update farm.app_users set role = 'manager', pin_hash = 'scrypt$changed', pin_set_at = now() + interval '1 minute'
        where id = $1`,
      [dale],
    );
    expect(await deactivateDemoPeople(pool)).toBe(DEMO_PEOPLE.length);
    const before = await pool.query(
      `select id, role, active, session_epoch, case when id = $1 then pin_hash end as pin_hash
         from farm.app_users where source = 'demo' order by id`,
      [dale],
    );

    const doc = JSON.parse(JSON.stringify(await exportData(pool)));
    expect(doc.tables['farm.app_users']).toEqual([]);
    const overlay = doc.overlays['farm.app_users'] as Record<string, unknown>[];
    expect(overlay).toHaveLength(DEMO_PEOPLE.length);
    // An untouched PIN is the seed's (derived from this install's secret): not in the file.
    expect(overlay.find((r) => r.id === amy)).not.toHaveProperty('pin_hash');
    expect(overlay.find((r) => r.id === dale)).toMatchObject({ pin_hash: 'scrypt$changed' });

    // db:reset: the seed brings the demo crew back, active, with their default PINs.
    await resetAndResync(admin, pool);
    await seedDemoPeople(pool, SECRET);
    const reseeded = await pool.query(
      `select count(*)::int as n from farm.app_users where source = 'demo' and active`,
    );
    expect(reseeded.rows[0]?.n).toBe(DEMO_PEOPLE.length);

    const report = await importData(pool, doc);
    expect(report.errors).toEqual([]);
    const after = await pool.query(
      `select id, role, active, session_epoch, case when id = $1 then pin_hash end as pin_hash
         from farm.app_users where source = 'demo' order by id`,
      [dale],
    );
    expect(after.rows).toEqual(before.rows);

    // Without the demo seed (a fresh production database) the overlay is skipped quietly.
    await resetAndResync(admin, pool);
    const bare = await importData(pool, doc);
    expect(bare.errors).toEqual([]);
    expect(bare.warnings.filter((w) => w.table === 'farm.app_users')).toEqual([]);
  });

  test('2a: products, jobs with their crew, machines and products, agreements, request links and usage come back', async () => {
    const { pool, admin } = t();
    await resetAndResync(admin, pool);
    await seedDemoPeople(pool, SECRET);
    const one = async (sql: string, values: unknown[] = []) =>
      (await pool.query<{ id: string }>(sql, values)).rows[0]?.id as string;

    // Your own customer, crew member (with a sign-in) and wall; demo rows to point at.
    const customer = validateParty({
      displayName: 'Piotrowski Farms',
      kind: 'org',
      roles: 'customer',
    });
    const crew = validateParty({ displayName: 'Wes Kowalczyk', roles: 'crew' });
    if (!customer.ok || !crew.ok) throw new Error('fixture');
    const customerId = await createParty(pool, customer.value, actor);
    const crewId = await createParty(pool, crew.value, actor);
    const userId = await one(
      `insert into farm.app_users (party_id, role) values ($1, 'operator') returning id::text as id`,
      [crewId],
    );
    const deviceId = await one(
      `insert into farm.devices (kind, name) values ('wall', 'Shop wall') returning id::text as id`,
    );
    const demoField = await one(
      `select id::text as id from farm.fields where source = 'demo' order by name limit 1`,
    );
    const sp2 = await one(`select id::text as id from farm.machines where unit_no = 'SP2'`);
    const demoProduct = await one(
      `insert into farm.products (kind, name, unit, source, source_id)
       values ('fuel', 'Diesel (demo)', 'gal', 'demo', 'product:diesel') returning id::text as id`,
    );

    const product = await one(
      `insert into farm.products (kind, name, epa_reg_no, restricted_use, unit, label_rules)
       values ('chemical', 'Atrazine 4L', '100-497', true, 'gal', '{"maxWindMph": 10}')
       returning id::text as id`,
    );
    const link = await one(
      `insert into farm.job_request_links (party_id, token_hash, label, created_by)
       values ($1, 'hmac-of-token', 'Piotrowski text link', $2) returning id::text as id`,
      [customerId, userId],
    );
    const job = await one(
      `insert into farm.jobs (kind, business_line, status, title, customer_party_id, field_id,
                              planned_window, crop_year, planned_acres, planned_acres_by_hand,
                              planned_qty, planned_unit, priority, sort_key, version, notes,
                              request_channel, requested_by_party_id, requester_name,
                              requester_phone, request_link_id, created_by, updated_by)
       values ('spray', 'spraying', 'assigned', 'Burndown', $1, $2,
               tstzrange('2026-11-07T12:00:00Z', '2026-11-07T22:00:00Z', '[)'), 2026, 77.5, true,
               3, 'loads', 2, 10, 4, 'Watch the creek', 'web_form', $1, 'Joe Piotrowski',
               '517-555-0101', $3, $4, $4)
       returning id::text as id`,
      [customerId, demoField, link, userId],
    );
    await pool.query(
      `insert into farm.job_assignments (job_id, party_id, machine_id, role, planned_for, assigned_by)
       values ($1, $2, $3, 'operator', tstzrange('2026-11-07T13:00:00Z', null, '[)'), $4)`,
      [job, crewId, sp2, userId],
    );
    await pool.query(
      `insert into farm.job_products (job_id, product_id, rate, unit, supplied_by)
       values ($1, $2, 32, 'floz_ac', 'customer'), ($1, $3, 5, 'gal', 'us')`,
      [job, product, demoProduct],
    );
    await pool.query(
      `insert into farm.data_rights_agreements (party_id, signed_on, document_key, permitted_uses, notes, created_by)
       values ($1, '2026-10-01', 'agreements/piotrowski.pdf', '{billing,agronomy}', 'Signed at the shop', $2)`,
      [customerId, userId],
    );
    // Your operator on your wall travels; the demo crew's usage does not.
    for (const [kind, who] of [
      ['board_heartbeat', userId],
      ['pin_sign_in', userId],
      ['page_view', demoUserId('crew-amy')],
    ] as const) {
      await pool.query(
        `insert into app.usage_events (at, farm_day, kind, route, app_user_id, device_id, actor_key, bucket_at)
         values ('2026-11-06T14:07:00Z', '2026-11-06', $1, '/board', $2, $3, $4,
                 '2026-11-06T14:05:00Z')`,
        [kind, who, deviceId, usageActorKey(deviceId, who)],
      );
    }
    // A demo job and its assignment stay behind.
    const demoJob = await one(
      `insert into farm.jobs (kind, business_line, field_id, source, source_id)
       values ('harvest', 'grain', $1, 'demo', 'job:x') returning id::text as id`,
      [demoField],
    );
    await pool.query(`insert into farm.job_assignments (job_id, machine_id) values ($1, $2)`, [
      demoJob,
      sp2,
    ]);

    const first = JSON.parse(JSON.stringify(await exportData(pool))) as ExportDoc;
    expect(first.tables['farm.products']).toHaveLength(1);
    expect(first.tables['farm.job_request_links']).toHaveLength(1);
    expect(first.tables['farm.jobs']).toHaveLength(1);
    expect(first.tables['farm.job_assignments']).toHaveLength(1);
    expect(first.tables['farm.job_products']).toHaveLength(2);
    expect(first.tables['farm.data_rights_agreements']).toHaveLength(1);
    expect(first.tables['app.usage_events']).toHaveLength(2);
    expect(first.tables['farm.jobs']?.[0]).toMatchObject({
      version: 4,
      planned_window: { from: expect.stringMatching(/^2026-11-07T12:00:00/) },
    });

    // db:reset, then the demo seed (the demo product here stands in for tools/seed's).
    await resetAndResync(admin, pool);
    await seedDemoPeople(pool, SECRET);
    await pool.query(
      `insert into farm.products (id, kind, name, unit, source, source_id)
       values ($1, 'fuel', 'Diesel (demo)', 'gal', 'demo', 'product:diesel')`,
      [demoProduct],
    );
    const report = await importData(pool, first);
    expect(report.errors, JSON.stringify(report.errors)).toEqual([]);
    expect(report.tables['farm.jobs']).toEqual({
      inserted: 1,
      updated: 0,
      unchanged: 0,
      failed: 0,
    });
    expect(report.tables['app.usage_events']?.inserted).toBe(2);
    const second = JSON.parse(JSON.stringify(await exportData(pool))) as ExportDoc;
    for (const table of [
      'farm.products',
      'farm.job_request_links',
      'farm.jobs',
      'farm.job_assignments',
      'farm.job_products',
      'farm.data_rights_agreements',
      'app.usage_events',
    ]) {
      expect(second.tables[table], table).toEqual(first.tables[table]);
    }
    const demoJobs = await pool.query(`select 1 from farm.jobs where source = 'demo'`);
    expect(demoJobs.rowCount).toBe(0);

    // Importing again changes nothing (usage events are insert-only).
    const again = await importData(pool, first);
    for (const [table, c] of Object.entries(again.tables)) {
      expect(c.inserted + c.updated + c.failed, table).toBe(0);
    }
    // Leave the database as the other tests expect it (the demo farm, no demo sign-ins).
    await resetAndResync(admin, pool);
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
