/**
 * deck.gl layers for the fleet (drawn interleaved inside MapLibre, above the basemap labels):
 * a dark disc with a coloured ring (the touch target), a heading arrow tinted by kind, and the
 * unit number. Built fresh each animation frame from FleetModel.frame(); ~50 machines is cheap.
 * Machines that sit together on screen share one label ("C1 · GC1 · S4", ./labels.ts) so unit
 * numbers never print on top of each other.
 */
import type { Layer } from '@deck.gl/core';
import { IconLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { LabelGroup } from './labels';
import type { FleetFrame } from './model';
import { HALO_FILL, hexToRgba, ICON_ATLAS, ICON_MAPPING, markerLook } from './style';

export interface FleetLayerSizes {
  ringRadiusPx: number;
  iconPx: number;
  labelPx: number;
  labelOffsetPx: number;
}

/** War-room wall (viewed from across the room) and phones. */
export const WALL_SIZES: FleetLayerSizes = {
  ringRadiusPx: 22,
  iconPx: 30,
  labelPx: 20,
  labelOffsetPx: 34,
};
export const PHONE_SIZES: FleetLayerSizes = {
  ringRadiusPx: 15,
  iconPx: 21,
  labelPx: 14,
  labelOffsetPx: 24,
};

export const FLEET_LAYER_IDS = ['fleet-halo', 'fleet-icons', 'fleet-labels'] as const;

const halo = hexToRgba(HALO_FILL, 220);
const white: [number, number, number, number] = [255, 255, 255, 255];

/** Distance (CSS px) under which two machines share a label: rings that touch or overlap. */
export const labelGroupRadiusPx = (sizes: FleetLayerSizes): number => sizes.ringRadiusPx * 2.2;

/**
 * `labels`: the label groups (./labels.ts groupLabels, from the map's projection); default one
 * label per machine.
 */
export function buildFleetLayers(
  frames: FleetFrame[],
  sizes: FleetLayerSizes,
  selectedId: string | null,
  labels?: readonly LabelGroup[],
): Layer[] {
  const groups: readonly LabelGroup[] =
    labels ??
    frames.map((f) => ({
      anchor: f,
      members: [f],
      text: markerLook(f).label,
      allStale: f.stale,
    }));
  return [
    new ScatterplotLayer<FleetFrame>({
      id: 'fleet-halo',
      data: frames,
      pickable: true,
      radiusUnits: 'pixels',
      lineWidthUnits: 'pixels',
      stroked: true,
      filled: true,
      getPosition: (f) => [f.lng, f.lat],
      getRadius: (f) => (f.id === selectedId ? sizes.ringRadiusPx * 1.35 : sizes.ringRadiusPx),
      getFillColor: halo,
      getLineColor: (f) => (f.id === selectedId ? white : markerLook(f).ring),
      getLineWidth: (f) => (f.id === selectedId ? 4 : 3),
      updateTriggers: { getRadius: selectedId, getLineColor: selectedId, getLineWidth: selectedId },
    }),
    new IconLayer<FleetFrame>({
      id: 'fleet-icons',
      data: frames,
      iconAtlas: ICON_ATLAS,
      iconMapping: ICON_MAPPING,
      getIcon: () => 'arrow',
      sizeUnits: 'pixels',
      getSize: sizes.iconPx,
      billboard: false,
      getPosition: (f) => [f.lng, f.lat],
      getAngle: (f) => -f.heading,
      getColor: (f) => markerLook(f).icon,
    }),
    new TextLayer<LabelGroup>({
      id: 'fleet-labels',
      data: groups,
      getPosition: (g) => [g.anchor.lng, g.anchor.lat],
      getText: (g) => g.text,
      getSize: sizes.labelPx,
      getPixelOffset: (g) => [
        0,
        g.anchor.id === selectedId
          ? sizes.labelOffsetPx + sizes.ringRadiusPx * 0.4
          : sizes.labelOffsetPx,
      ],
      getColor: (g) => (g.allStale ? markerLook(g.anchor).ring : white),
      fontFamily: 'system-ui, "Segoe UI", Roboto, sans-serif',
      fontWeight: 700,
      fontSettings: { sdf: true },
      outlineWidth: 3,
      outlineColor: [11, 18, 16, 255],
      characterSet: 'auto',
      billboard: true,
      updateTriggers: { getPixelOffset: selectedId },
    }),
  ];
}
