/**
 * Vertex editing of a field boundary, as plain data (pure; the map editor renders it). A shape
 * is polygons -> rings -> points WITHOUT the closing point (GeoJSON repeats the first point
 * last; editing is simpler without the duplicate). Every function returns a new shape.
 */
import type { Feature, FeatureCollection, MultiPolygon, Point, Position } from 'geojson';

export type Ring = [number, number][];
export type Shape = Ring[][];

/** Where a point is: polygon, ring, index. */
export interface VertexRef {
  p: number;
  r: number;
  i: number;
}

const same = (a: Position, b: Position) => a[0] === b[0] && a[1] === b[1];

export function fromMultiPolygon(g: MultiPolygon | null): Shape {
  if (!g) return [];
  return g.coordinates.map((poly) =>
    poly.map((ring) => {
      const pts = ring.map((p) => [p[0], p[1]] as [number, number]);
      const first = pts[0];
      const last = pts[pts.length - 1];
      return first && last && pts.length > 1 && same(first, last) ? pts.slice(0, -1) : pts;
    }),
  );
}

export function toMultiPolygon(shape: Shape): MultiPolygon {
  return {
    type: 'MultiPolygon',
    coordinates: shape
      .filter((poly) => (poly[0]?.length ?? 0) >= 3)
      .map((poly) =>
        poly
          .filter((ring) => ring.length >= 3)
          .map((ring) => [...ring, ring[0] as [number, number]]),
      ),
  };
}

export function pointCount(shape: Shape): number {
  return shape.reduce((n, poly) => n + poly.reduce((m, ring) => m + ring.length, 0), 0);
}

const at = (shape: Shape, v: VertexRef) => shape[v.p]?.[v.r];

export function movePoint(shape: Shape, v: VertexRef, to: [number, number]): Shape {
  const ring = at(shape, v);
  if (!ring || v.i < 0 || v.i >= ring.length) return shape;
  return shape.map((poly, p) =>
    p !== v.p
      ? poly
      : poly.map((r, ri) => (ri !== v.r ? r : r.map((pt, i) => (i === v.i ? to : pt)))),
  );
}

/** Insert `pt` before index `v.i` (v.i = ring length appends). */
export function insertPoint(shape: Shape, v: VertexRef, pt: [number, number]): Shape {
  const ring = at(shape, v);
  if (!ring || v.i < 0 || v.i > ring.length) return shape;
  return shape.map((poly, p) =>
    p !== v.p
      ? poly
      : poly.map((r, ri) => (ri !== v.r ? r : [...r.slice(0, v.i), pt, ...r.slice(v.i)])),
  );
}

/** Remove a point; a ring keeps at least 3 (returns null when it can't). */
export function deletePoint(shape: Shape, v: VertexRef): Shape | null {
  const ring = at(shape, v);
  if (!ring || v.i < 0 || v.i >= ring.length || ring.length <= 3) return null;
  return shape.map((poly, p) =>
    p !== v.p ? poly : poly.map((r, ri) => (ri !== v.r ? r : r.filter((_, i) => i !== v.i))),
  );
}

type PointFeature = Feature<Point, VertexRef & { selected?: boolean }>;

/** One point feature per vertex (for the draggable handles). */
export function vertexFeatures(shape: Shape, selected: VertexRef | null): FeatureCollection<Point> {
  const features: PointFeature[] = [];
  shape.forEach((poly, p) => {
    poly.forEach((ring, r) => {
      ring.forEach((pt, i) => {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: pt },
          properties: {
            p,
            r,
            i,
            selected: !!selected && selected.p === p && selected.r === r && selected.i === i,
          },
        });
      });
    });
  });
  return { type: 'FeatureCollection', features };
}

/** One point feature per edge midpoint; dragging one inserts a vertex at index `i`. */
export function midpointFeatures(shape: Shape): FeatureCollection<Point> {
  const features: PointFeature[] = [];
  shape.forEach((poly, p) => {
    poly.forEach((ring, r) => {
      ring.forEach((a, i) => {
        const b = ring[(i + 1) % ring.length] as [number, number];
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] },
          properties: { p, r, i: i + 1 },
        });
      });
    });
  });
  return { type: 'FeatureCollection', features };
}

/** [west, south, east, north] of a shape, or null when empty. */
export function shapeBounds(shape: Shape): [number, number, number, number] | null {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const poly of shape) {
    for (const ring of poly) {
      for (const [x, y] of ring) {
        w = Math.min(w, x);
        s = Math.min(s, y);
        e = Math.max(e, x);
        n = Math.max(n, y);
      }
    }
  }
  return Number.isFinite(w) ? [w, s, e, n] : null;
}

/** Read a VertexRef from a rendered feature's properties (MapLibre returns them as given). */
export function vertexRefOf(props: Record<string, unknown> | null | undefined): VertexRef | null {
  if (!props) return null;
  const p = Number(props.p);
  const r = Number(props.r);
  const i = Number(props.i);
  return Number.isInteger(p) && Number.isInteger(r) && Number.isInteger(i) ? { p, r, i } : null;
}
