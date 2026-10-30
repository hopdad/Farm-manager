/**
 * Layers drawn more than one way (soil map Phase A: the soils layer's colour-by modes). The
 * rail shows a mode picker under such a layer's toggle while it is on, shows the chosen mode's
 * legend, remembers the choice per device with the rest of its prefs (./persist.ts) and, after
 * every applyLayers, lets the layer paint itself for the mode (`apply`: paint properties only,
 * so switching never re-adds a source or refetches a tile). Owner: soils.
 *
 * The registry is keyed by layer key; the layer contract (../layers/types.ts) is untouched.
 */
import type { Map as MapLibreMap } from 'maplibre-gl';
import { create } from 'zustand';
import type { LayerLegend } from '../../../domain/map-layers';
import {
  applySoilsMode,
  DEFAULT_SOIL_MAP_MODE,
  SOIL_MAP_MODE_LABELS,
  SOIL_MAP_MODES,
  SOILS_LAYER_KEY,
  soilMapModeOf,
  soilsLegend,
} from '../layers/soils';
import type { BasemapFlavor, MapVariant } from '../types';

export interface LayerModeOption {
  id: string;
  label: string;
}

export interface LayerModeContext {
  flavor: BasemapFlavor;
  variant: MapVariant;
}

export interface LayerModes {
  options: readonly LayerModeOption[];
  defaultMode: string;
  /** A saved or chosen value → a valid mode (anything unknown is the default). */
  parse(x: unknown): string;
  legend(mode: string, ctx: LayerModeContext): LayerLegend;
  /** Paint the layer for `mode` on a map where applyLayers has added it (idempotent). */
  apply(map: MapLibreMap, mode: string, ctx: LayerModeContext): void;
}

export const soilsModes: LayerModes = {
  options: SOIL_MAP_MODES.map((id) => ({ id, label: SOIL_MAP_MODE_LABELS[id] })),
  defaultMode: DEFAULT_SOIL_MAP_MODE,
  parse: soilMapModeOf,
  legend: (mode, ctx) => soilsLegend(soilMapModeOf(mode), ctx.flavor),
  apply: (map, mode, ctx) => {
    applySoilsMode(map, soilMapModeOf(mode), ctx);
  },
};

/** Every layer with modes, by key. */
export const LAYER_MODES: Readonly<Record<string, LayerModes>> = {
  [SOILS_LAYER_KEY]: soilsModes,
};

/** The mode of `key` given the chosen ones (null for a layer without modes). */
export function layerModeOf(
  chosen: Readonly<Record<string, string>>,
  key: string,
  registry: Readonly<Record<string, LayerModes>> = LAYER_MODES,
): string | null {
  const modes = registry[key];
  if (!modes) return null;
  return modes.parse(chosen[key]);
}

/** Saved modes cleaned against the registry: unknown layers dropped, defaults left out. */
export function normalizeModes(
  saved: Readonly<Record<string, string>>,
  registry: Readonly<Record<string, LayerModes>> = LAYER_MODES,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(saved)) {
    const modes = registry[key];
    if (!modes) continue;
    const mode = modes.parse(value);
    if (mode !== modes.defaultMode) out[key] = mode;
  }
  return out;
}

export interface LayerModeState {
  /** Layer key → chosen mode (absent: the layer's default). */
  modes: Record<string, string>;
  setMode(key: string, mode: string): void;
  /** Replace the choices (from localStorage). */
  hydrate(modes: Record<string, string>): void;
  /** Every layer back to its default mode. */
  reset(): void;
}

/** One store per tab, like the visibility store (../layers/visibility.ts). */
export const useLayerModeStore = create<LayerModeState>()((set) => ({
  modes: {},
  setMode: (key, mode) => set((s) => ({ modes: normalizeModes({ ...s.modes, [key]: mode }) })),
  hydrate: (modes) => set({ modes: normalizeModes(modes) }),
  reset: () => set({ modes: {} }),
}));

/** React hook: the mode of `key` (null for a layer without modes). */
export function useLayerMode(key: string): string | null {
  return useLayerModeStore((s) => layerModeOf(s.modes, key));
}
