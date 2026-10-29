/**
 * NAIP request math for `pnpm gis:naip` (plan §5 "Aerial photos (NAIP)", 1d). Pure.
 *
 * Source: the USGS National Map's NAIP image service (plan §5; the 0.6 m natural-colour mosaic
 * of the latest NAIP year per state):
 *   https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer
 * Operation: `exportImage` (ArcGIS REST API, Image Service, "Export Image":
 * https://developers.arcgis.com/rest/services-reference/enterprise/export-image/), parameters
 * `bbox`, `bboxSR`, `imageSR`, `size`, `format`, `f=image` (the image bytes are streamed back).
 *
 * Every request asks for exactly one 256 × 256 Web Mercator tile (bbox = the tile's EPSG:3857
 * bounds, bboxSR = imageSR = 3857), so each answer IS a map tile: no reprojection, no mosaicking,
 * no GDAL. The online layer uses the same request with MapLibre's `{bbox-epsg-3857}` placeholder.
 * imagery.nationalmap.gov answered 403 at the build machine's proxy (Oct 29, 2026), so the
 * request shape was checked against the ArcGIS documentation only: confirm the first real run
 * on Derrick's PC (the CLI checks every answer is a JPEG).
 */
import { booleanIntersects, bbox as turfBbox } from '@turf/turf';
import type { Feature, MultiPolygon, Polygon } from 'geojson';
import {
  type BBox,
  type TileCoord,
  tilesCoveringBBox,
  tileToBBox,
} from '../../src/ui/map/tile-math';

export const NAIP_IMAGE_SERVER =
  'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer';

/** Half the Web Mercator world width in metres. */
const EXTENT_3857 = 20_037_508.342789244;

export const NAIP_TILE_SIZE = 256;
/** NAIP is 0.6 m; z17 is ~0.9 m/px at 42° N (z18 would only upsample). */
export const NAIP_DEFAULT_MAXZOOM = 17;
export const NAIP_DEFAULT_MINZOOM = 12;
/** Refuse builds bigger than this without --max-tiles (≈ 1 GB of JPEGs). */
export const NAIP_DEFAULT_MAX_TILES = 60_000;

/** A tile's bounds in EPSG:3857 metres: [minx, miny, maxx, maxy]. */
export function tileBounds3857({ z, x, y }: TileCoord): [number, number, number, number] {
  const size = (2 * EXTENT_3857) / 2 ** z;
  const minx = -EXTENT_3857 + x * size;
  const maxy = EXTENT_3857 - y * size;
  return [minx, maxy - size, minx + size, maxy];
}

const exportParams = (bbox: string) =>
  `bbox=${bbox}&bboxSR=3857&imageSR=3857&size=${NAIP_TILE_SIZE},${NAIP_TILE_SIZE}` +
  '&format=jpg&interpolation=RSP_BilinearInterpolation&f=image';

/** exportImage URL for one tile. */
export function naipExportUrl(tile: TileCoord, server = NAIP_IMAGE_SERVER): string {
  const b = tileBounds3857(tile)
    .map((n) => n.toFixed(3))
    .join(',');
  return `${server}/exportImage?${exportParams(b)}`;
}

/** The online layer's tile template (MapLibre fills `{bbox-epsg-3857}` per tile). */
export function naipOnlineTemplate(server = NAIP_IMAGE_SERVER): string {
  return `${server}/exportImage?${exportParams('{bbox-epsg-3857}')}`;
}

type Area = Polygon | MultiPolygon;

/** Tiles at zooms min..max that touch the area (bbox prefilter, then an exact test). */
export function tilesForArea(area: Area, minzoom: number, maxzoom: number): TileCoord[] {
  if (minzoom < 0 || maxzoom > 20 || minzoom > maxzoom) throw new Error('bad zoom range');
  const box = turfBbox(area) as unknown as BBox;
  const feature: Feature<Area> = { type: 'Feature', geometry: area, properties: {} };
  const out: TileCoord[] = [];
  for (let z = minzoom; z <= maxzoom; z++) {
    for (const t of tilesCoveringBBox(box, z)) {
      const [w, s, e, n] = tileToBBox(t);
      const poly: Feature<Polygon> = {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [w, s],
              [e, s],
              [e, n],
              [w, n],
              [w, s],
            ],
          ],
        },
      };
      if (booleanIntersects(poly, feature)) out.push(t);
    }
  }
  return out;
}

/** How many tiles a build would fetch (cheap: bbox count per zoom, an upper bound). */
export function tileCountUpperBound(area: Area, minzoom: number, maxzoom: number): number {
  const box = turfBbox(area) as unknown as BBox;
  let n = 0;
  for (let z = minzoom; z <= maxzoom; z++) n += tilesCoveringBBox(box, z).length;
  return n;
}

/** JPEG files start with FF D8 FF. */
export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** `z/x/y.jpg` (forward slashes) inside a run directory's `tiles/`. */
export const tilePath = ({ z, x, y }: TileCoord) => `${z}/${x}/${y}.jpg`;
