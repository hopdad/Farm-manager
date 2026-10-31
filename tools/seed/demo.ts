/**
 * The demo seed (contracts §9 "Seed contract"): writes the simulated farm into farm.* and
 * ingest.external_refs so the vendor syncs map onto it.
 *
 *  - every row's id is the SimFarm id (demoId(key)), source = 'demo', source_id = key;
 *  - one current boundary per field (id field.boundaryId, source_id 'boundary:<key>', valid
 *    from DEMO_VALID_FROM), five completed seasons per field, the fleet, one geofence per
 *    elevator (kind 'elevator', party = the elevator company), the shop (kind 'shop'), its
 *    bin site (kind 'bin_site') and one entrance per field (kind 'field_entrance', field_id set;
 *    src/sim/farm/geofences.ts, plan 1a);
 *  - exactly the external refs simExternalRefs(farm) returns, via upsertExternalRef (1f.2: every
 *    machine's own telematics vendor, so the whole mixed fleet maps at once);
 *  - machines.telematics_via from the simulated route (ford_pro, stellantis, gateway); `kind` is
 *    never overwritten once someone set it on /admin (kind_set_by = 'admin').
 *
 * Idempotent: every write is an upsert that changes a row only when a seeded column differs
 * (`... where (cols) is distinct from (excluded cols)`), so a re-run writes nothing. Columns the
 * app or the syncs own are written on insert only and never overwritten: fields.active, notes
 * and landlord_party_id, farms.client_party_id (both linked on /admin/parties or in the field
 * editor, and kept by data:export as overlays), boundaries' valid range and derived_stale,
 * machines' status, engine hours and odometer, and a machine kind set by a vendor tag or on /admin.
 * One transaction; any error rolls everything back.
 */
import type pg from 'pg';
import { externalRefKey } from '../../src/connectors/types';
import { statsNotReported } from '../../src/connectors/vendors';
import { exec } from '../../src/db/exec';
import { upsertExternalRef } from '../../src/db/external-refs';
import { positionVendorId } from '../../src/domain/fleet';
import { demoId } from '../../src/domain/ids';
import { buildDemoFarm, type DemoFarm } from '../../src/sim/farm/build';
import { FLEET } from '../../src/sim/farm/fleet';
import { fieldEntranceGeofences } from '../../src/sim/farm/geofences';
import { simFieldSeasons } from '../../src/sim/seasons';
import { type SimMachine, simExternalRefs } from '../../src/sim/types';

/** Lower bound of every seeded boundary's validity (fixed, so re-runs are no-ops). */
export const DEMO_VALID_FROM = '2020-01-01T00:00:00Z';
export const DEMO_SOURCE = 'demo';

export type SeedTable =
  | 'parties'
  | 'farms'
  | 'fields'
  | 'field_boundaries'
  | 'field_seasons'
  | 'machines'
  | 'geofences'
  | 'external_refs';

export interface SeedCounts {
  inserted: number;
  updated: number;
  unchanged: number;
}

export interface SeedReport {
  seed: number;
  tables: Record<SeedTable, SeedCounts>;
  /** External refs that point at demo rows but aren't in simExternalRefs (e.g. an earlier vendor's). Left alone. */
  extraRefs: string[];
}

const TABLES: SeedTable[] = [
  'parties',
  'farms',
  'fields',
  'field_boundaries',
  'field_seasons',
  'machines',
  'geofences',
  'external_refs',
];

type Outcome = keyof SeedCounts;

/** Run one upsert ending in `returning (xmax = 0) as inserted`. */
async function upsert(client: pg.PoolClient, text: string, values: unknown[]): Promise<Outcome> {
  const r = await exec<{ inserted: boolean }>(client, text, values);
  const row = r.rows[0];
  if (!row) return 'unchanged';
  return row.inserted ? 'inserted' : 'updated';
}

const GEOM = (n: number) =>
  `extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON($${n}::text), 4326)`;

/** Write the demo farm for `seed`. The caller owns the pool. */
export async function seedDemo(
  pool: pg.Pool,
  opts: { seed: number; farm?: DemoFarm },
): Promise<SeedReport> {
  const farm = opts.farm ?? buildDemoFarm(opts.seed);
  const tables = Object.fromEntries(
    TABLES.map((t) => [t, { inserted: 0, updated: 0, unchanged: 0 }]),
  ) as Record<SeedTable, SeedCounts>;
  const count = (t: SeedTable, o: Outcome) => {
    tables[t][o]++;
  };

  const client = await pool.connect();
  try {
    await client.query('begin');

    for (const p of farm.parties) {
      count(
        'parties',
        await upsert(
          client,
          `insert into farm.parties as t (id, kind, org_id, display_name, roles, phone, email, source, source_id)
           values ($1::uuid, $2, $3::uuid, $4, $5::text[], $6, $7, $8, $9)
           on conflict (id) do update set
             kind = excluded.kind, org_id = excluded.org_id, display_name = excluded.display_name,
             roles = excluded.roles, phone = excluded.phone, email = excluded.email,
             source = excluded.source, source_id = excluded.source_id, updated_at = now()
           where (t.kind, t.org_id, t.display_name, t.roles, t.phone, t.email, t.source, t.source_id)
             is distinct from (excluded.kind, excluded.org_id, excluded.display_name, excluded.roles,
                               excluded.phone, excluded.email, excluded.source, excluded.source_id)
           returning (xmax = 0) as inserted`,
          [
            p.id,
            p.kind,
            p.orgId,
            p.displayName,
            p.roles,
            p.phone ?? null,
            p.email ?? null,
            DEMO_SOURCE,
            p.key,
          ],
        ),
      );
    }

    for (const u of farm.farms) {
      count(
        'farms',
        await upsert(
          client,
          `insert into farm.farms as t (id, name, client_party_id, deere_farm_id, source, source_id)
           values ($1::uuid, $2, $3::uuid, $4, $5, $6)
           on conflict (id) do update set
             name = excluded.name, deere_farm_id = excluded.deere_farm_id,
             source = excluded.source, source_id = excluded.source_id, updated_at = now()
           where (t.name, t.deere_farm_id, t.source, t.source_id)
             is distinct from (excluded.name, excluded.deere_farm_id, excluded.source,
                               excluded.source_id)
           returning (xmax = 0) as inserted`,
          [u.id, u.name, u.clientPartyId, u.deereFarmId, DEMO_SOURCE, u.key],
        ),
      );
    }

    for (const f of farm.fields) {
      const meta = farm.fieldMeta[f.id];
      count(
        'fields',
        await upsert(
          client,
          `insert into farm.fields as t
             (id, farm_id, name, county_fips, tenure, landlord_party_id, deere_field_id, notes, source, source_id)
           values ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7, $8, $9, $10)
           on conflict (id) do update set
             farm_id = excluded.farm_id, name = excluded.name, county_fips = excluded.county_fips,
             tenure = excluded.tenure, deere_field_id = excluded.deere_field_id,
             source = excluded.source, source_id = excluded.source_id, updated_at = now()
           where (t.farm_id, t.name, t.county_fips, t.tenure, t.deere_field_id, t.source,
                  t.source_id)
             is distinct from (excluded.farm_id, excluded.name, excluded.county_fips, excluded.tenure,
                               excluded.deere_field_id, excluded.source, excluded.source_id)
           returning (xmax = 0) as inserted`,
          [
            f.id,
            f.farmId,
            f.name,
            f.countyFips,
            f.tenure,
            f.landlordPartyId,
            f.deereFieldId,
            meta ? `${meta.legal} (demo grid)` : null,
            DEMO_SOURCE,
            f.key,
          ],
        ),
      );
      count(
        'field_boundaries',
        await upsert(
          client,
          `insert into farm.field_boundaries as t (id, field_id, geom, valid, source, source_id, source_ref)
           values ($1::uuid, $2::uuid, extensions.ST_Multi(${GEOM(3)}),
                   tstzrange($4::timestamptz, null, '[)'), $5, $6, $7)
           on conflict (id) do update set
             field_id = excluded.field_id, geom = excluded.geom, source = excluded.source,
             source_id = excluded.source_id, source_ref = excluded.source_ref
           where (t.field_id, t.source, t.source_id, t.source_ref)
               is distinct from (excluded.field_id, excluded.source, excluded.source_id, excluded.source_ref)
              or extensions.ST_AsBinary(t.geom) is distinct from extensions.ST_AsBinary(excluded.geom)
           returning (xmax = 0) as inserted`,
          [
            f.boundaryId,
            f.id,
            JSON.stringify(f.boundary),
            DEMO_VALID_FROM,
            DEMO_SOURCE,
            `boundary:${f.key}`,
            'demo grid (simulated farm)',
          ],
        ),
      );
    }

    for (const s of simFieldSeasons(farm)) {
      count(
        'field_seasons',
        await upsert(
          client,
          `insert into farm.field_seasons as t
             (id, field_id, crop_year, crop, variety, planted_on, harvested_on, yield_bu_ac, source, source_id)
           values ($1::uuid, $2::uuid, $3, $4, $5, $6::date, $7::date, $8::numeric, $9, $10)
           on conflict (field_id, crop_year) do update set
             crop = excluded.crop, variety = excluded.variety, planted_on = excluded.planted_on,
             harvested_on = excluded.harvested_on, yield_bu_ac = excluded.yield_bu_ac,
             updated_at = now()
           where t.source = excluded.source
             and (t.crop, t.variety, t.planted_on, t.harvested_on, t.yield_bu_ac)
               is distinct from (excluded.crop, excluded.variety, excluded.planted_on,
                                 excluded.harvested_on, excluded.yield_bu_ac)
           returning (xmax = 0) as inserted`,
          [
            demoId(s.key),
            s.fieldId,
            s.cropYear,
            s.crop,
            s.variety,
            s.plantedOn,
            s.harvestedOn,
            s.yieldBuAc.toFixed(2),
            DEMO_SOURCE,
            s.key,
          ],
        ),
      );
    }

    for (const m of farm.machines) {
      const spec = FLEET.find((f) => f.key === m.key);
      // A counter the machine's route doesn't report is null, never 0 or a made-up number
      // (src/connectors/vendors.ts statsNotReported; the panel then says "not reported"). A
      // re-seed clears such a counter too (it can only have come from an older seed), and
      // replaces a 0 an older seed wrote for a counter the route does report.
      const notReported = statsNotReported(seededPositionVendor(m), m.telematics?.via);
      const noHours = notReported.includes('engineHours') || spec?.hoursAt2026 == null;
      const noOdometer = notReported.includes('odometerMi') || spec?.odometerAt2026 == null;
      count(
        'machines',
        await upsert(
          client,
          `insert into farm.machines as t
             (id, kind, unit_no, make, model, year, vin_serial, engine_hours, odometer_mi, source,
              source_id, telematics_via)
           values ($1::uuid, $2, $3, $4, $5, $6, $7, $8::numeric, $9::numeric, $10, $11, $12)
           on conflict (id) do update set
             kind = case when t.kind_set_by = 'default' then excluded.kind else t.kind end,
             unit_no = excluded.unit_no, make = excluded.make,
             model = excluded.model, year = excluded.year, vin_serial = excluded.vin_serial,
             source = excluded.source, source_id = excluded.source_id,
             telematics_via = excluded.telematics_via,
             engine_hours = case when $13::boolean then null
                                 when t.engine_hours = 0 then excluded.engine_hours
                                 else t.engine_hours end,
             odometer_mi = case when $14::boolean then null
                                when t.odometer_mi = 0 then excluded.odometer_mi
                                else t.odometer_mi end,
             updated_at = now()
           where (case when t.kind_set_by = 'default' then t.kind else excluded.kind end,
                  t.unit_no, t.make, t.model, t.year, t.vin_serial, t.source, t.source_id,
                  t.telematics_via, t.engine_hours, t.odometer_mi)
             is distinct from (excluded.kind, excluded.unit_no, excluded.make, excluded.model,
                               excluded.year, excluded.vin_serial, excluded.source, excluded.source_id,
                               excluded.telematics_via,
                               case when $13::boolean then null
                                    when t.engine_hours = 0 then excluded.engine_hours
                                    else t.engine_hours end,
                               case when $14::boolean then null
                                    when t.odometer_mi = 0 then excluded.odometer_mi
                                    else t.odometer_mi end)
           returning (xmax = 0) as inserted`,
          [
            m.id,
            m.kind,
            m.unitNo,
            m.make,
            m.model,
            m.year,
            `SIM-${m.unitNo}-${m.year}`,
            noHours ? null : (spec?.hoursAt2026 ?? 0).toFixed(1),
            noOdometer ? null : (spec?.odometerAt2026 ?? 0).toFixed(1),
            DEMO_SOURCE,
            m.key,
            m.telematics?.via ?? null,
            noHours,
            noOdometer,
          ],
        ),
      );
    }

    const geofences = [
      ...farm.elevators.map((e) => ({
        id: e.id,
        key: e.key,
        kind: 'elevator',
        name: e.name,
        partyId: e.partyId as string | null,
        fieldId: null as string | null,
        geom: e.geofence,
      })),
      {
        id: farm.shop.id,
        key: 'shop',
        kind: 'shop',
        name: farm.shop.name,
        partyId: null,
        fieldId: null,
        geom: farm.shop.geofence,
      },
      ...farm.binSites.map((b) => ({
        id: b.id,
        key: b.key,
        kind: 'bin_site',
        name: b.name,
        partyId: null,
        fieldId: null,
        geom: b.geofence,
      })),
      ...fieldEntranceGeofences(farm).map((g) => ({
        id: g.id,
        key: g.key,
        kind: g.kind,
        name: g.name,
        partyId: null,
        fieldId: g.fieldId as string | null,
        geom: g.geofence,
      })),
    ];
    for (const g of geofences) {
      count(
        'geofences',
        await upsert(
          client,
          `insert into farm.geofences as t (id, kind, name, party_id, field_id, geom, source, source_id)
           values ($1::uuid, $2, $3, $4::uuid, $5::uuid, ${GEOM(6)}, $7, $8)
           on conflict (id) do update set
             kind = excluded.kind, name = excluded.name, party_id = excluded.party_id,
             field_id = excluded.field_id, geom = excluded.geom, source = excluded.source,
             source_id = excluded.source_id, updated_at = now()
           where (t.kind, t.name, t.party_id, t.field_id, t.source, t.source_id)
               is distinct from (excluded.kind, excluded.name, excluded.party_id, excluded.field_id,
                                 excluded.source, excluded.source_id)
              or extensions.ST_AsBinary(t.geom) is distinct from extensions.ST_AsBinary(excluded.geom)
           returning (xmax = 0) as inserted`,
          [g.id, g.kind, g.name, g.partyId, g.fieldId, JSON.stringify(g.geom), DEMO_SOURCE, g.key],
        ),
      );
    }

    // External refs: diff against what is there (for the counts), then upsert every one.
    const refs = simExternalRefs(farm);
    const keyOf = (r: { source: string; kind: string; externalId: string; sourceOrg: string }) =>
      externalRefKey(
        r.source as Parameters<typeof externalRefKey>[0],
        r.kind as Parameters<typeof externalRefKey>[1],
        r.externalId,
        r.sourceOrg,
      );
    const demoIds = [
      ...new Set([
        ...farm.farms.map((u) => u.id),
        ...farm.fields.flatMap((f) => [f.id, f.boundaryId]),
        ...farm.machines.map((m) => m.id),
      ]),
    ];
    const existing = await exec<{
      source: string;
      kind: string;
      external_id: string;
      source_org: string;
      entity_id: string;
    }>(
      client,
      `select source, kind, external_id, source_org, entity_id::text as entity_id
         from ingest.external_refs
        where external_id = any($1::text[]) or entity_id = any($2::uuid[])`,
      [refs.map((r) => r.ref.externalId), demoIds],
    );
    const before = new Map(
      existing.rows.map((r) => [
        keyOf({
          source: r.source,
          kind: r.kind,
          externalId: r.external_id,
          sourceOrg: r.source_org,
        }),
        r.entity_id,
      ]),
    );
    const expected = new Set<string>();
    for (const r of refs) {
      const key = keyOf(r.ref);
      expected.add(key);
      const prev = before.get(key);
      count(
        'external_refs',
        prev === undefined ? 'inserted' : prev === r.entityId ? 'unchanged' : 'updated',
      );
      await upsertExternalRef(client, r.ref, r.entityId);
    }
    const demoIdSet = new Set(demoIds);
    const extraRefs = existing.rows
      .filter((r) => demoIdSet.has(r.entity_id))
      .map((r) =>
        keyOf({
          source: r.source,
          kind: r.kind,
          externalId: r.external_id,
          sourceOrg: r.source_org,
        }),
      )
      .filter((k) => !expected.has(k))
      .sort();

    await client.query('commit');
    return { seed: farm.seed, tables, extraRefs };
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** One line per table: "parties  31 inserted, 0 updated, 0 unchanged". */
export function formatSeedReport(r: SeedReport): string {
  const lines = TABLES.map((t) => {
    const c = r.tables[t];
    return `  ${t.padEnd(18)} ${String(c.inserted).padStart(4)} inserted ${String(c.updated).padStart(4)} updated ${String(c.unchanged).padStart(4)} unchanged`;
  });
  if (r.extraRefs.length) {
    lines.push(
      `  note: ${r.extraRefs.length} other external ref(s) point at demo rows and were left alone (e.g. ${r.extraRefs[0]})`,
    );
  }
  return lines.join('\n');
}

/**
 * The position vendor a seeded machine's fixes will carry (machine_state.position_vendor): its
 * telematics route (`aemp_<provider>`, `terminal_<tsp>`, or the connection), else `deere` for a
 * JDLink machine, else null (manual: nothing is known about its counters).
 */
export function seededPositionVendor(
  m: Pick<SimMachine, 'telematics' | 'vendorIds'>,
): string | null {
  const t = m.telematics;
  if (t) {
    const provider = t.vendor === 'aemp' ? t.provider : t.vendor === 'terminal' ? t.tsp : null;
    return positionVendorId(t.vendor, provider);
  }
  return m.vendorIds.deere ? 'deere' : null;
}
