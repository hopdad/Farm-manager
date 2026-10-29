/**
 * Sunrise and sunset for the spray inversion heuristic (pure; browser-safe).
 *
 * The sunrise equation as NOAA and the astronomical almanac state it (mean solar noon, solar
 * mean anomaly, equation of the centre, ecliptic longitude, declination, hour angle at the
 * standard altitude of the sun's upper limb, -0.833° for refraction): accurate to a minute or
 * two at Michigan's latitudes, which is plenty for "within 2 hours of sunrise".
 * Reference: https://en.wikipedia.org/wiki/Sunrise_equation (NOAA's solar calculator uses the
 * same series).
 */

const DAY_MS = 86_400_000;
const J2000 = 2451545.0;
const RAD = Math.PI / 180;

const toJulian = (ms: number) => ms / DAY_MS + 2440587.5;
const fromJulian = (j: number) => (j - 2440587.5) * DAY_MS;

export interface SunDay {
  /** Solar noon (UTC ms). */
  transit: number;
  /** null in polar day/night (never in Michigan). */
  sunrise: number | null;
  sunset: number | null;
  /** True when the sun stays below the horizon all day; false for midnight sun. */
  polarNight: boolean;
}

/** The sun on solar day `n` (days since J2000, rounded) at a place (lng east positive). */
function sunDay(n: number, lat: number, lng: number): SunDay {
  const jStar = n - lng / 360;
  const M = (((357.5291 + 0.98560028 * jStar) % 360) + 360) % 360;
  const C =
    1.9148 * Math.sin(M * RAD) + 0.02 * Math.sin(2 * M * RAD) + 0.0003 * Math.sin(3 * M * RAD);
  const lambda = (M + C + 180 + 102.9372) % 360;
  const jTransit = J2000 + jStar + 0.0053 * Math.sin(M * RAD) - 0.0069 * Math.sin(2 * lambda * RAD);
  const sinDecl = Math.sin(lambda * RAD) * Math.sin(23.4397 * RAD);
  const cosDecl = Math.cos(Math.asin(sinDecl));
  const cosW =
    (Math.sin(-0.833 * RAD) - Math.sin(lat * RAD) * sinDecl) / (Math.cos(lat * RAD) * cosDecl);
  const transit = fromJulian(jTransit);
  if (cosW > 1) return { transit, sunrise: null, sunset: null, polarNight: true };
  if (cosW < -1) return { transit, sunrise: null, sunset: null, polarNight: false };
  const w = Math.acos(cosW) / RAD / 360;
  return {
    transit,
    sunrise: fromJulian(jTransit - w),
    sunset: fromJulian(jTransit + w),
    polarNight: false,
  };
}

/** The solar day whose noon is nearest `ms` at longitude `lng`. */
export function sunAt(ms: number, lat: number, lng: number): SunDay {
  const n = Math.round(toJulian(ms) - J2000 + lng / 360);
  return sunDay(n, lat, lng);
}

export interface SunContext {
  sunrise: string | null;
  sunset: string | null;
  /** The sun is below the horizon at the instant. */
  night: boolean;
  /** Minutes to the nearest sunrise or sunset (either side); null in polar day/night. */
  minutesToEvent: number | null;
}

/** Where `ms` sits relative to the sun's rise and set at (lat, lng). */
export function sunContext(ms: number, lat: number, lng: number): SunContext {
  const today = sunAt(ms, lat, lng);
  const days = [-1, 0, 1].map((k) => sunAt(ms + k * DAY_MS, lat, lng));
  const events: number[] = [];
  for (const d of days) {
    if (d.sunrise !== null) events.push(d.sunrise);
    if (d.sunset !== null) events.push(d.sunset);
  }
  const night =
    today.sunrise === null || today.sunset === null
      ? today.polarNight
      : ms < today.sunrise || ms > today.sunset;
  const nearest = events.length ? Math.min(...events.map((e) => Math.abs(ms - e))) / 60_000 : null;
  return {
    sunrise: today.sunrise === null ? null : new Date(today.sunrise).toISOString(),
    sunset: today.sunset === null ? null : new Date(today.sunset).toISOString(),
    night,
    minutesToEvent: nearest === null ? null : Math.round(nearest),
  };
}
