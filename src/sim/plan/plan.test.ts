import { describe, expect, test } from 'vitest';
import { dist, dot, pointInPolygon, signedDistanceToRing, sub, vec } from '../geo/vec';
import { pieceAt, planCoverage, workedArea, workedSegments } from './coverage';
import { Track, TrackRecorder } from './track';

// An 800 m x 400 m field (a half-quarter), entrance in the middle of the long south side.
const ring = [vec(0, 0), vec(800, 0), vec(800, 400), vec(0, 400)];
const entrance = vec(400, -15);

describe('coverage planning', () => {
  const w = 12.19; // 40 ft
  const cov = planCoverage(ring, entrance, w);

  test('passes run the long axis, one width apart, starting at the entrance side', () => {
    const first = cov.passes[0];
    const second = cov.passes[1];
    if (!first || !second) throw new Error('no passes');
    const dir = sub(first.b, first.a);
    expect(Math.abs(dir.y)).toBeLessThan(1e-6); // east-west
    expect(first.a.y).toBeCloseTo(w / 2, 6); // edge of the header on the boundary
    expect(second.a.y - first.a.y).toBeCloseTo(w, 6);
    // Alternating direction.
    expect(dot(sub(first.b, first.a), sub(second.b, second.a))).toBeLessThan(0);
    expect(cov.passes.length).toBe(Math.ceil(400 / w));
  });

  test('every pass and its swath stay inside the field; turns too', () => {
    for (const p of cov.passes) {
      for (const q of [p.a, p.b]) {
        expect(signedDistanceToRing(q, ring)).toBeLessThan(-w / 2 + 1e-6);
      }
    }
    for (const q of cov.path.pts) expect(pointInPolygon(q, ring)).toBe(true);
  });

  test('worked side points at the passes already done (into the field for the first)', () => {
    expect(cov.passes[0]?.workedSide.y).toBeCloseTo(1);
    expect(cov.passes[1]?.workedSide.y).toBeCloseTo(-1);
  });

  test('pieces tile the path; worked area is about the field area', () => {
    let s = 0;
    for (const p of cov.pieces) {
      expect(p.s0).toBeCloseTo(s, 6);
      expect(p.s1).toBeGreaterThan(p.s0);
      s = p.s1;
    }
    expect(s).toBeCloseTo(cov.path.length, 3);
    const area = workedArea(cov, 0, cov.path.length);
    // Headlands (the turn strips at both ends) are not counted.
    expect(area / (800 * 400)).toBeGreaterThan(0.95);
    expect(area / (800 * 400)).toBeLessThanOrEqual(1.02);
    expect(pieceAt(cov, 0).kind).toBe('pass');
    expect(pieceAt(cov, (cov.pieces[0]?.s1 ?? 0) + 1).kind).toBe('turn');
    expect(workedSegments(cov, 0, (cov.pieces[0]?.s1 ?? 0) / 2)).toHaveLength(1);
  });

  test('square fields run perpendicular to the entrance side', () => {
    const sq = [vec(0, 0), vec(800, 0), vec(800, 800), vec(0, 800)];
    const c = planCoverage(sq, vec(-15, 400), w); // entrance on the west side
    const p = c.passes[0];
    if (!p) throw new Error('no pass');
    expect(Math.abs(p.b.y - p.a.y)).toBeLessThan(1e-6); // east-west passes
    expect(dist(p.a, vec(-15, 400))).toBeLessThan(dist(p.b, vec(-15, 400)));
    expect(() => planCoverage([vec(0, 0), vec(1, 0)], vec(0, 0), w)).toThrow();
  });
});

describe('track recorder', () => {
  const kf = (t: number, x: number, extra: Partial<Parameters<TrackRecorder['push']>[0]> = {}) => ({
    t,
    x,
    y: 0,
    hdg: 90,
    speedMph: 10,
    act: 'transport' as const,
    engineOn: true,
    field: -1,
    engineHours: t / 3_600_000,
    odometerMi: x / 1609.344,
    fuelPct: 50,
    ...extra,
  });

  test('straight constant-speed motion compresses to its end points', () => {
    const rec = new TrackRecorder();
    for (let i = 0; i <= 100; i++) rec.push(kf(i * 1000, i * 4.47));
    const tr = rec.freeze();
    expect(tr.n).toBe(2);
    const s = tr.sample(50_500);
    expect(s.x).toBeCloseTo(50.5 * 4.47, 6);
    expect(s.engineHours).toBeCloseTo(50_500 / 3_600_000, 9);
  });

  test('a turn or a state change keeps a keyframe; sampling uses the left state', () => {
    const rec = new TrackRecorder();
    for (let i = 0; i <= 10; i++) rec.push(kf(i * 1000, i));
    rec.push(kf(10_000, 10, { act: 'idle', speedMph: 0 }));
    for (let i = 11; i <= 20; i++) rec.push(kf(i * 1000, 10, { act: 'idle', speedMph: 0 }));
    const tr = rec.freeze();
    expect(tr.n).toBe(4);
    expect(tr.sample(5000).act).toBe('transport');
    expect(tr.sample(10_000).act).toBe('idle');
    expect(tr.sample(15_000).x).toBe(10);
    expect(tr.sample(-5).x).toBe(0);
    expect(tr.sample(99_000).x).toBe(10);
  });

  test('headings interpolate the short way round', () => {
    const tr = Track.fromKeyframes([kf(0, 0, { hdg: 350 }), kf(1000, 1, { hdg: 10 })]);
    expect(tr.sample(500).hdg).toBeCloseTo(0, 6);
  });

  test('time must not go backwards', () => {
    const rec = new TrackRecorder();
    rec.push(kf(1000, 0));
    rec.push(kf(2000, 1));
    expect(() => rec.push(kf(500, 0))).toThrow(/order/);
  });
});
