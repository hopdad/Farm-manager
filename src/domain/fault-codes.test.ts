import { describe, expect, test } from 'vitest';
import {
  activeFaultCodeSchema,
  FAULT_SEVERITIES,
  faultCodeKey,
  faultSeverity,
  normalizedFault,
  normalizedFaultSchema,
  oemSeverity,
  severityRank,
  sortFaultCodes,
  toFaultCode,
  worstSeverity,
} from './fault-codes';

describe('fault codes', () => {
  test('severities are ranked lowest first', () => {
    expect(FAULT_SEVERITIES.map(severityRank)).toEqual([0, 1, 2]);
  });

  test('worst severity of a set; null for none', () => {
    expect(worstSeverity([])).toBeNull();
    expect(worstSeverity([{ severity: 'info' }, { severity: 'warning' }])).toBe('warning');
    expect(worstSeverity([{ severity: 'critical' }, { severity: 'info' }])).toBe('critical');
  });

  test('sorted worst first, then by code', () => {
    const codes = [
      { code: 'P0217', severity: 'warning' as const, description: null },
      { code: 'J1939 SPN 110 FMI 0', severity: 'critical' as const, description: 'coolant' },
      { code: 'P0101', severity: 'warning' as const, description: null },
    ];
    expect(sortFaultCodes(codes).map((c) => c.code)).toEqual([
      'J1939 SPN 110 FMI 0',
      'P0101',
      'P0217',
    ]);
  });

  test('an active code needs its since time', () => {
    const ok = {
      code: 'P0217',
      severity: 'info',
      description: null,
      since: '2026-10-15T14:00:00Z',
    };
    expect(activeFaultCodeSchema.parse(ok)).toEqual(ok);
    expect(activeFaultCodeSchema.safeParse({ ...ok, since: 'soon' }).success).toBe(false);
    expect(activeFaultCodeSchema.safeParse({ ...ok, severity: 'fatal' }).success).toBe(false);
  });
});

describe('1f.2: one fault model for J1939, OBD-II and OEM codes', () => {
  test('history keys per system', () => {
    expect(faultCodeKey({ system: 'j1939', spn: 110, fmi: 0, sourceAddress: 0 })).toBe(
      'J1939 SPN 110 FMI 0',
    );
    expect(faultCodeKey({ system: 'obd2', dtc: ' p0217 ' })).toBe('P0217');
    expect(faultCodeKey({ system: 'oem', oemCode: '1234', oemClass: 'caution' })).toBe(
      'OEM caution 1234',
    );
    expect(faultCodeKey({ system: 'oem', oemCode: 'E-55' })).toBe('OEM E-55');
  });

  test('decision 1f-2 extended per system', () => {
    // J1939: lamps decide; no lamp = info.
    expect(faultSeverity({ system: 'j1939', lamps: { redStop: true, amberWarning: true } })).toBe(
      'critical',
    );
    expect(faultSeverity({ system: 'j1939', lamps: { amberWarning: true } })).toBe('warning');
    expect(faultSeverity({ system: 'j1939', lamps: { protect: true } })).toBe('warning');
    expect(faultSeverity({ system: 'j1939', lamps: { malfunction: true } })).toBe('warning');
    expect(faultSeverity({ system: 'j1939' })).toBe('info');
    // OBD-II: never critical; MIL, confirmed or permanent = warning; pending = info.
    expect(faultSeverity({ system: 'obd2', dtcState: 'confirmed' })).toBe('warning');
    expect(faultSeverity({ system: 'obd2', dtcState: 'permanent' })).toBe('warning');
    expect(faultSeverity({ system: 'obd2', dtcState: 'pending' })).toBe('info');
    expect(
      faultSeverity({ system: 'obd2', dtcState: 'pending', lamps: { malfunction: true } }),
    ).toBe('warning');
    expect(faultSeverity({ system: 'obd2', lamps: { redStop: true } })).toBe('info');
    // OEM: the vendor's own label when known, else the class.
    expect(faultSeverity({ system: 'oem', oemClass: 'caution', vendorSeverity: 'HIGH' })).toBe(
      'critical',
    );
    expect(faultSeverity({ system: 'oem', oemClass: 'fault', vendorSeverity: 'low' })).toBe('info');
    expect(faultSeverity({ system: 'oem', oemClass: 'caution' })).toBe('info');
    expect(faultSeverity({ system: 'oem', oemClass: 'fault', vendorSeverity: 'odd' })).toBe(
      'warning',
    );
    expect(faultSeverity({ system: 'oem' })).toBe('warning');
    expect(oemSeverity('Amber')).toBe('warning');
    expect(oemSeverity(null)).toBeNull();
  });

  test('normalizedFault fills the key and the severity; the schema checks each system', () => {
    const f = normalizedFault({
      system: 'j1939',
      spn: 3251,
      fmi: 2,
      lamps: { amberWarning: true },
      state: 'open',
      firstSeenAt: '2026-10-15T12:00:00Z',
    });
    expect(f).toMatchObject({ code: 'J1939 SPN 3251 FMI 2', severity: 'warning' });
    expect(normalizedFaultSchema.parse(f)).toEqual(f);
    expect(normalizedFault({ system: 'obd2', dtc: 'P0420', severity: 'critical' }).severity).toBe(
      'critical',
    );
    const bad = [
      { ...f, spn: null },
      { ...f, code: 'J1939 SPN 1 FMI 2' },
      { system: 'obd2', code: '?', severity: 'info' },
      { system: 'oem', code: 'OEM ?', severity: 'info' },
      { ...f, fmi: 32, code: 'J1939 SPN 3251 FMI 32' },
    ];
    for (const b of bad)
      expect(normalizedFaultSchema.safeParse(b).success, JSON.stringify(b)).toBe(false);
  });

  test("the panel's view keeps the system's own fields; a 1f code stays valid", () => {
    const f = normalizedFault({ system: 'obd2', dtc: 'P0217', dtcState: 'confirmed' });
    expect(toFaultCode(f)).toEqual({
      code: 'P0217',
      severity: 'warning',
      description: null,
      system: 'obd2',
      dtcState: 'confirmed',
    });
    expect(
      activeFaultCodeSchema.safeParse({
        code: 'J1939 SPN 110 FMI 0',
        severity: 'critical',
        description: null,
        since: '2026-10-15T14:00:00Z',
      }).success,
    ).toBe(true);
  });
});
