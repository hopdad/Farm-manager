import { describe, expect, test } from 'vitest';
import {
  activeFaultCodeSchema,
  FAULT_SEVERITIES,
  severityRank,
  sortFaultCodes,
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
