/**
 * The two sync models (1f.2): cursor/version feeds page from the stored token; snapshot-diff
 * polling emits only the vehicles whose version moved, per vehicle, and its cursor survives a
 * round trip through sync_state.cursor.
 */
import { describe, expect, test } from 'vitest';
import {
  fingerprint,
  parseSnapshotCursor,
  pollSnapshotDiff,
  pollVersionFeed,
  type VersionFeedPage,
} from './sync-models';

describe('pollVersionFeed (Samsara endCursor, Geotab toVersion)', () => {
  test('pages from the stored token while the vendor says there is more', async () => {
    const seen: (string | null)[] = [];
    const pages: Record<string, VersionFeedPage<number>> = {
      start: { items: [1, 2], next: 'v2', hasMore: true },
      v2: { items: [3], next: 'v3', hasMore: true },
      v3: { items: [], next: 'v3', hasMore: false },
    };
    const r = await pollVersionFeed({
      cursor: 'start',
      fetchPage: async (token) => {
        seen.push(token);
        return pages[token ?? ''] as VersionFeedPage<number>;
      },
    });
    expect(seen).toEqual(['start', 'v2', 'v3']);
    expect(r).toEqual({ items: [1, 2, 3], cursor: 'v3', hasMore: false });
  });

  test('a page budget leaves the rest for the next run; an empty token keeps the old one', async () => {
    let n = 0;
    const r = await pollVersionFeed({
      cursor: null,
      maxPages: 2,
      fetchPage: async () => ({ items: [n], next: `v${++n}`, hasMore: true }),
    });
    expect(r).toEqual({ items: [0, 1], cursor: 'v2', hasMore: true });
    const same = await pollVersionFeed({
      cursor: 'v9',
      fetchPage: async () => ({ items: [], next: '', hasMore: false }),
    });
    expect(same.cursor).toBe('v9');
  });

  test('a vendor that says "more" without moving its token stops (no endless loop)', async () => {
    let calls = 0;
    const r = await pollVersionFeed({
      cursor: 'v1',
      fetchPage: async () => {
        calls++;
        return { items: [calls], next: 'v1', hasMore: true };
      },
    });
    expect(calls).toBe(1);
    expect(r.cursor).toBe('v1');
  });

  test('stops at the deadline', async () => {
    let t = 0;
    let calls = 0;
    await pollVersionFeed({
      cursor: null,
      deadline: new Date(10),
      now: () => new Date(t),
      fetchPage: async () => {
        calls++;
        t += 6;
        return { items: [], next: `v${calls}`, hasMore: true };
      },
    });
    expect(calls).toBe(2);
  });
});

describe('pollSnapshotDiff (Motive lists, AEMP pages, per-vehicle calls)', () => {
  type V = { id: string; at: number; lat: number };
  const snap = (vs: V[]) => async () => vs;

  test('first poll emits everything; then only vehicles whose version moved', async () => {
    const a = { id: 'a', at: 100, lat: 1 };
    const b = { id: 'b', at: 100, lat: 2 };
    const first = await pollSnapshotDiff({
      cursor: null,
      fetchSnapshot: snap([a, b]),
      keyOf: (v) => v.id,
      versionOf: (v) => JSON.stringify([v.at, v.lat]),
    });
    expect(first.items.map((v) => v.id)).toEqual(['a', 'b']);
    const again = await pollSnapshotDiff({
      cursor: first.cursor,
      fetchSnapshot: snap([a, { ...b, lat: 3 }]),
      keyOf: (v) => v.id,
      versionOf: (v) => JSON.stringify([v.at, v.lat]),
    });
    expect(again.items.map((v) => v.id)).toEqual(['b']);
    const quiet = await pollSnapshotDiff({
      cursor: again.cursor,
      fetchSnapshot: snap([a, { ...b, lat: 3 }]),
      keyOf: (v) => v.id,
      versionOf: (v) => JSON.stringify([v.at, v.lat]),
    });
    expect(quiet.items).toEqual([]);
    expect(quiet.cursor).toBe(again.cursor);
  });

  test("'newer': per-vehicle watermarks; an older reading never comes back; gone keys are kept", async () => {
    const opts = { keyOf: (v: V) => v.id, versionOf: (v: V) => v.at, mode: 'newer' as const };
    const r1 = await pollSnapshotDiff({
      ...opts,
      cursor: null,
      fetchSnapshot: snap([
        { id: 'a', at: 200, lat: 0 },
        { id: 'b', at: 100, lat: 0 },
      ]),
    });
    const r2 = await pollSnapshotDiff({
      ...opts,
      cursor: r1.cursor,
      // a reports an older reading (out of order); b is newer; c is new; nothing for d.
      fetchSnapshot: snap([
        { id: 'a', at: 150, lat: 0 },
        { id: 'b', at: 110, lat: 0 },
        { id: 'c', at: 50, lat: 0 },
      ]),
    });
    expect(r2.items.map((v) => v.id)).toEqual(['b', 'c']);
    expect(parseSnapshotCursor(r2.cursor).seen).toMatchObject({ a: '200', b: '110', c: '50' });
    const r3 = await pollSnapshotDiff({ ...opts, cursor: r2.cursor, fetchSnapshot: snap([]) });
    expect(r3.gone.sort()).toEqual(['a', 'b', 'c']);
    expect(parseSnapshotCursor(r3.cursor).seen).toMatchObject({ a: '200' });
    // A reading without a time is skipped, never emitted twice.
    const r4 = await pollSnapshotDiff({
      ...opts,
      cursor: r3.cursor,
      fetchSnapshot: snap([{ id: 'z', at: Number.NaN, lat: 0 }]),
    });
    expect(r4.items).toEqual([]);
  });

  test('the cursor keeps at most maxKeys, dropping the least recently changed', async () => {
    const r = await pollSnapshotDiff({
      cursor: null,
      maxKeys: 2,
      fetchSnapshot: snap([
        { id: 'a', at: 1, lat: 0 },
        { id: 'b', at: 1, lat: 0 },
        { id: 'c', at: 1, lat: 0 },
      ]),
      keyOf: (v) => v.id,
      versionOf: (v) => v.at,
    });
    expect(Object.keys(parseSnapshotCursor(r.cursor).seen)).toEqual(['b', 'c']);
  });

  test('a foreign or broken cursor starts over; fingerprints are short and stable', () => {
    expect(parseSnapshotCursor('{"a":"2026-10-15T00:00:00Z"}').seen).toEqual({});
    expect(parseSnapshotCursor('not json').seen).toEqual({});
    expect(parseSnapshotCursor(null).seen).toEqual({});
    expect(fingerprint('x')).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint('x')).toBe(fingerprint('x'));
    expect(fingerprint('x')).not.toBe(fingerprint('y'));
  });
});
