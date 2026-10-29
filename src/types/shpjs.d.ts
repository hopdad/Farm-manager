/**
 * Types for shpjs 6.2.0 (ships none; @types/shpjs describes v3). Written from its lib/index.js:
 * a zip (or .shp/.dbf/.prj/.cpg buffers) -> GeoJSON in WGS84, reprojected with proj4 when a
 * .prj is present. Used by the M1 importers (import:boundaries, gis:parcels, import:tile).
 */
declare module 'shpjs' {
  import type { FeatureCollection, Geometry } from 'geojson';

  /** Node Buffer, Uint8Array, ArrayBuffer or DataView. */
  export type ShpBuffer = ArrayBuffer | ArrayBufferView | DataView;

  /** One layer; `fileName` is the shapefile's base name inside the zip. */
  export interface ShpFeatureCollection
    extends FeatureCollection<Geometry | null, Record<string, unknown>> {
    fileName?: string;
  }

  /** Separate component files (dbf, prj and cpg are optional). */
  export interface ShpParts {
    shp: ShpBuffer;
    dbf?: ShpBuffer;
    /** The .prj WKT (text or bytes): coordinates are reprojected to WGS84 with it. */
    prj?: string | ShpBuffer;
    /** The .cpg code page of the .dbf. */
    cpg?: string | ShpBuffer;
  }

  /**
   * A zip buffer (one collection per .shp inside: a single one is returned bare, several as an
   * array), a ShpParts object (one collection), or a URL (browser use).
   */
  function getShapefile(
    input: ShpBuffer | ShpParts | string,
    whiteList?: string[],
  ): Promise<ShpFeatureCollection | ShpFeatureCollection[]>;
  export default getShapefile;
  export { getShapefile };
  export function parseZip(
    buffer: ShpBuffer,
    whiteList?: string[],
  ): Promise<ShpFeatureCollection | ShpFeatureCollection[]>;
  export function parseShp(shp: ShpBuffer, prj?: string | ShpBuffer): (Geometry | null)[];
  export function parseDbf(dbf: ShpBuffer, cpg?: string | ShpBuffer): Record<string, unknown>[];
  export function combine(
    parts: [(Geometry | null)[], Record<string, unknown>[]?],
  ): ShpFeatureCollection;
}
