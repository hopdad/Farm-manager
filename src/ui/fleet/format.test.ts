import { describe, expect, test } from 'vitest';
import type { PanelMachine } from './contract';
import { rowAge, rowDetail, rowHeadline } from './format';
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
const row = (m: Partial<PanelMachine>, stale = false): PanelRow => ({
  machine: { ...base, ...m },
  group: 'moving',
  stale,
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
