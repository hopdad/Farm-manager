/**
 * The Samsara stand-in's fault codes (slice 1f, docs/contracts-1f.md §7.3): the pure pieces (the
 * knob's history, the breakdown schedule, the reading's shape per route) and, on the demo world,
 * the breakdown scenario's semi code arriving at its scheduled time, the pickups reporting
 * OBD-II only, and the knob clearing it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mapSamsaraFaults } from '../../../connectors/samsara/mapper';
import {
  type SamsaraFaultCodesFeed,
  type SamsaraFaultCodesReading,
  samsaraFaultCodesFeedSchema,
  samsaraFaultCodesReadingSchema,
} from '../../../connectors/samsara/schemas';
import { createSimWorld } from '../../index';
import { SIM_CREDENTIALS } from '../../types';
import { startVendorSim, type VendorSim } from '../server';
import {
  EMPTY_SAMSARA_SIM_FAULTS,
  SAMSARA_SIM_FAULTS_CONTROL_PATH,
  type SamsaraSimFaultsStatus,
  SIM_RED_STOP_FAULT,
  samsaraSimFaultsStatusSchema,
} from './control-types';
import {
  activeFaults,
  BREAKDOWN_SEMI_FAULT,
  type FaultVehicle,
  faultReading,
  obdDtcId,
  scheduledFaults,
  withFaultChange,
} from './fault-codes';

const semi: FaultVehicle = {
  id: 'v1',
  name: 'S3',
  machineId: 'm1',
  bus: 'j1939',
  systems: new Set(['j1939', 'obd2', 'oem']),
};
const pickup: FaultVehicle = {
  id: 'v2',
  name: 'PU1',
  machineId: 'm2',
  bus: 'obd2',
  systems: new Set(['obd2', 'oem']),
};
const breakdown = { scenario: 'breakdown' as const, startsAt: new Date('2026-10-15T11:00:00Z') };
const sameTime = (w: Date) => w;

describe('fault codes, pure', () => {
  test('the breakdown schedule: S3 only, from 09:40 local on day 0, nothing elsewhere', () => {
    const at = breakdown.startsAt.getTime() + BREAKDOWN_SEMI_FAULT.afterStartMs;
    expect(new Date(at).toISOString()).toBe('2026-10-15T13:40:00.000Z'); // 09:40 EDT
    expect(scheduledFaults(breakdown, semi, new Date(at - 1))).toEqual([]);
    expect(scheduledFaults(breakdown, semi, new Date(at))).toEqual([SIM_RED_STOP_FAULT]);
    expect(scheduledFaults(breakdown, { name: 'S1' }, new Date(at + 1))).toEqual([]);
    expect(
      scheduledFaults({ ...breakdown, scenario: 'harvest-day' }, semi, new Date(at + 1)),
    ).toEqual([]);
  });

  test('the knob: codes from the moment they are set; null hands back to the schedule', () => {
    const t0 = Date.parse('2026-10-15T14:00:00Z');
    let state = withFaultChange(EMPTY_SAMSARA_SIM_FAULTS, 'v1', new Date(t0), []);
    state = withFaultChange(state, 'v1', new Date(t0 + 60_000), null);
    const at = (ms: number) => activeFaults(breakdown, state, semi, ms, sameTime);
    expect(at(t0 - 1)).toMatchObject({ from: 'schedule', codes: [SIM_RED_STOP_FAULT] });
    expect(at(t0)).toMatchObject({ from: 'knob', codes: [], setAt: new Date(t0).toISOString() });
    expect(at(t0 + 60_000)).toMatchObject({ from: 'schedule', setAt: null });
    // A change set "in the past" replaces the later history (the knob only moves forward).
    const back = withFaultChange(state, 'v1', new Date(t0 + 30_000), [SIM_RED_STOP_FAULT]);
    expect(back.vehicles.v1?.map((c) => c.setAt)).toEqual([
      new Date(t0).toISOString(),
      new Date(t0 + 30_000).toISOString(),
    ]);
  });

  test('a truck reading: J1939 block with the lamps of its codes, valid for the live schema', () => {
    const r = faultReading(semi, [SIM_RED_STOP_FAULT], Date.parse('2026-10-15T14:00:00Z'));
    expect(samsaraFaultCodesReadingSchema.safeParse(r).success).toBe(true);
    expect(r).toMatchObject({
      time: '2026-10-15T14:00:00.000Z',
      canBusType: 'CANBUS_J1939_500',
      j1939: {
        checkEngineLights: {
          stopIsOn: true,
          warningIsOn: true,
          protectIsOn: false,
          emissionsIsOn: false,
        },
        diagnosticTroubleCodes: [
          {
            spnId: 110,
            fmiId: 0,
            txId: 0,
            sourceAddressName: 'Engine #1',
            spnDescription: 'Engine Coolant Temperature',
          },
        ],
      },
    });
    expect(r.obdii).toBeUndefined();
    // No codes: the block is still there, empty ("empty if there are no active fault codes").
    expect(faultReading(semi, [], 0).j1939?.diagnosticTroubleCodes).toEqual([]);
  });

  test('a pickup reading: OBD-II engine module (even when clean), J1939 codes left out', () => {
    const clean = faultReading(pickup, [], 0);
    expect(clean.j1939).toBeUndefined();
    expect(clean.obdii?.diagnosticTroubleCodes).toEqual([
      expect.objectContaining({ txId: 2024, confirmedDtcs: [], milStatus: false }),
    ]);
    const r = faultReading(
      pickup,
      [
        SIM_RED_STOP_FAULT, // the route reports no J1939: dropped
        { system: 'obd2', dtc: 'P0087', description: 'Fuel rail pressure low' },
        { system: 'obd2', dtc: 'P0420', state: 'pending', txId: 2025 },
        { system: 'oem', code: 'CA2387', severity: 'L03' },
      ],
      0,
    );
    expect(r.j1939).toBeUndefined();
    expect(r.obdii).toMatchObject({
      checkEngineLightIsOn: true,
      diagnosticTroubleCodes: [
        {
          txId: 2024,
          milStatus: true,
          confirmedDtcs: [{ dtcId: 135, dtcShortCode: 'P0087' }],
        },
        { txId: 2025, milStatus: false, pendingDtcs: [{ dtcShortCode: 'P0420' }] },
      ],
    });
    expect(r.oem?.diagnosticTroubleCodes).toEqual([
      { codeIdentifier: 'CA2387', codeSeverity: 'L03' },
    ]);
    expect(obdDtcId('P0087')).toBe(135);
    expect(obdDtcId('U0100')).toBe(0xc100);
  });
});

// ---- the demo world in the stand-in -----------------------------------------------------------

let wall = Date.parse('2026-11-30T15:00:02.000Z');
let sim: VendorSim;

/** One feed page (retried past the breakdown scenario's own "trucks API flaky" 500s). */
async function feed(after: string | null): Promise<SamsaraFaultCodesFeed> {
  const q = new URLSearchParams({ types: 'faultCodes', ...(after ? { after } : {}) });
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${sim.url}/samsara/fleet/vehicles/stats/feed?${q}`, {
      headers: { authorization: `Bearer ${SIM_CREDENTIALS.samsara.apiToken}` },
    });
    if (res.status === 500 && attempt < 20) continue;
    expect(res.status).toBe(200);
    return samsaraFaultCodesFeedSchema.parse(await res.json());
  }
}

async function knob(body?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${sim.url}${SAMSARA_SIM_FAULTS_CONTROL_PATH}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() };
}

const readings = (page: SamsaraFaultCodesFeed, name: string) =>
  (page.data.find((v) => v.name === name)?.faultCodes ?? []) as SamsaraFaultCodesReading[];

beforeAll(async () => {
  sim = await startVendorSim({ createWorld: createSimWorld, port: 0, now: () => new Date(wall) });
});
afterAll(() => sim.close());

describe('fault codes on the demo world', () => {
  test('breakdown: S3 reports its red-stop code at 09:40; the pickups are OBD-II only', async () => {
    sim.control.reset({ scenario: 'breakdown' });
    const first = await feed(null);
    // Every vehicle that reports faults, once: the four semis (J1939) and both pickups (OBD-II).
    expect(first.data.map((v) => v.name).sort()).toEqual(['PU1', 'PU2', 'S1', 'S2', 'S3', 'S4']);
    for (const v of first.data) expect(v.faultCodes).toHaveLength(1);
    expect(readings(first, 'PU1')[0]?.j1939).toBeUndefined();
    expect(readings(first, 'PU1')[0]?.obdii?.diagnosticTroubleCodes?.[0]?.txId).toBe(2024);
    expect(readings(first, 'S3')[0]?.j1939?.diagnosticTroubleCodes).toEqual([]);

    // Nothing changes for a minute: no readings.
    wall += 60_000;
    let page = await feed(first.pagination.endCursor);
    expect(page.data).toEqual([]);

    // Jump to 09:41: S3 alone reports, once, with the critical code.
    sim.control.clock({ action: 'jump', simTime: '2026-10-15T13:41:00.000Z' });
    wall += 10_000;
    page = await feed(page.pagination.endCursor);
    expect(page.data.map((v) => v.name)).toEqual(['S3']);
    const [stat] = mapSamsaraFaults({ id: page.data[0]?.id, reading: readings(page, 'S3')[0] });
    expect(stat?.faultCodes).toMatchObject([
      { code: 'J1939 SPN 110 FMI 0', severity: 'critical', lamps: { redStop: true } },
    ]);
    const status = samsaraSimFaultsStatusSchema.parse((await knob()).body);
    expect(status.scenario).toBe('breakdown');
    expect(status.schedule).toMatchObject({ vehicle: 'S3', simAt: '2026-10-15T13:40:00.000Z' });
    expect(status.vehicles.find((v) => v.name === 'S3')).toMatchObject({ from: 'schedule' });

    // The knob clears it: the next reading is empty; handing it back brings the code back.
    expect((await knob({ vehicle: 'S3', codes: [] })).status).toBe(200);
    wall += 5_000;
    page = await feed(page.pagination.endCursor);
    expect(readings(page, 'S3').map((r) => r.j1939?.diagnosticTroubleCodes)).toEqual([[]]);
    const back = (await knob({ vehicle: 'S3', codes: null })).body as SamsaraSimFaultsStatus;
    expect(back.vehicles.find((v) => v.name === 'S3')).toMatchObject({ from: 'schedule' });
    wall += 5_000;
    page = await feed(page.pagination.endCursor);
    expect(readings(page, 'S3')[0]?.j1939?.diagnosticTroubleCodes).toHaveLength(1);
  });

  test('the knob refuses bad bodies and vehicles that report no faults', async () => {
    expect((await knob({ vehicle: 'S3' })).status).toBe(400);
    expect((await knob({ vehicle: 'S3', codes: [{ system: 'j1939', spn: 1 }] })).status).toBe(400);
    expect((await knob({ vehicle: 'H1', codes: [] })).status).toBe(404); // Motive's, not Samsara's
    expect((await knob({ vehicle: 'nope', codes: [] })).status).toBe(404);
    // By name or by Samsara id.
    const status = samsaraSimFaultsStatusSchema.parse((await knob()).body);
    const pu2 = status.vehicles.find((v) => v.name === 'PU2');
    const set = await knob({ vehicle: pu2?.id, codes: [{ system: 'obd2', dtc: 'P0217' }] });
    expect(set.status).toBe(200);
    expect(
      (set.body as SamsaraSimFaultsStatus).vehicles.find((v) => v.name === 'PU2'),
    ).toMatchObject({ from: 'knob', codes: [{ system: 'obd2', dtc: 'P0217' }] });
    // Reset forgets the knob.
    sim.control.reset({});
    const after = samsaraSimFaultsStatusSchema.parse((await knob()).body);
    expect(after.vehicles.every((v) => v.from !== 'knob')).toBe(true);
  });
});
