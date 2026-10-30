/**
 * The 1f additions to the fleet panel contract (docs/contracts-1f.md §5.3) are optional: a 1a
 * payload (no faults, no vendor) still parses, and a 1f one carries both.
 */
import { describe, expect, test } from 'vitest';
import { panelMachineSchema } from './contract';

const machine = {
  id: '3f1c2b4a-5d6e-5f70-8a9b-0c1d2e3f4a5b',
  unitNo: 'S1',
  kind: 'semi',
  make: null,
  model: null,
  status: 'active',
  downReason: null,
  downAt: null,
  downBy: null,
  position: {
    lng: -84.05,
    lat: 41.9,
    heading: 90,
    speedMph: 50,
    activity: 'transport',
    positionSource: 'eld',
    ts: '2026-10-15T14:00:00.000Z',
    fieldId: null,
    fieldName: null,
  },
  place: null,
};

describe('fleet panel contract (1f fields)', () => {
  test('a 1a machine (no faults, no vendor) still parses', () => {
    const m = panelMachineSchema.parse(machine);
    expect(m.faults).toBeUndefined();
    expect(m.position?.vendor).toBeUndefined();
  });

  test('a 1f machine carries its active fault codes and the vendor of its fix', () => {
    const m = panelMachineSchema.parse({
      ...machine,
      position: { ...machine.position, vendor: 'samsara' },
      faults: [
        {
          code: 'J1939 SPN 110 FMI 0',
          severity: 'critical',
          description: 'Engine coolant temperature high',
          since: '2026-10-15T13:50:00.000Z',
        },
      ],
    });
    expect(m.position?.vendor).toBe('samsara');
    expect(m.faults?.[0]?.severity).toBe('critical');
    expect(
      panelMachineSchema.safeParse({ ...machine, position: { ...machine.position, vendor: 'x' } })
        .success,
    ).toBe(false);
  });
});
