/**
 * Web-mercator (EPSG:3857) tile math, shared by the tiles route, the synthetic basemap fixture
 * and the map. Pure. Tiles follow the XYZ scheme (y = 0 at the top), like MapLibre and PMTiles.
 */

/** Web mercator's latitude limit. */
export const MAX_MERCATOR_LAT = 85.0511287798066;
/** Deepest zoom the app serves vector tiles for. */
export const MAX_TILE_ZOOM = 22;

export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

/** [minLon, minLat, maxLon, maxLat] in degrees. */
export type BBox = readonly [number, number, number, number];

const clampLat = (lat: number) => Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));

/** (lng, lat) → normalized world coordinates in [0, 1] (x east, y south). */
export function lngLatToWorld(lng: number, lat: number): [number, number] {
  const x = (lng + 180) / 360;
  const φ = (clampLat(lat) * Math.PI) / 180;
  const y = (1 - Math.log(Math.tan(φ) + 1 / Math.cos(φ)) / Math.PI) / 2;
  return [x, y];
}

/** Normalized world coordinates → (lng, lat). */
export function worldToLngLat(x: number, y: number): [number, number] {
  const lng = x * 360 - 180;
  const n = Math.PI - 2 * Math.PI * y;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return [lng, lat];
}

/** The tile containing (lng, lat) at zoom z (edges clamp into range). */
export function lngLatToTile(lng: number, lat: number, z: number): TileCoord {
  const n = 2 ** z;
  const [wx, wy] = lngLatToWorld(lng, lat);
  const clamp = (v: number) => Math.min(n - 1, Math.max(0, Math.floor(v * n)));
  return { z, x: clamp(wx), y: clamp(wy) };
}

/** A tile's bounds as [west, south, east, north]. */
export function tileToBBox({ z, x, y }: TileCoord): BBox {
  const n = 2 ** z;
  const [west, north] = worldToLngLat(x / n, y / n);
  const [east, south] = worldToLngLat((x + 1) / n, (y + 1) / n);
  return [west, south, east, north];
}

/** Is (z, x, y) a real tile (integers, 0 <= z <= maxZoom, 0 <= x, y < 2^z)? */
export function isValidTile(z: number, x: number, y: number, maxZoom = MAX_TILE_ZOOM): boolean {
  if (![z, x, y].every(Number.isSafeInteger)) return false;
  if (z < 0 || z > maxZoom) return false;
  const n = 2 ** z;
  return x >= 0 && x < n && y >= 0 && y < n;
}

/** Every tile at zoom z that intersects bbox, row by row. */
export function tilesCoveringBBox(bbox: BBox, z: number): TileCoord[] {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const a = lngLatToTile(minLon, maxLat, z);
  const b = lngLatToTile(maxLon, minLat, z);
  const out: TileCoord[] = [];
  for (let y = a.y; y <= b.y; y++) {
    for (let x = a.x; x <= b.x; x++) out.push({ z, x, y });
  }
  return out;
}

/** (lng, lat) → integer tile-local coordinates for an MVT of `extent` (default 4096). */
export function lngLatToTilePixel(
  lng: number,
  lat: number,
  tile: TileCoord,
  extent = 4096,
): [number, number] {
  const n = 2 ** tile.z;
  const [wx, wy] = lngLatToWorld(lng, lat);
  return [Math.round((wx * n - tile.x) * extent), Math.round((wy * n - tile.y) * extent)];
}

/** Do two bboxes intersect (edges touching counts)? */
export function bboxesIntersect(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

/** Grow a bbox by `ratio` of its size on every side. */
export function padBBox(b: BBox, ratio: number): BBox {
  const dx = (b[2] - b[0]) * ratio;
  const dy = (b[3] - b[1]) * ratio;
  return [b[0] - dx, b[1] - dy, b[2] + dx, b[3] + dy];
}

/** Center of a bbox as [lng, lat]. */
export function bboxCenter(b: BBox): [number, number] {
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}
