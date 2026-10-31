import { describe, expect, test } from 'vitest';
import { preferredType, simDefPct } from './routes';

describe('the AEMP stand-in helpers', () => {
  test('preferredType reads q values (ties: the first listed)', () => {
    expect(preferredType('application/xml')).toBe('application/xml');
    expect(preferredType('application/xml, application/json;q=0.9')).toBe('application/xml');
    expect(preferredType('application/xml;q=0.5, application/json')).toBe('application/json');
    expect(preferredType('application/json, application/xml')).toBe('application/json');
    expect(preferredType('')).toBeNull();
    expect(preferredType(undefined)).toBeNull();
  });

  test('a steady DEF level per machine, 40-89 %', () => {
    expect(simDefPct('m1')).toBe(simDefPct('m1'));
    for (const id of ['a', 'b', 'c', 'd']) {
      expect(simDefPct(id)).toBeGreaterThanOrEqual(40);
      expect(simDefPct(id)).toBeLessThan(90);
    }
  });
});
