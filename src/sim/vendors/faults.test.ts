import { describe, expect, test } from 'vitest';
import type { FaultRule } from '../types';
import {
  applyFaultsRequest,
  FaultRequestError,
  faultRoll,
  faultsControlRequestSchema,
  matchFaults,
  scenarioFaultRules,
  zonedInstant,
} from './faults';

const wallNow = new Date('2026-10-29T12:00:00Z');
const simNow = new Date('2026-10-15T11:30:00Z');
const ctx = {
  vendor: 'samsara' as const,
  path: '/fleet/vehicles/locations/feed',
  wallNow,
  simNow,
  seq: 1,
};

const rule = (r: Partial<FaultRule> & Pick<FaultRule, 'kind'>): FaultRule => ({
  id: r.id ?? `r-${r.kind}`,
  vendor: r.vendor ?? 'samsara',
  ...r,
});

describe('fault matching', () => {
  test('vendor, path prefix and windows decide which rules apply', () => {
    const rules = [
      rule({ id: 'a', kind: 'outage', label: 'trucks API down' }),
      rule({ id: 'b', kind: 'latency', vendor: 'deere' }),
      rule({ id: 'c', kind: 'rate_limit', vendor: '*', pathPrefix: '/fleet/vehicles/stats' }),
      rule({ id: 'd', kind: 'http_error', until: '2026-10-29T11:59:59Z' }),
      rule({ id: 'e', kind: 'http_error', from: '2026-10-29T12:00:00Z' }),
      rule({ id: 'f', kind: 'timeout', simFrom: '2026-10-15T12:00:00Z' }),
      rule({ id: 'g', kind: 'token_expired', vendor: '*', simUntil: '2026-10-15T12:00:00Z' }),
    ];
    expect(matchFaults(rules, ctx).map((r) => r.id)).toEqual(['a', 'e', 'g']);
  });

  test('probability is deterministic per (rule id, seq) and roughly right', () => {
    const r = rule({ id: 'flaky', kind: 'http_error', probability: 0.2 });
    const hits = Array.from(
      { length: 2000 },
      (_, i) => matchFaults([r], { ...ctx, seq: i }).length,
    );
    const again = Array.from(
      { length: 2000 },
      (_, i) => matchFaults([r], { ...ctx, seq: i }).length,
    );
    expect(hits).toEqual(again);
    const rate = hits.reduce((a, b) => a + b, 0) / hits.length;
    expect(rate).toBeGreaterThan(0.15);
    expect(rate).toBeLessThan(0.25);
    expect(faultRoll('x', 1)).toBeGreaterThanOrEqual(0);
    expect(faultRoll('x', 1)).toBeLessThan(1);
  });
});

describe('fault control requests', () => {
  test('add assigns ids, rejects duplicates; remove and clear', () => {
    let rules: FaultRule[] = [];
    rules = applyFaultsRequest(
      rules,
      { action: 'add', rule: { vendor: 'samsara', kind: 'outage' } },
      () => 'gen-1',
    );
    expect(rules).toEqual([{ id: 'gen-1', vendor: 'samsara', kind: 'outage' }]);
    expect(() =>
      applyFaultsRequest(
        rules,
        { action: 'add', rule: { id: 'gen-1', vendor: '*', kind: 'latency' } },
        () => 'x',
      ),
    ).toThrow(FaultRequestError);
    rules = applyFaultsRequest(rules, { action: 'remove', id: 'gen-1' }, () => 'x');
    expect(rules).toEqual([]);
    rules = applyFaultsRequest(
      rules,
      { action: 'set', rules: [rule({ id: 'p', kind: 'latency', latencyMs: 5 })] },
      () => 'x',
    );
    expect(applyFaultsRequest(rules, { action: 'clear' }, () => 'x')).toEqual([]);
  });

  test('the wire schema rejects unknown kinds and fields', () => {
    expect(
      faultsControlRequestSchema.safeParse({
        action: 'add',
        rule: { vendor: 'samsara', kind: 'meteor' },
      }).success,
    ).toBe(false);
    expect(
      faultsControlRequestSchema.safeParse({
        action: 'add',
        rule: { vendor: 'samsara', kind: 'outage', bogus: 1 },
      }).success,
    ).toBe(false);
    expect(
      faultsControlRequestSchema.safeParse({
        action: 'add',
        rule: { vendor: 'samsara', kind: 'outage', label: 'trucks API down' },
      }).success,
    ).toBe(true);
  });
});

describe('scenario schedules', () => {
  test('zonedInstant finds local clock times in America/Detroit (EDT and EST)', () => {
    expect(zonedInstant(new Date('2026-10-15T11:00:00Z'), 6).toISOString()).toBe(
      '2026-10-15T10:00:00.000Z',
    );
    expect(zonedInstant(new Date('2026-12-15T15:00:00Z'), 6, 30).toISOString()).toBe(
      '2026-12-15T11:30:00.000Z',
    );
    // Late evening UTC that is still the previous local day.
    expect(zonedInstant(new Date('2026-10-16T02:00:00Z'), 6).toISOString()).toBe(
      '2026-10-15T10:00:00.000Z',
    );
  });

  test('bad-morning has an internet outage from 6:00 to 6:45 local sim time', () => {
    const rules = scenarioFaultRules('bad-morning', new Date('2026-10-15T09:30:00Z'));
    const outage = rules.find((r) => r.kind === 'outage');
    expect(outage).toMatchObject({
      vendor: '*',
      simFrom: '2026-10-15T10:00:00.000Z',
      simUntil: '2026-10-15T10:45:00.000Z',
    });
    expect(rules.every((r) => r.id.startsWith('scenario:'))).toBe(true);
    expect(scenarioFaultRules('harvest-day', new Date())).toEqual([]);
    expect(scenarioFaultRules('breakdown', new Date()).length).toBeGreaterThan(0);
  });
});
