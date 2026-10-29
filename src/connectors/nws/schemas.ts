/**
 * zod schemas of the api.weather.gov responses the NWS connector reads (the stand-in at
 * `${VENDOR_SIM_URL}/nws` and the replay fixtures are validated with the same ones).
 *
 * Source: the NWS API's OpenAPI document (https://api.weather.gov/openapi.json, version 2.0.0;
 * a copy is vendored in github.com/ckampfe/weather_dot_gov, Feb 2025) and
 * https://www.weather.gov/documentation/services-web-api. Paths used:
 *   GET /points/{latitude},{longitude}            PointGeoJson
 *   GET /gridpoints/{wfo}/{x},{y}                 GridpointGeoJson (raw forecast layers)
 *   GET /gridpoints/{wfo}/{x},{y}/stations        ObservationStationCollectionGeoJson
 *   GET /stations/{stationId}/observations        ObservationCollectionGeoJson (?start, ?limit)
 * Responses are GeoJSON (`Accept: application/geo+json`); errors are application/problem+json
 * (ProblemDetail: type, title, status, detail, instance, correlationId).
 *
 * The schemas are lenient where NWS adds fields over time (objects are not strict) and strict
 * where the app depends on a value (grid ids, update times, layer values).
 */
import { z } from 'zod';

const isoDateTime = z.iso.datetime({ offset: true });

/** GeoJSON Point geometry (coordinates are [lon, lat]). */
export const nwsPointGeometrySchema = z.object({
  type: z.literal('Point'),
  coordinates: z.tuple([z.number(), z.number()]).rest(z.number()),
});

const ring = z.array(z.tuple([z.number(), z.number()]).rest(z.number())).min(4);

/** The grid cell outline a /gridpoints answer carries. */
export const nwsPolygonGeometrySchema = z.object({
  type: z.literal('Polygon'),
  coordinates: z.array(ring).min(1),
});

/** QuantitativeValue: a number (or null) with its unit (observations). */
export const nwsQuantitativeValueSchema = z.object({
  value: z.number().nullable().optional(),
  unitCode: z.string().optional(),
  qualityControl: z.string().optional(),
});
export type NwsQuantitativeValue = z.infer<typeof nwsQuantitativeValueSchema>;

/** Three-letter forecast office id (NWSForecastOfficeId). */
const wfo = z.string().regex(/^[A-Z]{3}$/);

// ---------------------------------------------------------------------------------------------
// /points/{lat},{lon}
// ---------------------------------------------------------------------------------------------

export const nwsPointSchema = z.object({
  type: z.literal('Feature'),
  geometry: nwsPointGeometrySchema.nullable().optional(),
  properties: z.object({
    gridId: wfo,
    gridX: z.number().int().min(0),
    gridY: z.number().int().min(0),
    forecastGridData: z.string().min(1),
    observationStations: z.string().min(1),
    timeZone: z.string().min(1).optional(),
  }),
});
export type NwsPoint = z.infer<typeof nwsPointSchema>;

// ---------------------------------------------------------------------------------------------
// /gridpoints/{wfo}/{x},{y}
// ---------------------------------------------------------------------------------------------

/**
 * ISO 8601 interval (OpenAPI `ISO8601Interval`): start/end, start/duration or duration/end.
 * NWS gridpoint layers use start/duration, e.g. '2026-10-29T14:00:00+00:00/PT3H'.
 */
export const nwsValidTimeSchema = z
  .string()
  .regex(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})|P[0-9YMWDTHS.]+)\/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})|P[0-9YMWDTHS.]+)$/,
    'not an ISO 8601 interval',
  );

/** GridpointQuantitativeValueLayer. */
export const nwsGridLayerSchema = z.object({
  uom: z.string().optional(),
  values: z.array(z.object({ validTime: nwsValidTimeSchema, value: z.number().nullable() })),
});
export type NwsGridLayer = z.infer<typeof nwsGridLayerSchema>;

/** The layers the app reads (others are ignored and not kept). */
export const NWS_GRID_LAYERS = [
  'temperature',
  'dewpoint',
  'relativeHumidity',
  'windSpeed',
  'windGust',
  'windDirection',
  'probabilityOfPrecipitation',
  'quantitativePrecipitation',
  'skyCover',
  'mixingHeight',
  'transportWindSpeed',
] as const;
export type NwsGridLayerName = (typeof NWS_GRID_LAYERS)[number];

const layers = Object.fromEntries(
  NWS_GRID_LAYERS.map((k) => [k, nwsGridLayerSchema.optional()]),
) as Record<NwsGridLayerName, z.ZodOptional<typeof nwsGridLayerSchema>>;

export const nwsGridpointSchema = z.object({
  type: z.literal('Feature'),
  geometry: nwsPolygonGeometrySchema.nullable().optional(),
  properties: z.object({
    updateTime: isoDateTime,
    validTimes: z.string().optional(),
    gridId: wfo,
    gridX: z.number().int().min(0),
    gridY: z.number().int().min(0),
    ...layers,
  }),
});
export type NwsGridpoint = z.infer<typeof nwsGridpointSchema>;

// ---------------------------------------------------------------------------------------------
// /gridpoints/{wfo}/{x},{y}/stations
// ---------------------------------------------------------------------------------------------

export const nwsStationCollectionSchema = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(
    z.object({
      type: z.literal('Feature'),
      geometry: nwsPointGeometrySchema,
      properties: z.object({
        stationIdentifier: z.string().regex(/^[A-Z0-9]{3,8}$/),
        name: z.string().nullable().optional(),
        timeZone: z.string().optional(),
      }),
    }),
  ),
  observationStations: z.array(z.string()).optional(),
});
export type NwsStationCollection = z.infer<typeof nwsStationCollectionSchema>;

// ---------------------------------------------------------------------------------------------
// /stations/{stationId}/observations
// ---------------------------------------------------------------------------------------------

const qv = nwsQuantitativeValueSchema.nullable().optional();

export const nwsObservationSchema = z.object({
  type: z.literal('Feature'),
  geometry: nwsPointGeometrySchema.nullable().optional(),
  properties: z.object({
    /** Station URI, e.g. https://api.weather.gov/stations/KADG. */
    station: z.string().optional(),
    /** Present in current responses (doc-derived, confirm); else taken from `station`. */
    stationId: z.string().optional(),
    stationName: z.string().optional(),
    timestamp: isoDateTime,
    temperature: qv,
    dewpoint: qv,
    windDirection: qv,
    windSpeed: qv,
    windGust: qv,
    relativeHumidity: qv,
    precipitationLastHour: qv,
  }),
});
export type NwsObservation = z.infer<typeof nwsObservationSchema>;

export const nwsObservationCollectionSchema = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(nwsObservationSchema),
});
export type NwsObservationCollection = z.infer<typeof nwsObservationCollectionSchema>;

/** ProblemDetail (error bodies). */
export const nwsProblemSchema = z.object({
  type: z.string().optional(),
  title: z.string(),
  status: z.number(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  correlationId: z.string().optional(),
});
