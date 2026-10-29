/**
 * Which map layers are switched on (contract: ./types.ts). One store per tab: the rail writes
 * it, applyLayers and the owners of 'external' layers (the fleet) read it. Only the person's
 * choices are stored; a layer nobody touched follows its default (row default_visible, else
 * the def's). Persisting the choices per device (the wall remembers) is the rail's call:
 * `hydrate()` restores them.
 */
import { create } from 'zustand';

export interface LayerVisibilityState {
  /** key -> chosen visibility (absent: the layer's default). */
  overrides: Record<string, boolean>;
  set(key: string, visible: boolean): void;
  /** Flip from what is shown now (pass the layer's default). */
  toggle(key: string, defaultVisible: boolean): void;
  /** Back to every layer's default. */
  reset(): void;
  /** Replace the choices (e.g. from localStorage). */
  hydrate(overrides: Record<string, boolean>): void;
}

export const useLayerVisibilityStore = create<LayerVisibilityState>()((set) => ({
  overrides: {},
  set: (key, visible) => set((s) => ({ overrides: { ...s.overrides, [key]: visible } })),
  toggle: (key, defaultVisible) =>
    set((s) => ({
      overrides: { ...s.overrides, [key]: !(s.overrides[key] ?? defaultVisible) },
    })),
  reset: () => set({ overrides: {} }),
  hydrate: (overrides) => set({ overrides: { ...overrides } }),
}));

/** Is `key` visible, given the store's overrides and the layer's default? */
export function isLayerVisible(
  overrides: Readonly<Record<string, boolean>>,
  key: string,
  defaultVisible: boolean,
): boolean {
  return overrides[key] ?? defaultVisible;
}

/** React hook: is `key` visible? (Re-renders only when that layer's override changes.) */
export function useLayerVisible(key: string, defaultVisible: boolean): boolean {
  return useLayerVisibilityStore((s) => isLayerVisible(s.overrides, key, defaultVisible));
}
