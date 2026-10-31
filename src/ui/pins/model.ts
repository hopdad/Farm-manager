/**
 * The pins UI's pure parts (slice 1f, docs/contracts-1f.md §5.2; owner: deere-data): colours and
 * labels per pin kind, pins → the GeoJSON the `pins` layer's source draws (every feature with
 * `properties.id` = the pin's uuid, as the map's tap seam expects), the popup's text, and the
 * tap patterns BoardScreen hands WarRoomMap. No React, no map: unit-tested.
 */
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import type { PinKind, PinView } from '../../domain/pins';

/** Pin colours per kind (both basemap flavours: saturated, with a dark/light stroke). */
export const PIN_KIND_COLORS: Record<PinKind, string> = {
  rock: '#d6d3d1',
  wet_hole: '#38bdf8',
  tile_blowout: '#fb923c',
  washout: '#facc15',
  hazard: '#f87171',
  note: '#c084fc',
};

export const PIN_KIND_LABELS: Record<PinKind, string> = {
  rock: 'Rock',
  wet_hole: 'Wet hole',
  tile_blowout: 'Tile blowout',
  washout: 'Washout',
  hazard: 'Hazard',
  note: 'Note',
};

/** WarRoomMap's tap layers for pins: every MapLibre layer of the `pins` def. */
export const PIN_TAP_LAYERS: readonly string[] = ['layer:pins:*'];

/** Feature properties of one pin on the map (MapLibre keeps them flat). */
export interface PinFeatureProps {
  id: string;
  kind: PinKind;
  color: string;
  category: string;
}

/** Pins as the layer's GeoJSON source data (resolved pins are left out). */
export function pinsFeatureCollection(
  pins: readonly PinView[],
): FeatureCollection<Geometry, PinFeatureProps> {
  const features: Feature<Geometry, PinFeatureProps>[] = pins
    .filter((p) => p.resolvedAt === null)
    .map((p) => ({
      type: 'Feature',
      id: p.id,
      geometry: p.geometry,
      properties: {
        id: p.id,
        kind: p.kind,
        color: PIN_KIND_COLORS[p.kind],
        category: p.category ?? PIN_KIND_LABELS[p.kind],
      },
    }));
  return { type: 'FeatureCollection', features };
}

/** What the popup shows for one pin. */
export interface PinPopupView {
  title: string;
  kindLabel: string;
  color: string;
  note: string | null;
  field: string;
  /** "From Operations Center (read-only)" for Deere flags. */
  origin: string;
}

export function pinPopupView(p: PinView): PinPopupView {
  const kindLabel = PIN_KIND_LABELS[p.kind];
  return {
    title: p.category ?? kindLabel,
    kindLabel,
    color: PIN_KIND_COLORS[p.kind],
    note: p.note,
    field: p.fieldName ?? 'Not on a field',
    origin:
      p.source === 'deere_flag'
        ? `From Operations Center${p.readOnly ? ' (read-only)' : ''}`
        : p.readOnly
          ? 'Read-only'
          : 'Dropped in the app',
  };
}
