/**
 * Clipping in tile pixel space for the synthetic basemap: polylines (Liang–Barsky per segment,
 * consecutive pieces joined) and polygon rings (Sutherland–Hodgman). Pure.
 */
export type Pt = readonly [number, number];

export interface ClipBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Clip one segment; null when it lies outside. */
function clipSegment(a: Pt, b: Pt, box: ClipBox): [Pt, Pt] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const checks: [number, number][] = [
    [-dx, a[0] - box.minX],
    [dx, box.maxX - a[0]],
    [-dy, a[1] - box.minY],
    [dy, box.maxY - a[1]],
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return [
    [a[0] + t0 * dx, a[1] + t0 * dy],
    [a[0] + t1 * dx, a[1] + t1 * dy],
  ];
}

const same = (p: Pt, q: Pt) => Math.abs(p[0] - q[0]) < 1e-9 && Math.abs(p[1] - q[1]) < 1e-9;

/** Clip a polyline to the box: zero or more pieces. */
export function clipLine(line: readonly Pt[], box: ClipBox): Pt[][] {
  const pieces: Pt[][] = [];
  let current: Pt[] | null = null;
  for (let i = 1; i < line.length; i++) {
    const seg = clipSegment(line[i - 1] as Pt, line[i] as Pt, box);
    if (!seg) {
      current = null;
      continue;
    }
    const [p, q] = seg;
    const last = current?.[current.length - 1];
    if (current && last && same(last, p)) {
      current.push(q);
    } else {
      current = [p, q];
      pieces.push(current);
    }
    // The segment left the box: the next one starts a new piece.
    if (!same(q, line[i] as Pt)) current = null;
  }
  return pieces;
}

/** Clip a ring (open or closed) to the box; an empty array when nothing remains. */
export function clipRing(ring: readonly Pt[], box: ClipBox): Pt[] {
  let pts: Pt[] = ring.slice();
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first && last && pts.length > 1 && same(first, last)) pts = pts.slice(0, -1);
  const edges: [(p: Pt) => boolean, (a: Pt, b: Pt) => Pt][] = [
    [(p) => p[0] >= box.minX, (a, b) => atX(a, b, box.minX)],
    [(p) => p[0] <= box.maxX, (a, b) => atX(a, b, box.maxX)],
    [(p) => p[1] >= box.minY, (a, b) => atY(a, b, box.minY)],
    [(p) => p[1] <= box.maxY, (a, b) => atY(a, b, box.maxY)],
  ];
  for (const [inside, cross] of edges) {
    if (pts.length === 0) break;
    const out: Pt[] = [];
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i] as Pt;
      const prev = pts[(i + pts.length - 1) % pts.length] as Pt;
      if (inside(cur)) {
        if (!inside(prev)) out.push(cross(prev, cur));
        out.push(cur);
      } else if (inside(prev)) {
        out.push(cross(prev, cur));
      }
    }
    pts = out;
  }
  return pts.length >= 3 ? pts : [];
}

function atX(a: Pt, b: Pt, x: number): Pt {
  const t = (x - a[0]) / (b[0] - a[0]);
  return [x, a[1] + t * (b[1] - a[1])];
}

function atY(a: Pt, b: Pt, y: number): Pt {
  const t = (y - a[1]) / (b[1] - a[1]);
  return [a[0] + t * (b[0] - a[0]), y];
}
