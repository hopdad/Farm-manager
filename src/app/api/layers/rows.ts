/**
 * GET /api/layers' logic (framework-free; the DB test calls it with a test database). Owner:
 * soils (docs/contracts-m1.md §7.4).
 *
 * Every gis.map_layers row the caller may see, sorted by key, each with the URL the browser
 * fetches resolved on the server:
 *  - pmtiles: the storage adapter's public URL of the `tiles` key (/api/storage/tiles/… locally,
 *    the public bucket at MD);
 *  - mvt: `<url_or_key>/{z}/{x}/{y}?v=<version>`, the version being the tiles route's own
 *    `version()` for that layer (src/app/api/tiles/layers.ts), so the URL changes exactly when the
 *    tiles do; `version` in the response carries the same value;
 *  - xyz: the online template as stored.
 * Private rows (fields, parcels with owner names, tile lines) only for a session that may view
 * private data. A row that fails the registry schema is skipped (and logged) rather than failing
 * the whole rail; a bad legend just falls back to the code's.
 */
import type { Queryable } from '@/db/client';
import {
  legendSchema,
  type MapLayerRow,
  type MapLayersResponse,
  mapLayerRowSchema,
  type ResolvedMapLayer,
} from '@/domain/map-layers';
import { ROLE_FOR, type Role, roleAtLeast, type Session } from '@/platform/auth/types';
import type { StorageReader } from '@/platform/storage/types';
import { isTileLayerId, TILE_LAYERS, tileVersionFor } from '../tiles/layers';

interface DbRow {
  key: string;
  kind: string;
  url_or_key: string;
  version: string | null;
  cache_policy: string;
  minzoom: number;
  maxzoom: number;
  attribution: string | null;
  legend: unknown;
  source_vintage: string | null;
  built_at: Date | null;
  default_visible: boolean;
  meta: Record<string, unknown> | null;
}

/** Can this session see private layers? (null = signed out.) */
export function mayViewPrivate(session: Session | null): boolean {
  return session !== null && roleAtLeast(session.role, ROLE_FOR.viewPrivate);
}

/** gis.map_layers → validated rows (invalid ones skipped with a log line). */
export async function readMapLayerRows(ex: Queryable): Promise<MapLayerRow[]> {
  const r = await ex.query<DbRow>(
    `select key, kind, url_or_key, version, cache_policy, minzoom, maxzoom, attribution, legend,
            source_vintage, built_at, default_visible, meta
       from gis.map_layers
      order by key`,
  );
  const out: MapLayerRow[] = [];
  for (const d of r.rows) {
    let legend = null;
    if (d.legend !== null && d.legend !== undefined) {
      const l = legendSchema.safeParse(d.legend);
      if (l.success) legend = l.data;
      else
        console.warn(
          `[api/layers] gis.map_layers '${d.key}': legend ignored (${l.error.issues[0]?.message})`,
        );
    }
    const parsed = mapLayerRowSchema.safeParse({
      key: d.key,
      kind: d.kind,
      urlOrKey: d.url_or_key,
      version: d.version,
      cachePolicy: d.cache_policy,
      minzoom: d.minzoom,
      maxzoom: d.maxzoom,
      attribution: d.attribution,
      legend,
      sourceVintage: d.source_vintage,
      builtAt: d.built_at ? d.built_at.toISOString() : null,
      defaultVisible: d.default_visible,
      meta: d.meta ?? {},
    });
    if (parsed.success) out.push(parsed.data);
    else
      console.warn(
        `[api/layers] gis.map_layers '${d.key}' skipped: ${parsed.error.issues[0]?.message}`,
      );
  }
  return out;
}

/**
 * The URL (and effective version) the browser uses for one row. `role`: the session's, for
 * layers whose tiles differ by role (parcels: the owners variant gets its own `?v=`).
 */
export async function resolveLayerRow(
  ex: Queryable,
  row: MapLayerRow,
  storage: Pick<StorageReader, 'publicUrl'>,
  role: Role | null = null,
): Promise<ResolvedMapLayer> {
  if (row.kind === 'pmtiles') return { ...row, url: storage.publicUrl('tiles', row.urlOrKey) };
  if (row.kind === 'xyz') return { ...row, url: row.urlOrKey };
  const version = isTileLayerId(row.key)
    ? tileVersionFor(TILE_LAYERS[row.key], await TILE_LAYERS[row.key].version(ex), role)
    : row.version;
  const base = `${row.urlOrKey.replace(/\/+$/, '')}/{z}/{x}/{y}`;
  return {
    ...row,
    version,
    url: version ? `${base}?v=${encodeURIComponent(version)}` : base,
  };
}

export async function listMapLayers(
  ex: Queryable,
  storage: Pick<StorageReader, 'publicUrl'>,
  opts: { includePrivate: boolean; role?: Role | null },
): Promise<MapLayersResponse> {
  const rows = (await readMapLayerRows(ex)).filter(
    (r) => opts.includePrivate || r.cachePolicy === 'public',
  );
  const layers: ResolvedMapLayer[] = [];
  for (const row of rows) layers.push(await resolveLayerRow(ex, row, storage, opts.role ?? null));
  return { layers };
}
