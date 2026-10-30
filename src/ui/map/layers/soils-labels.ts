/**
 * Soil map unit labels without repeats (soil map Phase A). MapLibre places a polygon's label once
 * per tile-clipped piece, so a large map unit read "BnB BnB BnB" across tile seams. Instead the
 * page asks GET /api/soils/labels for ONE point per polygon (the centre of its largest inscribed
 * circle, else a point on its surface), computed in the query, and draws them from a GeoJSON
 * source (`layer:soils:labels`, ./soils.ts). Pure; shared by the route (parse) and the page
 * (planning, URL). Owner: soils.
 *
 *   GET /api/soils/labels?bbox=<west>,<south>,<east>,<north>&z=<zoom>[&v=<soils version>]
 *
 *  - z: whole zoom, SOIL_LABEL_MINZOOM (13) to 22: labels start where the symbol is readable.
 *  - bbox: WGS84 degrees, at most SOIL_LABEL_MAX_SPAN_TILES tiles of zoom z on each side (a
 *    wall screen at z13 is about 4 by 2 tiles).
 *  - One feature per soil polygon that meets the bbox and is at least SOIL_LABEL_MIN_PX on a
 *    side at zoom z (a smaller one can't carry its symbol), largest first, at most
 *    SOIL_LABEL_LIMIT (`truncated` says the cap bit).
 *  - The page snaps the bbox outward to a grid of zoom-z tiles plus a margin, so panning inside
 *    it asks nothing, and the same view asks the same URL (with `v`, the browser may keep it).
 */

export const SOIL_LABELS_PATH = '/api/soils/labels';
/** Labels start here (the symbol; ./soils.ts SOIL_LABEL_MINZOOM); the name joins at z16. */
export const SOIL_LABELS_MIN_Z = 13;
export const SOIL_LABELS_MAX_Z = 22;
/** Most points one answer carries (largest polygons first). */
export const SOIL_LABEL_LIMIT = 800;
/** Widest bbox per side, in tiles of the request's zoom. */
export const SOIL_LABEL_MAX_SPAN_TILES = 12;
/** A polygon smaller than this many CSS pixels on a side at the request's zoom gets no label. */
export const SOIL_LABEL_MIN_PX = 12;
/** Tiles of margin the page asks for around the view (pans inside it ask nothing). */
export const SOIL_LABEL_MARGIN_TILES = 1;

export interface Bbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface SoilLabelsQuery {
  bbox: Bbox;
  /** Whole zoom. */
  z: number;
  /** The soils layer version the page drew (cache key only), or null. */
  v: string | null;
}

/** One label point (a GeoJSON Feature; `id` is the soil polygon's id). */
export interface SoilLabelFeature {
  type: 'Feature';
  id: string;
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: {
    mukey: string;
    musym: string | null;
    muname: string;
    /** 0 = the largest polygon in the answer (symbol-sort-key: placed first). */
    rank: number;
  };
}

/** The answer: a GeoJSON FeatureCollection (setData takes it as is) plus what was asked. */
export interface SoilLabelsResponse {
  type: 'FeatureCollection';
  features: SoilLabelFeature[];
  z: number;
  limit: number;
  /** More polygons met the bbox than `limit`: the smallest went unlabelled. */
  truncated: boolean;
}

/** Degrees of longitude one tile spans at zoom z (2^z tiles around the world). */
export function tileSpanDeg(z: number): number {
  return 360 / 2 ** z;
}

/** Degrees of longitude per CSS pixel at zoom z (MapLibre tiles are 512 px). */
export function degPerPixel(z: number): number {
  return tileSpanDeg(z) / 512;
}

/**
 * Smallest polygon labelled at zoom z, in square degrees (what PostGIS ST_Area gives for
 * EPSG:4326): SOIL_LABEL_MIN_PX on a side, where a degree of latitude is 1/cos(lat) as long on
 * screen as a degree of longitude.
 */
export function minLabelAreaDeg2(z: number, lat: number): number {
  const side = SOIL_LABEL_MIN_PX * degPerPixel(z);
  return side * side * Math.cos((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
}

export type ParseResult = { ok: true; query: SoilLabelsQuery } | { ok: false; error: string };

const VERSION_RE = /^[0-9A-Za-z_.-]{1,64}$/;

/** Validate the route's query string. */
export function parseSoilLabelsQuery(params: URLSearchParams): ParseResult {
  const zText = params.get('z') ?? '';
  if (!/^\d{1,2}$/.test(zText)) return { ok: false, error: 'z must be a whole zoom' };
  const z = Number(zText);
  if (z < SOIL_LABELS_MIN_Z || z > SOIL_LABELS_MAX_Z) {
    return {
      ok: false,
      error: `z must be ${SOIL_LABELS_MIN_Z} to ${SOIL_LABELS_MAX_Z} (labels start at zoom ${SOIL_LABELS_MIN_Z})`,
    };
  }
  const parts = (params.get('bbox') ?? '').split(',');
  if (parts.length !== 4 || parts.some((p) => !/^-?\d{1,3}(\.\d{1,12})?$/.test(p.trim()))) {
    return { ok: false, error: 'bbox must be west,south,east,north in degrees' };
  }
  const [west, south, east, north] = parts.map(Number) as [number, number, number, number];
  if (west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) {
    return { ok: false, error: 'bbox is out of range or empty' };
  }
  // (URLs carry 7 decimals: allow their rounding.)
  const max = SOIL_LABEL_MAX_SPAN_TILES * tileSpanDeg(z) + 1e-6;
  if (east - west > max || north - south > max) {
    return {
      ok: false,
      error: `bbox is wider than ${SOIL_LABEL_MAX_SPAN_TILES} tiles of zoom ${z}`,
    };
  }
  const v = params.get('v');
  if (v !== null && !VERSION_RE.test(v)) return { ok: false, error: 'bad version' };
  return { ok: true, query: { bbox: { west, south, east, north }, z, v } };
}

/** Does `outer` contain `inner`? */
export function containsBbox(outer: Bbox, inner: Bbox): boolean {
  return (
    outer.west <= inner.west &&
    outer.south <= inner.south &&
    outer.east >= inner.east &&
    outer.north >= inner.north
  );
}

const clampLng = (x: number) => Math.max(-180, Math.min(180, x));
const clampLat = (x: number) => Math.max(-85, Math.min(85, x));
const round = (x: number) => Math.round(x * 1e9) / 1e9;
/** 7 decimals (about 1 cm), never an exponent, no trailing zeros. */
const fixed = (x: number) =>
  x
    .toFixed(7)
    .replace(/\.?0+$/, '')
    .replace(/^-0$/, '0');

/**
 * The bbox to ask for: `view` grown by `margin` tiles and snapped outward to whole tiles of
 * zoom z (a degree grid of tileSpanDeg(z) on both axes), never over the route's span limit
 * (a huge screen keeps the centre).
 */
export function snapBbox(view: Bbox, z: number, margin = SOIL_LABEL_MARGIN_TILES): Bbox {
  const step = tileSpanDeg(z);
  const max = SOIL_LABEL_MAX_SPAN_TILES;
  const axis = (lo: number, hi: number): [number, number] => {
    let a = Math.floor(lo / step) - margin;
    let b = Math.ceil(hi / step) + margin;
    if (b - a > max) {
      const mid = Math.round((lo + hi) / 2 / step);
      a = mid - Math.floor(max / 2);
      b = a + max;
    }
    return [round(a * step), round(b * step)];
  };
  const [west, east] = axis(view.west, view.east);
  const [south, north] = axis(view.south, view.north);
  return {
    west: clampLng(west),
    south: clampLat(south),
    east: clampLng(east),
    north: clampLat(north),
  };
}

/** The route URL for a request (origin-relative). */
export function soilLabelsUrl(bbox: Bbox, z: number, version: string | null): string {
  const b = [bbox.west, bbox.south, bbox.east, bbox.north].map(fixed).join(',');
  const q = new URLSearchParams({ bbox: b, z: String(z) });
  if (version) q.set('v', version);
  return `${SOIL_LABELS_PATH}?${q.toString()}`;
}

/** What the page has drawn: the zoom and bbox of the last answer. */
export interface LabelCoverage {
  z: number;
  bbox: Bbox;
  version: string | null;
}

/**
 * What to ask for after the map moved: null when nothing is needed (below the label zoom, or
 * the view is still inside the last answer at the same zoom and version), else the request.
 */
export function planLabelFetch(
  view: Bbox,
  zoom: number,
  version: string | null,
  last: LabelCoverage | null,
): LabelCoverage | null {
  const z = Math.min(SOIL_LABELS_MAX_Z, Math.floor(zoom + 1e-9));
  if (z < SOIL_LABELS_MIN_Z) return null;
  if (last && last.z === z && last.version === version && containsBbox(last.bbox, view)) {
    return null;
  }
  return { z, bbox: snapBbox(view, z), version };
}
