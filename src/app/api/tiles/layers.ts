/**
 * App vector tile layers served by /api/tiles/<layer>/<z>/<x>/<y> (plan §1 "App vector layers").
 * Until `gis.map_layers` exists (1d) this registry is the source of each layer's SQL, cache
 * policy and zoom range. Fields are private data (`Cache-Control: private`, contracts §4).
 *
 * `version()` is the cache-busting token the page appends as `?v=`: a hash of everything the
 * layer's tiles contain, so a URL with a given `v` can be cached for a year and a change to any
 * field or boundary yields new URLs.
 */
import type { Queryable } from '@/db/client';

export type TileCachePolicy = 'public' | 'private';

export interface TileLayerDef {
  /** SQL with params ($1 z, $2 x, $3 y) returning one bytea column named `mvt`. */
  sql: string;
  cachePolicy: TileCachePolicy;
  /** Zoom range the map requests (the route answers any valid tile). */
  minzoom: number;
  maxzoom: number;
  /** Current data version (short hex). */
  version(ex: Queryable): Promise<string>;
}

const FIELDS_VERSION_SQL = `
  select left(md5(coalesce(string_agg(
           b.id::text || ':' || md5(extensions.ST_AsBinary(b.geom)) || ':' || f.id::text || ':' ||
           f.name || ':' || f.tenure || ':' || f.farm_id::text || ':' || f.updated_at::text,
           ',' order by b.id), '')), 12) as v
    from farm.current_boundaries b
    join farm.fields f on f.id = b.field_id
   where f.active`;

export const TILE_LAYERS = {
  fields: {
    sql: 'select app.mvt_fields($1, $2, $3) as mvt',
    cachePolicy: 'private',
    minzoom: 8,
    maxzoom: 16,
    async version(ex) {
      const r = await ex.query<{ v: string }>(FIELDS_VERSION_SQL);
      return r.rows[0]?.v ?? '0';
    },
  },
} satisfies Record<string, TileLayerDef>;

export type TileLayerId = keyof typeof TILE_LAYERS;

export function isTileLayerId(id: string): id is TileLayerId {
  return Object.hasOwn(TILE_LAYERS, id);
}

/** `/api/tiles/<layer>/{z}/{x}/{y}` (+ `?v=` when a version is known), relative to the origin. */
export function tileUrlTemplate(layer: TileLayerId, version: string | null): string {
  const base = `/api/tiles/${layer}/{z}/{x}/{y}`;
  return version ? `${base}?v=${encodeURIComponent(version)}` : base;
}
