/**
 * The map layer registry's vocabulary (gis.map_layers, plan §4; docs/contracts-m1.md §7).
 *
 * gis.map_layers says WHAT is built and WHERE it lives (format, URL or storage key, version,
 * cache policy, zooms, attribution, legend overrides). How a layer is DRAWN lives in code: a
 * `LayerDef` with the same `key` (src/ui/map/layers/types.ts). Pure TS + zod (the API route
 * validates rows with it; the browser gets them as JSON).
 */
import { z } from 'zod';

/** Delivery format (gis.map_layers.kind). */
export const MAP_LAYER_FORMATS = ['pmtiles', 'mvt', 'xyz'] as const;
export type MapLayerFormat = (typeof MAP_LAYER_FORMATS)[number];

/**
 * Who may cache a layer's tiles (gis.map_layers.cache_policy): `public` = public-domain data
 * (CDN may cache for a year when versioned), `private` = the farm's own or licensed data
 * (fields, parcels with owner names, tile lines, pins, jobs): `Cache-Control: private` and a
 * session check (plan §1 "App vector layers").
 */
export const CACHE_POLICIES = ['public', 'private'] as const;
export type CachePolicy = (typeof CACHE_POLICIES)[number];

/** Layer keys are lower-case identifiers (the database CHECKs the same pattern). */
export const LAYER_KEY_RE = /^[a-z][a-z0-9_]{0,62}$/;

/** One legend entry. */
export interface LegendItem {
  label: string;
  /** How the swatch looks. `ramp` draws `colors` as a gradient. */
  swatch: 'fill' | 'line' | 'point' | 'ramp';
  /** CSS colour of a fill/line/point swatch. */
  color?: string;
  /** Ramp stops, low to high. */
  colors?: string[];
}

export interface LayerLegend {
  title?: string;
  items: LegendItem[];
  /** Small print under the items, e.g. 'NAIP 2024, 0.6 m'. */
  note?: string;
}

export const legendSchema = z.strictObject({
  title: z.string().min(1).optional(),
  items: z.array(
    z.strictObject({
      label: z.string().min(1),
      swatch: z.enum(['fill', 'line', 'point', 'ramp']),
      color: z.string().min(1).optional(),
      colors: z.array(z.string().min(1)).min(2).optional(),
    }),
  ),
  note: z.string().min(1).optional(),
}) satisfies z.ZodType<LayerLegend>;

/** One gis.map_layers row as the app passes it around (camelCase; times as ISO strings). */
export interface MapLayerRow {
  key: string;
  kind: MapLayerFormat;
  /**
   * pmtiles: a key in the `tiles` bucket (content-addressed, e.g. 'naip/aoi.1a2b3c4d.pmtiles');
   * mvt: the tiles route base, '/api/tiles/<layer>'; xyz: an online URL template with {z}/{x}/{y}.
   */
  urlOrKey: string;
  /** Content version (the `?v=` cache buster); null = computed per request (mvt layers). */
  version: string | null;
  cachePolicy: CachePolicy;
  minzoom: number;
  maxzoom: number;
  attribution: string | null;
  /** Overrides the LayerDef's legend (e.g. a built raster's real classes). */
  legend: LayerLegend | null;
  /** What the data is, e.g. 'SSURGO FY2026', 'NAIP 2024'. */
  sourceVintage: string | null;
  builtAt: string | null;
  defaultVisible: boolean;
  /** Format-specific extras (pmtiles: bounds, tileType; anything a builder needs). */
  meta: Record<string, unknown>;
}

export const mapLayerRowSchema = z.strictObject({
  key: z.string().regex(LAYER_KEY_RE),
  kind: z.enum(MAP_LAYER_FORMATS),
  urlOrKey: z.string().min(1),
  version: z
    .string()
    .regex(/^[0-9A-Za-z_.-]{1,64}$/)
    .nullable(),
  cachePolicy: z.enum(CACHE_POLICIES),
  minzoom: z.number().int().min(0).max(24),
  maxzoom: z.number().int().min(0).max(24),
  attribution: z.string().nullable(),
  legend: legendSchema.nullable(),
  sourceVintage: z.string().nullable(),
  builtAt: z.iso.datetime({ offset: true }).nullable(),
  defaultVisible: z.boolean(),
  meta: z.record(z.string(), z.unknown()),
}) satisfies z.ZodType<MapLayerRow>;

/**
 * A registry row with the URL the browser fetches, resolved on the server (the storage adapter
 * decides where `tiles` objects live: /api/storage locally, the public bucket at MD):
 *  - pmtiles: the archive URL (origin-relative locally; draw it as `pmtiles://<origin><url>`)
 *  - mvt: the tile URL template with `?v=<version>`, e.g. '/api/tiles/soils/{z}/{x}/{y}?v=ab12'
 *  - xyz: the online URL template as stored
 */
export interface ResolvedMapLayer extends MapLayerRow {
  url: string;
}

/**
 * Response of GET /api/layers (owner: soils builder, src/app/api/layers/**): every registry row,
 * sorted by key, with `url` resolved. Private rows are included only for a session that may see
 * them (requireRole('viewer')).
 */
export interface MapLayersResponse {
  layers: ResolvedMapLayer[];
}
