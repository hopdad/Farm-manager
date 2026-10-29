/**
 * Is any machine under (or near) a tap? A cheap screen-space test the map runs before deck.gl's
 * GPU pick: `overlay.pickObject` reads pixels back from the GPU, which stalls the frame (measured
 * at 40-170 ms per tap in software WebGL, M1 field-panel report) and would hit every field tap.
 * Projecting the current fleet frames (tens of machines) costs microseconds, so a tap with no
 * machine within reach skips the GPU pick and goes straight to the field under the finger.
 */
export interface ScreenPoint {
  x: number;
  y: number;
}

/**
 * True when some machine's projected position is within `reachPx` of `point`. `project` maps a
 * machine's lng/lat to screen pixels (MapLibre's `map.project`). Generous by design: a false
 * "maybe" only costs the GPU pick that decides for real.
 */
export function machineNear(
  frames: readonly { lng: number; lat: number }[],
  project: (lngLat: [number, number]) => ScreenPoint,
  point: ScreenPoint,
  reachPx: number,
): boolean {
  const r2 = reachPx * reachPx;
  for (const f of frames) {
    const p = project([f.lng, f.lat]);
    const dx = p.x - point.x;
    const dy = p.y - point.y;
    if (dx * dx + dy * dy <= r2) return true;
  }
  return false;
}
