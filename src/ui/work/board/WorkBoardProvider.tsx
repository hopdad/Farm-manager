'use client';
/**
 * The drag context of the job board (slice 2a; docs/contracts-2a.md §7.2). BoardScreen wraps the
 * wall's jobs band AND the map area in it (the cards and the drop targets: the chips tray, the
 * map, and later machine markers must share one dnd-kit `DndContext`).
 *
 * FOUNDATION STUB, owned by the board builder (src/ui/work/board/**): it renders its children
 * unchanged. The board builder makes it the `DndContext` (MouseSensor distance 6 px, TouchSensor
 * delay 200 ms / tolerance 8 px, KeyboardSensor; collision `pointerWithin` with chips before the
 * map droppable), disables `map.dragPan` / `map.touchZoomRotate` while a drag runs and turns
 * them back on at the end or on cancel, and renders the `DragOverlay` (z-index
 * DRAG_OVERLAY_Z_INDEX, pointer-events none). The props are frozen (additive changes only).
 */
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { ReactNode } from 'react';
import type { MapVariant } from '../../map/types';

export interface WorkBoardProviderProps {
  variant: MapVariant;
  /** The board's map (WarRoomMap onMapReady); null until it has loaded. */
  map: MapLibreMap | null;
  children: ReactNode;
}

export function WorkBoardProvider({ children }: WorkBoardProviderProps) {
  return <>{children}</>;
}
