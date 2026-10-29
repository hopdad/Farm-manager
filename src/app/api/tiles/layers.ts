/**
 * App vector tile layers served by /api/tiles/<layer>/<z>/<x>/<y> (plan §1 "App vector layers").
 * This registry is the source of each layer's SQL; gis.map_layers (M1, 0003) has a row per layer
 * with the same key, cache policy and zooms (src/app/api/tiles/tiles.db.test.ts keeps the two
 * equal). The cache policy here is the one the route enforces: a database edit can never make
 * private data (fields, parcels with owners, tile lines) public. Private layers also need a
 * session (the route calls requireRole('viewer')).
 *
 * `version()` is the cache-busting token the page appends as `?v=`: a hash of everything the
 * layer's tiles contain, so a URL with a given `v` can be cached for a year and a change to any
 * field or boundary yields new URLs.
 */
import type { Queryable } from '@/db/client';
import { parcelTileSql, parcelTileVersionSuffix } from '@/db/queries/parcels';
import { canSeeParcelOwners } from '@/db/queries/parcels-access';
import type { CachePolicy } from '@/domain/map-layers';
import type { Role } from '@/platform/auth/types';

export type TileCachePolicy = CachePolicy;

export interface TileLayerDef {
  /** SQL with params ($1 z, $2 x, $3 y) returning one bytea column named `mvt`. */
  sql: string;
  cachePolicy: TileCachePolicy;
  /** Zoom range the map requests (the route answers any valid tile). */
  minzoom: number;
  maxzoom: number;
  /** Current data version (short hex). */
  version(ex: Queryable): Promise<string>;
  /**
   * Layers whose tiles differ by role (parcels: owner names for managers and up). The SQL for a
   * role (null = unknown: the safe variant), and the suffix that keeps each variant's URLs apart
   * (`?v=<version><suffix>`): private tiles are cached immutable, and a shared wall browser must
   * never show one person's variant to the next.
   */
  sqlForRole?(role: Role | null): string;
  versionSuffixForRole?(role: Role | null): string;
}

const FIELDS_VERSION_SQL = `
  select left(md5(coalesce(string_agg(
           b.id::text || ':' || md5(extensions.ST_AsBinary(b.geom)) || ':' || f.id::text || ':' ||
           f.name || ':' || f.tenure || ':' || f.farm_id::text || ':' || f.updated_at::text ||
           ':' || coalesce(fa.client_party_id::text, '') || ':' || coalesce(cp.display_name, ''),
           ',' order by b.id), '')), 12) as v
    from farm.current_boundaries b
    join farm.fields f on f.id = b.field_id
    join farm.farms fa on fa.id = f.farm_id
    left join farm.parties cp on cp.id = fa.client_party_id
   where f.active`;

/**
 * Version of a table-backed layer: changes when a row is added, removed or updated (the writer
 * must bump `updated_at`/`loaded_at`). `registryKey`: a version the loader wrote into
 * gis.map_layers wins (gis:soils sets one per load).
 */
function tableVersionSql(table: string, stampColumn: string, registryKey?: string): string {
  const own = `(select left(md5(count(*)::text || ':' || coalesce(max(${stampColumn})::text, '') ||
             ':' || coalesce(sum(hashtext(id::text))::text, '')), 12) from ${table})`;
  return registryKey
    ? `select coalesce((select version from gis.map_layers where key = '${registryKey}'), ${own}) as v`
    : `select ${own} as v`;
}

async function versionOf(ex: Queryable, sql: string): Promise<string> {
  const r = await ex.query<{ v: string | null }>(sql);
  return r.rows[0]?.v ?? '0';
}

export const TILE_LAYERS = {
  fields: {
    sql: 'select app.mvt_fields($1, $2, $3) as mvt',
    cachePolicy: 'private',
    minzoom: 8,
    maxzoom: 16,
    version: (ex) => versionOf(ex, FIELDS_VERSION_SQL),
  },
  /** SSURGO soils (public data; empty below z10). Owner of the data: the soils builder. */
  soils: {
    sql: 'select app.mvt_soils($1, $2, $3) as mvt',
    cachePolicy: 'public',
    minzoom: 10,
    maxzoom: 16,
    version: (ex) => versionOf(ex, tableVersionSql('gis.soil_polygons', 'loaded_at', 'soils')),
  },
  /** Parcels with owner names: PRIVATE (empty below z12). Owner of the data: imagery builder. */
  parcels: {
    sql: 'select app.mvt_parcels($1, $2, $3) as mvt',
    cachePolicy: 'private',
    minzoom: 12,
    maxzoom: 16,
    version: (ex) => versionOf(ex, tableVersionSql('gis.parcels', 'updated_at')),
    // Owner names and mailing addresses only for managers and up (D8; migration 0004).
    sqlForRole: (role) => parcelTileSql(role !== null && canSeeParcelOwners(role)),
    versionSuffixForRole: (role) =>
      parcelTileVersionSuffix(role !== null && canSeeParcelOwners(role)),
  },
  /** Drainage tile lines: PRIVATE (empty below z12). Owner of the data: imagery builder. */
  tile_lines: {
    sql: 'select app.mvt_tile_lines($1, $2, $3) as mvt',
    cachePolicy: 'private',
    minzoom: 12,
    maxzoom: 16,
    version: (ex) => versionOf(ex, tableVersionSql('farm.tile_lines', 'updated_at')),
  },
} satisfies Record<string, TileLayerDef>;

/** The SQL that serves `layer` to `role` (role-dependent layers; else the layer's SQL). */
export function tileSqlFor(def: TileLayerDef, role: Role | null): string {
  return def.sqlForRole ? def.sqlForRole(role) : def.sql;
}

/** The `?v=` value for `role`: the layer's version plus its role variant's suffix. */
export function tileVersionFor(def: TileLayerDef, version: string, role: Role | null): string {
  return `${version}${def.versionSuffixForRole?.(role) ?? ''}`;
}

export type TileLayerId = keyof typeof TILE_LAYERS;

export function isTileLayerId(id: string): id is TileLayerId {
  return Object.hasOwn(TILE_LAYERS, id);
}

/** `/api/tiles/<layer>/{z}/{x}/{y}` (+ `?v=` when a version is known), relative to the origin. */
export function tileUrlTemplate(layer: TileLayerId, version: string | null): string {
  const base = `/api/tiles/${layer}/{z}/{x}/{y}`;
  return version ? `${base}?v=${encodeURIComponent(version)}` : base;
}
