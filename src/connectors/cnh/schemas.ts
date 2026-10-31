/**
 * CNH FieldOps JSON shapes (the ISO-style telemetry is XML: ../aemp/parse.ts reads it), from CNH's
 * published OpenAPI: SwaggerHub CNH/FieldOps-API 1.0.0
 * (https://api.swaggerhub.com/apis/CNH/FieldOps-API/1.0.0), linked from develop.cnh.com, read
 * Oct 30, 2026 (vendor-docs cnh.md §2). The spec's own examples and schemas disagree in places;
 * both spellings are accepted (`companyName` vs `name`, `subscriptions` vs `subscription`), every
 * field of the equipment list is nullable, and objects stay loose so a field CNH adds never fails
 * a page. Shared by the client (./client.ts) and the stand-in (src/sim/vendors/cnh/routes.ts).
 */
import { z } from 'zod';

const str = z.string();
const nullableStr = z.string().nullable().optional();

export const cnhLinkSchema = z.looseObject({ rel: str, href: str });
export type CnhLink = z.infer<typeof cnhLinkSchema>;

/** GET /companies: `{ companies: [{ id, name }] }` (the schema says companyName). */
export const cnhCompaniesSchema = z.looseObject({
  companies: z.array(
    z.looseObject({ id: z.string().min(1), name: nullableStr, companyName: nullableStr }),
  ),
});
export type CnhCompanies = z.infer<typeof cnhCompaniesSchema>;

/** GET /UserProfile (capital U and P). */
export const cnhUserProfileSchema = z.looseObject({
  companyId: nullableStr,
  companyName: nullableStr,
  userName: nullableStr,
});

const named = z.looseObject({ id: z.string().min(1), name: nullableStr });

/** GET /companies/{companyId}/overview: growers → farms → fields (names only, no boundaries). */
export const cnhOverviewSchema = z.looseObject({
  companyId: str,
  companyName: nullableStr,
  growers: z.array(
    named.extend({
      farms: z.array(named.extend({ fields: z.array(named).default([]) })).default([]),
    }),
  ),
});
export type CnhOverview = z.infer<typeof cnhOverviewSchema>;

/** One boundary record of a field (no geometry): OUTER, or INNER with `passible`. */
export const cnhBoundaryListItemSchema = z.looseObject({
  id: z.string().min(1),
  boundaryType: nullableStr,
  passible: z.boolean().nullable().optional(),
  /** Units conflict in the spec (square metres on one page, acres on another): display only. */
  area: z.number().nullable().optional(),
  createdDate: nullableStr,
  modifiedDate: nullableStr,
});

/** GET /companies/{companyId}/fields/{fieldId}/boundaries */
export const cnhFieldBoundariesSchema = z.looseObject({
  companyId: nullableStr,
  growerId: nullableStr,
  farmId: nullableStr,
  fieldId: nullableStr,
  boundaries: z.array(cnhBoundaryListItemSchema),
  irrigated: z.boolean().nullable().optional(),
  ownershipType: nullableStr,
});
export type CnhFieldBoundaries = z.infer<typeof cnhFieldBoundariesSchema>;

/**
 * GET /companies/{companyId}/boundaries/{boundaryId}: one boundary WITH its geometry, GeoJSON
 * shaped (`type` + `coordinates`, [lon, lat]; the schema declares two levels, the example has
 * three: read as GeoJSON).
 */
export const cnhBoundarySchema = z.looseObject({
  companyId: nullableStr,
  growerId: nullableStr,
  farmId: nullableStr,
  fieldId: nullableStr,
  boundaryId: z.string().min(1),
  boundaryType: nullableStr,
  passible: z.boolean().nullable().optional(),
  area: z.number().nullable().optional(),
  type: z.enum(['Polygon', 'MultiPolygon']),
  coordinates: z.array(z.unknown()),
  boundingBox: z.array(z.number()).nullable().optional(),
});
export type CnhBoundary = z.infer<typeof cnhBoundarySchema>;

const subscriptionSchema = z.looseObject({
  name: nullableStr,
  validFrom: nullableStr,
  expirationDate: nullableStr,
});

const deviceSchema = z.looseObject({
  model: nullableStr,
  serialNumber: nullableStr,
  fileType: nullableStr,
  /** GET /equipment/{vin} only: modem or display. */
  type: nullableStr,
  subscriptions: z.array(subscriptionSchema).nullable().optional(),
  subscription: z.array(subscriptionSchema).nullable().optional(),
});

/** One machine of GET /equipment (every field nullable; machines are addressed by VIN). */
export const cnhEquipmentSchema = z.looseObject({
  vin: nullableStr,
  nickName: nullableStr,
  companyName: nullableStr,
  companyId: nullableStr,
  brand: nullableStr,
  model: nullableStr,
  productLine: nullableStr,
  productType: nullableStr,
  fileTransferEnabled: z.boolean().nullable().optional(),
  devices: z.array(deviceSchema).nullable().optional(),
});
export type CnhEquipment = z.infer<typeof cnhEquipmentSchema>;

/** GET /equipment: the whole list, no paging. Items are read one by one (bad ones dropped). */
export const cnhEquipmentListSchema = z.looseObject({ equipment: z.array(z.unknown()) });

/** `errorTags`: an array in the spec, "a comma separated list" in the guide: both. */
const errorTags = z
  .union([z.array(z.string()), z.string()])
  .nullable()
  .optional()
  .transform((v) =>
    v == null
      ? []
      : Array.isArray(v)
        ? v
        : v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
  );

/** GET /equipment/{vin}/metrics: the CAN-parameter feed (cursor + limit; one-day windows). */
export const cnhMetricsSchema = z.looseObject({
  links: z.array(cnhLinkSchema).default([]),
  items: z.array(
    z.looseObject({
      systemDatetime: nullableStr,
      position: z
        .looseObject({
          time: nullableStr,
          latitude: z.number().nullable().optional(),
          longitude: z.number().nullable().optional(),
          fieldIds: z.array(str).nullable().optional(),
          errorTags,
        })
        .nullable()
        .optional(),
      telemetry: z
        .array(
          z.looseObject({
            metric: str,
            function: nullableStr,
            value: z.union([z.string(), z.number()]).nullable().optional(),
            type: nullableStr,
            unitOfMeasure: nullableStr,
            errorTags,
          }),
        )
        .nullable()
        .optional(),
    }),
  ),
});
export type CnhMetrics = z.infer<typeof cnhMetricsSchema>;

/** Auth0's token response (the spec documents `{}`: Auth0's standard fields assumed). */
export const cnhTokenResponseSchema = z.looseObject({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive().optional(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
});
export type CnhTokenResponse = z.infer<typeof cnhTokenResponseSchema>;

/** The EULA refusal text CNH documents for every telemetry call (403). */
export const CNH_EULA_MESSAGE = 'EULA not accepted for the VIN. Login to FieldOps to accept EULA.';

/** CNH's OAuth scope (the only one documented). */
export const CNH_SCOPE = 'offline_access';
