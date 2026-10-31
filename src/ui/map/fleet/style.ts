/**
 * How machines look on the map: colours by kind, the stale, down and last-known treatments, and
 * the icon atlas (an inline SVG data URL, so no request leaves the page). Pure.
 *
 * 1f.2 (docs/contracts-1f.md §B.4.7): terminal-pickups owns this file; its exports are frozen
 * (additive changes only: FleetPanel, BoardScreen and the map's layers read them). The map's
 * IconLayer draws `iconFor(kind)` from ICON_MAPPING, so a per-kind icon needs only an atlas
 * entry and an `iconFor` case here.
 *
 * Icons are top-down silhouettes with the front at the top (the IconLayer turns them by the
 * heading, like the arrow): the field machines and the semis keep the M0 heading arrow; a pickup
 * is a cab and a short bed, a service truck a cab and a wide utility body with an open middle,
 * a loader a body on two tracks behind a wide bucket. All are alpha masks tinted by kind.
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
  // 1f.2: tan, so a service truck never reads as a pickup (white) or a grain cart (orange).
  service_truck: '#d4b483',
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

/**
 * Icon alpha of a `last_known` fix (a vendor snapshot, AEMP or Terminal's latest location): drawn
 * fainter than a live fix, so the board tells "was here at the last snapshot" from "is here".
 */
export const LAST_KNOWN_ICON_ALPHA = 150;

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
  positionKind?: 'live' | 'last_known';
  /** 1f: a Deere machine that stopped working: its last working position, drawn like last-known. */
  lastWorking?: boolean;
}): MarkerLook {
  if (m.stale) {
    return {
      icon: hexToRgba(STALE_COLOR),
      ring: hexToRgba(STALE_RING_COLOR),
      label: `${m.unitNo} stale`,
    };
  }
  const kind = hexToRgba(KIND_COLORS[m.kind]);
  const icon =
    m.positionKind === 'last_known' || m.lastWorking
      ? hexToRgba(KIND_COLORS[m.kind], LAST_KNOWN_ICON_ALPHA)
      : kind;
  if (m.status === 'down') return { icon, ring: hexToRgba(DOWN_COLOR), label: `${m.unitNo} down` };
  return { icon, ring: kind, label: m.unitNo };
}

/** The atlas cell (64×64) of each icon, left to right. */
const CELL = 64;

/** A 64×64 navigation arrow pointing north (alpha mask; tinted per machine). */
const ARROW_PATH = '<path d="M32 4 L56 58 L32 45 L8 58 Z" fill="#fff"/>';
/** Pickup, top-down, front up: a tapered hood and cab, a gap, the bed. */
const PICKUP_PATH =
  '<path d="M19 13 Q20 5 32 4 Q44 5 45 13 L47 34 L17 34 Z" fill="#fff"/>' +
  '<rect x="17" y="37" width="30" height="23" rx="3" fill="#fff"/>';
/** Service truck: the cab, a gap, a wide utility body whose middle (the open bed) is cut out. */
const SERVICE_TRUCK_PATH =
  '<path d="M23 12 Q24 5 32 4 Q40 5 41 12 L43 24 L21 24 Z" fill="#fff"/>' +
  '<path fill="#fff" fill-rule="evenodd" d="M15 27 H49 V60 H15 Z M27 31 V56 H37 V31 Z"/>';
/** Track loader: a wide bucket in front, the body, a track on each side. */
const LOADER_PATH =
  '<rect x="9" y="4" width="46" height="9" rx="2" fill="#fff"/>' +
  '<rect x="21" y="16" width="22" height="36" rx="4" fill="#fff"/>' +
  '<rect x="12" y="18" width="7" height="42" rx="3" fill="#fff"/>' +
  '<rect x="45" y="18" width="7" height="42" rx="3" fill="#fff"/>';

const ICONS = [
  ['arrow', ARROW_PATH],
  ['pickup', PICKUP_PATH],
  ['service_truck', SERVICE_TRUCK_PATH],
  ['loader', LOADER_PATH],
] as const;

const ATLAS_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${CELL * ICONS.length}" height="${CELL}" ` +
  `viewBox="0 0 ${CELL * ICONS.length} ${CELL}">` +
  ICONS.map(([, path], i) => `<g transform="translate(${i * CELL} 0)">${path}</g>`).join('') +
  '</svg>';

export const ICON_ATLAS = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(ATLAS_SVG)}`;

const cell = (i: number) => ({
  x: i * CELL,
  y: 0,
  width: CELL,
  height: CELL,
  anchorX: CELL / 2,
  anchorY: CELL / 2,
  mask: true,
});

export const ICON_MAPPING = {
  arrow: cell(0),
  pickup: cell(1),
  service_truck: cell(2),
  loader: cell(3),
};

/**
 * The ICON_MAPPING entry a machine kind is drawn with: its own silhouette for a pickup, a service
 * truck and a loader; the heading arrow for every other kind.
 */
export function iconFor(kind: MachineKind): keyof typeof ICON_MAPPING {
  switch (kind) {
    case 'pickup':
    case 'service_truck':
    case 'loader':
      return kind;
    default:
      return 'arrow';
  }
}
