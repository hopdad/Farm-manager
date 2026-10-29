/**
 * Drainage tile lines (plan 1d "tile_lines import and draw tool"; docs/contracts-m1.md §3.1
 * farm.tile_lines): the shapes the app, the importer and the draw tool exchange. Pure (zod), so
 * the browser's draw tool and the server validate the same way.
 */
import { z } from 'zod';

export const TILE_KINDS = ['main', 'submain', 'lateral', 'unknown'] as const;
export type TileKind = (typeof TILE_KINDS)[number];

export const TILE_ORIGINS = ['installer_drawing', 'deere_tile_plow', 'manual'] as const;
export type TileOrigin = (typeof TILE_ORIGINS)[number];

export const TILE_SOURCES = ['app', 'import', 'demo', 'deere'] as const;
export type TileSource = (typeof TILE_SOURCES)[number];

export const TILE_KIND_LABELS: Record<TileKind, string> = {
  main: 'Main',
  submain: 'Submain',
  lateral: 'Lateral',
  unknown: 'Unknown',
};

/** Most vertices one drawn line may have (a hand-drawn line has tens; this stops abuse). */
export const MAX_TILE_VERTICES = 2000;

const lng = z.number().min(-180).max(180);
const lat = z.number().min(-90).max(90);
const position = z.tuple([lng, lat]).or(z.tuple([lng, lat, z.number()]));
const line = z.array(position).min(2).max(MAX_TILE_VERTICES);

/** A LineString or MultiLineString in WGS84 (stored as MultiLineString). */
export const tileGeometrySchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('LineString'), coordinates: line }),
  z.strictObject({
    type: z.literal('MultiLineString'),
    coordinates: z.array(line).min(1).max(100),
  }),
]);
export type TileGeometry = z.infer<typeof tileGeometrySchema>;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'not a date');

/** What a person sets on a line (the draw tool's form, PATCH bodies). */
export const tileAttributesSchema = z.strictObject({
  kind: z.enum(TILE_KINDS).optional(),
  /** Inches (4, 5, 6, 8, 10, 12, …). */
  sizeIn: z.number().positive().max(120).nullable().optional(),
  /** Feet below the surface. */
  depthFt: z.number().positive().max(30).nullable().optional(),
  installedOn: isoDate.nullable().optional(),
  installer: z.string().trim().max(200).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  /** Pin the field; omitted = the field the line mostly lies in (or none). */
  fieldId: z.uuid().nullable().optional(),
});
export type TileAttributes = z.infer<typeof tileAttributesSchema>;

/** POST /api/tile-lines. */
export const createTileLineSchema = tileAttributesSchema.extend({ geometry: tileGeometrySchema });
export type CreateTileLineInput = z.infer<typeof createTileLineSchema>;

/** PATCH /api/tile-lines/<id>: the version read (optimistic), and what changes. */
export const updateTileLineSchema = tileAttributesSchema.extend({
  version: z.string().min(1).max(64),
  geometry: tileGeometrySchema.optional(),
});
export type UpdateTileLineInput = z.infer<typeof updateTileLineSchema>;

/** One line as the API returns it. */
export interface TileLineView {
  id: string;
  fieldId: string | null;
  fieldName: string | null;
  geometry: { type: 'MultiLineString'; coordinates: [number, number][][] };
  kind: TileKind;
  sizeIn: number | null;
  depthFt: number | null;
  installedOn: string | null;
  origin: TileOrigin;
  installer: string | null;
  notes: string | null;
  source: TileSource;
  /** Geodesic length in feet. */
  lengthFt: number;
  /** farm.tile_lines.updated_at with microseconds: the PATCH/DELETE version. */
  version: string;
  /** Lines synced from Deere are read-only in the app (Operations Center is their master). */
  editable: boolean;
}

/** GET /api/tile-lines. */
export interface TileLinesResponse {
  lines: TileLineView[];
  /** May this session draw and edit (ROLE_FOR.editTileLines)? A hint; the server re-checks. */
  canEdit: boolean;
  /** More lines than the limit in view: zoom in. */
  truncated: boolean;
}

/** `w,s,e,n` → a bbox, or null when malformed (or larger than a county: refuse huge reads). */
export function parseBbox(s: string | null): [number, number, number, number] | null {
  if (!s) return null;
  const parts = s.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [w, south, e, n] = parts as [number, number, number, number];
  if (w < -180 || e > 180 || south < -90 || n > 90 || w >= e || south >= n) return null;
  if (e - w > 2 || n - south > 2) return null;
  return [w, south, e, n];
}
