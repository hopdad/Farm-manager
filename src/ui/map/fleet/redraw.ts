/**
 * Pacing the gliding fleet's frames (pure). The fleet is a deck.gl overlay interleaved with
 * MapLibre, so every frame that moves a marker repaints the whole map. A glide moves a machine a
 * few metres a second: at the wall's usual zoom (the farm, z11-12) that is a fraction of a pixel
 * per second, yet redrawing every animation frame kept the GPU busy all day (measured in software
 * WebGL: the board fell from 60 to ~11 fps with the harvest-day fleet moving, and every other
 * page on the machine slowed down with it). So while machines glide, the render loop redraws
 * only once the fastest machine on screen has moved or turned about half a device pixel: smooth
 * where motion is visible (a truck at z15), a frame or two a second where it isn't. New fixes,
 * selection and visibility changes still draw on the next frame (WarRoomMap's render loop).
 */

/** WGS84 equator length (m): MapLibre's Web Mercator ground resolution uses it. */
const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
/** MapLibre tiles are 512 CSS px: at zoom z the world is 512 * 2^z px wide. */
const WORLD_PX_AT_Z0 = 512;

/** A glide step smaller than this (device pixels) is invisible: no new frame for it. */
export const MIN_STEP_DEVICE_PX = 0.5;
/** Redraw a gliding fleet at least this often, however slowly it moves. */
export const MAX_REDRAW_INTERVAL_MS = 1_000;

/** How fast the fastest gliding machine moves: ground speed and turn rate. */
export interface FleetMotion {
  metersPerSecond: number;
  degreesPerSecond: number;
}

export const NO_MOTION: FleetMotion = { metersPerSecond: 0, degreesPerSecond: 0 };

/** Ground metres per CSS pixel at `lat` and `zoom` (Web Mercator, no pitch: the board has none). */
export function metersPerCssPixel(lat: number, zoom: number): number {
  return (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / (WORLD_PX_AT_Z0 * 2 ** zoom);
}

/**
 * Milliseconds between frames for a gliding fleet: the time the fastest machine needs to move
 * (or, for a turning icon of `turnRadiusPx`, to sweep) MIN_STEP_DEVICE_PX, capped at
 * MAX_REDRAW_INTERVAL_MS. 0 means every animation frame.
 */
export function redrawIntervalMs(
  motion: FleetMotion,
  metersPerPixel: number,
  devicePixelRatio: number,
  turnRadiusPx: number,
): number {
  if (!(metersPerPixel > 0)) return 0;
  const cssPxPerSecond =
    motion.metersPerSecond / metersPerPixel +
    ((motion.degreesPerSecond * Math.PI) / 180) * turnRadiusPx;
  const devicePxPerSecond =
    cssPxPerSecond *
    (devicePixelRatio > 0 && Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1);
  if (!Number.isFinite(devicePxPerSecond)) return 0;
  if (devicePxPerSecond <= 0) return MAX_REDRAW_INTERVAL_MS;
  return Math.min(MAX_REDRAW_INTERVAL_MS, (MIN_STEP_DEVICE_PX / devicePxPerSecond) * 1000);
}

/** A lng/lat box (degrees). */
export interface LngLatBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * `box` grown by `fraction` of its size on every side, as a point test: a machine just off
 * screen still counts (its icon and label reach in).
 */
export function insideGrown(
  box: LngLatBox,
  fraction: number,
): (lng: number, lat: number) => boolean {
  const dx = (box.east - box.west) * fraction;
  const dy = (box.north - box.south) * fraction;
  const w = box.west - dx;
  const e = box.east + dx;
  const s = box.south - dy;
  const n = box.north + dy;
  return (lng, lat) => lng >= w && lng <= e && lat >= s && lat <= n;
}
