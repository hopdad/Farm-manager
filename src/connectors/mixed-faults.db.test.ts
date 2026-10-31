/**
 * The 1f.2 combined fault test (docs/contracts-1f.md §B.8.4), after merging all seven builders:
 * one report from each part B vendor, each read by that vendor's own mapper from a payload in
 * its documented shape, reaches farm.machine_faults and the fleet panel's badge through
 * fleet-faults' one writer (upsertVehicleStat):
 *  - a Motive `delta` fault (H1, open from /v1/fault_codes);
 *  - a Geotab FaultData (H2, J1939 decoded through the Diagnostic and FailureMode lookups, red
 *    stop lamp: critical);
 *  - an AEMP fault-series occurrence (L1 through Kubota's feed) that ages out after 24 h without
 *    another sighting (decision 1f-12);
 *  - a CNH caution code (C3), open until CNH says it cleared.
 * The panel also reads "not reported" for the pickups' carmaker route and "faults not reported"
 * for a route that reports no fault system. The demo seed stands in for the mapped machines.
 */
import { beforeAll, describe, expect, test } from 'vitest';
import { seedDemo } from '../../tools/seed/demo';
import { resolveExternalRefs } from '../db/external-refs';
import { fleetPanelMachines, upsertPosition, upsertVehicleStat } from '../db/queries/fleet';
import { DELTA_FAULT_AGE_OUT_SECONDS } from '../domain/fault-codes';
import { buildSimFarm } from '../sim/index';
import {
  SIM_CNH_COMPANY_ID,
  SIM_MOTIVE_COMPANY_ID,
  type SimTelematicsVendor,
  simTelematicsMachines,
} from '../sim/types';
import { setupTestDb } from '../test/db';
import { mapAempFault } from './aemp/mapper';
import { mapCnhFault } from './cnh/mapper';
import { mapGeotabFault } from './geotab/mapper';
import { GEOTAB_SOURCES } from './geotab/schemas';
import { mapMotiveFault } from './motive/mapper';
import type { ConnectorSource, NormalizedVehicleStat } from './types';

const t = setupTestDb(import.meta.url);
const farm = buildSimFarm(1);
const T0 = Date.parse('2026-10-15T14:00:00.000Z');
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();

/** The demo machine a vendor serves, and its farm.machines id through the seeded ref. */
async function mapped(
  vendor: SimTelematicsVendor,
  source: ConnectorSource,
  unitNo: string,
): Promise<{ id: string; externalId: string; org: string }> {
  const m = simTelematicsMachines(farm, vendor).find((x) => x.unitNo === unitNo);
  const externalId = m?.telematics?.id as string;
  const org = m?.telematics?.provider ?? '';
  const id = (await resolveExternalRefs(t().pool, source, 'machine', org, [externalId])).get(
    externalId,
  );
  if (!id) throw new Error(`${unitNo}: no ${source} ref (demo seed)`);
  return { id, externalId, org };
}

/** A fix first, so the machine has a machine_state row for the panel's summary. */
async function placed(id: string, source: ConnectorSource, provider?: string): Promise<void> {
  await upsertPosition(t().pool, id, {
    source,
    ...(provider ? { provider, positionKind: 'last_known' as const } : {}),
    externalMachineId: 'x',
    sourceOrg: '',
    ts: iso(0),
    lng: -84.04,
    lat: 41.9,
    heading: 0,
    speedMph: 0,
    engineOn: false,
    positionSource: 'eld',
  });
}

async function land(id: string, stats: NormalizedVehicleStat[]): Promise<void> {
  expect(stats).toHaveLength(1);
  await upsertVehicleStat(t().pool, id, stats[0] as NormalizedVehicleStat);
}

async function openFaults(id: string) {
  return (
    await t().pool.query<{ source: string; code: string; severity: string; system: string }>(
      `select source, code, severity, system from farm.machine_faults
        where machine_id = $1 and cleared_at is null order by code`,
      [id],
    )
  ).rows;
}

async function panelRow(id: string) {
  const m = (await fleetPanelMachines(t().pool)).find((x) => x.id === id);
  if (!m) throw new Error('not on the panel');
  return m;
}

let h1: Awaited<ReturnType<typeof mapped>>;
let h2: Awaited<ReturnType<typeof mapped>>;
let l1: Awaited<ReturnType<typeof mapped>>;
let c3: Awaited<ReturnType<typeof mapped>>;

beforeAll(async () => {
  await seedDemo(t().pool, { seed: 1 });
  h1 = await mapped('motive', 'motive', 'H1');
  h2 = await mapped('geotab', 'geotab', 'H2');
  l1 = await mapped('aemp', 'aemp', 'L1');
  c3 = await mapped('cnh', 'cnh', 'C3');
  expect([h1.org, c3.org, l1.org]).toEqual([SIM_MOTIVE_COMPANY_ID, SIM_CNH_COMPANY_ID, 'kubota']);
  await placed(h1.id, 'motive');
  await placed(h2.id, 'geotab');
  await placed(l1.id, 'aemp', 'kubota'); // position vendor aemp_kubota, a last-known snapshot
  await placed(c3.id, 'cnh');
});

describe('every part B vendor through the one fault writer', () => {
  test('a Motive delta fault: open, then closed by Motive', async () => {
    const motive = (status: 'open' | 'closed', min: number) =>
      mapMotiveFault({
        companyId: h1.org,
        fault: {
          id: 49_487,
          code: 'P0217',
          code_label: 'P0217',
          network: 'obdii',
          status,
          first_observed_at: iso(1),
          last_observed_at: iso(min),
          vehicle: { id: Number(h1.externalId) },
        },
      });
    await land(h1.id, motive('open', 2));
    expect(await openFaults(h1.id)).toEqual([
      { source: 'motive', code: 'P0217', severity: expect.any(String), system: 'obd2' },
    ]);
    expect((await panelRow(h1.id)).faults).toMatchObject([{ code: 'P0217' }]);
    await land(h1.id, motive('closed', 5));
    expect(await openFaults(h1.id)).toEqual([]);
    expect((await panelRow(h1.id)).faults ?? []).toEqual([]);
  });

  test('a Geotab FaultData: J1939 decoded, red stop lamp: critical on the panel', async () => {
    await land(
      h2.id,
      mapGeotabFault({
        record: {
          id: 'aF1',
          dateTime: iso(3),
          device: { id: h2.externalId },
          diagnostic: { id: 'aSimSpn110' },
          failureMode: { id: 'aSimFmi0' },
          faultState: 'Active',
          redStopLamp: true,
          amberWarningLamp: true,
        },
        diagnostic: {
          id: 'aSimSpn110',
          code: 110,
          name: 'Engine coolant temperature',
          source: { id: GEOTAB_SOURCES.j1939 },
        },
        failureMode: { id: 'aSimFmi0', code: 0, name: 'Above normal' },
      }),
    );
    expect(await openFaults(h2.id)).toEqual([
      { source: 'geotab', code: 'J1939 SPN 110 FMI 0', severity: 'critical', system: 'j1939' },
    ]);
    expect((await panelRow(h2.id)).faults).toMatchObject([
      { code: 'J1939 SPN 110 FMI 0', severity: 'critical' },
    ]);
  });

  test('an AEMP fault-series occurrence (Kubota): open, aged out after 24 h unseen', async () => {
    const occurrence = (min: number, code: string) =>
      mapAempFault({
        provider: 'kubota',
        machineId: l1.externalId,
        fault: { datetime: iso(min), CodeIdentifier: code, CodeDescription: 'DPF pressure high' },
      });
    await land(l1.id, occurrence(4, 'SPN 3251 FMI 0'));
    expect(await openFaults(l1.id)).toMatchObject([
      { source: 'aemp', code: 'J1939 SPN 3251 FMI 0', system: 'j1939' },
    ]);
    expect((await panelRow(l1.id)).faults).toMatchObject([{ code: 'J1939 SPN 3251 FMI 0' }]);
    // A day and a minute later, another occurrence (a different code): the first one aged out.
    const later = 4 + DELTA_FAULT_AGE_OUT_SECONDS / 60 + 1;
    await land(l1.id, occurrence(later, 'OIL-7'));
    expect((await openFaults(l1.id)).map((f) => f.code)).toEqual(['OEM fault OIL-7']);
    const aged = await t().pool.query(
      `select cleared_at from farm.machine_faults where machine_id = $1 and code = $2`,
      [l1.id, 'J1939 SPN 3251 FMI 0'],
    );
    expect(aged.rows[0]?.cleared_at).not.toBeNull();
  });

  test('a CNH caution code: open on the panel until CNH says it cleared', async () => {
    const caution = (min: number, active: boolean) =>
      mapCnhFault({
        vin: c3.externalId,
        companyId: c3.org,
        kind: 'caution',
        caution: {
          datetime: iso(min),
          Identifier: '5021',
          Description: 'Hydraulic oil temperature',
          Severity: 'Amber',
          Active: active,
        },
      });
    await land(c3.id, caution(6, true));
    expect(await openFaults(c3.id)).toEqual([
      { source: 'cnh', code: 'OEM caution 5021', severity: 'warning', system: 'oem' },
    ]);
    expect((await panelRow(c3.id)).faults).toMatchObject([
      { code: 'OEM caution 5021', severity: 'warning' },
    ]);
    // No age-out for CNH's caution codes: still open a day later, closed when CNH says so.
    await land(c3.id, caution(6 + 25 * 60, true));
    expect(await openFaults(c3.id)).toHaveLength(1);
    await land(c3.id, caution(6 + 26 * 60, false));
    expect(await openFaults(c3.id)).toEqual([]);
  });

  test('the panel: "not reported" for the pickups, "faults not reported" where no system is', async () => {
    // The pickups' first fix through Samsara (their carmaker route: Ford Pro, Stellantis).
    for (const unit of ['PU1', 'PU2'])
      await placed((await mapped('samsara', 'samsara', unit)).id, 'samsara');
    const rows = await fleetPanelMachines(t().pool);
    for (const unit of ['PU1', 'PU2']) {
      const pu = rows.find((m) => m.unitNo === unit);
      expect(pu?.engineHours ?? null).toBeNull();
      expect(pu?.odometerMi ?? null).toBeNull();
      expect(pu?.notReported).toEqual(expect.arrayContaining(['engineHours', 'odometerMi']));
    }
    // Kubota's AEMP feed reports no fault system the app can read (the registry's levels);
    // L1 carries an AEMP fault series above, so its badge shows a code instead.
    const kubota = rows.find((m) => m.unitNo === 'L1');
    expect(kubota?.position?.vendor).toBe('aemp_kubota');
    expect(kubota?.faultsNotReported).toBe(true);
  });
});
