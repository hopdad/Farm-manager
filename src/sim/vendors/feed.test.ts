import { describe, expect, test } from 'vitest';
import { decodeFeedCursor, encodeFeedCursor, feedWindow, seededShuffle } from './feed';

const base = { intervalMs: 5000, perPage: 10, maxCatchUpMs: 30 * 60_000 };

describe('feed windows', () => {
  test('no cursor: just the latest grid instant', () => {
    expect(feedWindow({ ...base, afterMs: null, nowMs: 1_000_003_000 })).toEqual({
      instants: [1_000_000_000],
      endMs: 1_000_000_000,
      hasNextPage: false,
    });
  });

  test('cursor: instants after it up to now, paged', () => {
    const w = feedWindow({ ...base, afterMs: 1_000_000_000, nowMs: 1_000_017_000 });
    expect(w).toEqual({
      instants: [1_000_005_000, 1_000_010_000, 1_000_015_000],
      endMs: 1_000_015_000,
      hasNextPage: false,
    });
    const big = feedWindow({ ...base, afterMs: 1_000_000_000, nowMs: 1_000_100_000 });
    expect(big.instants).toHaveLength(10);
    expect(big.hasNextPage).toBe(true);
    const next = feedWindow({ ...base, afterMs: big.endMs, nowMs: 1_000_100_000 });
    expect(next.instants[0]).toBe(big.endMs + 5000);
    expect(next.hasNextPage).toBe(false);
  });

  test('nothing new keeps the cursor; old cursors resume from the catch-up limit', () => {
    expect(feedWindow({ ...base, afterMs: 1_000_000_000, nowMs: 1_000_004_999 })).toEqual({
      instants: [],
      endMs: 1_000_000_000,
      hasNextPage: false,
    });
    const now = 2_000_000_000;
    const w = feedWindow({ ...base, perPage: 1000, afterMs: 0, nowMs: now });
    expect(w.instants[0]).toBeGreaterThanOrEqual(now - base.maxCatchUpMs);
    expect(w.instants).toHaveLength(360);
  });

  test('cursors round-trip; foreign cursors are rejected', () => {
    expect(decodeFeedCursor(encodeFeedCursor(1_793_240_325_000))).toBe(1_793_240_325_000);
    expect(decodeFeedCursor('garbage')).toBeNull();
    expect(decodeFeedCursor(Buffer.from('{"v":2,"t":1}').toString('base64url'))).toBeNull();
  });

  test('seededShuffle is deterministic and never the identity for >1 items', () => {
    const items = [1, 2, 3, 4, 5];
    expect(seededShuffle(items, 7)).toEqual(seededShuffle(items, 7));
    for (let s = 1; s < 50; s++) {
      const out = seededShuffle(items, s);
      expect([...out].sort()).toEqual(items);
      expect(out).not.toEqual(items);
    }
    expect(seededShuffle([1], 3)).toEqual([1]);
  });
});
