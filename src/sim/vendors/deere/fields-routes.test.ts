/**
 * The Deere stand-in's `fields` module (docs/contracts-1f.md §7.1): Deere's recordFilter and
 * embed rules, its 403 for an unknown org and 404 for an unknown field or machine, single
 * resources, engine-hour windows on the 15-minute grid, and it leaves every other path (field
 * operations, the Equipment API) to the next module or the core.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { DeereClient } from '../../../connectors/deere/client';
import { deereEngineHoursListSchema } from '../../../connectors/deere/fields/schemas';
import {
  deereBoundariesSchema,
  deereFieldSchema,
  deereFieldsSchema,
  deereFlagsSchema,
} from '../../../connectors/deere/schemas';
import { type ConnectorConfig, deereEndpoints } from '../../../connectors/endpoints';
import { MemoryTokenStore } from '../../../connectors/oauth/memory-store';
import { startVendorSim, type VendorSim } from '../server';
import { buildStubFarm, createStubSimWorld } from '../stub-world';
import { deereFieldsRoutes, ENGINE_HOURS_GRID_MS } from './fields-routes';
import { simDeereFieldRecords } from './fields-world';
import { deereModuleWith } from './routes';

let wall = Date.parse('2026-10-15T14:07:30.000Z');
const now = () => new Date(wall);
let sim: VendorSim;
let c: DeereClient;
const farm = buildStubFarm();
const machineId = farm.machines.find((m) => m.vendorIds.deere)?.vendorIds.deere as string;

beforeAll(async () => {
  sim = await startVendorSim({
    createWorld: createStubSimWorld,
    port: 0,
    now,
    modules: { deere: deereModuleWith([deereFieldsRoutes]) },
  });
  const cfg: ConnectorConfig = { VENDOR_SIM_URL: sim.url, PUBLIC_URL: 'http://localhost:3111' };
  c = new DeereClient({
    endpoints: deereEndpoints('sim', cfg),
    tokens: new MemoryTokenStore('deere', null, { now }),
    http: { now, timeoutMs: 2_000, maxRetries: 0 },
  });
});
afterAll(() => sim?.close());

const url = (path: string[], q: Record<string, string> = {}) => {
  const u = new URL(c.apiUrl(...path));
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return u.toString();
};

describe('the fields module of the Deere stand-in', () => {
  test('fields: every record of the org (the stub field and the Deere-only one when there is room)', async () => {
    const records = simDeereFieldRecords(farm).filter((r) => r.orgId === 'org-home');
    const list = await c.getPaged(deereFieldsSchema, url(['organizations', 'org-home', 'fields']));
    expect(list.map((f) => f.id)).toEqual(records.map((r) => r.deereFieldId));
    // Not embedded unless asked.
    expect((list[0] as Record<string, unknown>).farms).toBeUndefined();
    const embedded = await c.getPaged(
      deereFieldsSchema,
      url(['organizations', 'org-home', 'fields'], { embed: 'farms,clients' }),
    );
    expect((embedded[0] as Record<string, unknown>).farms).toBeDefined();
    // Nothing in the stand-in is archived.
    expect(
      await c.getPaged(
        deereFieldsSchema,
        url(['organizations', 'org-home', 'fields'], { recordFilter: 'ARCHIVED' }),
      ),
    ).toEqual([]);
    const one = await c.getOne(
      deereFieldSchema,
      url(['organizations', 'org-home', 'fields', records[0]?.deereFieldId as string]),
    );
    expect(one.id).toBe(records[0]?.deereFieldId);
  });

  test('boundaries of the org and of one field', async () => {
    const records = simDeereFieldRecords(farm).filter((r) => r.orgId === 'org-home');
    const all = await c.getPaged(
      deereBoundariesSchema,
      url(['organizations', 'org-home', 'boundaries']),
    );
    expect(all.map((b) => b.id)).toEqual(records.map((r) => r.boundaryId));
    expect(all.every((b) => b.active === true && b.archived === false)).toBe(true);
    const field = records[0]?.deereFieldId as string;
    const one = await c.getPaged(
      deereBoundariesSchema,
      url(['organizations', 'org-home', 'fields', field, 'boundaries']),
    );
    expect(one.map((b) => b.id)).toEqual([records[0]?.boundaryId]);
  });

  test('flags follow recordFilter (archived only when asked)', async () => {
    const active = await c.getPaged(deereFlagsSchema, url(['organizations', 'org-home', 'flags']));
    const all = await c.getPaged(
      deereFlagsSchema,
      url(['organizations', 'org-home', 'flags'], { recordFilter: 'all' }),
    );
    const archived = await c.getPaged(
      deereFlagsSchema,
      url(['organizations', 'org-home', 'flags'], { recordFilter: 'archived' }),
    );
    expect(active.every((f) => !f.archived)).toBe(true);
    expect(archived.every((f) => f.archived)).toBe(true);
    expect(all.length).toBe(active.length + archived.length);
  });

  test('an org the world lacks is 403; an unknown field or machine is 404', async () => {
    for (const what of ['fields', 'farms', 'clients', 'boundaries', 'flags']) {
      await expect(
        c.getPaged(deereFieldsSchema, url(['organizations', 'org-nobody', what])),
      ).rejects.toMatchObject({ status: 403 });
    }
    await expect(
      c.getOne(deereFieldSchema, url(['organizations', 'org-home', 'fields', 'nope'])),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      c.getOne(deereEngineHoursListSchema, url(['machines', 'nope', 'engineHours'])),
    ).rejects.toMatchObject({ status: 404 });
  });

  test('engine hours: the last report on the grid, or every report of a window, newest first', async () => {
    const last = await c.getOne(
      deereEngineHoursListSchema,
      url(['machines', machineId, 'engineHours'], { lastKnown: 'true' }),
    );
    expect(last.values).toHaveLength(1);
    const t = Date.parse(last.values[0]?.reportTime as string);
    expect(t % ENGINE_HOURS_GRID_MS).toBe(0);
    expect(t).toBeLessThanOrEqual(wall);
    const window = await c.getPaged(
      deereEngineHoursListSchema,
      url(['machines', machineId, 'engineHours'], {
        startDate: new Date(wall - 60 * 60_000).toISOString(),
        endDate: new Date(wall).toISOString(),
      }),
    );
    expect(window).toHaveLength(4);
    const times = window.map((r) => Date.parse(r.reportTime));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    const values = window.map((r) => r.reading.valueAsDouble);
    expect([...values].sort((a, b) => b - a)).toEqual(values);
    wall += ENGINE_HOURS_GRID_MS;
  });

  test('paths it does not serve pass on (field operations, the Equipment API, other machine paths)', async () => {
    const field = simDeereFieldRecords(farm)[0]?.deereFieldId as string;
    await expect(
      c.getPaged(
        deereFieldsSchema,
        url(['organizations', 'org-home', 'fields', field, 'fieldOperations']),
      ),
    ).rejects.toMatchObject({ status: 404, detail: expect.stringMatching(/not simulated/) });
    expect(await c.machines('org-home')).toEqual(expect.any(Array));
    await expect(
      c.getPaged(deereFieldsSchema, url(['machines', machineId, 'alerts'])),
    ).rejects.toMatchObject({ status: 404 });
  });
});
