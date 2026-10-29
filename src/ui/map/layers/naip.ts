/**
 * Aerial photos (plan 1d "NAIP online layer plus AOI close-up PMTiles"; contract ./types.ts,
 * docs/contracts-m1.md §7.3). Owner: imagery. Two layers, both written into gis.map_layers by
 * `pnpm gis:naip` (tools/gis/naip.ts):
 *
 *  - `naip` (ONLINE ONLY): the USGS National Map's cached imagery basemap (`USGSImageryOnly`
 *    MapServer tiles, NAIP-based across the US; plan §5), cached to z16 and over-zoomed above.
 *    Needs the internet: with it unplugged the rail shows the layer as "offline" (plan 1d
 *    done-when) and nothing else breaks.
 *  - `naip_aoi` (works offline): NAIP 0.6 m close-ups from the NAIP image service's exportImage,
 *    prebuilt for the area of interest (your fields plus a mile, z12-17) into a raster PMTiles in
 *    the `tiles` bucket (`naip/aoi.<sha8>.pmtiles`), read with HTTP range requests like the basemap.
 *
 * Both are public-domain data (cache policy public) and sit under the field fills.
 */
import type { LayerLegend } from '../../../domain/map-layers';
import { absoluteUrl, layerIdPrefix, layerSourceId, type MapLibreLayerDef } from './types';

export const NAIP_LAYER_KEY = 'naip';
export const NAIP_AOI_LAYER_KEY = 'naip_aoi';

export const NAIP_ATTRIBUTION = 'Imagery: USDA NAIP via USGS The National Map';

const NAIP_LEGEND: LayerLegend = {
  items: [{ label: 'Aerial photo (NAIP, natural colour)', swatch: 'fill', color: '#7c9a5c' }],
  note: 'Online only: needs the internet',
};

const NAIP_AOI_LEGEND: LayerLegend = {
  items: [{ label: 'Aerial photo (NAIP), your area', swatch: 'fill', color: '#7c9a5c' }],
  note: 'Saved on this PC: works offline',
};

export const naipLayer: MapLibreLayerDef = {
  key: NAIP_LAYER_KEY,
  render: 'maplibre',
  group: 'imagery',
  label: 'Aerial photos (online)',
  legend: NAIP_LEGEND,
  kind: 'online',
  offline: false,
  cachePolicy: 'public',
  defaultVisible: false,
  order: 20,
  requiresRow: true,
  buildHint: 'Run pnpm gis:naip --online-only to add the online aerial layer',
  anchor: 'below-fields',
  minzoom: 10,
  maxzoom: 22,
  spec: ({ origin, row }) => {
    if (!row) return { sources: {}, layers: [] };
    const source = layerSourceId(NAIP_LAYER_KEY);
    return {
      sources: {
        [source]: {
          type: 'raster',
          tiles: [absoluteUrl(origin, row.url)],
          tileSize: 256,
          minzoom: row.minzoom,
          maxzoom: row.maxzoom,
          attribution: row.attribution ?? NAIP_ATTRIBUTION,
        },
      },
      layers: [
        {
          id: `${layerIdPrefix(NAIP_LAYER_KEY)}raster`,
          type: 'raster',
          source,
          minzoom: row.minzoom,
          paint: { 'raster-opacity': 1, 'raster-fade-duration': 150 },
        },
      ],
    };
  },
};

export const naipAoiLayer: MapLibreLayerDef = {
  key: NAIP_AOI_LAYER_KEY,
  render: 'maplibre',
  group: 'imagery',
  label: 'Aerial photos (saved, your area)',
  legend: NAIP_AOI_LEGEND,
  kind: 'raster',
  offline: true,
  cachePolicy: 'public',
  defaultVisible: false,
  order: 10,
  requiresRow: true,
  buildHint: 'Run pnpm gis:naip to save aerial photos of your area for offline use',
  anchor: 'below-fields',
  minzoom: 10,
  maxzoom: 22,
  spec: ({ origin, row }) => {
    if (!row) return { sources: {}, layers: [] };
    const source = layerSourceId(NAIP_AOI_LAYER_KEY);
    const bounds = Array.isArray(row.meta.bounds) ? (row.meta.bounds as number[]) : null;
    return {
      sources: {
        [source]: {
          type: 'raster',
          url: `pmtiles://${absoluteUrl(origin, row.url)}`,
          tileSize: 256,
          ...(bounds && bounds.length === 4
            ? { bounds: bounds as [number, number, number, number] }
            : {}),
          attribution: row.attribution ?? NAIP_ATTRIBUTION,
        },
      },
      layers: [
        {
          id: `${layerIdPrefix(NAIP_AOI_LAYER_KEY)}raster`,
          type: 'raster',
          source,
          minzoom: row.minzoom,
          paint: { 'raster-opacity': 1, 'raster-fade-duration': 150 },
        },
      ],
    };
  },
};
