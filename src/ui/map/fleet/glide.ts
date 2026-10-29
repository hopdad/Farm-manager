/**
 * Gliding between fleet fixes (pure). A tick moves each machine from where it is drawn now to its
 * new fix over the tick interval, at constant speed, turning the short way round.
 */

export interface Fix {
  lng: number;
  lat: number;
  /** Degrees clockwise from north, [0, 360). */
  heading: number;
}

export interface Glide {
  from: Fix;
  to: Fix;
  /** performance.now()-style milliseconds. */
  start: number;
  duration: number;
}

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Interpolate headings along the shorter arc; the result is in [0, 360). */
export function lerpHeading(a: number, b: number, t: number): number {
  const delta = ((((b - a) % 360) + 540) % 360) - 180;
  const h = (a + delta * t) % 360;
  return h < 0 ? h + 360 : h;
}

const EARTH_RADIUS_M = 6_371_008.8;

/** Great-circle distance in metres (haversine). */
export function distanceMeters(a: Pick<Fix, 'lng' | 'lat'>, b: Pick<Fix, 'lng' | 'lat'>): number {
  const φ1 = (a.lat * Math.PI) / 180;
  const φ2 = (b.lat * Math.PI) / 180;
  const dφ = φ2 - φ1;
  const dλ = ((b.lng - a.lng) * Math.PI) / 180;
  const h = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Progress of a glide at `now`, clamped to [0, 1]. */
export function glideProgress(g: Glide, now: number): number {
  if (g.duration <= 0) return 1;
  return Math.min(1, Math.max(0, (now - g.start) / g.duration));
}

/** Where a glide is at `now`. */
export function glideAt(g: Glide, now: number): Fix {
  const t = glideProgress(g, now);
  if (t >= 1) return g.to;
  return {
    lng: lerp(g.from.lng, g.to.lng, t),
    lat: lerp(g.from.lat, g.to.lat, t),
    heading: lerpHeading(g.from.heading, g.to.heading, t),
  };
}

export function isGliding(g: Glide, now: number): boolean {
  return glideProgress(g, now) < 1;
}

/** A glide that is already at `fix` (no movement). */
export function stationary(fix: Fix, now: number): Glide {
  return { from: fix, to: fix, start: now, duration: 0 };
}

/**
 * Estimate the tick interval from arrival gaps: an exponential moving average, clamped to
 * [min, max]. Gaps longer than 3x max (a pause, a reconnect) are ignored.
 */
export function nextIntervalEstimate(
  current: number,
  gapMs: number,
  min: number,
  max: number,
  alpha = 0.5,
): number {
  if (!Number.isFinite(gapMs) || gapMs <= 0 || gapMs > max * 3) return current;
  const clamped = Math.min(max, Math.max(min, gapMs));
  return Math.min(max, Math.max(min, current * (1 - alpha) + clamped * alpha));
}
