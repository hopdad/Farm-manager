/**
 * Keep a MapLibre map in step with the resolved layers (contract: ./types.ts). Idempotent: call
 * it whenever the rows, the visibility or the style change ('styledata' after a basemap flavour
 * switch drops imperatively added sources and layers; this puts them back).
 *
 *  - 'maplibre' defs: their spec is added once (sources, then layers at the def's anchor) and
 *    re-added when it changes (a new `?v=` version, a new flavour); visibility is a layout
 *    property, so hidden layers fetch no tiles. Defs that are not 'ready' are removed.
 *  - 'style' defs: only the visibility of their base-style layers changes.
 *  - 'external' defs: nothing here (their owner reads useLayerVisible).
 *  - Anything prefixed `layer:` on the map that no resolved def owns any more is removed.
 */
import type { LayerSpecification, SourceSpecification } from 'maplibre-gl';
import { FIELD_LAYER_IDS } from '../style';
import {
  type LayerAnchor,
  type LayerSpec,
  type LayerSpecContext,
  layerIdPrefix,
  layerSourceId,
  type ResolvedLayer,
} from './types';

/** The part of maplibre-gl's Map this needs (a fake implements it in tests). */
export interface MapLike {
  getStyle():
    | {
        layers?: readonly { id: string; type: string }[];
        sources?: Record<string, unknown>;
      }
    | null
    | undefined;
  getSource(id: string): unknown;
  addSource(id: string, source: SourceSpecification): unknown;
  removeSource(id: string): unknown;
  getLayer(id: string): unknown;
  addLayer(layer: LayerSpecification, beforeId?: string): unknown;
  removeLayer(id: string): unknown;
  setLayoutProperty(layerId: string, name: string, value: unknown): unknown;
}

export type ApplyContext = Omit<LayerSpecContext, 'row'>;

export interface ApplyResult {
  /** Layer ids added this call. */
  added: string[];
  /** Layer and source ids removed this call. */
  removed: string[];
}

const applied = new WeakMap<object, Map<string, { fingerprint: string; spec: LayerSpec }>>();

const LAYER_PREFIX = 'layer:';

/** Check a def's spec follows the id rules (sources `layer:<key>[:…]`, layers `layer:<key>:…`). */
export function validateSpec(key: string, spec: LayerSpec): void {
  const src = layerSourceId(key);
  for (const id of Object.keys(spec.sources)) {
    if (id !== src && !id.startsWith(`${src}:`)) {
      throw new Error(`layer '${key}': source id '${id}' must be '${src}' or start with '${src}:'`);
    }
  }
  for (const l of spec.layers) {
    if (!l.id.startsWith(layerIdPrefix(key))) {
      throw new Error(`layer '${key}': layer id '${l.id}' must start with '${layerIdPrefix(key)}'`);
    }
  }
}

function anchorId(map: MapLike, anchor: LayerAnchor): string | undefined {
  if (anchor === 'top') return undefined;
  const layers = map.getStyle()?.layers ?? [];
  if (anchor === 'below-fields' && map.getLayer(FIELD_LAYER_IDS.fill)) return FIELD_LAYER_IDS.fill;
  return layers.find((l) => l.type === 'symbol' && !l.id.startsWith(LAYER_PREFIX))?.id;
}

function removeSpec(map: MapLike, spec: LayerSpec, removed: string[]): void {
  for (const l of spec.layers) {
    if (map.getLayer(l.id)) {
      map.removeLayer(l.id);
      removed.push(l.id);
    }
  }
  for (const id of Object.keys(spec.sources)) {
    if (map.getSource(id)) {
      map.removeSource(id);
      removed.push(id);
    }
  }
}

/**
 * Bring `map` in line with `layers` and the visibility function. Returns what changed (tests,
 * logs). Throws only for a def that breaks the id rules (a programming error).
 */
export function applyLayers(
  map: MapLike,
  layers: readonly ResolvedLayer[],
  isVisible: (key: string, defaultVisible: boolean) => boolean,
  ctx: ApplyContext,
): ApplyResult {
  const result: ApplyResult = { added: [], removed: [] };
  let state = applied.get(map);
  if (!state) {
    state = new Map();
    applied.set(map, state);
  }
  const owned = new Set<string>();

  for (const r of layers) {
    const { def } = r;
    const visibility = isVisible(def.key, r.defaultVisible) ? 'visible' : 'none';
    if (def.render === 'style') {
      for (const id of def.styleLayerIds) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility);
      }
      continue;
    }
    if (def.render === 'external') continue;

    const prev = state.get(def.key);
    if (r.status !== 'ready') {
      if (prev) removeSpec(map, prev.spec, result.removed);
      state.delete(def.key);
      continue;
    }
    const spec = def.spec({ ...ctx, row: r.row });
    validateSpec(def.key, spec);
    for (const id of Object.keys(spec.sources)) owned.add(id);
    for (const l of spec.layers) owned.add(l.id);
    const fingerprint = JSON.stringify(spec);
    const present =
      spec.layers.every((l) => map.getLayer(l.id)) &&
      Object.keys(spec.sources).every((id) => map.getSource(id));
    if (!prev || prev.fingerprint !== fingerprint || !present) {
      if (prev) removeSpec(map, prev.spec, result.removed);
      removeSpec(map, spec, result.removed);
      for (const [id, source] of Object.entries(spec.sources)) map.addSource(id, source);
      const before = anchorId(map, def.anchor);
      for (const l of spec.layers) {
        map.addLayer(
          { ...l, layout: { ...(l.layout ?? {}), visibility } } as LayerSpecification,
          before,
        );
        result.added.push(l.id);
      }
      state.set(def.key, { fingerprint, spec });
    }
    for (const l of spec.layers) map.setLayoutProperty(l.id, 'visibility', visibility);
  }

  // Leftovers: `layer:` layers and sources no resolved def owns any more.
  const style = map.getStyle();
  for (const l of style?.layers ?? []) {
    if (l.id.startsWith(LAYER_PREFIX) && !owned.has(l.id)) {
      map.removeLayer(l.id);
      result.removed.push(l.id);
    }
  }
  for (const id of Object.keys(style?.sources ?? {})) {
    if (id.startsWith(LAYER_PREFIX) && !owned.has(id)) {
      map.removeSource(id);
      result.removed.push(id);
    }
  }
  for (const key of [...state.keys()]) {
    if (!layers.some((r) => r.def.key === key && r.status === 'ready')) state.delete(key);
  }
  return result;
}
