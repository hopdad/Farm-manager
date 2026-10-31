/**
 * The soil label query (soil map Phase A): the route's query string (zoom, bbox, span limit,
 * version), the bbox the page asks for (snapped to tiles, with a margin, never over the limit),
 * when a move needs a new request, and the smallest polygon labelled at a zoom.
 */
import { describe, expect, test } from 'vitest';
import { SOIL_LABEL_MINZOOM } from './soils';
import {
  type Bbox,
  containsBbox,
  degPerPixel,
  minLabelAreaDeg2,
  parseSoilLabelsQuery,
  planLabelFetch,
  SOIL_LABEL_MAX_SPAN_TILES,
  SOIL_LABEL_MIN_PX,
  SOIL_LABELS_MAX_Z,
  SOIL_LABELS_MIN_Z,
  snapBbox,
  soilLabelsUrl,
  tileSpanDeg,
} from './soils-labels';

const q = (s: string) => parseSoilLabelsQuery(new URLSearchParams(s));

/** A phone-sized view over the demo farm at z13. */
const VIEW: Bbox = { west: -84.02, south: 41.88, east: -83.98, north: 41.92 };

describe('parseSoilLabelsQuery', () => {
  test('a good query', () => {
    expect(q('bbox=-84.02,41.88,-83.98,41.92&z=13&v=fixture-abc')).toEqual({
      ok: true,
      query: { bbox: VIEW, z: 13, v: 'fixture-abc' },
    });
    expect(q('bbox=-84.02,41.88,-83.98,41.92&z=16')).toMatchObject({
      ok: true,
      query: { v: null },
    });
  });

  test('labels start at z13, the same zoom the label layer shows them from', () => {
    expect(SOIL_LABELS_MIN_Z).toBe(13);
    expect(SOIL_LABEL_MINZOOM).toBe(SOIL_LABELS_MIN_Z);
    expect(q('bbox=-84.02,41.88,-83.98,41.92&z=12')).toMatchObject({ ok: false });
    expect(q(`bbox=-84.02,41.88,-83.98,41.92&z=${SOIL_LABELS_MAX_Z + 1}`)).toMatchObject({
      ok: false,
    });
  });

  test('refuses malformed zooms, bboxes and versions', () => {
    for (const bad of [
      'bbox=-84.02,41.88,-83.98,41.92',
      'bbox=-84.02,41.88,-83.98,41.92&z=13.5',
      'bbox=-84.02,41.88,-83.98,41.92&z=abc',
      'z=13',
      'bbox=-84.02,41.88,-83.98&z=13',
      'bbox=a,b,c,d&z=13',
      'bbox=-84.02,41.88,-83.98,41.92,1&z=13',
      'bbox=1e2,41.88,-83.98,41.92&z=13',
      'bbox=-83.98,41.88,-84.02,41.92&z=13', // west east swapped
      'bbox=-84.02,41.92,-83.98,41.88&z=13', // south north swapped
      'bbox=-181,41.88,-83.98,41.92&z=13',
      'bbox=-84.02,41.88,-83.98,91&z=13',
      'bbox=-84.02,41.88,-83.98,41.92&z=13&v=bad%20version',
    ]) {
      expect(q(bad).ok, bad).toBe(false);
    }
  });

  test('a bbox wider than the span limit at that zoom is refused', () => {
    const span = SOIL_LABEL_MAX_SPAN_TILES * tileSpanDeg(13);
    expect(q(`bbox=-84,41.8,${(-84 + span).toFixed(6)},41.9&z=13`).ok).toBe(true);
    expect(q(`bbox=-84,41.8,${(-84 + span + 0.01).toFixed(6)},41.9&z=13`)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/wider than/),
    });
    // The same width is fine one zoom out (tiles are twice as wide), not one zoom in.
    expect(q(`bbox=-84,41.8,${(-84 + span * 1.5).toFixed(6)},41.9&z=13`).ok).toBe(false);
  });
});

describe('the bbox the page asks for', () => {
  test('grown by a tile and snapped to whole tiles of the zoom', () => {
    const z = 13;
    const step = tileSpanDeg(z);
    const b = snapBbox(VIEW, z);
    expect(containsBbox(b, VIEW)).toBe(true);
    for (const v of [b.west, b.south, b.east, b.north]) {
      expect(Math.abs(v / step - Math.round(v / step))).toBeLessThan(1e-6);
    }
    expect(b.west).toBeLessThanOrEqual(VIEW.west - step + 1e-9);
    expect(b.east).toBeGreaterThanOrEqual(VIEW.east + step - 1e-9);
    // Nearby views (edges in the same tiles) ask the same URL: the browser may reuse it.
    const at = (x: number, y: number, w: number, h: number): Bbox => ({
      west: x * step,
      south: y * step,
      east: (x + w) * step,
      north: (y + h) * step,
    });
    const view = at(-1911.7, 953.2, 1.1, 1.3);
    const nudged = at(-1911.6, 953.3, 1.15, 1.25);
    expect(soilLabelsUrl(snapBbox(nudged, z), z, 'v1')).toBe(
      soilLabelsUrl(snapBbox(view, z), z, 'v1'),
    );
  });

  test('never over the route’s span limit (a huge screen keeps the centre), and always accepted', () => {
    const huge: Bbox = { west: -84.5, south: 41.6, east: -83.5, north: 42.2 };
    for (const z of [13, 14, 16, 19]) {
      const b = snapBbox(huge, z);
      expect((b.east - b.west) / tileSpanDeg(z)).toBeLessThanOrEqual(
        SOIL_LABEL_MAX_SPAN_TILES + 1e-6,
      );
      expect((b.north - b.south) / tileSpanDeg(z)).toBeLessThanOrEqual(
        SOIL_LABEL_MAX_SPAN_TILES + 1e-6,
      );
      const centre = (huge.west + huge.east) / 2;
      expect(b.west).toBeLessThan(centre);
      expect(b.east).toBeGreaterThan(centre);
      const url = new URL(soilLabelsUrl(b, z, 'fixture-1'), 'http://localhost');
      expect(parseSoilLabelsQuery(url.searchParams).ok, `z${z}`).toBe(true);
    }
    // A wall screen at z13 fits whole.
    const wall: Bbox = { west: -84.15, south: 41.85, east: -83.82, north: 41.98 };
    expect(containsBbox(snapBbox(wall, 13), wall)).toBe(true);
  });

  test('the URL: the path, 7 decimals at most, never an exponent, the version when known', () => {
    const url = soilLabelsUrl(
      { west: -84.0000001, south: 0.00000001, east: 1, north: 2 },
      13,
      null,
    );
    expect(url).toBe('/api/soils/labels?bbox=-84.0000001%2C0%2C1%2C2&z=13');
    expect(soilLabelsUrl(VIEW, 14, 'ssurgo-0123456789ab')).toMatch(/&z=14&v=ssurgo-0123456789ab$/);
  });
});

describe('planLabelFetch', () => {
  test('nothing below zoom 13', () => {
    expect(planLabelFetch(VIEW, 12.99, 'v', null)).toBeNull();
    expect(planLabelFetch(VIEW, 13, 'v', null)).toMatchObject({ z: 13, version: 'v' });
    expect(planLabelFetch(VIEW, 15.7, 'v', null)?.z).toBe(15);
    expect(planLabelFetch(VIEW, 25, 'v', null)?.z).toBe(SOIL_LABELS_MAX_Z);
  });

  test('a pan inside the last answer asks nothing; out of it, a new zoom or version asks again', () => {
    const first = planLabelFetch(VIEW, 13.4, 'v', null);
    if (!first) throw new Error('expected a request');
    const nudged = { ...VIEW, west: VIEW.west + 0.01, east: VIEW.east + 0.01 };
    expect(planLabelFetch(nudged, 13.8, 'v', first)).toBeNull();
    const far = { west: -83.5, south: 41.5, east: -83.46, north: 41.54 };
    expect(planLabelFetch(far, 13.4, 'v', first)).not.toBeNull();
    expect(planLabelFetch(VIEW, 14.1, 'v', first)?.z).toBe(14);
    expect(planLabelFetch(VIEW, 13.4, 'w', first)?.version).toBe('w');
  });

  test('a pan inside the request still in flight asks nothing (it would only abort it)', () => {
    const pending = planLabelFetch(VIEW, 14.2, 'v', null);
    if (!pending) throw new Error('expected a request');
    const nudged = { ...VIEW, west: VIEW.west + 0.0005, east: VIEW.east + 0.0005 };
    // Nothing answered yet (last is null), but the answer on its way covers the view.
    expect(planLabelFetch(nudged, 14.3, 'v', null, pending)).toBeNull();
    expect(planLabelFetch(VIEW, 14.2, 'v', null, pending)).toBeNull();
    // Out of it, another zoom or version: a new request (the caller aborts the old one).
    const far = { west: -83.5, south: 41.5, east: -83.46, north: 41.54 };
    expect(planLabelFetch(far, 14.2, 'v', null, pending)).not.toBeNull();
    expect(planLabelFetch(VIEW, 15.1, 'v', null, pending)?.z).toBe(15);
    expect(planLabelFetch(VIEW, 14.2, 'w', null, pending)?.version).toBe('w');
  });
});

describe('minLabelAreaDeg2', () => {
  test(`a polygon ${SOIL_LABEL_MIN_PX} px on a side, in square degrees`, () => {
    const side = SOIL_LABEL_MIN_PX * degPerPixel(13);
    expect(minLabelAreaDeg2(13, 0)).toBeCloseTo(side * side, 15);
    expect(minLabelAreaDeg2(13, 60)).toBeCloseTo((side * side) / 2, 15);
    // Each zoom in labels polygons a quarter the size.
    expect(minLabelAreaDeg2(14, 42) / minLabelAreaDeg2(13, 42)).toBeCloseTo(0.25, 10);
    // At z13 over Lenawee: 12 px is about 85 m, so about 0.7 ha (a degree of longitude is
    // 111.32 km times cos(latitude) there).
    const lat = 41.9;
    const m2 = minLabelAreaDeg2(13, lat) * 111_320 * 111_320 * Math.cos((lat * Math.PI) / 180);
    expect(Math.sqrt(m2)).toBeGreaterThan(80);
    expect(Math.sqrt(m2)).toBeLessThan(90);
  });
});
