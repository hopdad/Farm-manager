/**
 * Back-and-forth passes at implement width over a convex field, in EPSG:3078 metres (plan §5:
 * "passes at implement width (turf, EPSG:3078), clipped to the boundary").
 *
 * Passes run along the field's long axis (perpendicular to the entrance side when the field is
 * square), start on the entrance side, and are spaced one implement width apart with the
 * implement's edge on the boundary. Pass ends stop `width / 2 + END_MARGIN_M` short of the
 * boundary so the U-turn between passes (a half circle of the implement's width) stays inside.
 * The result is one Path: pass, turn, pass, turn, ... with arc-length ranges per piece.
 */
import {
  add,
  along,
  clipLineConvex,
  cross,
  dist,
  dot,
  norm,
  Path,
  perpLeft,
  scale,
  sub,
  type Vec,
} from '../geo/vec';

const END_MARGIN_M = 1.5;
const TURN_STEPS = 10;

export interface CoveragePiece {
  kind: 'pass' | 'turn';
  /** Pass index (for a turn: the pass it follows). */
  pass: number;
  s0: number;
  s1: number;
}

export interface CoveragePass {
  a: Vec;
  b: Vec;
  /** Unit normal pointing to the side already worked (into the field for the first pass). */
  workedSide: Vec;
}

export interface Coverage {
  widthM: number;
  passes: CoveragePass[];
  pieces: CoveragePiece[];
  path: Path;
  /** Sum of pass lengths (worked area = passLengthM * widthM). */
  passLengthM: number;
}

function longestEdge(ring: readonly Vec[]): { dir: Vec; length: number; second: number } {
  const lengths = ring.map((p, i) => dist(p, ring[(i + 1) % ring.length] as Vec));
  let best = 0;
  for (let i = 1; i < lengths.length; i++)
    if ((lengths[i] as number) > (lengths[best] as number)) best = i;
  const a = ring[best] as Vec;
  const b = ring[(best + 1) % ring.length] as Vec;
  const sorted = [...lengths].sort((x, y) => y - x);
  return {
    dir: norm(sub(b, a)),
    length: sorted[0] as number,
    second: sorted[2] ?? (sorted[1] as number),
  };
}

/** Plan coverage of `ring` (convex, EPSG:3078) for an implement `widthM` wide. */
export function planCoverage(ring: readonly Vec[], entrance: Vec, widthM: number): Coverage {
  if (ring.length < 3) throw new RangeError('coverage needs a polygon');
  if (!(widthM > 0)) throw new RangeError('implement width must be positive');
  // Pass direction: the long axis, or perpendicular to the entrance side for square fields.
  const edge = longestEdge(ring);
  let d = edge.dir;
  if (edge.length / edge.second < 1.25) {
    let nearest = 0;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i] as Vec;
      const b = ring[(i + 1) % ring.length] as Vec;
      const ab = sub(b, a);
      const t = Math.max(0, Math.min(1, dot(sub(entrance, a), ab) / dot(ab, ab)));
      const dd = dist(entrance, along(a, ab, t));
      if (dd < best) {
        best = dd;
        nearest = i;
      }
    }
    const a = ring[nearest] as Vec;
    const b = ring[(nearest + 1) % ring.length] as Vec;
    d = perpLeft(norm(sub(b, a)));
  }
  const o = perpLeft(d);
  const offs = ring.map((p) => dot(p, o));
  const oMin = Math.min(...offs);
  const oMax = Math.max(...offs);
  const offsets: number[] = [];
  for (let c = oMin + widthM / 2; c <= oMax - widthM / 2 + 1e-9; c += widthM) offsets.push(c);
  const lastOff = offsets[offsets.length - 1];
  if (lastOff === undefined) offsets.push((oMin + oMax) / 2);
  else if (oMax - widthM / 2 - lastOff > widthM * 0.25) offsets.push(oMax - widthM / 2);
  // Start on the entrance side.
  const eOff = dot(entrance, o);
  if (Math.abs(eOff - oMax) < Math.abs(eOff - oMin)) offsets.reverse();
  const progression =
    offsets.length > 1 ? Math.sign((offsets[1] as number) - (offsets[0] as number)) : 1;

  const endInset = widthM / 2 + END_MARGIN_M;
  const passes: CoveragePass[] = [];
  let forward = true;
  for (const c of offsets) {
    const p0 = scale(o, c);
    const clip = clipLineConvex(p0, d, ring);
    if (!clip) continue;
    const t0 = clip[0] + endInset;
    const t1 = clip[1] - endInset;
    if (t1 - t0 < 5) continue;
    let a = along(p0, d, t0);
    let b = along(p0, d, t1);
    if (!passes.length) {
      // The first pass starts at the end nearest the entrance.
      forward = dist(entrance, a) <= dist(entrance, b);
    }
    if (!forward) [a, b] = [b, a];
    const workedSide = passes.length ? scale(o, -progression) : scale(o, progression);
    passes.push({ a, b, workedSide });
    forward = !forward;
  }
  if (!passes.length) throw new Error('field too small for this implement');

  // Assemble the path with exact arc lengths per piece.
  const pts: Vec[] = [];
  const pieces: CoveragePiece[] = [];
  let s = 0;
  const pushPoint = (p: Vec) => {
    const last = pts[pts.length - 1];
    if (last) s += dist(last, p);
    if (!last || dist(last, p) > 1e-9) pts.push(p);
  };
  let passLengthM = 0;
  passes.forEach((ps, k) => {
    const sStart = s;
    pushPoint(ps.a);
    pushPoint(ps.b);
    pieces.push({ kind: 'pass', pass: k, s0: sStart, s1: s });
    passLengthM += dist(ps.a, ps.b);
    const next = passes[k + 1];
    if (!next) return;
    const tStart = s;
    for (const p of turnPoints(ps.b, norm(sub(ps.b, ps.a)), next.a)) pushPoint(p);
    pieces.push({ kind: 'turn', pass: k, s0: tStart, s1: s });
  });
  return { widthM, passes, pieces, path: new Path(pts), passLengthM };
}

/** U-turn from `e` (travelling along `dir`) to `s` (next pass start, travelling back). */
function turnPoints(e: Vec, dir: Vec, s: Vec): Vec[] {
  const delta = dot(sub(s, e), dir);
  const e2 = add(e, scale(dir, Math.max(delta, 0)));
  const s2 = add(s, scale(dir, Math.max(-delta, 0)));
  const c = scale(add(e2, s2), 0.5);
  const r = dist(e2, s2) / 2;
  const v0 = sub(e2, c);
  const out: Vec[] = [e2];
  if (r > 1e-6) {
    // Rotate v0 through 180 degrees on the side of `dir` (bulging beyond the pass ends).
    const sign = cross(v0, dir) >= 0 ? 1 : -1;
    for (let k = 1; k <= TURN_STEPS; k++) {
      const th = (sign * Math.PI * k) / TURN_STEPS;
      const cs = Math.cos(th);
      const sn = Math.sin(th);
      out.push(add(c, { x: v0.x * cs - v0.y * sn, y: v0.x * sn + v0.y * cs }));
    }
  }
  out.push(s2, s);
  return out;
}

/** The piece containing arc length s (the last one at the end). */
export function pieceAt(cov: Coverage, s: number): CoveragePiece {
  const ps = cov.pieces;
  let lo = 0;
  let hi = ps.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((ps[mid] as CoveragePiece).s0 <= s) lo = mid;
    else hi = mid - 1;
  }
  const p = ps[lo] as CoveragePiece;
  // At an exact boundary prefer the piece that starts there.
  return p;
}

/** Worked area (m^2) of the passes between arc lengths s0 and s1. */
export function workedArea(cov: Coverage, s0: number, s1: number): number {
  let m = 0;
  for (const p of cov.pieces) {
    if (p.kind !== 'pass') continue;
    const a = Math.max(s0, p.s0);
    const b = Math.min(s1, p.s1);
    if (b > a) m += b - a;
  }
  return m * cov.widthM;
}

/** The pass segments (centrelines) worked between s0 and s1, for checks and reports. */
export function workedSegments(cov: Coverage, s0: number, s1: number): [Vec, Vec][] {
  const out: [Vec, Vec][] = [];
  for (const p of cov.pieces) {
    if (p.kind !== 'pass') continue;
    const a = Math.max(s0, p.s0);
    const b = Math.min(s1, p.s1);
    if (b > a) out.push([cov.path.at(a), cov.path.at(b)]);
  }
  return out;
}
