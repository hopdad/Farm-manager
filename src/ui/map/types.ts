/**
 * Props the map pages' server components hand to the client (JSON-serializable). URLs are
 * origin-relative paths: the browser resolves them against the origin it actually used
 * (localhost, a LAN IP, `<pc>.local`), so phones on shop Wi-Fi work without configuration.
 */
import type { PublicConfig } from '../../config';
import type { BBox } from './tile-math';

export interface BasemapInfo {
  /** `/api/storage/tiles/basemap.<sha8>.pmtiles` (used as `pmtiles://<origin><path>`). */
  pmtilesPath: string;
  /** `/api/storage/tiles/assets/sprites/v4/<flavor>` without extension. */
  spritePathPrefix: string;
  /** basemap.json `build`. */
  build: string;
  /** True for the synthetic test fixture (the board shows a badge). */
  synthetic: boolean;
  bbox: BBox;
  maxzoom: number;
}

export interface FieldsLayerInfo {
  /** `/api/tiles/fields/{z}/{x}/{y}?v=<version>`. */
  tilesPath: string;
  minzoom: number;
  maxzoom: number;
  version: string | null;
}

export interface MapPageData {
  config: PublicConfig;
  basemap: BasemapInfo | null;
  /** Why there is no basemap (shown in the badge's tooltip and logged). */
  basemapProblem: string | null;
  /** `/api/storage/tiles/assets/fonts/{fontstack}/{range}.pbf` when the fonts are installed. */
  glyphsPath: string | null;
  fields: FieldsLayerInfo;
  /** Where the camera starts: the fields' extent, else the basemap area. */
  initialBounds: BBox;
  /** Database reachable while rendering (else fields can't load; the board says so). */
  dbOk: boolean;
}

export type MapVariant = 'wall' | 'phone';
export type BasemapFlavor = 'light' | 'dark';
