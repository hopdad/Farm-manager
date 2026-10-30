/**
 * How machines look on the map: colours by kind, the stale and down treatments, and the icon
 * atlas (an inline SVG data URL, so no request leaves the page). Pure.
 */
import type { MachineKind } from '../../../domain/fleet';

export type Rgba = [number, number, number, number];

export const KIND_COLORS: Record<MachineKind, string> = {
  combine: '#facc15',
  grain_cart: '#fb923c',
  semi: '#38bdf8',
  tractor: '#4ade80',
  sprayer: '#c084fc',
  planter: '#f472b6',
  trailer: '#94a3b8',
  drone: '#2dd4bf',
  pickup: '#e2e8f0',
  // 1f.2: placeholders until terminal-pickups styles pickups and service trucks.
  service_truck: '#cbd5e1',
  loader: '#a3e635',
};

export const KIND_LABELS: Record<MachineKind, string> = {
  combine: 'Combine',
  grain_cart: 'Grain cart',
  semi: 'Semi',
  tractor: 'Tractor',
  sprayer: 'Sprayer',
  planter: 'Planter',
  trailer: 'Trailer',
  drone: 'Drone',
  pickup: 'Pickup',
  service_truck: 'Service truck',
  loader: 'Loader',
};

export const STALE_COLOR = '#9ca3af';
export const STALE_RING_COLOR = '#f59e0b';
export const DOWN_COLOR = '#ef4444';
export const HALO_FILL = '#0b1210';

export function hexToRgba(hex: string, alpha = 255): Rgba {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`bad colour ${hex}`);
  return [
    Number.parseInt(m[1] as string, 16),
    Number.parseInt(m[2] as string, 16),
    Number.parseInt(m[3] as string, 16),
    alpha,
  ];
}

export interface MarkerLook {
  icon: Rgba;
  ring: Rgba;
  label: string;
}

/** Colours and label for one machine. */
export function markerLook(m: {
  kind: MachineKind;
  stale: boolean;
  status: 'active' | 'down' | 'retired';
  unitNo: string;
}): MarkerLook {
  if (m.stale) {
    return {
      icon: hexToRgba(STALE_COLOR),
      ring: hexToRgba(STALE_RING_COLOR),
      label: `${m.unitNo} stale`,
    };
  }
  const kind = hexToRgba(KIND_COLORS[m.kind]);
  if (m.status === 'down')
    return { icon: kind, ring: hexToRgba(DOWN_COLOR), label: `${m.unitNo} down` };
  return { icon: kind, ring: kind, label: m.unitNo };
}

/** A 64×64 navigation arrow pointing north (alpha mask; tinted per machine). */
const ARROW_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">' +
  '<path d="M32 4 L56 58 L32 45 L8 58 Z" fill="#fff"/></svg>';

export const ICON_ATLAS = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(ARROW_SVG)}`;
export const ICON_MAPPING = {
  arrow: { x: 0, y: 0, width: 64, height: 64, anchorX: 32, anchorY: 32, mask: true },
};
