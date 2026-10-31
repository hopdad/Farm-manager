/**
 * Contract tests: the LIVE AEMP client against the stand-in (in-process, the real demo world)
 * and against the replay fixtures. The stand-in's `kubota` answers ISO XML, its `samsara` JSON
 * wrapped in {"Fleet": …} (and 500 to Accept: application/xml, as Samsara does); both parse to
 * last-known positions and stats of the machines the seed maps; the kubota fault series serves
 * what its knob raised.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { DELTA_FAULT_AGE_OUT_SECONDS } from '../../domain/fault-codes';
import { createSimWorld } from '../../sim/index';
import { SIM_CREDENTIALS, simExternalRefs, simTelematicsMachines } from '../../sim/types';
import { AEMP_SIM_COUNTER_GRID_MS, AEMP_SIM_LOCATION_GRID_MS } from '../../sim/vendors/aemp/routes';
import { startVendorSim, type VendorSim } from '../../sim/vendors/server';
import { aempEndpoints, type ConnectorConfig } from '../endpoints';
import { AempClient } from './client';
import { mapAempFault, mapAempFleet } from './mapper';

const NOW = Date.parse('2026-11-30T15:07:12.000Z');
let wall = NOW;
let sim: VendorSim;
let cfg: ConnectorConfig;
const http = { now: () => new Date(wall), sleep: async () => {}, timeoutMs: 5000 };

beforeAll(async () => {
  sim = await startVendorSim({ createWorld: createSimWorld, port: 0, now: () => new Date(wall) });
  cfg = { VENDOR_SIM_URL: sim.url, PUBLIC_URL: 'http://localhost:3116' };
});
afterAll(() => sim.close());
beforeEach(() => {
  wall = NOW;
  sim.control.reset({ scenario: 'harvest-day' });
});

const control = (path: string, body: unknown) =>
  fetch(`${sim.url}/_control/vendor/aemp${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('AEMP stand-in (sim)', () => {
  test('each provider lists exactly its machines; XML and JSON map to last-known fixes and stats', async () => {
    const c = AempClient.forMode('sim', cfg, { http });
    const r = await c.pollFleet(null);
    expect(r.failed).toEqual([]);
    const byProvider = Object.fromEntries(r.items.map((i) => [i.payload.provider, i.payload]));
    const l1 = simTelematicsMachines(sim.world.farm, 'aemp', { provider: 'kubota' });
    const sp2 = simTelematicsMachines(sim.world.farm, 'aemp', { provider: 'samsara' });
    expect(l1.map((m) => m.unitNo)).toEqual(['L1']);
    expect(sp2.map((m) => m.unitNo)).toEqual(['SP2']);
    expect(byProvider.kubota?.machineId).toBe(l1[0]?.telematics?.id);
    expect(byProvider.samsara?.machineId).toBe(sp2[0]?.telematics?.id);

    const locAt = new Date(Math.floor(NOW / AEMP_SIM_LOCATION_GRID_MS) * AEMP_SIM_LOCATION_GRID_MS);
    const counterAt = new Date(
      Math.floor(NOW / AEMP_SIM_COUNTER_GRID_MS) * AEMP_SIM_COUNTER_GRID_MS,
    );
    const items = mapAempFleet(JSON.parse(JSON.stringify(byProvider.kubota)));
    const pos = items.find((i) => i.kind === 'position');
    const sample = sim.world.machineAt(l1[0]?.id as string, locAt);
    expect(pos?.kind === 'position' && pos.position).toMatchObject({
      source: 'aemp',
      sourceOrg: 'kubota',
      provider: 'kubota',
      positionKind: 'last_known',
      ts: locAt.toISOString(),
      lat: Math.round((sample?.lat ?? 0) * 1e6) / 1e6,
    });
    const stat = items.find((i) => i.kind === 'stat');
    expect(stat?.kind === 'stat' && stat.stat).toMatchObject({ ts: counterAt.toISOString() });
    expect(stat?.kind === 'stat' && Object.keys(stat.stat.readings ?? {}).sort()).toEqual([
      'defPct',
      'engineHours',
      'fuelPct',
    ]);
    const samsaraStats = mapAempFleet(JSON.parse(JSON.stringify(byProvider.samsara))).find(
      (i) => i.kind === 'stat',
    );
    expect(
      samsaraStats?.kind === 'stat' && Object.keys(samsaraStats.stat.readings ?? {}).sort(),
    ).toEqual(['defPct', 'engineHours', 'engineOn', 'fuelPct', 'odometerMi']);
    // Every machine the stand-in serves is one the seed maps under its provider.
    const refs = new Set(
      simExternalRefs(sim.world.farm)
        .filter((x) => x.ref.source === 'aemp')
        .map((x) => `${x.ref.sourceOrg}:${x.ref.externalId}`),
    );
    for (const i of r.items)
      expect(refs.has(`${i.payload.provider}:${i.payload.machineId}`)).toBe(true);
  });

  test('the same snapshot polled again emits nothing new; the next grid instant moves it', async () => {
    const c = AempClient.forMode('sim', cfg, { http });
    const first = await c.pollFleet(null);
    wall += 15 * 60_000;
    const later = await c.pollFleet(first.cursor);
    expect(later.items.length).toBe(2);
    wall += 60_000; // not due yet: pacing (900 s)
    expect((await c.pollFleet(later.cursor)).items).toEqual([]);
  });

  test('Samsara answers 500 to Accept: application/xml; a wrong token is a 401', async () => {
    const auth = { authorization: `Bearer ${SIM_CREDENTIALS.aemp.token}` };
    const xmlAsk = await fetch(`${sim.url}/aemp/samsara/Fleet/1`, {
      headers: { ...auth, accept: 'application/xml' },
    });
    expect(xmlAsk.status).toBe(500);
    const jsonAsk = await fetch(`${sim.url}/aemp/samsara/Fleet/1`, {
      headers: { ...auth, accept: 'application/json' },
    });
    expect(jsonAsk.status).toBe(200);
    const kubota = await fetch(`${sim.url}/aemp/kubota/Fleet/1`, { headers: auth });
    expect(kubota.headers.get('content-type')).toMatch(/xml/);
    expect(await kubota.text()).toMatch(
      /^<\?xml[\s\S]*xmlns="http:\/\/standards\.iso\.org\/iso\/15143\/-3"/,
    );
    const denied = await fetch(`${sim.url}/aemp/kubota/Fleet/1`, {
      headers: { authorization: 'Bearer wrong' },
    });
    expect(denied.status).toBe(401);
  });

  test('the kubota fault series serves what the knob raised, as delta faults with the age-out', async () => {
    expect(
      (
        await control('/faults', {
          action: 'add',
          machine: 'L1',
          code: 'SPN 3251 FMI 0',
          description: 'DPF pressure high',
          severity: 'Amber',
        })
      ).status,
    ).toBe(200);
    wall += 60_000;
    const endpoints = aempEndpoints('sim', cfg);
    expect(endpoints.find((e) => e.id === 'kubota')?.faultsPath).toBeDefined();
    expect(endpoints.find((e) => e.id === 'samsara')?.faultsPath).toBeUndefined();
    const c = new AempClient({ endpoints, http });
    const l1 = simTelematicsMachines(sim.world.farm, 'aemp', { provider: 'kubota' })[0];
    const r = await c.pollFaults(null, { kubota: [l1?.telematics?.id as string] });
    expect(r.items).toHaveLength(1);
    const [stat] = mapAempFault(JSON.parse(JSON.stringify(r.items[0]?.payload)));
    expect(stat).toMatchObject({
      sourceOrg: 'kubota',
      faultReport: 'delta',
      faultAgeOutSeconds: DELTA_FAULT_AGE_OUT_SECONDS,
      faultCodes: [
        {
          system: 'j1939',
          spn: 3251,
          fmi: 0,
          state: 'open',
          vendorSeverity: 'Amber',
          lastSeenAt: new Date(NOW).toISOString(),
        },
      ],
    });
    // The next window starts where this one ended: the occurrence isn't read twice.
    wall += 600_000;
    expect(
      (await c.pollFaults(r.cursor, { kubota: [l1?.telematics?.id as string] })).items,
    ).toEqual([]);
    expect((await control('/faults', { action: 'clear' })).status).toBe(200);
    expect((await control('/faults', { action: 'add', machine: 'nobody', code: 'X' })).status).toBe(
      404,
    );
  });
});

describe('AEMP replay', () => {
  test('the doc-derived fixtures move L1 and SP2 to now (time-shifted), mapped as last-known', async () => {
    wall = Date.parse('2026-11-30T15:00:30.000Z');
    const c = AempClient.forMode('replay', cfg, { http });
    const r = await c.pollFleet(null);
    expect(r.failed).toEqual([]);
    expect(r.items.map((i) => i.payload.provider).sort()).toEqual(['kubota', 'samsara']);
    for (const i of r.items) {
      const pos = mapAempFleet(JSON.parse(JSON.stringify(i.payload))).find(
        (x) => x.kind === 'position',
      );
      expect(pos?.kind === 'position' && pos.position.positionKind).toBe('last_known');
      expect(pos?.kind === 'position' && pos.position.ts).toBe('2026-11-30T15:00:00.000Z');
    }
  });
});
