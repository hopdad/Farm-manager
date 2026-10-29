import { describe, expect, test } from 'vitest';
import { retryAfterFrom, SyncStepError, type SyncStepResult, syncStepJobResult } from './types';

const base: SyncStepResult = {
  claimed: true,
  ok: true,
  landed: 3,
  processed: 3,
  dead: 0,
  cursor: 'c2',
};

describe('syncStepJobResult', () => {
  test('skipped runs become a zero-item note', () => {
    expect(
      syncStepJobResult({ ...base, claimed: false, skipped: 'off', landed: 0, processed: 0 }),
    ).toEqual({ items: 0, note: 'off' });
    expect(
      syncStepJobResult({
        ...base,
        claimed: false,
        skipped: 'lease held elsewhere',
        processed: 0,
      }),
    ).toEqual({ items: 0, note: 'lease held elsewhere' });
  });

  test('a successful run reports processed items and dead letters', () => {
    expect(syncStepJobResult(base)).toEqual({ items: 3 });
    expect(syncStepJobResult({ ...base, processed: 5, dead: 2 })).toEqual({
      items: 5,
      note: '2 dead-lettered',
    });
  });

  test('a failed run throws SyncStepError carrying the result', () => {
    const failed: SyncStepResult = { ...base, ok: false, error: 'samsara 503', landed: 0 };
    expect(() => syncStepJobResult(failed)).toThrow(SyncStepError);
    try {
      syncStepJobResult(failed);
    } catch (e) {
      expect((e as SyncStepError).message).toBe('samsara 503');
      expect((e as SyncStepError).result).toBe(failed);
    }
  });
});

describe('retryAfterFrom', () => {
  const now = new Date('2026-10-29T12:00:00.000Z');

  test('uses a numeric retryAfterSeconds on the error', () => {
    const err = Object.assign(new Error('429'), { retryAfterSeconds: 30 });
    expect(retryAfterFrom(err, now)?.toISOString()).toBe('2026-10-29T12:00:30.000Z');
    expect(retryAfterFrom({ retryAfterSeconds: 1.2 }, now)?.toISOString()).toBe(
      '2026-10-29T12:00:02.000Z',
    );
  });

  test('anything else means no delay (null)', () => {
    expect(retryAfterFrom(new Error('boom'), now)).toBeNull();
    expect(retryAfterFrom({ retryAfterSeconds: '30' }, now)).toBeNull();
    expect(retryAfterFrom({ retryAfterSeconds: 0 }, now)).toBeNull();
    expect(retryAfterFrom({ retryAfterSeconds: Number.NaN }, now)).toBeNull();
    expect(retryAfterFrom(null, now)).toBeNull();
    expect(retryAfterFrom(undefined, now)).toBeNull();
  });
});
