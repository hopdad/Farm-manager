/**
 * Contract tests of the deere.fields calls (docs/contracts-1f.md §5.7, §7.1, §8), in SIM mode:
 * the live Deere client (DeereFieldsApi over DeereClient) against the stand-in in-process with
 * the demo world, so every id must map onto the demo seed's external refs. Each call validated by
 * the same schemas as a live response. Replay mode is covered by ./fields.replay.contract.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildDemoFarm } from '../../../sim/farm/build';
import { simFlags } from '../../../sim/farm/flags';
import { createSimWorld } from '../../../sim/index';
import { SIM_DEERE_HOME_ORG, simExternalRefs } from '../../../sim/types';
import { ENGINE_HOURS_GRID_MS } from '../../../sim/vendors/deere/fields-routes';
import { simDeereOnlyField } from '../../../sim/vendors/deere/fields-world';
import { startVendorSim, type VendorSim } from '../../../sim/vendors/server';
import { type ConnectorConfig, deereEndpoints } from '../../endpoints';
import { MemoryTokenStore } from '../../oauth/memory-store';
import { DeereClient } from '../client';
import { deereLinkId } from '../mapper';
import { DeereFieldsApi } from './client';
import {
  activeBoundaryOf,
  engineHoursOf,
  mapDeereEquipment,
  mapDeereField,
  mapDeereFlag,
} from './mapper';

const farm = buildDemoFarm(1);
const refs = simExternalRefs(farm);
const mapped = (kind: string, org: string, id: string) =>
  refs.find((r) => r.ref.kind === kind && r.ref.sourceOrg === org && r.ref.externalId === id)
    ?.entityId ?? null;
const only = simDeereOnlyField(farm);

let wall = Date.parse('2026-10-15T14:07:00.000Z');
const now = () => new Date(wall);
let sim: VendorSim;
let api: DeereFieldsApi;

beforeAll(async () => {
  sim = await startVendorSim({
    createWorld: createSimWorld,
    port: 0,
    now,
    scenario: 'harvest-day',
  });
  const cfg: ConnectorConfig = { VENDOR_SIM_URL: sim.url, PUBLIC_URL: 'http://localhost:3111' };
  api = new DeereFieldsApi(
    new DeereClient({
      endpoints: deereEndpoints('sim', cfg),
      tokens: new MemoryTokenStore('deere', null, { now }),
      http: { now, timeoutMs: 5_000 },
    }),
  );
});
afterAll(() => sim?.close());

describe('Deere fields in sim mode', () => {
  test('the orgs carry the fields module links', async () => {
    const orgs = await api.client.organizations();
    const home = orgs.find((o) => o.id === SIM_DEERE_HOME_ORG);
    expect(home?.links?.map((l) => l.rel)).toEqual(
      expect.arrayContaining(['fields', 'farms', 'boundaries', 'flags']),
    );
  });

  test('fields of each org (paged, embedded farm and client) map onto the seed, plus one Deere-only field', async () => {
    expect(only).not.toBeNull();
    const seen = new Set<string>();
    for (const org of await api.client.organizations()) {
      const fields = await api.fields(org.id);
      for (const f of fields) {
        if (f.id === only?.deereFieldId) {
          expect(org.id).toBe(SIM_DEERE_HOME_ORG);
          expect(mapped('field', org.id, f.id)).toBeNull();
          continue;
        }
        const entity = mapped('field', org.id, f.id);
        expect(entity, `${org.id} ${f.name}`).not.toBeNull();
        seen.add(entity as string);
        // The embedded farm is the field's farm unit (its owning org) or the sharing org's farm.
        const farmRef = f.farms?.farms[0];
        expect(farmRef).toBeDefined();
        const field = farm.fields.find((x) => x.id === entity);
        const unit = farm.farms.find((u) => u.id === field?.farmId);
        if (org.id === unit?.deereOrgId)
          expect(mapped('farm', org.id, farmRef?.id ?? '')).toBe(unit?.id);
      }
    }
    expect(seen.size).toBe(farm.fields.length);
    const home = await api.fields(SIM_DEERE_HOME_ORG);
    expect(home.length).toBeGreaterThan(10); // more than one 10-item page: nextPage followed
    expect(home.filter((f) => f.id === only?.deereFieldId)).toHaveLength(1);
    // Juniper Hill (a custom-work farm in the home org) names its customer as the Deere client.
    const juniper = home.find((f) => f.name.startsWith('Juniper Hill'));
    expect(juniper?.clients?.clients[0]?.name).toBe('Juniper Hill Farms LLC');
  });

  test('every listed field has its active boundary; the sharing org has its own boundary ids', async () => {
    for (const org of await api.client.organizations()) {
      const [fields, boundaries] = [await api.fields(org.id), await api.boundaries(org.id)];
      for (const f of fields) {
        const b = activeBoundaryOf(f.id, boundaries);
        expect(b, `${org.id} ${f.name}`).not.toBeNull();
        const item = mapDeereField({
          orgId: org.id,
          orgName: org.name,
          homeOrgId: null,
          field: f,
          boundary: b,
        })[0];
        expect(item?.field.boundary?.geom.type).toBe('MultiPolygon');
        const entity = mapped('field', org.id, f.id);
        const field = farm.fields.find((x) => x.id === entity);
        if (!field) continue;
        const unit = farm.farms.find((u) => u.id === field.farmId);
        if (org.id === unit?.deereOrgId) {
          expect(b?.id).toBe(field.deereBoundaryId);
          expect(mapped('boundary', org.id, b?.id as string)).toBe(field.boundaryId);
        } else {
          expect(b?.id).not.toBe(field.deereBoundaryId);
        }
        expect(item?.field.boundary?.areaAc).toBeCloseTo(field.acres, -1);
      }
    }
  });

  test('farms and clients listings', async () => {
    const farms = await api.farms(SIM_DEERE_HOME_ORG);
    const homeUnits = farm.farms.filter((u) => u.deereOrgId === SIM_DEERE_HOME_ORG);
    expect(farms.map((f) => f.id).sort()).toEqual(homeUnits.map((u) => u.deereFarmId).sort());
    const juniper = farms.find((f) => f.name === 'Juniper Hill');
    expect(juniper?.clientUri).toMatch(/\/clients\//);
    const clients = await api.clients(SIM_DEERE_HOME_ORG);
    expect(clients.map((c) => c.name)).toEqual(['Juniper Hill Farms LLC']);
    expect(await api.clients('org-customer-1')).toEqual([]);
  });

  test('flags (archived ones too, with their category) on the fields they link', async () => {
    const expected = simFlags(farm, 1);
    let total = 0;
    for (const org of await api.client.organizations()) {
      const flags = await api.flags(org.id);
      total += flags.length;
      for (const f of flags) {
        const n = mapDeereFlag(org.id, f);
        expect(n?.category).toBeTruthy();
        expect(mapped('field', org.id, deereLinkId(f.links, 'field') as string)).not.toBeNull();
      }
    }
    expect(total).toBe(expected.length);
    // Deere hides archived flags unless asked: the default listing has one fewer.
    const archived = expected.find((f) => f.archived);
    const plain = await api.client.getPaged(
      (await import('../schemas')).deereFlagsSchema,
      api.client.apiUrl('organizations', archived?.orgId as string, 'flags'),
    );
    expect(plain.some((f) => f.id === archived?.id)).toBe(false);
    expect((await api.flags(archived?.orgId as string)).some((f) => f.id === archived?.id)).toBe(
      true,
    );
  });

  test("machines (Equipment API, principalId) and each one's latest engine hours on the 15-min grid", async () => {
    const machines = await api.machines(SIM_DEERE_HOME_ORG);
    expect(machines.length).toBe(6);
    for (const e of machines) {
      const m = mapDeereEquipment(SIM_DEERE_HOME_ORG, e);
      expect(m?.machine.kind).not.toBeNull();
      expect(mapped('machine', SIM_DEERE_HOME_ORG, m?.machine.externalId as string)).not.toBeNull();
      const report = await api.lastEngineHours(m?.machine.externalId as string);
      expect(Date.parse(report?.reportTime as string) % ENGINE_HOURS_GRID_MS).toBe(0);
      expect(engineHoursOf(report?.reading ?? { valueAsDouble: -1 })).toBeGreaterThan(0);
    }
    const id = machines[0]?.principalId as string;
    const a = await api.lastEngineHours(id);
    wall += 60_000; // same 15-minute slot: the same report
    expect(await api.lastEngineHours(id)).toEqual(a);
    wall += ENGINE_HOURS_GRID_MS; // the next report: later, never lower
    const b = await api.lastEngineHours(id);
    expect(Date.parse(b?.reportTime as string)).toBeGreaterThan(
      Date.parse(a?.reportTime as string),
    );
    expect(b?.reading.valueAsDouble).toBeGreaterThanOrEqual(a?.reading.valueAsDouble as number);
  });
});

describe('the plan §5 ports over these calls', () => {
  test('FieldSource, FlagSource and MachineSource give normalized items of every connected org', async () => {
    const fields = await api.asFieldSource().listFields();
    const shared = farm.fields.filter((f) => f.sharedWith).length;
    expect(fields).toHaveLength(farm.fields.length + shared + 1);
    expect(fields.every((f) => f.boundary?.geom.type === 'MultiPolygon')).toBe(true);
    expect(fields.filter((f) => f.externalId === only?.deereFieldId)).toHaveLength(1);
    const flags = await api.asFlagSource(now).flagsSince(null);
    expect(flags.items).toHaveLength(simFlags(farm, 1).length);
    expect(flags.cursor).toBe(now().toISOString());
    const machines = await api.asMachineSource().listMachines();
    expect(machines).toHaveLength(6);
    expect(machines.every((m) => m.kind !== null && m.sourceOrg === SIM_DEERE_HOME_ORG)).toBe(true);
  });
});
