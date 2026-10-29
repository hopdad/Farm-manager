import { describe, expect, test } from 'vitest';
import {
  deriveVisits,
  emptyVisitState,
  type FixInside,
  type GeofenceVisit,
  isNoChange,
  planVisitChanges,
  type StoredVisit,
  stepVisits,
  VISIT_MAX_GAP_SECONDS,
} from './geofence';

const MIN = 60_000;
const GAP = VISIT_MAX_GAP_SECONDS * 1000;
/** Fix at minute `m` inside the listed geofences. */
const at = (m: number, ...inside: string[]): FixInside => ({ ts: m * MIN, inside });
const visit = (geofenceId: string, inMin: number, outMin: number | null): GeofenceVisit => ({
  geofenceId,
  enteredAt: inMin * MIN,
  exitedAt: outMin === null ? null : outMin * MIN,
});

describe('deriveVisits', () => {
  test('enter at the first fix inside, exit at the first fix outside', () => {
    expect(deriveVisits([at(0), at(1, 'elev'), at(2, 'elev'), at(3), at(4)])).toEqual([
      visit('elev', 1, 3),
    ]);
  });

  test('still inside at the newest fix: the visit stays open', () => {
    expect(deriveVisits([at(0), at(1, 'shop'), at(2, 'shop')])).toEqual([visit('shop', 1, null)]);
  });

  test('the first fix ever may already be inside', () => {
    expect(deriveVisits([at(5, 'shop'), at(6)])).toEqual([visit('shop', 5, 6)]);
  });

  test('overlapping geofences are visited independently', () => {
    expect(deriveVisits([at(0, 'bins'), at(1, 'bins', 'shop'), at(2, 'shop'), at(3)])).toEqual([
      visit('bins', 0, 2),
      visit('shop', 1, 3),
    ]);
  });

  test('re-entering makes a second visit', () => {
    expect(deriveVisits([at(0, 'e'), at(1), at(2, 'e'), at(3, 'e')])).toEqual([
      visit('e', 0, 1),
      visit('e', 2, null),
    ]);
  });

  test('a gap longer than the limit closes the visit at the last fix inside', () => {
    const late = VISIT_MAX_GAP_SECONDS / 60 + 10;
    expect(deriveVisits([at(0, 'e'), at(1, 'e'), at(1 + late, 'e')])).toEqual([
      visit('e', 0, 1),
      visit('e', 1 + late, null),
    ]);
    // exactly at the limit is still continuous
    const limit = VISIT_MAX_GAP_SECONDS / 60;
    expect(deriveVisits([at(0, 'e'), at(limit, 'e')])).toEqual([visit('e', 0, null)]);
  });

  test('a single fix inside followed by a gap is a visit of zero length', () => {
    expect(deriveVisits([at(0, 'e'), at(100)])).toEqual([visit('e', 0, 0)]);
  });

  test('a custom gap limit', () => {
    expect(deriveVisits([at(0, 'e'), at(3, 'e')], 2 * MIN)).toEqual([
      visit('e', 0, 0),
      visit('e', 3, null),
    ]);
  });

  test('no fixes, no visits; fixes outside everything, no visits', () => {
    expect(deriveVisits([])).toEqual([]);
    expect(deriveVisits([at(0), at(1)])).toEqual([]);
  });

  test('results are sorted by entered_at then geofence', () => {
    const v = deriveVisits([at(0, 'b', 'a'), at(1)]);
    expect(v.map((x) => x.geofenceId)).toEqual(['a', 'b']);
  });
});

describe('stepVisits', () => {
  test('one step at a time equals the fold', () => {
    const fixes = [at(0), at(1, 'x'), at(2, 'x', 'y'), at(3, 'y'), at(4)];
    const state = emptyVisitState();
    const closed: GeofenceVisit[] = [];
    const opened: string[] = [];
    for (const f of fixes) {
      const r = stepVisits(state, f);
      closed.push(...r.closed);
      opened.push(...r.opened);
    }
    expect(opened).toEqual(['x', 'y']);
    expect(closed).toEqual(deriveVisits(fixes));
    expect(state.open.size).toBe(0);
    expect(state.lastTs).toBe(4 * MIN);
  });

  test('refuses fixes out of order (the job recomputes instead)', () => {
    const state = emptyVisitState();
    stepVisits(state, at(5, 'x'));
    expect(() => stepVisits(state, at(5))).toThrow(RangeError);
    expect(() => stepVisits(state, at(4))).toThrow(RangeError);
  });

  test('a gap closes at the last fix and reopens at the new one when still inside', () => {
    const state = emptyVisitState();
    stepVisits(state, at(0, 'x'));
    const r = stepVisits(state, { ts: GAP + MIN, inside: ['x'] });
    expect(r.closed).toEqual([visit('x', 0, 0)]);
    expect(r.opened).toEqual(['x']);
  });
});

describe('out-of-order fixes: recomputation gives what in-order processing would', () => {
  const ordered = [at(0), at(1, 'e'), at(2, 'e'), at(3), at(4, 'e'), at(5)];

  test('any arrival order, once sorted, derives the same visits', () => {
    const expected = deriveVisits(ordered);
    const shuffled = [ordered[3], ordered[0], ordered[5], ordered[1], ordered[4], ordered[2]];
    const sorted = [...(shuffled as FixInside[])].sort((a, b) => a.ts - b.ts);
    expect(deriveVisits(sorted)).toEqual(expected);
  });

  test('a late fix outside splits a visit; a late fix inside bridges two', () => {
    const base = [at(0, 'e'), at(2, 'e'), at(4)];
    expect(deriveVisits(base)).toEqual([visit('e', 0, 4)]);
    const split = [at(0, 'e'), at(1), at(2, 'e'), at(4)];
    expect(deriveVisits(split)).toEqual([visit('e', 0, 1), visit('e', 2, 4)]);
    const gappy = [at(0, 'e'), at(1), at(2, 'e'), at(3)];
    const bridged = [at(0, 'e'), at(1, 'e'), at(2, 'e'), at(3)];
    expect(deriveVisits(gappy)).toHaveLength(2);
    expect(deriveVisits(bridged)).toEqual([visit('e', 0, 3)]);
  });
});

describe('planVisitChanges', () => {
  const s = (id: string, g: string, i: number, o: number | null): StoredVisit => ({
    id,
    ...visit(g, i, o),
  });

  test('identical sets change nothing (ids kept)', () => {
    const stored = [s('1', 'e', 0, 3), s('2', 'e', 5, null)];
    const plan = planVisitChanges(stored, [visit('e', 0, 3), visit('e', 5, null)]);
    expect(isNoChange(plan)).toBe(true);
  });

  test('closes, reopens, deletes and inserts by (geofence, entered_at)', () => {
    const stored = [s('a', 'e', 0, null), s('b', 'x', 1, 2), s('c', 'y', 4, 9), s('d', 'z', 7, 8)];
    const derived = [visit('e', 0, 3), visit('x', 1, 2), visit('y', 4, null), visit('w', 5, null)];
    expect(planVisitChanges(stored, derived)).toEqual({
      deletes: ['d'],
      closes: [{ id: 'a', exitedAt: 3 * MIN }],
      reopens: ['c'],
      inserts: [visit('w', 5, null)],
    });
  });

  test('a duplicate stored key is deleted (the table forbids it; be safe anyway)', () => {
    const plan = planVisitChanges([s('a', 'e', 0, 1), s('b', 'e', 0, 1)], [visit('e', 0, 1)]);
    expect(plan.deletes).toEqual(['b']);
    expect(plan.inserts).toEqual([]);
  });
});
