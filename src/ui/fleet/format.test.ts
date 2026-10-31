import { describe, expect, test } from 'vitest';
import type { ActiveFaultCode } from '../../domain/fault-codes';
import type { PanelMachine } from './contract';
import {
  faultBadgeText,
  faultListText,
  lastWorkingText,
  rowAge,
  rowDetail,
  rowHeadline,
  rowStats,
} from './format';
import type { PanelRow } from './model';

const NOW = Date.parse('2026-11-30T15:00:00.000Z');
const base: PanelMachine = {
  id: '00000000-0000-4000-8000-000000000001',
  unitNo: 'S1',
  kind: 'semi',
  make: null,
  model: null,
  status: 'active',
  downReason: null,
  downAt: null,
  downBy: null,
  position: {
    lng: -83.9,
    lat: 41.9,
    heading: 0,
    speedMph: 44.6,
    activity: 'transport',
    positionSource: 'eld',
    ts: '2026-11-30T14:59:30.000Z',
    fieldId: null,
    fieldName: null,
  },
  place: null,
};
const row = (m: Partial<PanelMachine>, stale = false, lastWorking = false): PanelRow => ({
  machine: { ...base, ...m },
  group: 'moving',
  stale,
  lastWorking,
});

describe('fleet panel row text', () => {
  test('moving: activity and speed; age of the fix', () => {
    expect(rowHeadline(row({}))).toBe('On the road · 45 mph');
    expect(rowAge(row({}), NOW)).toBe('Seen 30 s ago');
  });

  test('stopped, stale and never seen', () => {
    const idle = { ...base.position, activity: 'idle', speedMph: 0 } as PanelMachine['position'];
    expect(rowHeadline(row({ position: idle }))).toBe('Idle');
    expect(rowHeadline(row({}, true))).toBe('No recent position');
    expect(rowHeadline(row({ position: null }, true))).toBe('No position yet');
    expect(rowAge(row({ position: null }), NOW)).toBe('Never seen');
  });

  test('down: the reason, since when (Detroit time) and by whom', () => {
    const r = row({
      status: 'down',
      downReason: 'Hydraulic leak',
      downAt: '2026-11-30T14:12:00.000Z',
      downBy: 'Dana',
    });
    expect(rowHeadline(r)).toBe('Down: Hydraulic leak');
    expect(rowDetail(r)).toBe('since 9:12 AM · by Dana');
    expect(rowDetail(row({ status: 'down' }))).toBeNull();
    expect(rowHeadline(row({ status: 'down' }))).toBe('Down');
  });

  test('where: a geofence wins over the field', () => {
    const inField = {
      ...base.position,
      fieldName: 'Kowalski North 80',
    } as PanelMachine['position'];
    expect(rowDetail(row({ position: inField }))).toBe('In Kowalski North 80');
    expect(
      rowDetail(
        row({
          position: inField,
          place: {
            geofenceId: '00000000-0000-4000-8000-000000000009',
            name: 'Kestrel Grain Co.',
            kind: 'elevator',
            since: '2026-11-30T14:50:00.000Z',
          },
        }),
      ),
    ).toBe('At Kestrel Grain Co. since 9:50 AM');
    expect(rowDetail(row({}))).toBeNull();
  });
});

describe('1f: last working position, stats, faults', () => {
  test('a Deere-only machine that stopped working: "Last working position, N min ago"', () => {
    const p = { ...base.position, positionSource: 'deere_working', ts: '2026-11-30T14:53:00.000Z' };
    const r = row({ position: p as PanelMachine['position'] }, false, true);
    expect(rowHeadline(r, NOW)).toBe('Last working position, 7 min ago');
    expect(lastWorkingText('2026-11-30T14:59:50.000Z', NOW)).toBe(
      'Last working position, 1 min ago',
    );
    expect(lastWorkingText('2026-11-30T12:00:00.000Z', NOW)).toBe('Last working position, 3 h ago');
    // Down still says why.
    expect(rowHeadline({ ...r, machine: { ...r.machine, status: 'down' } }, NOW)).toBe('Down');
  });

  test('stats: hours, odometer, fuel always; DEF when known; "not reported", never 0', () => {
    expect(
      rowStats({ engineHours: 4312.04, odometerMi: 412_300, fuelPct: 61.6, defPct: 54.2 }),
    ).toBe('4,312 h · 412,300 mi · fuel 62 % · DEF 54 %');
    expect(rowStats({})).toBe('hours — · odometer — · fuel —');
    // The Ford pickup through Samsara: hours and odometer not reported.
    expect(
      rowStats({
        engineHours: null,
        odometerMi: null,
        fuelPct: 54,
        notReported: ['engineHours', 'odometerMi', 'defPct', 'engineOn'],
      }),
    ).toBe('hours not reported · odometer not reported · fuel 54 %');
    expect(rowStats({ engineHours: 0, odometerMi: 0, fuelPct: 0 })).toBe('0 h · 0 mi · fuel 0 %');
  });

  test('the fault badge: the worst code first, the count of the others; every code in the list', () => {
    const f = (code: string, severity: ActiveFaultCode['severity']): ActiveFaultCode => ({
      code,
      severity,
      description: code === 'P0087' ? 'Fuel rail pressure low' : null,
      since: '2026-11-30T14:40:00.000Z',
    });
    expect(faultBadgeText([])).toBeNull();
    expect(faultBadgeText([f('P0087', 'warning')])).toBe('Warning: P0087');
    const list = [f('P0087', 'warning'), f('J1939 SPN 110 FMI 0', 'critical'), f('P0420', 'info')];
    expect(faultBadgeText(list)).toBe('Critical: J1939 SPN 110 FMI 0 +2');
    expect(faultListText(list, NOW).split('\n')).toEqual([
      'CRITICAL J1939 SPN 110 FMI 0 (since 20 min ago)',
      'WARNING P0087: Fuel rail pressure low (since 20 min ago)',
      'INFO P0420 (since 20 min ago)',
    ]);
  });
});
