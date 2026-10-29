/**
 * Planar geometry in metres (EPSG:3078 coordinates): vectors, polylines with arc-length
 * lookup, point-in-polygon, convex clipping. Headings here are GRID headings (degrees
 * clockwise from the projection's +y axis); src/sim/geo/lnglat.ts turns them into true headings.
 */

export interface Vec {
  x: number;
  y: number;
}

export const vec = (x: number, y: number): Vec => ({ x, y });
export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec, b: Vec): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: Vec, b: Vec, t: number): Vec => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});
/** a + d * k */
export const along = (a: Vec, d: Vec, k: number): Vec => ({ x: a.x + d.x * k, y: a.y + d.y * k });

export function norm(a: Vec): Vec {
  const l = len(a);
  if (l === 0) throw new RangeError('norm of a zero vector');
  return { x: a.x / l, y: a.y / l };
}

/** Left-hand normal (rotate +90 degrees). */
export const perpLeft = (a: Vec): Vec => ({ x: -a.y, y: a.x });

/** Grid heading of a direction: degrees clockwise from +y, in [0, 360). */
export function headingOf(d: Vec): number {
  const h = (Math.atan2(d.x, d.y) * 180) / Math.PI;
  return h < 0 ? h + 360 : h;
}

/** Unit direction of a grid heading. */
export function dirOf(headingDeg: number): Vec {
  const r = (headingDeg * Math.PI) / 180;
  return { x: Math.sin(r), y: Math.cos(r) };
}

/** Shortest signed difference b - a in degrees, in (-180, 180]. */
export function angleDiff(a: number, b: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

export function wrap360(h: number): number {
  const r = h % 360;
  return r < 0 ? r + 360 : r;
}

/** Distance from p to segment ab. */
export function distToSegment(p: Vec, a: Vec, b: Vec): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 === 0) return dist(p, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  return dist(p, along(a, ab, t));
}

/** Ray casting; `ring` without the closing point. Points on an edge may go either way. */
export function pointInPolygon(p: Vec, ring: readonly Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as Vec;
    const b = ring[j] as Vec;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Signed distance to the ring's boundary: negative inside, positive outside. */
export function signedDistanceToRing(p: Vec, ring: readonly Vec[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as Vec;
    const b = ring[(i + 1) % ring.length] as Vec;
    best = Math.min(best, distToSegment(p, a, b));
  }
  return pointInPolygon(p, ring) ? -best : best;
}

/** Twice the signed area (positive = counter-clockwise). */
export function ringArea2(ring: readonly Vec[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as Vec;
    const b = ring[(i + 1) % ring.length] as Vec;
    s += a.x * b.y - b.x * a.y;
  }
  return s;
}

/**
 * Clip the line p0 + d*t against a CONVEX ring (Cyrus-Beck). Returns the [tMin, tMax] interval
 * inside the polygon, or null when the line misses it.
 */
export function clipLineConvex(p0: Vec, d: Vec, ring: readonly Vec[]): [number, number] | null {
  const ccw = ringArea2(ring) > 0;
  let tMin = Number.NEGATIVE_INFINITY;
  let tMax = Number.POSITIVE_INFINITY;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as Vec;
    const b = ring[(i + 1) % ring.length] as Vec;
    const edge = sub(b, a);
    // Inward normal of the edge.
    const n = ccw ? perpLeft(edge) : { x: edge.y, y: -edge.x };
    const denom = dot(n, d);
    const num = dot(n, sub(p0, a));
    if (denom === 0) {
      if (num < 0) return null; // parallel and outside
      continue;
    }
    const t = -num / denom;
    if (denom > 0) tMin = Math.max(tMin, t);
    else tMax = Math.min(tMax, t);
    if (tMin > tMax) return null;
  }
  return Number.isFinite(tMin) && Number.isFinite(tMax) ? [tMin, tMax] : null;
}

/** A polyline with cumulative arc length, for "where is s metres along" lookups. */
export class Path {
  readonly pts: readonly Vec[];
  readonly cum: Float64Array;
  readonly length: number;

  constructor(points: readonly Vec[]) {
    // Drop consecutive duplicates so every segment has a direction.
    const pts: Vec[] = [];
    for (const p of points) {
      const last = pts[pts.length - 1];
      if (!last || dist(last, p) > 1e-6) pts.push(p);
    }
    if (!pts.length) throw new RangeError('Path needs at least one point');
    this.pts = pts;
    this.cum = new Float64Array(pts.length);
    for (let i = 1; i < pts.length; i++) {
      this.cum[i] = (this.cum[i - 1] as number) + dist(pts[i - 1] as Vec, pts[i] as Vec);
    }
    this.length = this.cum[pts.length - 1] as number;
  }

  get start(): Vec {
    return this.pts[0] as Vec;
  }

  get end(): Vec {
    return this.pts[this.pts.length - 1] as Vec;
  }

  /** Index i of the segment [pts[i], pts[i+1]] containing arc length s (clamped). */
  segmentIndex(s: number): number {
    const n = this.pts.length;
    if (n < 2 || s <= 0) return 0;
    if (s >= this.length) return n - 2;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((this.cum[mid] as number) <= s) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  at(s: number): Vec {
    if (this.pts.length < 2) return this.start;
    const i = this.segmentIndex(s);
    const a = this.pts[i] as Vec;
    const b = this.pts[i + 1] as Vec;
    const s0 = this.cum[i] as number;
    const segLen = (this.cum[i + 1] as number) - s0;
    const t = segLen > 0 ? Math.max(0, Math.min(1, (s - s0) / segLen)) : 0;
    return lerp(a, b, t);
  }

  /** Grid heading of the segment at s (the last segment's at the end). */
  headingAt(s: number): number {
    if (this.pts.length < 2) return 0;
    const i = this.segmentIndex(s);
    return headingOf(sub(this.pts[i + 1] as Vec, this.pts[i] as Vec));
  }

  /** Arc lengths of the interior vertices strictly between s0 and s1 (s0 < s1). O(log n + k). */
  verticesBetween(s0: number, s1: number): number[] {
    const out: number[] = [];
    if (this.pts.length < 3 || s1 <= s0) return out;
    for (let i = Math.max(1, this.segmentIndex(s0)); i < this.pts.length - 1; i++) {
      const c = this.cum[i] as number;
      if (c >= s1) break;
      if (c > s0) out.push(c);
    }
    return out;
  }
}
