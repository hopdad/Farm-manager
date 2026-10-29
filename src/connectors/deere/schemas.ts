/**
 * John Deere Operations Center shapes (zod), shared by the live client (./client.ts, ./oauth.ts),
 * the replay fixtures (./fixtures, ./replay.ts) and the vendor stand-in (src/sim/vendors/deere),
 * so the same schemas validate real, replayed and simulated responses (plan §5).
 *
 * SOURCES. developer.deere.com is not reachable from the build machine (Oct 29, 2026). The
 * shapes below follow Deere's own OpenAPI documents as published on the developer portal
 * (https://developer.deere.com/dev-docs/<api>; the portal's raw specs, fetched Oct 19, 2026 from
 * https://developer.deere.com/devDoc/apiDetails, are mirrored in the open-source
 * ProductOfAmerica/deere-sdk repository under specs/raw/*.yaml, commit 626e5d0), and recorded
 * sandbox responses in the MIT-licensed RealmFive/my_john_deere_api gem
 * (test/support/vcr/get_fields.yml, get_field.yml, get_flags.yml, get_organizations.yml):
 *  - Machine Locations, https://developer.deere.com/dev-docs/machine-locations
 *    (machine-locations.yaml): GET /machines/{principalId}/breadcrumbs?startDate&endDate&lastKnown,
 *    a Breadcrumb has point {lat, lon, altitude}, eventTimestamp, createTimestamp, speed
 *    (MeasurementAsDouble, unit "km1hr-1"), heading (MeasurementAsInteger), machineState
 *    ({ value: Idle | Working | Transporting }), fuelLevel, origin, correlationId; collections page
 *    with `nextPage` links such as `…/breadcrumbs;start=10;count=10`.
 *  - Fields, https://developer.deere.com/dev-docs/fields (fields.yaml): GET
 *    /organizations/{orgId}/fields, Field { id, name, archived, lastModifiedTime, links }.
 *  - Boundaries, https://developer.deere.com/dev-docs/boundaries (boundaries.yaml): GET
 *    /organizations/{orgId}/boundaries and /organizations/{orgId}/fields/{fieldId}/boundaries,
 *    Boundary { id, name, sourceType, area/workableArea (MeasurementAsDouble, ha), multipolygons:
 *    [Polygon { rings: [Ring { points: [Point {lat, lon}], type: exterior | interior,
 *    passable }] }], extent, active, archived, irrigated, signalType, links }; and GET
 *    /fieldOperations/{operationId}/boundary ("generate a boundary that surrounds the area
 *    worked by that field operation": our operation coverage).
 *  - Field Operations, https://developer.deere.com/dev-docs/field-operations
 *    (field-operations-api.yaml): GET /organizations/{orgId}/fields/{fieldId}/fieldOperations
 *    (?cropSeason&fieldOperationType&startDate&endDate&embed), FieldOperation { id,
 *    fieldOperationType, adaptMachineType, cropSeason, startDate, endDate, modifiedTime,
 *    fieldOperationMachines, products, links }; GET /fieldOperations/{id}/measurementTypes,
 *    FieldOperationMeasurement { measurementName, measurementCategory, area, yield,
 *    averageYield, averageMoisture, … as EventMeasurement { value, unitId } }.
 *  - Flags, https://developer.deere.com/dev-docs/flags (flags.yaml): GET
 *    /organizations/{orgId}/flags and /organizations/{orgId}/fields/{fieldId}/flags, Flag { id,
 *    geometry (GeoJSON Point/LineString/Polygon, sent as a JSON STRING on GET), notes, archived,
 *    proximityAlertEnabled, createdTime, lastModifiedTime, links }.
 * Still `doc-derived, confirm` until a recorded sandbox response (1f, listed on
 * /admin/connectors via src/connectors/doc-derived.ts): the OAuth issuer path and scopes, the
 * org `machines` link (the Equipment API's successor paths), units as the org sends them.
 * Objects are `loose`: extra vendor fields never fail a response.
 */
import { z } from 'zod';

/** The Deere API media type (Accept header). */
export const DEERE_MEDIA_TYPE = 'application/vnd.deere.axiom.v3+json';

/** Okta authorization-server id in Deere's sign-in URLs. // doc-derived, confirm */
export const DEERE_AUTH_SERVER_ID = 'aus78tnlaysMraFhC1t7';

/**
 * Scopes requested at consent. `offline_access` returns a refresh token; `eq1` reads equipment,
 * `org1` organizations, `ag1` fields/operations (1f). // doc-derived, confirm
 */
export const DEERE_SCOPES = ['openid', 'profile', 'offline_access', 'ag1', 'eq1', 'org1'] as const;

const time = z.iso.datetime({ offset: true });

export const deereLinkSchema = z.looseObject({ rel: z.string(), uri: z.string() });
export type DeereLink = z.infer<typeof deereLinkSchema>;

/** A Deere collection page: `{ links, total, values }`; the next page is the `nextPage` link. */
export function deereCollectionSchema<T extends z.ZodType>(item: T) {
  return z.looseObject({
    links: z.array(deereLinkSchema).default([]),
    total: z.number().int().nonnegative().optional(),
    values: z.array(item),
  });
}

export const deereOrganizationSchema = z.looseObject({
  '@type': z.literal('Organization').optional(),
  id: z.string().min(1),
  name: z.string(),
  type: z.string().optional(),
  member: z.boolean().optional(),
  links: z.array(deereLinkSchema).optional(),
});
export type DeereOrganization = z.infer<typeof deereOrganizationSchema>;
export const deereOrganizationsSchema = deereCollectionSchema(deereOrganizationSchema);

/** A machine in an org. // doc-derived, confirm (Equipment API field names) */
export const deereMachineSchema = z.looseObject({
  '@type': z.literal('Machine').optional(),
  id: z.string().min(1),
  name: z.string().optional(),
  vin: z.string().optional(),
  modelYear: z.number().int().optional(),
  links: z.array(deereLinkSchema).optional(),
});
export type DeereMachine = z.infer<typeof deereMachineSchema>;
export const deereMachinesSchema = deereCollectionSchema(deereMachineSchema);

/** Deere `MeasurementAsDouble` (`{ valueAsDouble, unit }`, e.g. km1hr-1, ha, prcnt). */
export const deereMeasurementAsDoubleSchema = z.looseObject({
  '@type': z.string().optional(),
  valueAsDouble: z.number(),
  unit: z.string().optional(),
});

/** Deere `MeasurementAsInteger`; the docs' own example sends the value as a string ("33"). */
const deereMeasurementAsIntegerSchema = z.looseObject({
  '@type': z.string().optional(),
  valueAsInteger: z.union([
    z.number(),
    z
      .string()
      .regex(/^-?\d+(\.\d+)?$/)
      .transform(Number),
  ]),
  unit: z.string().optional(),
});

/**
 * `{ value, unit }`: the shape the M0 vendor stand-in still serves (src/sim/vendors/deere).
 * Accepted next to the documented ones until the stand-in moves to them.
 */
const legacyMeasurementSchema = z.looseObject({ value: z.number(), unit: z.string() });

export const deerePointSchema = z.looseObject({
  '@type': z.literal('Point').optional(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  altitude: deereMeasurementAsDoubleSchema.optional(),
});

/** One breadcrumb (recorded only while working; Machine Locations API). */
export const deereBreadcrumbSchema = z.looseObject({
  '@type': z.literal('Breadcrumb').optional(),
  point: deerePointSchema,
  eventTimestamp: time,
  createTimestamp: time.optional(),
  /** Ground speed; documented `{ valueAsDouble, unit: 'km1hr-1' }`. */
  speed: z.union([deereMeasurementAsDoubleSchema, legacyMeasurementSchema]).optional(),
  /** Heading in degrees; documented `{ valueAsInteger }`. */
  heading: z.union([deereMeasurementAsIntegerSchema, legacyMeasurementSchema]).optional(),
  /** Documented `{ '@type': 'Breadcrumb$MachineState', value: 'Working' }` (the stand-in too); a bare string is accepted. */
  machineState: z
    .union([
      z.string(),
      z.looseObject({
        '@type': z.string().optional(),
        value: z.string().optional(),
        rawState: z.number().optional(),
      }),
    ])
    .optional(),
  fuelLevel: deereMeasurementAsDoubleSchema.optional(),
  origin: z.string().optional(),
  correlationId: z.string().optional(),
  links: z.array(deereLinkSchema).optional(),
});
export type DeereBreadcrumb = z.infer<typeof deereBreadcrumbSchema>;
export const deereBreadcrumbsSchema = deereCollectionSchema(deereBreadcrumbSchema);

// ---------------------------------------------------------------------------------------------
// Fields, boundaries, field operations, flags (1a replay fixtures; the syncs arrive at 1f)
// ---------------------------------------------------------------------------------------------

export const deereFieldSchema = z.looseObject({
  '@type': z.literal('Field').optional(),
  id: z.string().min(1),
  name: z.string(),
  archived: z.boolean().optional(),
  lastModifiedTime: time.optional(),
  links: z.array(deereLinkSchema).optional(),
});
export type DeereField = z.infer<typeof deereFieldSchema>;
export const deereFieldsSchema = deereCollectionSchema(deereFieldSchema);

export const deereRingSchema = z.looseObject({
  '@type': z.literal('Ring').optional(),
  points: z.array(deerePointSchema).min(3),
  type: z.enum(['exterior', 'interior']),
  passable: z.boolean().optional(),
});

export const deerePolygonSchema = z.looseObject({
  '@type': z.literal('Polygon').optional(),
  rings: z.array(deereRingSchema).min(1),
});

const deereExtentSchema = z.looseObject({
  '@type': z.string().optional(),
  topLeft: deerePointSchema,
  bottomRight: deerePointSchema,
});

/** A field boundary (also the shape of an operation's generated coverage boundary). */
export const deereBoundarySchema = z.looseObject({
  '@type': z.literal('Boundary').optional(),
  /** Absent on a boundary generated from a field operation (not stored in Deere yet). */
  id: z.string().min(1).optional(),
  name: z.string().optional(),
  sourceType: z.string().optional(),
  createdTime: time.optional(),
  modifiedTime: time.optional(),
  area: deereMeasurementAsDoubleSchema.optional(),
  workableArea: deereMeasurementAsDoubleSchema.optional(),
  multipolygons: z.array(deerePolygonSchema).min(1),
  extent: deereExtentSchema.optional(),
  active: z.boolean().optional(),
  archived: z.boolean().optional(),
  irrigated: z.boolean().optional(),
  signalType: z.string().optional(),
  links: z.array(deereLinkSchema).optional(),
});
export type DeereBoundary = z.infer<typeof deereBoundarySchema>;
export const deereBoundariesSchema = deereCollectionSchema(deereBoundarySchema);

/** Deere `EventMeasurement` (`{ value, unitId }`, ADAPT unit codes such as ac, bu1ac-1, prcnt). */
export const deereEventMeasurementSchema = z.looseObject({
  '@type': z.string().optional(),
  value: z.number(),
  unitId: z.string(),
});

export const deereFieldOperationMachineSchema = z.looseObject({
  '@type': z.string().optional(),
  erid: z.string().optional(),
  machineId: z.union([z.number().int(), z.string().min(1)]).optional(),
  vin: z.string().optional(),
  operators: z
    .array(z.looseObject({ operatorId: z.string().optional(), name: z.string().optional() }))
    .optional(),
});

export const deereFieldOperationSchema = z.looseObject({
  '@type': z.literal('FieldOperation').optional(),
  id: z.string().min(1),
  /** seeding, application, harvest, tillage (Deere mixes the case: "Tillage", "application"). */
  fieldOperationType: z.string().min(1),
  adaptMachineType: z.string().optional(),
  /** The crop year as a string ("2026"). */
  cropSeason: z.string().optional(),
  cropName: z.string().optional(),
  startDate: time,
  endDate: time.optional(),
  modifiedTime: time.optional(),
  fieldOperationMachines: z.array(deereFieldOperationMachineSchema).optional(),
  /** A product, a tank mix or a list of them (application / seeding). */
  products: z.unknown().optional(),
  links: z.array(deereLinkSchema).optional(),
});
export type DeereFieldOperation = z.infer<typeof deereFieldOperationSchema>;
export const deereFieldOperationsSchema = deereCollectionSchema(deereFieldOperationSchema);

export const deereFieldOperationMeasurementSchema = z.looseObject({
  '@type': z.string().optional(),
  measurementName: z.string().min(1),
  measurementCategory: z.string().optional(),
  /** The worked (covered) area. */
  area: deereEventMeasurementSchema.optional(),
  yield: deereEventMeasurementSchema.optional(),
  averageYield: deereEventMeasurementSchema.optional(),
  averageMoisture: deereEventMeasurementSchema.optional(),
  wetMass: deereEventMeasurementSchema.optional(),
  averageSpeed: deereEventMeasurementSchema.optional(),
  totalMaterial: deereEventMeasurementSchema.optional(),
  averageMaterial: deereEventMeasurementSchema.optional(),
  links: z.array(deereLinkSchema).optional(),
});
export type DeereFieldOperationMeasurement = z.infer<typeof deereFieldOperationMeasurementSchema>;
export const deereFieldOperationMeasurementsSchema = deereCollectionSchema(
  deereFieldOperationMeasurementSchema,
);

/** The GeoJSON geometries the Flags API accepts (all others are rejected by Deere). */
const position = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
export const deereFlagGeometrySchema = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('Point'), coordinates: position }),
  z.looseObject({ type: z.literal('LineString'), coordinates: z.array(position).min(2) }),
  z.looseObject({
    type: z.literal('Polygon'),
    coordinates: z.array(z.array(position).min(4)).min(1),
  }),
]);
export type DeereFlagGeometry = z.infer<typeof deereFlagGeometrySchema>;

export const deereFlagSchema = z.looseObject({
  '@type': z.literal('Flag').optional(),
  id: z.string().min(1),
  /** A GeoJSON geometry; GET sends it as a JSON string (see `deereFlagGeometry`). */
  geometry: z.union([z.string().min(2), deereFlagGeometrySchema]),
  notes: z.string().optional(),
  archived: z.boolean().optional(),
  proximityAlertEnabled: z.boolean().optional(),
  createdTime: time.optional(),
  lastModifiedTime: time.optional(),
  links: z.array(deereLinkSchema).optional(),
});
export type DeereFlag = z.infer<typeof deereFlagSchema>;
export const deereFlagsSchema = deereCollectionSchema(deereFlagSchema);

/** API error body. // doc-derived, confirm */
export const deereApiErrorSchema = z.looseObject({
  errors: z.array(z.looseObject({ message: z.string(), guid: z.string().optional() })),
});

/** RFC 6749 §5.1 token response (authorization_code and refresh_token grants). */
export const deereTokenResponseSchema = z.looseObject({
  access_token: z.string().min(1),
  token_type: z.string(),
  /** Access-token lifetime in seconds. */
  expires_in: z.number().positive(),
  /** Present with offline_access. Deere's real tokens rotate like the stand-in's do. */
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
});
export type DeereTokenResponse = z.infer<typeof deereTokenResponseSchema>;

/** RFC 6749 §5.2 error response. */
export const oauthErrorSchema = z.looseObject({
  error: z.string(),
  error_description: z.string().optional(),
});
export type OAuthErrorBody = z.infer<typeof oauthErrorSchema>;

/**
 * Raw item landed in ingest.raw_events (stream 'locations'): ONE breadcrumb with the org and
 * machine it was read from. externalId `${orgId}:${machineId}:${eventTimestamp}`.
 */
export const deereBreadcrumbRawSchema = z.object({
  orgId: z.string().min(1),
  machineId: z.string().min(1),
  breadcrumb: deereBreadcrumbSchema,
});
export type DeereBreadcrumbRaw = z.infer<typeof deereBreadcrumbRawSchema>;
