/**
 * Pins (plan §4 `farm.pins`): a wet hole, a rock, a tile blowout… on a field. In slice 1f they
 * come only from Deere flags, read-only (`source = 'deere_flag'`, `read_only = true`, D19: app
 * pins are never pushed to Deere); drawing pins with photos on a phone is 2c. Written by the
 * `deere.fields` job (deere-data builder, docs/contracts-1f.md §5.2), served by `GET /api/pins`,
 * drawn by the "Deere flags" map layer and shown in a popup on the board and the phone.
 *
 * Pure TS + zod. Owned by the 1f foundation (contract file).
 */
import type { LineString, Point, Polygon } from 'geojson';
import { z } from 'zod';

export const PIN_KINDS = ['wet_hole', 'rock', 'tile_blowout', 'washout', 'hazard', 'note'] as const;
export type PinKind = (typeof PIN_KINDS)[number];

/** `deere_flag`: a Deere flag (read-only here); `app`: drawn in the app (2c). */
export const PIN_SOURCES = ['app', 'deere_flag'] as const;
export type PinSource = (typeof PIN_SOURCES)[number];

/** The geometries a pin may have (the ones Deere's Flags API accepts). */
export type PinGeometry = Point | LineString | Polygon;
export const PIN_GEOMETRY_TYPES = ['Point', 'LineString', 'Polygon'] as const;

/** One pin as the map and the popup show it. */
export interface PinView {
  /** farm.pins.id (deterministicId('deere_flag', <Deere flag id>) for flags). */
  id: string;
  kind: PinKind;
  fieldId: string | null;
  fieldName: string | null;
  note: string | null;
  /** The vendor's category or label (a Deere flag category name), when known. */
  category: string | null;
  geometry: PinGeometry;
  source: PinSource;
  readOnly: boolean;
  /** UTC ISO; null while open. A Deere flag archived in Operations Center is resolved. */
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/pins[?fieldId=<uuid>][&resolved=1] (viewer and up). Open pins unless `resolved=1`. */
export interface PinsResponse {
  builtAt: string;
  pins: PinView[];
}

export const PINS_URL = '/api/pins';

const iso = z.iso.datetime({ offset: true });
const position = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);

export const pinGeometrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('Point'), coordinates: position }),
  z.object({ type: z.literal('LineString'), coordinates: z.array(position).min(2) }),
  z.object({ type: z.literal('Polygon'), coordinates: z.array(z.array(position).min(4)).min(1) }),
]);

export const pinViewSchema = z.object({
  id: z.uuid(),
  kind: z.enum(PIN_KINDS),
  fieldId: z.uuid().nullable(),
  fieldName: z.string().nullable(),
  note: z.string().nullable(),
  category: z.string().nullable(),
  geometry: pinGeometrySchema,
  source: z.enum(PIN_SOURCES),
  readOnly: z.boolean(),
  resolvedAt: iso.nullable(),
  createdAt: iso,
  updatedAt: iso,
});

export const pinsResponseSchema = z.object({ builtAt: iso, pins: z.array(pinViewSchema) });
