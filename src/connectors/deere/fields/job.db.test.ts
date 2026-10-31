/**
 * deere.fields end to end in SIM mode (docs/contracts-1f.md §11.1): the live Deere client against
 * the stand-in (demo world, in-process) and the demo farm as the seed writes it. After a run the
 * 40 demo fields keep their ids (no duplicate field, farm or machine), each has its owning org's
 * Deere boundary as the current version (the demo one is history, the ref moved; the sharing
 * org's boundaries only got refs), the Deere-only field landed in its Deere farm with tenure
 * `unknown`, flags are read-only pins (the archived one resolved), the Deere machines have engine
 * hours; a second run writes nothing (also when every raw event is processed again); and the ids
 * are the same after a "reset" (a fresh database, seeded and synced again).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { resolveExternalRef } from '../../../db/external-refs';
import { deterministicId } from '../../../domain/ids';
import { createDeereFieldsJob, type DeereFieldsConfig } from '../../../jobs/deere-fields';
import { buildDemoFarm } from '../../../sim/farm/build';
import { simFlags } from '../../../sim/farm/flags';
import { createSimWorld } from '../../../sim/index';
import { SIM_DEERE_HOME_ORG } from '../../../sim/types';
import { simDeereOnlyField } from '../../../sim/vendors/deere/fields-world';
import { startVendorSim, type VendorSim } from '../../../sim/vendors/server';
import { createTestDb, setupTestDb, type TestDb } from '../../../test/db';
import { listenAppEvents, seedSimFarm, testJobContext } from '../../testkit';
import { externalRef } from '../../types';

const t = setupTestDb(import.meta.url);
const farm = buildDemoFarm(1);
const only = simDeereOnlyField(farm);
const flags = simFlags(farm, 1);
const deereMachines = farm.machines.filter((m) => m.vendorIds.deere);

const wall = Date.parse('2026-10-15T14:07:00.000Z');
let offset = 0;
const now = () => new Date(wall + offset);
let sim: VendorSim;
let cfg: DeereFieldsConfig;
let listener: Awaited<ReturnType<typeof listenAppEvents>>;

const http = { timeoutMs: 5_000, baseBackoffMs: 1, sleep: async () => {} };
const job = () => createDeereFieldsJob({ config: () => cfg, http });
const runOn = (db: TestDb) =>
  job()(testJobContext(db, { name: 'deere.fields', now, budgetMs: 55_000 }));

async function count(db: TestDb, sql: string, params: unknown[] = []): Promise<number> {
  const r = await db.pool.query<{ n: number }>(sql, params);
  return r.rows[0]?.n ?? 0;
}

/** Everything the sync wrote, by table, for comparing two databases. */
async function syncedIds(db: TestDb) {
  const q = async (sql: string) =>
    (await db.pool.query<{ id: string }>(sql)).rows.map((r) => r.id).sort();
  return {
    fields: await q(`select id::text as id from farm.fields`),
    farms: await q(`select id::text as id from farm.farms`),
    machines: await q(`select id::text as id from farm.machines`),
    versions: await q(
      `select id::text || ' ' || source_id as id from farm.field_boundaries where source = 'deere'`,
    ),
    pins: await q(`select id::text as id from farm.pins`),
  };
}

beforeAll(async () => {
  sim = await startVendorSim({
    createWorld: createSimWorld,
    port: 0,
    now,
    scenario: 'harvest-day',
  });
  cfg = {
    VENDOR_SIM_URL: sim.url,
    PUBLIC_URL: 'http://localhost:3111',
    TOKEN_ENC_KEY: 'cd'.repeat(32),
    CONNECTOR_DEERE: 'sim',
  };
  await seedSimFarm(t().adminDb, farm);
  listener = await listenAppEvents(t().appUrl);
});
afterAll(async () => {
  await listener?.close();
  await sim?.close();
});

describe('deere.fields in sim mode', () => {
  test('a first run: every field matched or created, boundaries, pins, engine hours', async () => {
    const machinesBefore = await count(t(), 'select count(*)::int as n from farm.machines');
    const farmsBefore = await count(t(), 'select count(*)::int as n from farm.farms');
    const result = await runOn(t());
    expect(result.items).toBeGreaterThan(farm.fields.length);
    expect(result.note).toBeUndefined();

    // 40 demo fields keep their ids; one Deere-only field is created. No duplicate farm or machine.
    expect(await count(t(), 'select count(*)::int as n from farm.fields')).toBe(
      farm.fields.length + 1,
    );
    expect(await count(t(), 'select count(*)::int as n from farm.farms')).toBe(farmsBefore);
    expect(await count(t(), 'select count(*)::int as n from farm.machines')).toBe(machinesBefore);
    const created = await t().pool.query(
      `select id::text, name, tenure, farm_id::text as farm_id, source, deere_field_id from farm.fields
        where source = 'deere'`,
    );
    const unit = farm.farms.find((u) => u.deereFarmId === only?.farm.id);
    expect(created.rows).toEqual([
      {
        id: deterministicId('deere', only?.deereFieldId as string),
        name: only?.name,
        tenure: 'unknown',
        farm_id: unit?.id,
        source: 'deere',
        deere_field_id: only?.deereFieldId,
      },
    ]);

    // Every field's current version is a Deere one; the seeded demo version is history.
    const open = await t().pool.query<{ source: string; n: number }>(
      `select source, count(*)::int as n from farm.field_boundaries where upper_inf(valid) group by source`,
    );
    expect(open.rows).toEqual([{ source: 'deere', n: farm.fields.length + 1 }]);
    expect(
      await count(
        t(),
        `select count(*)::int as n from farm.field_boundaries where source = 'demo' and not upper_inf(valid)`,
      ),
    ).toBe(farm.fields.length);
    for (const f of farm.fields.slice(0, 5)) {
      const org = farm.farms.find((u) => u.id === f.farmId)?.deereOrgId as string;
      const ref = await resolveExternalRef(
        t().pool,
        externalRef('deere', 'boundary', f.deereBoundaryId, org),
      );
      const cur = await t().pool.query(
        `select id::text from farm.field_boundaries where field_id = $1 and upper_inf(valid)`,
        [f.id],
      );
      expect(ref).toBe(cur.rows[0]?.id);
    }
    // The sharing org's boundaries are refs to the current versions, never versions themselves.
    const shared = farm.fields.filter((f) => f.sharedWith);
    expect(shared.length).toBeGreaterThan(0);
    for (const f of shared) {
      const r = await t().pool.query<{ entity_id: string; open: boolean }>(
        `select r.entity_id::text, upper_inf(b.valid) as open from ingest.external_refs r
           join farm.field_boundaries b on b.id = r.entity_id
          where r.source = 'deere' and r.kind = 'boundary' and r.source_org = $1 and b.field_id = $2`,
        [f.sharedWith?.deereOrgId, f.id],
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]?.open).toBe(true);
    }
    expect(
      await count(
        t(),
        `select count(*)::int as n from farm.field_boundaries where source = 'deere'`,
      ),
    ).toBe(farm.fields.length + 1);

    // Flags: read-only pins, the archived one resolved.
    expect(
      await count(
        t(),
        `select count(*)::int as n from farm.pins where read_only and source = 'deere_flag'`,
      ),
    ).toBe(flags.length);
    expect(
      await count(t(), `select count(*)::int as n from farm.pins where resolved_at is not null`),
    ).toBe(1);
    expect(
      await count(t(), `select count(*)::int as n from farm.pins where field_id is null`),
    ).toBe(0);

    // Engine hours on every Deere machine, appended to machine_hours.
    const hours = await t().pool.query<{ n: number }>(
      `select count(*)::int as n from farm.machines where id = any($1::uuid[]) and engine_hours > 0`,
      [deereMachines.map((m) => m.id)],
    );
    expect(hours.rows[0]?.n).toBe(deereMachines.length);
    expect(
      await count(t(), `select count(*)::int as n from farm.machine_hours where source = 'deere'`),
    ).toBe(deereMachines.length);
    const extra = await t().pool.query(
      `select extra->'unmappedKinds' as k from ingest.sync_state where source = 'deere' and stream = 'equipment'`,
    );
    expect(extra.rows[0]?.k).toEqual({});

    await listener.settle();
    expect(listener.of('pins', 'updated')).toHaveLength(1);
    const boundaryUpdates = listener
      .of('fields', 'updated')
      .concat(listener.of('fields', 'invalidate'));
    expect(boundaryUpdates.length).toBeGreaterThan(0);
    const statuses = listener.of('admin', 'sync.status').map((m) => String(m.payload.stream));
    expect(new Set(statuses)).toEqual(new Set(['fields', 'flags', 'equipment', 'hours']));
  });

  test('a second run writes nothing, also when every raw event is processed again', async () => {
    const before = await syncedIds(t());
    const stamps = async () =>
      (
        await t().pool.query(
          `select (select max(updated_at) from farm.fields) as f, (select max(updated_at) from farm.pins) as p,
                  (select count(*) from farm.machine_hours) as h, (select count(*) from farm.field_boundaries) as b`,
        )
      ).rows[0];
    const s0 = await stamps();
    const pinsBefore = listener.of('pins', 'updated').length;
    offset += 60_000; // the same 15-minute engine-hours slot
    expect(await runOn(t())).toEqual({ items: 0 });
    expect(await stamps()).toEqual(s0);
    await t().pool.query(`delete from ingest.raw_events where source = 'deere'`);
    const again = await runOn(t());
    expect(again.items).toBeGreaterThan(farm.fields.length);
    expect(await stamps()).toEqual(s0);
    expect(await syncedIds(t())).toEqual(before);
    await listener.settle();
    expect(listener.of('pins', 'updated').length).toBe(pinsBefore);
  });

  test('the next engine-hours report is appended and raises the meter', async () => {
    const id = deereMachines.find((m) => m.kind === 'combine')?.id as string;
    const meter = async () =>
      Number(
        (await t().pool.query(`select engine_hours from farm.machines where id = $1`, [id])).rows[0]
          ?.engine_hours,
      );
    const before = await meter();
    offset += 3 * 60 * 60_000; // three hours of a working combine later
    await runOn(t());
    expect(await meter()).toBeGreaterThan(before);
    expect(
      await count(t(), `select count(*)::int as n from farm.machine_hours where machine_id = $1`, [
        id,
      ]),
    ).toBe(2);
  });

  test('ids survive a reset: a fresh database, seeded and synced, gets the same ids', async () => {
    const fresh = await createTestDb('deere-fields-reset');
    try {
      await seedSimFarm(fresh.adminDb, farm);
      await runOn(fresh);
      const a = await syncedIds(t());
      const b = await syncedIds(fresh);
      expect(b.fields).toEqual(a.fields);
      expect(b.farms).toEqual(a.farms);
      expect(b.machines).toEqual(a.machines);
      expect(b.pins).toEqual(a.pins);
      expect(b.versions).toEqual(a.versions);
    } finally {
      await fresh.drop();
    }
  });

  test('the home org of the sim is org-home: the Deere-only field is in its farm unit', async () => {
    expect(only?.orgId).toBe(SIM_DEERE_HOME_ORG);
    const ref = await resolveExternalRef(
      t().pool,
      externalRef('deere', 'field', only?.deereFieldId as string, SIM_DEERE_HOME_ORG),
    );
    expect(ref).toBe(deterministicId('deere', only?.deereFieldId as string));
  });
});
