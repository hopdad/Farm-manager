/**
 * The demo seed as farm_app on a fresh test database: what it writes (ids, sources, boundaries,
 * seasons, geofences, exactly simExternalRefs), that the database agrees with the SimFarm
 * (acres trigger, current boundaries, MVT tile), and that a re-run changes nothing (no row is
 * even rewritten: xmin stays the same).
 */
import { describe, expect, test } from 'vitest';
import { externalRefKey } from '../../src/connectors/types';
import { resolveExternalRef, resolveExternalRefs } from '../../src/db/external-refs';
import { demoId } from '../../src/domain/ids';
import { buildDemoFarm } from '../../src/sim/farm/build';
import { simFieldSeasons } from '../../src/sim/seasons';
import { simExternalRefs, simTelematicsMachines } from '../../src/sim/types';
import { setupTestDb } from '../../src/test/db';
import { tileFor } from '../../src/test/fixtures';
import { DEMO_VALID_FROM, seedDemo } from './demo';

const t = setupTestDb(import.meta.url);
const farm = buildDemoFarm(1);

const SEEDED = [
  'farm.parties',
  'farm.farms',
  'farm.fields',
  'farm.field_boundaries',
  'farm.field_seasons',
  'farm.machines',
  'farm.geofences',
  'ingest.external_refs',
] as const;

async function snapshot(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const table of SEEDED) {
    const r = await t().pool.query(
      `select id::text || ':' || xmin::text || ':' || md5(row_to_json(x)::text) as k
         from ${table} x order by id`,
    );
    out[table] = r.rows.map((row) => row.k as string);
  }
  return out;
}

describe('pnpm db:seed demo', () => {
  test('a fresh seed writes the SimFarm with demo ids and sources', async () => {
    const report = await seedDemo(t().pool, { seed: 1 });
    const ins = (k: keyof typeof report.tables) => report.tables[k].inserted;
    expect(ins('parties')).toBe(farm.parties.length);
    expect(ins('farms')).toBe(farm.farms.length);
    expect(ins('fields')).toBe(40);
    expect(ins('field_boundaries')).toBe(40);
    expect(ins('field_seasons')).toBe(200);
    expect(ins('machines')).toBe(farm.machines.length);
    expect(ins('geofences')).toBe(farm.elevators.length + 1 + farm.binSites.length + 40);
    expect(ins('external_refs')).toBe(simExternalRefs(farm).length);
    expect(report.extraRefs).toEqual([]);

    const { pool } = t();
    for (const [table, rows] of [
      ['farm.parties', farm.parties],
      ['farm.farms', farm.farms],
      ['farm.fields', farm.fields],
      ['farm.machines', farm.machines],
    ] as const) {
      const r = await pool.query(
        `select id::text, source, source_id from ${table} order by source_id`,
      );
      expect(r.rows).toEqual(
        [...rows]
          .sort((a, b) => (a.key < b.key ? -1 : 1))
          .map((x) => ({ id: demoId(x.key), source: 'demo', source_id: x.key })),
      );
    }
    const f = farm.fields[0];
    if (!f) throw new Error('no field');
    const field = await pool.query(
      `select f.name, f.tenure, f.county_fips, f.deere_field_id, f.landlord_party_id::text as landlord,
              f.farm_id::text as farm_id, f.active, f.notes
         from farm.fields f where id = $1`,
      [f.id],
    );
    expect(field.rows[0]).toMatchObject({
      name: f.name,
      tenure: f.tenure,
      county_fips: f.countyFips,
      deere_field_id: f.deereFieldId,
      landlord: f.landlordPartyId,
      farm_id: f.farmId,
      active: true,
    });
    expect(field.rows[0].notes).toMatch(/Sec \d+, T\dS R\dE/);
  });

  test('boundaries: one current version per field, acres from the trigger match the SimFarm', async () => {
    const r = await t().pool.query(
      `select b.id::text, b.field_id::text, b.source, b.source_id, b.acres::float8 as acres,
              lower(b.valid) as valid_from, upper(b.valid) is null as open
         from farm.current_boundaries b order by b.source_id`,
    );
    expect(r.rows).toHaveLength(40);
    const byField = new Map(farm.fields.map((f) => [f.id, f]));
    for (const row of r.rows) {
      const f = byField.get(row.field_id);
      expect(f).toBeDefined();
      expect(row.id).toBe(f?.boundaryId);
      expect(row.source).toBe('demo');
      expect(row.source_id).toBe(`boundary:${f?.key}`);
      expect(row.open).toBe(true);
      expect((row.valid_from as Date).toISOString()).toBe(new Date(DEMO_VALID_FROM).toISOString());
      // turf's spherical area vs PostGIS's spheroid: within half a percent.
      expect(Math.abs(row.acres - (f?.acres ?? 0)) / (f?.acres ?? 1)).toBeLessThan(0.005);
    }
  });

  test('seasons, geofences and the fields MVT tile', async () => {
    const { pool } = t();
    const seasons = await pool.query(
      `select source_id, crop, crop_year, yield_bu_ac::float8 as y from farm.field_seasons order by source_id`,
    );
    const expected = simFieldSeasons(farm).sort((a, b) => (a.key < b.key ? -1 : 1));
    expect(seasons.rows.map((r) => [r.source_id, r.crop, r.crop_year, r.y])).toEqual(
      expected.map((s) => [s.key, s.crop, s.cropYear, s.yieldBuAc]),
    );
    const g = await pool.query(
      `select kind, name, party_id::text as party, field_id::text as field,
              extensions.ST_IsValid(geom) as valid
         from farm.geofences order by kind, name`,
    );
    // One entrance per field (plan 1a), tied to its field; it ends short of the crop.
    const entrances = g.rows.filter((r) => r.kind === 'field_entrance');
    expect(entrances.map((r) => r.field).sort()).toEqual(farm.fields.map((f) => f.id).sort());
    expect(entrances.every((r) => r.valid && r.party === null)).toBe(true);
    const crossing = await pool.query(
      `select count(*)::int as n
         from farm.geofences g
         join farm.field_boundaries b on b.field_id = g.field_id and upper_inf(b.valid)
        where g.kind = 'field_entrance' and extensions.ST_Intersects(g.geom, b.geom)`,
    );
    expect(crossing.rows[0].n).toBe(0);
    expect(
      g.rows
        .filter((r) => r.kind === 'elevator')
        .map((r) => r.party)
        .sort(),
    ).toEqual(farm.elevators.map((e) => e.partyId).sort());
    expect(g.rows.filter((r) => r.kind !== 'field_entrance').map((r) => r.kind)).toEqual([
      'bin_site',
      'elevator',
      'elevator',
      'elevator',
      'shop',
    ]);
    expect(g.rows.every((r) => r.valid)).toBe(true);
    const f = farm.fields[0];
    const corner = f?.boundary.coordinates[0]?.[0]?.[0];
    if (!corner) throw new Error('no corner');
    const tile = tileFor((corner[0] as number) + 0.002, (corner[1] as number) + 0.002, 13);
    const mvt = await pool.query('select length(app.mvt_fields($1, $2, $3)) as n', [
      tile.z,
      tile.x,
      tile.y,
    ]);
    expect(mvt.rows[0].n).toBeGreaterThan(0);
  });

  test('exactly the external refs simExternalRefs returns, resolvable by the syncs', async () => {
    const { pool } = t();
    const r = await pool.query(
      `select source, kind, external_id, source_org, entity_id::text as entity_id from ingest.external_refs`,
    );
    const actual = r.rows
      .map((x) => `${externalRefKey(x.source, x.kind, x.external_id, x.source_org)}=${x.entity_id}`)
      .sort();
    const expected = simExternalRefs(farm)
      .map(
        (x) =>
          `${externalRefKey(x.ref.source, x.ref.kind, x.ref.externalId, x.ref.sourceOrg)}=${x.entityId}`,
      )
      .sort();
    expect(actual).toEqual(expected);
    const onSamsara = simTelematicsMachines(farm, 'samsara');
    const map = await resolveExternalRefs(
      pool,
      'samsara',
      'machine',
      '',
      onSamsara.map((m) => m.telematics?.id as string),
    );
    expect([...map.values()].sort()).toEqual(onSamsara.map((m) => m.id).sort());
    const kubota = simTelematicsMachines(farm, 'aemp', { provider: 'kubota' });
    expect([
      ...(
        await resolveExternalRefs(
          pool,
          'aemp',
          'machine',
          'kubota',
          kubota.map((m) => m.telematics?.id as string),
        )
      ).values(),
    ]).toEqual(kubota.map((m) => m.id));
    const shared = farm.fields.find((f) => f.sharedWith);
    if (!shared?.sharedWith) throw new Error('no shared field');
    expect(
      await resolveExternalRef(pool, {
        source: 'deere',
        kind: 'field',
        externalId: shared.sharedWith.deereFieldId,
        sourceOrg: shared.sharedWith.deereOrgId,
      }),
    ).toBe(shared.id);
  });

  test('re-running changes nothing, not even xmin', async () => {
    const before = await snapshot();
    const report = await seedDemo(t().pool, { seed: 1 });
    for (const c of Object.values(report.tables)) {
      expect(c.inserted).toBe(0);
      expect(c.updated).toBe(0);
    }
    expect(report.tables.fields.unchanged).toBe(40);
    expect(await snapshot()).toEqual(before);
  });

  test('app-owned columns survive a re-seed; seeded columns are restored', async () => {
    const { pool } = t();
    const f = farm.fields[1];
    const m = farm.machines[0];
    if (!f || !m) throw new Error('no rows');
    await pool.query(`update farm.fields set active = false, name = 'Renamed' where id = $1`, [
      f.id,
    ]);
    await pool.query(
      `update farm.machines set engine_hours = 9999, status = 'down' where id = $1`,
      [m.id],
    );
    const report = await seedDemo(pool, { seed: 1 });
    expect(report.tables.fields.updated).toBe(1);
    expect(report.tables.machines.updated).toBe(0);
    const row = await pool.query(`select name, active from farm.fields where id = $1`, [f.id]);
    expect(row.rows[0]).toEqual({ name: f.name, active: false });
    const mrow = await pool.query(
      `select engine_hours::float8 as h, status from farm.machines where id = $1`,
      [m.id],
    );
    expect(mrow.rows[0]).toEqual({ h: 9999, status: 'down' });
  });

  test('a landlord or customer linked in the app survives a re-seed', async () => {
    const { pool } = t();
    const f = farm.fields[2];
    if (!f) throw new Error('no field');
    const own = await pool.query<{ id: string }>(
      `insert into farm.parties (kind, display_name, roles, source)
       values ('org', 'River Bend Land LLC', array['landlord', 'customer']::text[], 'app')
       returning id::text as id`,
    );
    const partyId = own.rows[0]?.id;
    await pool.query(`update farm.fields set landlord_party_id = $2 where id = $1`, [
      f.id,
      partyId,
    ]);
    await pool.query(`update farm.farms set client_party_id = $2 where id = $1`, [
      f.farmId,
      partyId,
    ]);
    await seedDemo(pool, { seed: 1 });
    const fr = await pool.query(
      `select landlord_party_id::text as p from farm.fields where id = $1`,
      [f.id],
    );
    const fa = await pool.query(`select client_party_id::text as p from farm.farms where id = $1`, [
      f.farmId,
    ]);
    expect(fr.rows[0]?.p).toBe(partyId);
    expect(fa.rows[0]?.p).toBe(partyId);
  });

  test('1f.2: telematics_via from the route; a kind set on /admin survives a re-seed', async () => {
    const { pool } = t();
    const pu1 = farm.machines.find((m) => m.unitNo === 'PU1');
    const sp2 = farm.machines.find((m) => m.unitNo === 'SP2');
    const via = await pool.query(
      `select unit_no, telematics_via, kind_set_by from farm.machines where id = any($1::uuid[]) order by unit_no`,
      [[pu1?.id, sp2?.id]],
    );
    expect(via.rows).toEqual([
      { unit_no: 'PU1', telematics_via: 'ford_pro', kind_set_by: 'default' },
      { unit_no: 'SP2', telematics_via: 'gateway', kind_set_by: 'default' },
    ]);
    await pool.query(
      `update farm.machines set kind = 'service_truck', kind_set_by = 'admin' where id = $1`,
      [pu1?.id],
    );
    const report = await seedDemo(pool, { seed: 1 });
    expect(report.tables.machines.updated).toBe(0);
    const after = await pool.query(`select kind from farm.machines where id = $1`, [pu1?.id]);
    expect(after.rows[0]?.kind).toBe('service_truck');
    await pool.query(
      `update farm.machines set kind = 'pickup', kind_set_by = 'default' where id = $1`,
      [pu1?.id],
    );
  });

  test('refs a previous seed wrote that the farm no longer lists are reported, never deleted', async () => {
    const { pool } = t();
    const s1 = farm.machines.find((m) => m.unitNo === 'S1');
    await pool.query(
      `insert into ingest.external_refs (source, kind, external_id, source_org, entity_id)
       values ('motive', 'machine', 'old-motive-s1', '', $1)`,
      [s1?.id],
    );
    const report = await seedDemo(pool, { seed: 1 });
    expect(report.extraRefs).toEqual(['motive|machine||old-motive-s1']);
  });
});
