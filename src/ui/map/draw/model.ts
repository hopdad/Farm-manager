/**
 * The tile-line draw tool's pure parts (plan 1d "tile_lines … draw tool"): the sketch being drawn,
 * the attribute form, and the GeoJSON the tool shows on the map. No React, no MapLibre, so it is
 * unit-tested directly; ./TileLineDrawTool.tsx wires it to the map and /api/tile-lines.
 */
import type { Feature, FeatureCollection, LineString, MultiLineString, Point } from 'geojson';
import {
  type CreateTileLineInput,
  MAX_TILE_VERTICES,
  TILE_KINDS,
  type TileKind,
  type TileLineView,
  type UpdateTileLineInput,
} from '../../../db/queries/tile-lines-schema';

export type LngLatPair = [number, number];

/** What the tool is doing. */
export type DrawMode =
  | { kind: 'closed' }
  /** Open: lines in view are shown; a tap selects one. */
  | { kind: 'browse'; selectedId: string | null }
  /** Tapping adds points. `editing`: reshaping an existing line (its id and version). */
  | { kind: 'draw'; points: LngLatPair[]; editing: { id: string; version: string } | null }
  /** The attribute form, for a new sketch (`points`) or an existing line (`editing`). */
  | {
      kind: 'form';
      points: LngLatPair[] | null;
      editing: { id: string; version: string } | null;
      form: TileForm;
    };

/** The form as typed (strings, so a half-typed number isn't lost). */
export interface TileForm {
  kind: TileKind;
  sizeIn: string;
  depthFt: string;
  installedOn: string;
  notes: string;
}

export const EMPTY_FORM: TileForm = {
  kind: 'lateral',
  sizeIn: '',
  depthFt: '',
  installedOn: '',
  notes: '',
};

const round7 = (n: number) => Math.round(n * 1e7) / 1e7;

export function addPoint(points: readonly LngLatPair[], p: LngLatPair): LngLatPair[] {
  if (points.length >= MAX_TILE_VERTICES) return [...points];
  const last = points[points.length - 1];
  const next: LngLatPair = [round7(p[0]), round7(p[1])];
  // A double tap on the same spot adds one point, not two.
  if (last && last[0] === next[0] && last[1] === next[1]) return [...points];
  return [...points, next];
}

export function undoPoint(points: readonly LngLatPair[]): LngLatPair[] {
  return points.slice(0, -1);
}

export function movePoint(
  points: readonly LngLatPair[],
  index: number,
  p: LngLatPair,
): LngLatPair[] {
  if (index < 0 || index >= points.length) return [...points];
  return points.map((q, i) => (i === index ? ([round7(p[0]), round7(p[1])] as LngLatPair) : q));
}

export const canFinish = (points: readonly LngLatPair[]) => points.length >= 2;

/** Great-circle length in feet (haversine; plenty for a tile run). */
export function lengthFt(points: readonly LngLatPair[]): number {
  const R = 20_902_231; // mean Earth radius in feet
  const rad = Math.PI / 180;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const [lng1, lat1] = points[i - 1] as LngLatPair;
    const [lng2, lat2] = points[i] as LngLatPair;
    const dLat = (lat2 - lat1) * rad;
    const dLng = (lng2 - lng1) * rad;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
    total += 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  return total;
}

/** The form of an existing line. */
export function formOf(line: TileLineView): TileForm {
  return {
    kind: line.kind,
    sizeIn: line.sizeIn === null ? '' : String(line.sizeIn),
    depthFt: line.depthFt === null ? '' : String(line.depthFt),
    installedOn: line.installedOn ?? '',
    notes: line.notes ?? '',
  };
}

export type FormResult =
  | {
      ok: true;
      value: Required<
        Pick<CreateTileLineInput, 'kind' | 'sizeIn' | 'depthFt' | 'installedOn' | 'notes'>
      >;
    }
  | { ok: false; error: string };

function positive(s: string, what: string, max: number): number | null | string {
  const t = s
    .trim()
    .replace(/["”]|in$|ft$/gi, '')
    .trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return `${what} must be a positive number`;
  if (n > max) return `${what} looks too large (at most ${max})`;
  return Math.round(n * 100) / 100;
}

/** Validate the typed form (the server validates again). */
export function parseForm(form: TileForm): FormResult {
  if (!(TILE_KINDS as readonly string[]).includes(form.kind))
    return { ok: false, error: 'pick a kind' };
  const sizeIn = positive(form.sizeIn, 'Size', 120);
  if (typeof sizeIn === 'string') return { ok: false, error: sizeIn };
  const depthFt = positive(form.depthFt, 'Depth', 30);
  if (typeof depthFt === 'string') return { ok: false, error: depthFt };
  const date = form.installedOn.trim();
  if (
    date !== '' &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)))
  ) {
    return { ok: false, error: 'Installed must be a date' };
  }
  const notes = form.notes.trim();
  return {
    ok: true,
    value: {
      kind: form.kind,
      sizeIn,
      depthFt,
      installedOn: date === '' ? null : date,
      notes: notes === '' ? null : notes.slice(0, 2000),
    },
  };
}

/** POST body for a new line. */
export function createPayload(
  points: readonly LngLatPair[],
  form: TileForm,
): CreateTileLineInput | string {
  if (!canFinish(points)) return 'a line needs at least two points';
  const f = parseForm(form);
  if (!f.ok) return f.error;
  return {
    ...f.value,
    geometry: { type: 'LineString', coordinates: points.map((p) => [p[0], p[1]]) },
  };
}

/** PATCH body: attributes, plus the shape when reshaped. */
export function updatePayload(
  version: string,
  form: TileForm,
  points: readonly LngLatPair[] | null,
): UpdateTileLineInput | string {
  const f = parseForm(form);
  if (!f.ok) return f.error;
  if (points && !canFinish(points)) return 'a line needs at least two points';
  return {
    version,
    ...f.value,
    ...(points
      ? { geometry: { type: 'LineString' as const, coordinates: points.map((p) => [p[0], p[1]]) } }
      : {}),
  };
}

/** The longest part of a stored line, as the editable sketch. */
export function pointsOf(line: TileLineView): LngLatPair[] {
  const parts = line.geometry.coordinates;
  let best = parts[0] ?? [];
  for (const p of parts) if (p.length > best.length) best = p;
  return best.map((c) => [c[0], c[1]] as LngLatPair);
}

/** The lines in view, for the tool's own map source (selected one flagged). */
export function linesCollection(
  lines: readonly TileLineView[],
  selectedId: string | null,
  hiddenId: string | null = null,
): FeatureCollection<MultiLineString, { id: string; kind: TileKind; selected: boolean }> {
  return {
    type: 'FeatureCollection',
    features: lines
      .filter((l) => l.id !== hiddenId)
      .map((l) => ({
        type: 'Feature',
        id: l.id,
        geometry: l.geometry,
        properties: { id: l.id, kind: l.kind, selected: l.id === selectedId },
      })),
  };
}

/** The sketch: its line (≥ 2 points) and every vertex (with its index, for dragging). */
export function sketchCollection(
  points: readonly LngLatPair[],
): FeatureCollection<LineString | Point, { role: 'line' | 'vertex'; index: number }> {
  const features: Feature<LineString | Point, { role: 'line' | 'vertex'; index: number }>[] = [];
  if (points.length >= 2) {
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: points.map((p) => [p[0], p[1]]) },
      properties: { role: 'line', index: -1 },
    });
  }
  points.forEach((p, index) => {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p[0], p[1]] },
      properties: { role: 'vertex', index },
    });
  });
  return { type: 'FeatureCollection', features };
}

/** `w,s,e,n` of a view padded by `pad` of its size on each side (clamped to the API's limits). */
export function paddedBbox(
  b: { west: number; south: number; east: number; north: number },
  pad = 0.25,
): string {
  const dx = (b.east - b.west) * pad;
  const dy = (b.north - b.south) * pad;
  const cx = (b.east + b.west) / 2;
  const cy = (b.north + b.south) / 2;
  const hx = Math.min((b.east - b.west) / 2 + dx, 0.99);
  const hy = Math.min((b.north - b.south) / 2 + dy, 0.99);
  const r = (n: number) => n.toFixed(6);
  return [
    r(Math.max(-180, cx - hx)),
    r(Math.max(-90, cy - hy)),
    r(Math.min(180, cx + hx)),
    r(Math.min(90, cy + hy)),
  ].join(',');
}

/** '1,240 ft · 4" lateral at 3.5 ft'. */
export function describeLine(
  l: Pick<TileLineView, 'lengthFt' | 'sizeIn' | 'depthFt' | 'kind'>,
): string {
  const parts = [`${Math.round(l.lengthFt).toLocaleString('en-US')} ft`];
  const size = l.sizeIn !== null ? `${l.sizeIn}" ` : '';
  const depth = l.depthFt !== null ? ` at ${l.depthFt} ft` : '';
  parts.push(`${size}${l.kind}${depth}`);
  return parts.join(' · ');
}
