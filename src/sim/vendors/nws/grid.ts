/**
 * The NWS stand-in's forecast grid and observation stations.
 *
 * NWS forecasts live on ~2.5 km grids, one per forecast office (WFO), on a Lambert conformal
 * projection. The stand-in uses a plain 2.5 km latitude/longitude lattice instead (good enough
 * for "most fields share a few cells"): every point maps to office DTX (Detroit/Pontiac, which
 * covers Lenawee and Monroe counties) and an (x, y) cell. Cell ids look like real ones
 * ('DTX/64,40') but are NOT NWS's: never compare them with live grid ids.
 *
 * Stations: four airports around the demo farm with approximate public locations (simulated
 * observations only; their real reports are never used here).
 */
import type { Polygon } from 'geojson';

export const SIM_WFO = 'DTX';

/** South-west corner of cell (0, 0). */
const LNG0 = -86.0;
const LAT0 = 41.0;
/** Cell size: 2.5 km at 42° N. */
const DLAT = 2.5 / 111.2;
const DLNG = 2.5 / (111.32 * Math.cos((42 * Math.PI) / 180));
/** The lattice covers the DTX office area the stand-in serves (else 404 like real NWS). */
const MAX_X = 199;
const MAX_Y = 199;

export interface SimCell {
  wfo: string;
  x: number;
  y: number;
}

/** The cell containing a point, or null outside the simulated office area. */
export function simCellAt(lng: number, lat: number): SimCell | null {
  const x = Math.floor((lng - LNG0) / DLNG);
  const y = Math.floor((lat - LAT0) / DLAT);
  if (x < 0 || y < 0 || x > MAX_X || y > MAX_Y) return null;
  return { wfo: SIM_WFO, x, y };
}

/** A cell's outline (closed ring, counter-clockwise). */
export function simCellPolygon(x: number, y: number): Polygon {
  const w = LNG0 + x * DLNG;
  const s = LAT0 + y * DLAT;
  const e = w + DLNG;
  const n = s + DLAT;
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return {
    type: 'Polygon',
    coordinates: [
      [
        [r(w), r(s)],
        [r(e), r(s)],
        [r(e), r(n)],
        [r(w), r(n)],
        [r(w), r(s)],
      ],
    ],
  };
}

/** The cell's centre. */
export function simCellCenter(x: number, y: number): { lng: number; lat: number } {
  return { lng: LNG0 + (x + 0.5) * DLNG, lat: LAT0 + (y + 0.5) * DLAT };
}

/** Is (x, y) a cell of the simulated office? */
export function isSimCell(wfo: string, x: number, y: number): boolean {
  return wfo === SIM_WFO && x >= 0 && y >= 0 && x <= MAX_X && y <= MAX_Y;
}

export interface SimStation {
  id: string;
  name: string;
  lng: number;
  lat: number;
  elevationM: number;
}

/** Approximate locations (simulated observations only). */
export const SIM_STATIONS: readonly SimStation[] = [
  {
    id: 'KADG',
    name: 'Adrian, Lenawee County Airport',
    lng: -84.0773,
    lat: 41.8676,
    elevationM: 243,
  },
  { id: 'KTTF', name: 'Monroe, Custer Airport', lng: -83.4349, lat: 41.9399, elevationM: 187 },
  { id: 'KTOL', name: 'Toledo Express Airport', lng: -83.8078, lat: 41.5868, elevationM: 208 },
  { id: 'KJYM', name: 'Hillsdale Municipal Airport', lng: -84.5858, lat: 41.9213, elevationM: 344 },
];

export function simStation(id: string): SimStation | undefined {
  return SIM_STATIONS.find((s) => s.id === id);
}
