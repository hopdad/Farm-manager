/**
 * Map layer contract (plan 1d "layer toggles down one side"; docs/contracts-m1.md §7).
 *
 * Two halves with the same `key`:
 *  - DATA: a gis.map_layers row (src/domain/map-layers.ts) says what is built, where it lives,
 *    its version, cache policy, zooms, attribution and legend overrides. The rail reads every
 *    row from GET /api/layers (soils builder) with its URL resolved (`ResolvedMapLayer`).
 *  - DRAWING: a `LayerDef` in code says how the layer looks and where it sits. Each builder
 *    writes its own defs (soils: src/ui/map/layers/soils*.ts; imagery: naip*, parcels*,
 *    tile*.ts) and adds them to ./registry.ts (one line each; the integrator owns the list).
 *
 * The rail (src/ui/map/rail/**, soils builder) shows `resolveLayers(LAYER_DEFS, rows)` grouped
 * by `group`, toggles visibility in the store (./visibility.ts), and keeps the map in step with
 * `applyLayers()` (./apply.ts), which is idempotent and safe to call on every change and on the
 * map's 'styledata' event (a basemap flavour switch replaces the style).
 *
 * Render kinds:
 *  - 'maplibre': the def builds MapLibre sources + layers from the resolved row (`spec`).
 *    Source ids are `layer:<key>` (or start with `layer:<key>:`); layer ids start with
 *    `layer:<key>:`. applyLayers checks both.
 *  - 'style': layers that are already in the base style (the M0 fields fill/outline/label);
 *    the rail only flips their visibility.
 *  - 'external': drawn by app code outside MapLibre's style (the deck.gl fleet); the owner reads
 *    `useLayerVisible(key)` and hides its own layers.
 */
import type { LayerSpecification, SourceSpecification } from 'maplibre-gl';
import type { CachePolicy, LayerLegend, ResolvedMapLayer } from '../../../domain/map-layers';

/** Rail groups, in rail order (plan 1d): soils, elevation and drainage, imagery, tile maps, parcels, live fleet, custom-work customers. Fields sit on top. */
export const LAYER_GROUPS = [
  'fields',
  'soils',
  'terrain',
  'imagery',
  'tile',
  'parcels',
  'fleet',
  'customers',
] as const;
export type LayerGroup = (typeof LAYER_GROUPS)[number];

export const LAYER_GROUP_LABELS: Record<LayerGroup, string> = {
  fields: 'Fields',
  soils: 'Soils',
  terrain: 'Elevation and drainage',
  imagery: 'Imagery',
  tile: 'Tile maps',
  parcels: 'Parcels',
  fleet: 'Live fleet',
  customers: 'Custom-work customers',
};

/**
 * vector: MVT or vector PMTiles; raster: raster PMTiles (works offline); online: tiles fetched
 * from the internet (shows "offline" when it can't load, plan 1d).
 */
export type LayerKind = 'vector' | 'raster' | 'online';

/** Where a MapLibre def's layers go in the style. */
export type LayerAnchor = 'below-fields' | 'below-labels' | 'top';

interface LayerDefBase {
  /** = gis.map_layers.key (lower-case identifier). */
  key: string;
  group: LayerGroup;
  label: string;
  /** Default legend; a row's `legend` overrides it. */
  legend: LayerLegend | null;
  kind: LayerKind;
  /** Works with the internet unplugged (false for 'online'). */
  offline: boolean;
  /** Must equal the row's cache_policy (the tiles route and the rail check it). */
  cachePolicy: CachePolicy;
  /** A row's default_visible overrides it. */
  defaultVisible: boolean;
  /** Order within the group (ascending). */
  order: number;
}

export interface MapLibreLayerDef extends LayerDefBase {
  render: 'maplibre';
  /**
   * True when the layer only exists once built (PMTiles, MVT over loaded data, xyz URL): without
   * a gis.map_layers row the rail shows it disabled with `buildHint`.
   */
  requiresRow: boolean;
  /** Shown when the row is missing, e.g. 'run pnpm gis:soils'. */
  buildHint?: string;
  anchor: LayerAnchor;
  /** Zooms of the def's own layers (the row's minzoom/maxzoom win when present). */
  minzoom: number;
  maxzoom: number;
  /** The sources and layers to add (pure; no map access). */
  spec(ctx: LayerSpecContext): LayerSpec;
}

export interface StyleLayerDef extends LayerDefBase {
  render: 'style';
  /** Ids of base-style layers this toggle shows and hides. */
  styleLayerIds: readonly string[];
}

export interface ExternalLayerDef extends LayerDefBase {
  render: 'external';
}

export type LayerDef = MapLibreLayerDef | StyleLayerDef | ExternalLayerDef;

export interface LayerSpecContext {
  /** window.location.origin (MapLibre needs absolute tile URLs; pmtiles:// too). */
  origin: string;
  /** The registry row, null when there is none (only possible when requiresRow is false). */
  row: ResolvedMapLayer | null;
  flavor: 'light' | 'dark';
  variant: 'wall' | 'phone';
}

export interface LayerSpec {
  sources: Record<string, SourceSpecification>;
  layers: LayerSpecification[];
}

/** Source id of a def's main source. */
export const layerSourceId = (key: string): string => `layer:${key}`;
/** Prefix every MapLibre layer id of a def must start with. */
export const layerIdPrefix = (key: string): string => `layer:${key}:`;

/** Absolute URL for a resolved row's url (origin-relative locally, absolute at MD). */
export function absoluteUrl(origin: string, url: string): string {
  return new URL(url, origin).toString().replace(/%7B/gi, '{').replace(/%7D/gi, '}');
}

/** What the rail shows for one def. */
export interface ResolvedLayer {
  def: LayerDef;
  row: ResolvedMapLayer | null;
  /** 'ready'; 'missing' (needs a row: show buildHint); 'mismatch' (row disagrees on cache policy: never drawn). */
  status: 'ready' | 'missing' | 'mismatch';
  legend: LayerLegend | null;
  defaultVisible: boolean;
}

/**
 * Join defs with registry rows by key, in rail order (group, then order, then key). Rows with
 * no def are ignored (built data nobody draws yet); a def whose row has a different cache
 * policy is 'mismatch' and must not be drawn (private data must never be served as public).
 */
export function resolveLayers(
  defs: readonly LayerDef[],
  rows: readonly ResolvedMapLayer[],
): ResolvedLayer[] {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const seen = new Set<string>();
  const out: ResolvedLayer[] = [];
  for (const def of defs) {
    if (seen.has(def.key)) throw new Error(`layer '${def.key}' is defined twice`);
    seen.add(def.key);
    const row = byKey.get(def.key) ?? null;
    let status: ResolvedLayer['status'] = 'ready';
    if (row && row.cachePolicy !== def.cachePolicy) status = 'mismatch';
    else if (!row && def.render === 'maplibre' && def.requiresRow) status = 'missing';
    out.push({
      def,
      row,
      status,
      legend: row?.legend ?? def.legend,
      defaultVisible: row?.defaultVisible ?? def.defaultVisible,
    });
  }
  const g = (d: LayerDef) => LAYER_GROUPS.indexOf(d.group);
  return out.sort(
    (a, b) =>
      g(a.def) - g(b.def) || a.def.order - b.def.order || a.def.key.localeCompare(b.def.key),
  );
}
