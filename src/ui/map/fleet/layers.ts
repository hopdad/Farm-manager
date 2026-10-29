/**
 * deck.gl layers for the fleet (drawn interleaved inside MapLibre, above the basemap labels):
 * a dark disc with a coloured ring (the touch target), a heading arrow tinted by kind, and the
 * unit number. Built fresh each animation frame from FleetModel.frame(); ~50 machines is cheap.
 */
import type { Layer } from '@deck.gl/core';
import { IconLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
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

export function buildFleetLayers(
  frames: FleetFrame[],
  sizes: FleetLayerSizes,
  selectedId: string | null,
): Layer[] {
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
    new TextLayer<FleetFrame>({
      id: 'fleet-labels',
      data: frames,
      getPosition: (f) => [f.lng, f.lat],
      getText: (f) => markerLook(f).label,
      getSize: sizes.labelPx,
      getPixelOffset: (f) => [
        0,
        f.id === selectedId ? sizes.labelOffsetPx + sizes.ringRadiusPx * 0.4 : sizes.labelOffsetPx,
      ],
      getColor: (f) => (f.stale ? markerLook(f).ring : white),
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
