/**
 * Server-side data for /board and /m (server components only: reads the storage adapter and
 * the database). Never throws for a missing basemap or a database outage: the board still
 * renders and says what's wrong.
 */
import { TILE_LAYERS, tileUrlTemplate } from '../../../app/api/tiles/layers';
import { getConfig, publicConfig } from '../../../config';
import { getPool, type Queryable } from '../../../db/client';
import { getStorage } from '../../../platform/storage';
import {
  BASEMAP_BBOX,
  BASEMAP_BUCKET,
  BASEMAP_FONTS_PREFIX,
  BASEMAP_SPRITES_PREFIX,
  isSyntheticBasemap,
  readBasemapStatus,
} from '../../../platform/storage/basemap';
import type { StorageReader } from '../../../platform/storage/types';
import { type BBox, padBBox } from '../tile-math';
import type { BasemapInfo, MapPageData } from '../types';

/** A font file every installed glyph set has. */
const GLYPH_PROBE = `${BASEMAP_FONTS_PREFIX}/Noto Sans Medium/0-255.pbf`;

export async function fieldsExtent(ex: Queryable): Promise<BBox | null> {
  const r = await ex.query<{
    w: number | null;
    s: number | null;
    e: number | null;
    n: number | null;
  }>(
    `select extensions.ST_XMin(x) as w, extensions.ST_YMin(x) as s,
            extensions.ST_XMax(x) as e, extensions.ST_YMax(x) as n
       from (select extensions.ST_Extent(b.geom)::extensions.box3d as x
               from farm.current_boundaries b
               join farm.fields f on f.id = b.field_id
              where f.active) q`,
  );
  const row = r.rows[0];
  if (!row || row.w === null || row.s === null || row.e === null || row.n === null) return null;
  return [row.w, row.s, row.e, row.n];
}

/** Initial camera: the fields (padded, at least ~2 km across), else the basemap area. */
export function initialBoundsFor(extent: BBox | null): BBox {
  if (!extent) return [...BASEMAP_BBOX];
  const minSpan = 0.02;
  const [w, s, e, n] = extent;
  const cx = (w + e) / 2;
  const cy = (s + n) / 2;
  const hx = Math.max((e - w) / 2, minSpan / 2);
  const hy = Math.max((n - s) / 2, minSpan / 2);
  return padBBox([cx - hx, cy - hy, cx + hx, cy + hy], 0.08);
}

async function loadBasemap(
  storage: StorageReader,
): Promise<{ basemap: BasemapInfo | null; problem: string | null; glyphsPath: string | null }> {
  const [status, glyphs] = await Promise.all([
    readBasemapStatus(storage),
    storage.stat(BASEMAP_BUCKET, GLYPH_PROBE).catch(() => null),
  ]);
  // URLs come from the adapter (local route now, the public tiles bucket at MD); MapLibre fills
  // in the literal {fontstack}/{range} placeholders.
  const glyphsPath = glyphs
    ? `${storage.publicUrl(BASEMAP_BUCKET, BASEMAP_FONTS_PREFIX)}/{fontstack}/{range}.pbf`
    : null;
  if (!status.ok) return { basemap: null, problem: status.detail, glyphsPath };
  const m = status.manifest;
  return {
    basemap: {
      pmtilesPath: storage.publicUrl(BASEMAP_BUCKET, m.key),
      spritePathPrefix: storage.publicUrl(BASEMAP_BUCKET, BASEMAP_SPRITES_PREFIX),
      build: m.build,
      synthetic: isSyntheticBasemap(m),
      bbox: m.bbox,
      maxzoom: m.maxzoom,
    },
    problem: null,
    glyphsPath,
  };
}

export async function loadMapPageData(): Promise<MapPageData> {
  const cfg = getConfig();
  const fieldsDef = TILE_LAYERS.fields;
  const [basemap, db] = await Promise.all([
    loadBasemap(getStorage()),
    (async () => {
      try {
        const pool = getPool();
        const [version, extent] = await Promise.all([fieldsDef.version(pool), fieldsExtent(pool)]);
        return { ok: true as const, version, extent };
      } catch (e) {
        console.error('[board] fields unavailable:', (e as Error).message);
        return { ok: false as const, version: null, extent: null };
      }
    })(),
  ]);
  if (basemap.problem)
    console.warn(`[board] basemap missing: ${basemap.problem} (run pnpm gis:basemap)`);
  return {
    config: publicConfig(cfg),
    basemap: basemap.basemap,
    basemapProblem: basemap.problem,
    glyphsPath: basemap.glyphsPath,
    fields: {
      tilesPath: tileUrlTemplate('fields', db.version),
      minzoom: fieldsDef.minzoom,
      maxzoom: fieldsDef.maxzoom,
      version: db.version,
    },
    initialBounds: initialBoundsFor(db.extent),
    dbOk: db.ok,
  };
}
