/**
 * EPSG:3078, "NAD83 / Michigan Oblique Mercator" (Michigan GeoRef, metres): the metric CRS the
 * plan uses for passes and buffers (plan §4: Lenawee straddles UTM 16/17, so no UTM).
 *
 * Hotine Oblique Mercator, variant A (EPSG method 9812, PROJ `omerc +no_uoff`), forward and
 * inverse from IOGP Guidance Note 7-2 §3.2.4, with the parameters PostGIS carries for 3078:
 *   +proj=omerc +lat_0=45.30916666666666 +lonc=-86 +alpha=337.25556 +gamma=337.25556
 *   +k=0.9996 +x_0=2546731.496 +y_0=-4354009.816 +no_uoff +datum=NAD83 (GRS80, towgs84 = 0)
 * WGS84 and NAD83 are treated as identical here, exactly as PostGIS's definition does.
 * src/sim/geo/georef.db.test.ts checks it against ST_Transform (agreement is sub-millimetre).
 */
import type { LngLat } from '../types';
import type { Vec } from './vec';

export const GEOREF_SRID = 3078;

const DEG = Math.PI / 180;
const A_AXIS = 6378137;
const FLATTENING = 1 / 298.257222101;
const E2 = FLATTENING * (2 - FLATTENING);
const E = Math.sqrt(E2);

const PHI_C = 45.30916666666666 * DEG;
const LAMBDA_C = -86 * DEG;
const ALPHA_C = 337.25556 * DEG;
const GAMMA_C = 337.25556 * DEG;
const K_C = 0.9996;
const FALSE_EASTING = 2546731.496;
const FALSE_NORTHING = -4354009.816;

function tFn(phi: number): number {
  const s = E * Math.sin(phi);
  return Math.tan(Math.PI / 4 - phi / 2) / ((1 - s) / (1 + s)) ** (E / 2);
}

const B = Math.sqrt(1 + (E2 * Math.cos(PHI_C) ** 4) / (1 - E2));
const A = (A_AXIS * B * K_C * Math.sqrt(1 - E2)) / (1 - E2 * Math.sin(PHI_C) ** 2);
const T0 = tFn(PHI_C);
const D = (B * Math.sqrt(1 - E2)) / (Math.cos(PHI_C) * Math.sqrt(1 - E2 * Math.sin(PHI_C) ** 2));
const F = D + Math.sqrt(Math.max(1, D * D) - 1) * Math.sign(PHI_C);
const H = F * T0 ** B;
const G = (F - 1 / F) / 2;
const GAMMA_0 = Math.asin(Math.sin(ALPHA_C) / D);
const LAMBDA_0 = LAMBDA_C - Math.asin(G * Math.tan(GAMMA_0)) / B;
const COS_G0 = Math.cos(GAMMA_0);
const SIN_G0 = Math.sin(GAMMA_0);
const COS_GC = Math.cos(GAMMA_C);
const SIN_GC = Math.sin(GAMMA_C);

const E4 = E2 * E2;
const E6 = E4 * E2;
const E8 = E6 * E2;
const C2 = E2 / 2 + (5 * E4) / 24 + E6 / 12 + (13 * E8) / 360;
const C4 = (7 * E4) / 48 + (29 * E6) / 240 + (811 * E8) / 11520;
const C6 = (7 * E6) / 120 + (81 * E8) / 1120;
const C8 = (4279 * E8) / 161280;

/** WGS84 longitude/latitude (degrees) -> EPSG:3078 easting/northing (metres). */
export function toGeoRef(lng: number, lat: number): Vec {
  const phi = lat * DEG;
  const dl = B * (lng * DEG - LAMBDA_0);
  const Q = H / tFn(phi) ** B;
  const S = (Q - 1 / Q) / 2;
  const T = (Q + 1 / Q) / 2;
  const V = Math.sin(dl);
  const U = (-V * COS_G0 + S * SIN_G0) / T;
  const v = (A * Math.log((1 - U) / (1 + U))) / (2 * B);
  const u = (A / B) * Math.atan2(S * COS_G0 + V * SIN_G0, Math.cos(dl));
  return {
    x: v * COS_GC + u * SIN_GC + FALSE_EASTING,
    y: u * COS_GC - v * SIN_GC + FALSE_NORTHING,
  };
}

/** EPSG:3078 easting/northing (metres) -> WGS84 [longitude, latitude] (degrees). */
export function fromGeoRef(x: number, y: number): LngLat {
  const de = x - FALSE_EASTING;
  const dn = y - FALSE_NORTHING;
  const v = de * COS_GC - dn * SIN_GC;
  const u = dn * COS_GC + de * SIN_GC;
  const Q = Math.exp(-(B * v) / A);
  const S = (Q - 1 / Q) / 2;
  const T = (Q + 1 / Q) / 2;
  const V = Math.sin((B * u) / A);
  const U = (V * COS_G0 + S * SIN_G0) / T;
  const t = (H / Math.sqrt((1 + U) / (1 - U))) ** (1 / B);
  const chi = Math.PI / 2 - 2 * Math.atan(t);
  const phi =
    chi +
    Math.sin(2 * chi) * C2 +
    Math.sin(4 * chi) * C4 +
    Math.sin(6 * chi) * C6 +
    Math.sin(8 * chi) * C8;
  const lambda = LAMBDA_0 - Math.atan2(S * COS_G0 - V * SIN_G0, Math.cos((B * u) / A)) / B;
  return [lambda / DEG, phi / DEG];
}

export function lngLatToGeoRef(p: LngLat): Vec {
  return toGeoRef(p[0], p[1]);
}
