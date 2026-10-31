import { describe, expect, test } from 'vitest';
import type { Mode } from '../../connectors/types';
import type { ActiveFaultCode } from '../../domain/fault-codes';
import type { FleetTick, MachineView } from '../../domain/fleet';
import type { FleetPanelData, PanelMachine } from './contract';
import { MAX_DOWN_REASON_CHARS } from './contract';
import {
  criticalFault,
  DEERE_STOPPED_WORKING_SECONDS,
  deereStoppedWorkingSeconds,
  groupMachines,
  groupOf,
  initialPanelState,
  markDownReason,
  modeNotices,
  offersMarkDown,
  type PanelState,
  reducePanel,
  thresholdsOf,
  vendorBadge,
  worstFault,
} from './model';

const NOW = new Date('2026-11-30T15:00:00.000Z');
const ago = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();
const TH = { staleAfterSeconds: 600, deereStaleAfterSeconds: 900 };

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const BASE_POS: NonNullable<PanelMachine['position']> = {
  lng: -83.9,
  lat: 41.9,
  heading: 90,
  speedMph: 45,
  activity: 'transport',
  positionSource: 'eld',
  ts: ago(10),
  fieldId: null,
  fieldName: null,
};

function machine(n: number, unitNo: string, over: Partial<PanelMachine> = {}): PanelMachine {
  return {
    id: id(n),
    unitNo,
    kind: 'semi',
    make: null,
    model: null,
    status: 'active',
    downReason: null,
    downAt: null,
    downBy: null,
    position: BASE_POS,
    place: null,
    ...over,
  };
}

function data(machines: PanelMachine[], over: Partial<FleetPanelData> = {}): FleetPanelData {
  return {
    builtAt: NOW.toISOString(),
    machines,
    canMarkDown: true,
    modes: {
      deere: 'sim',
      samsara: 'live',
      motive: 'live',
      geotab: 'off',
      aemp: 'off',
      cnh: 'off',
      terminal: 'off',
    },
    config: {
      appEnv: 'development',
      realtime: 'sse',
      staleAfterSeconds: 600,
      deereStaleAfterSeconds: 900,
    },
    ...over,
  };
}

function view(m: PanelMachine, over: Partial<MachineView> = {}): MachineView {
  return {
    id: m.id,
    unitNo: m.unitNo,
    kind: m.kind,
    lng: -83.8,
    lat: 41.95,
    heading: 180,
    speedMph: 0,
    activity: 'idle',
    fieldId: null,
    positionSource: 'eld',
    ts: ago(1),
    status: m.status,
    stale: false,
    ...over,
  };
}

const loaded = (ms: PanelMachine[]): PanelState =>
  reducePanel(initialPanelState, { type: 'snapshot', data: data(ms) });

describe('groupOf / groupMachines', () => {
  test('moving, idle, down, stale', () => {
    const working = machine(1, 'C1', {
      kind: 'combine',
      position: { ...BASE_POS, activity: 'working' },
    });
    const queued = machine(2, 'S2', {
      position: { ...BASE_POS, activity: 'queued', speedMph: 1 },
    });
    const down = machine(3, 'S3', { status: 'down', downReason: 'Flat tire' });
    const old = machine(4, 'S4', {
      position: { ...BASE_POS, ts: ago(601) },
    });
    const never = machine(5, 'D1', { kind: 'drone', position: null });
    const g = groupMachines([working, queued, down, old, never], NOW, TH);
    expect(g.moving.map((r) => r.machine.unitNo)).toEqual(['C1']);
    expect(g.idle.map((r) => r.machine.unitNo)).toEqual(['S2']);
    expect(g.down.map((r) => r.machine.unitNo)).toEqual(['S3']);
    expect(g.stale.map((r) => r.machine.unitNo)).toEqual(['S4']);
    // Never reported: its own group, not a stale alarm (the map doesn't count it either).
    expect(g.unplaced.map((r) => [r.machine.unitNo, r.stale])).toEqual([['D1', false]]);
  });

  test('down wins over stale, and the row still says it is stale', () => {
    const m = machine(1, 'S1', {
      status: 'down',
      position: { ...BASE_POS, ts: ago(3600) },
    });
    expect(groupOf(m, NOW, TH)).toEqual({ group: 'down', stale: true, lastWorking: false });
  });

  test('1f: a Deere-only machine that stopped working shows its last working position, no alarm', () => {
    const deere = (age: number, over: Partial<NonNullable<PanelMachine['position']>> = {}) =>
      machine(1, 'C1', {
        kind: 'combine',
        position: {
          ...BASE_POS,
          activity: 'working',
          positionSource: 'deere_working',
          ts: ago(age),
          ...over,
        },
      });
    expect(DEERE_STOPPED_WORKING_SECONDS).toBe(180);
    expect(groupOf(deere(60), NOW, TH)).toEqual({
      group: 'moving',
      stale: false,
      lastWorking: false,
    });
    // No breadcrumb for 3 min: stopped working (idle), never "stale", even long after the
    // Deere stale threshold (900 s here).
    for (const age of [180, 700, 901, 6 * 3600]) {
      expect(groupOf(deere(age), NOW, TH)).toEqual({
        group: 'idle',
        stale: false,
        lastWorking: true,
      });
    }
    // A Deere stale threshold under 3 min wins (the panel never says "working" past it).
    expect(deereStoppedWorkingSeconds({ ...TH, deereStaleAfterSeconds: 60 })).toBe(60);
    expect(groupOf(deere(70), NOW, { ...TH, deereStaleAfterSeconds: 60 }).lastWorking).toBe(true);
    // Down still wins; a live telematics fix of the same age is still a stale alarm.
    expect(groupOf({ ...deere(901), status: 'down' }, NOW, TH).group).toBe('down');
    expect(groupOf(deere(901, { positionSource: 'eld' }), NOW, TH).group).toBe('stale');
    expect(
      groupMachines([deere(901)], NOW, TH).idle.map((r) => [r.machine.unitNo, r.lastWorking]),
    ).toEqual([['C1', true]]);
  });

  test('thresholds default until the config loads', () => {
    expect(thresholdsOf(null)).toEqual({ staleAfterSeconds: 600, deereStaleAfterSeconds: 600 });
    expect(thresholdsOf(data([]).config)).toEqual(TH);
  });
});

describe('reducePanel', () => {
  test('a snapshot loads and sorts by unit number (S2 before S10)', () => {
    const s = loaded([machine(3, 'S10'), machine(1, 'S2'), machine(2, 'C1')]);
    expect(s.loaded).toBe(true);
    expect(s.machines.map((m) => m.unitNo)).toEqual(['C1', 'S2', 'S10']);
    expect(s.canMarkDown).toBe(true);
  });

  test('ticks before the first snapshot are ignored', () => {
    const tick: FleetTick = { ts: NOW.toISOString(), machines: [view(machine(1, 'S1'))] };
    expect(reducePanel(initialPanelState, { type: 'tick', tick })).toBe(initialPanelState);
  });

  test('a tick moves machines; the field name stays only while in the same field', () => {
    const a = machine(1, 'S1', {
      position: { ...BASE_POS, fieldId: id(90), fieldName: 'North 80' },
    });
    let s = loaded([a, machine(2, 'S2')]);
    s = reducePanel(s, {
      type: 'tick',
      tick: { ts: NOW.toISOString(), machines: [view(a, { fieldId: id(90), speedMph: 3 })] },
    });
    expect(s.machines[0]?.position).toMatchObject({ speedMph: 3, fieldName: 'North 80' });
    s = reducePanel(s, {
      type: 'tick',
      tick: { ts: NOW.toISOString(), machines: [view(a, { fieldId: id(91) })] },
    });
    expect(s.machines[0]?.position).toMatchObject({ fieldId: id(91), fieldName: null });
    expect(s.machines[1]?.position?.lng).toBe(-83.9); // not in the tick: unchanged
    expect(s.needsRefetch).toBe(true); // a field we have no name for: refetch
  });

  test('staying in the same field, or leaving to the road, needs no refetch', () => {
    const a = machine(1, 'S1', {
      position: { ...BASE_POS, fieldId: id(90), fieldName: 'North 80' },
    });
    let s = loaded([a]);
    s = reducePanel(s, {
      type: 'tick',
      tick: { ts: NOW.toISOString(), machines: [view(a, { fieldId: id(90) })] },
    });
    expect(s.needsRefetch).toBe(false);
    s = reducePanel(s, {
      type: 'tick',
      tick: { ts: NOW.toISOString(), machines: [view(a, { fieldId: null })] },
    });
    expect(s.machines[0]?.position?.fieldName).toBeNull();
    expect(s.needsRefetch).toBe(false);
  });

  test('a fleet/machine event marks down and back up at once', () => {
    let s = loaded([machine(1, 'C1')]);
    s = reducePanel(s, {
      type: 'machine',
      payload: {
        machineId: id(1),
        status: 'down',
        downReason: 'Hydraulic leak',
        downAt: ago(0),
        by: 'Dana',
      },
    });
    expect(s.machines[0]).toMatchObject({
      status: 'down',
      downReason: 'Hydraulic leak',
      downBy: 'Dana',
    });
    s = reducePanel(s, {
      type: 'machine',
      payload: { machineId: id(1), status: 'active', downReason: null, downAt: null, by: 'Dana' },
    });
    expect(s.machines[0]).toMatchObject({
      status: 'active',
      downReason: null,
      downAt: null,
      downBy: null,
    });
    expect(s.needsRefetch).toBe(false);
  });

  test('a tick that says "back up" clears the down state', () => {
    const down = machine(1, 'C1', { status: 'down', downReason: 'Engine', downAt: ago(60) });
    const s = reducePanel(loaded([down]), {
      type: 'tick',
      tick: { ts: NOW.toISOString(), machines: [view(down, { status: 'active' })] },
    });
    expect(s.machines[0]).toMatchObject({ status: 'active', downReason: null });
    expect(s.needsRefetch).toBe(false);
  });

  test('surprises ask for a refetch: an unheard-of down, an unknown machine or event', () => {
    const m = machine(1, 'C1');
    const down = reducePanel(loaded([m]), {
      type: 'tick',
      tick: { ts: NOW.toISOString(), machines: [view(m, { status: 'down' })] },
    });
    expect(down.machines[0]?.status).toBe('down');
    expect(down.needsRefetch).toBe(true);
    const stranger = reducePanel(loaded([m]), {
      type: 'tick',
      tick: { ts: NOW.toISOString(), machines: [view(machine(9, 'X9'))] },
    });
    expect(stranger.needsRefetch).toBe(true);
    const event = reducePanel(loaded([m]), {
      type: 'machine',
      payload: { machineId: id(9), status: 'down', downReason: 'x', downAt: null, by: null },
    });
    expect(event.needsRefetch).toBe(true);
    expect(reducePanel(event, { type: 'snapshot', data: data([m]) }).needsRefetch).toBe(false);
  });

  test('retired machines drop out', () => {
    const m = machine(1, 'C1');
    const s = reducePanel(loaded([m, machine(2, 'C2')]), {
      type: 'machine',
      payload: { machineId: id(1), status: 'retired', downReason: null, downAt: null, by: null },
    });
    expect(s.machines.map((x) => x.unitNo)).toEqual(['C2']);
  });

  test('errors are kept until the next snapshot', () => {
    const s = reducePanel(loaded([]), { type: 'error', message: 'Fleet unavailable' });
    expect(s.error).toBe('Fleet unavailable');
    expect(reducePanel(s, { type: 'snapshot', data: data([]) }).error).toBeNull();
  });
});

describe('modeNotices', () => {
  test('flags every connection that is not live or off, in registry order and words', () => {
    const all = (mode: Mode) => ({
      deere: mode,
      samsara: mode,
      motive: mode,
      geotab: mode,
      aemp: mode,
      cnh: mode,
      terminal: mode,
    });
    expect(modeNotices(null)).toEqual([]);
    expect(modeNotices(all('live'))).toEqual([]);
    expect(modeNotices(all('off'))).toEqual([]);
    expect(modeNotices({ ...all('off'), deere: 'replay', samsara: 'replay' })).toEqual([
      'John Deere: replay',
      'Samsara: replay',
    ]);
    expect(modeNotices({ ...all('live'), deere: 'sandbox', motive: 'sim', aemp: 'sim' })).toEqual([
      'John Deere: sandbox',
      'Motive: sim',
      'AEMP (ISO 15143-3): sim',
    ]);
  });
});

describe('1f: mode notices only for connections that serve a machine', () => {
  const modes = data([]).modes;
  const sim = { ...modes, samsara: 'sim' as const, cnh: 'sim' as const, terminal: 'sim' as const };
  test('the connections of the machines on the panel (their latest fix), else all of them', () => {
    const samsara = machine(1, 'S1', { position: { ...BASE_POS, vendor: 'samsara' } });
    const kubota = machine(2, 'L1', { position: { ...BASE_POS, vendor: 'aemp_kubota' } });
    expect(modeNotices(sim, [samsara])).toEqual(['Samsara: sim']);
    expect(modeNotices({ ...sim, aemp: 'sim' }, [samsara, kubota])).toEqual([
      'Samsara: sim',
      'AEMP (ISO 15143-3): sim',
    ]);
    // Nothing known yet (a fresh database, no vendor on any fix): every non-live connection.
    expect(modeNotices(sim, [machine(3, 'S2')])).toEqual([
      'John Deere: sim',
      'Samsara: sim',
      'CNH FieldOps: sim',
      'Terminal: sim',
    ]);
  });
});

describe('1f: the vendor badge and faults', () => {
  const modes = { ...data([]).modes, samsara: 'sim' as const, aemp: 'sim' as const };
  const withVendor = (vendor: string | null) =>
    machine(1, 'S1', { position: { ...BASE_POS, vendor } });
  const fault = (
    code: string,
    severity: ActiveFaultCode['severity'],
    description: string | null = null,
  ): ActiveFaultCode => ({ code, severity, description, since: ago(60) });

  test('"Samsara · sim", a provider route, a vendor the registry does not know, none', () => {
    expect(vendorBadge(withVendor('samsara'), modes)?.text).toBe('Samsara · sim');
    expect(vendorBadge(withVendor('aemp_kubota'), modes)).toEqual({
      text: 'Kubota (AEMP) · sim',
      vendor: 'aemp_kubota',
      mode: 'sim',
    });
    expect(vendorBadge(withVendor('deere'), { ...modes, deere: 'replay' })?.text).toBe(
      'John Deere · replay',
    );
    expect(vendorBadge(withVendor('terminal_omnitracs_xrs'), modes)?.text).toBe(
      'Omnitracs XRS (via Terminal) · off',
    );
    expect(vendorBadge(withVendor('acme_tracker'), modes)).toEqual({
      text: 'acme_tracker',
      vendor: 'acme_tracker',
      mode: null,
    });
    expect(vendorBadge(withVendor(null), modes)).toBeNull();
    expect(vendorBadge(machine(1, 'D1', { position: null }), modes)).toBeNull();
  });

  test('the worst code; a critical one offers "mark down?" to drivers and up, never when down', () => {
    const faults = [fault('P0087', 'warning'), fault('J1939 SPN 110 FMI 0', 'critical', 'Hot')];
    const m = machine(1, 'S3', { faults });
    expect(worstFault(m)?.code).toBe('J1939 SPN 110 FMI 0');
    expect(criticalFault(m)?.code).toBe('J1939 SPN 110 FMI 0');
    expect(offersMarkDown(m, true)).toBe(true);
    expect(offersMarkDown(m, false)).toBe(false); // a viewer: the badge only
    expect(offersMarkDown({ ...m, status: 'down' }, true)).toBe(false);
    const warn = machine(2, 'S2', { faults: [fault('P0087', 'warning')] });
    expect(criticalFault(warn)).toBeNull();
    expect(offersMarkDown(warn, true)).toBe(false);
    expect(worstFault(machine(3, 'S1'))).toBeNull();
  });

  test('the reason the sheet opens with: the code and its description, within the limit', () => {
    expect(
      markDownReason(fault('J1939 SPN 110 FMI 0', 'critical', 'Engine Coolant Temperature')),
    ).toBe('Critical fault J1939 SPN 110 FMI 0: Engine Coolant Temperature');
    expect(markDownReason(fault('OEM X1', 'critical'))).toBe('Critical fault OEM X1');
    const long = markDownReason(fault('P0087', 'critical', 'x'.repeat(400)));
    expect(long.length).toBe(MAX_DOWN_REASON_CHARS);
    expect(long.endsWith('…')).toBe(true);
  });

  test('a tick keeps the faults, stats and vendor the snapshot said', () => {
    const m = machine(1, 'S1', {
      faults: [fault('P0087', 'warning')],
      engineHours: 4312,
      position: { ...BASE_POS, vendor: 'samsara' },
    });
    const s = reducePanel(initialPanelState, { type: 'snapshot', data: data([m]) });
    const tick: FleetTick = { ts: NOW.toISOString(), machines: [view(m, { speedMph: 30 })] };
    const next = reducePanel(s, { type: 'tick', tick }).machines[0];
    expect(next?.faults).toEqual(m.faults);
    expect(next?.engineHours).toBe(4312);
    expect(next?.position?.vendor).toBe('samsara');
  });
});
