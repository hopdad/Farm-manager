'use client';
/**
 * deck.gl inside MapLibre: one interleaved MapLibreOverlay per map (plan §3), so deck layers
 * share MapLibre's WebGL2 context and depth order. Layers are pushed imperatively by the map's
 * animation loop (overlay.setProps), not through React state, so ticks don't re-render React.
 *
 * Not react-map-gl's useControl: an interleaved overlay attaches a luma.gl device to MapLibre's
 * WebGL context, and a second attach to the same context throws ("WebGL context already
 * attached"). React StrictMode and Fast Refresh unmount and remount effects, so the overlay is
 * kept per map and its removal is deferred by a tick: a remount in the same commit reuses it.
 */
import { MapLibreOverlay } from '@deck.gl/maplibre';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { useEffect } from 'react';
import { useMap } from 'react-map-gl/maplibre';

export interface DeckOverlayProps {
  onOverlay(overlay: MapLibreOverlay | null): void;
}

interface Attached {
  overlay: MapLibreOverlay;
  removal: ReturnType<typeof setTimeout> | null;
}

const attached = new WeakMap<MapLibreMap, Attached>();

export function DeckOverlay({ onOverlay }: DeckOverlayProps) {
  const { current: mapRef } = useMap();

  useEffect(() => {
    const map = mapRef?.getMap();
    if (!map) return;
    let entry = attached.get(map);
    if (entry) {
      if (entry.removal) clearTimeout(entry.removal);
      entry.removal = null;
    } else {
      const overlay = new MapLibreOverlay({ interleaved: true, layers: [] });
      map.addControl(overlay);
      entry = { overlay, removal: null };
      attached.set(map, entry);
    }
    const current = entry;
    onOverlay(current.overlay);
    return () => {
      onOverlay(null);
      current.removal = setTimeout(() => {
        attached.delete(map);
        try {
          map.removeControl(current.overlay);
        } catch {
          // The map was already destroyed with its controls.
        }
      }, 0);
    };
  }, [mapRef, onOverlay]);

  return null;
}
