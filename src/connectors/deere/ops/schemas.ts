/**
 * Field operation shapes deere.ops reads (slice 1f, deere-ops; docs/contracts-1f.md §5.1), built
 * on the shared Deere schemas (../schemas.ts, a contract file): the operation listing with its
 * products, varieties and embedded measurement types, and the raw item the `operations` stream
 * lands in ingest.raw_events.
 *
 * Source: Deere's Field Operations API (https://developer.deere.com/dev-docs/field-operations;
 * the portal's spec feed, field-operations__field-operation.yaml and
 * field-operations__measurement-type.yaml, read Oct 30, 2026), scope `ag2` on every endpoint:
 *  - GET /organizations/{orgId}/fields/{fieldId}/fieldOperations?cropSeason=&fieldOperationType=
 *    &embed=measurementTypes: `FieldOperation { id, fieldOperationType (mixed case: "Tillage",
 *    "application"), cropSeason (a string), cropName (a crop token, CORN_WET), startDate,
 *    endDate, modifiedTime, varieties[] (seeding and harvest), products (an object OR a list
 *    since Nov 17, 2023; a tank mix carries `carrier` and `components`), fieldOperationMachines[]
 *    { machineId (int), vin, operators[] { name } }, links }`.
 *  - GET /fieldOperations/{id}/measurementTypes: `FieldOperationMeasurement { measurementName
 *    (SeedingRateResult, ApplicationRateResult, HarvestYieldResult, HarvestMoistureResult, …),
 *    measurementCategory, area, yield, averageYield, averageMoisture, averageSpeed,
 *    totalMaterial, averageMaterial … as EventMeasurement { value, unitId } }`.
 *  - GET /fieldOperations/{id}/boundary: a Boundary around the worked area; 400 when the field
 *    has an active boundary or was merged.
 * Doc-derived, confirm (./doc-derived.ts): where `embed=measurementTypes` puts the measurements
 * on an operation (the spec names the embed, not its shape: a list or a `{ values }`
 * collection are both read), product shapes as our org sends them.
 * Objects are loose; products and varieties that don't parse are dropped, not fatal.
 */
import { z } from 'zod';
import {
  deereBoundarySchema,
  deereCollectionSchema,
  deereEventMeasurementSchema,
  deereFieldOperationMeasurementSchema,
  deereFieldOperationSchema,
} from '../schemas';

/** `fieldOperationType` query values as Deere documents them ("APPLICATION", "HARVEST", …). */
export const DEERE_FIELD_OPERATION_TYPES = [
  'SEEDING',
  'APPLICATION',
  'HARVEST',
  'TILLAGE',
] as const;

/** One component of a tank mix (or its carrier). */
export const deereProductComponentSchema = z.looseObject({
  '@type': z.string().optional(),
  guid: z.string().optional(),
  name: z.string().optional(),
  agencyRegistrationNumber: z.string().optional(),
  rate: deereEventMeasurementSchema.optional(),
});

/** A product, a tank mix or a seed variety (`TankMixProduct` / `NonTankMixProduct`). */
export const deereProductSchema = z.looseObject({
  '@type': z.string().optional(),
  guid: z.string().optional(),
  /** OTHER, CHEMICAL, SEED, FEED, FERTILIZER. */
  productType: z.string().optional(),
  name: z.string().optional(),
  brand: z.string().optional(),
  tankMix: z.boolean().optional(),
  rate: deereEventMeasurementSchema.optional(),
  carrier: deereProductComponentSchema.optional(),
  components: z.array(deereProductComponentSchema).optional(),
});
export type DeereProduct = z.infer<typeof deereProductSchema>;

const products = z
  .union([z.array(deereProductSchema), deereProductSchema])
  .optional()
  .catch(undefined);

/** `embed=measurementTypes`: a list, or a `{ values }` collection. // doc-derived, confirm */
const embeddedMeasurements = z
  .union([
    z.array(deereFieldOperationMeasurementSchema),
    z.looseObject({ values: z.array(deereFieldOperationMeasurementSchema) }),
  ])
  .optional()
  .catch(undefined);

export const deereOpsFieldOperationSchema = deereFieldOperationSchema.extend({
  products,
  varieties: z.array(deereProductSchema).optional().catch(undefined),
  measurementTypes: embeddedMeasurements,
});
export type DeereOpsFieldOperation = z.infer<typeof deereOpsFieldOperationSchema>;
export const deereOpsFieldOperationsSchema = deereCollectionSchema(deereOpsFieldOperationSchema);

/** How the operation's coverage was read. */
export const COVERAGE_STATUSES = [
  /** GET /fieldOperations/{id}/boundary answered a boundary. */
  'ok',
  /** Deere answered 400: the field has an active boundary, or was merged (no coverage then). */
  'refused',
  /** Not asked: the same field refused recently (the cursor remembers it, ./poll.ts). */
  'skipped',
] as const;
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

/**
 * Raw item of stream `operations` (ingest.raw_events.payload): ONE operation with the org and
 * Deere field it was listed under, its measurements (embedded or fetched) and its coverage.
 * externalId = the Deere operation id.
 */
export const deereOperationRawSchema = z.object({
  orgId: z.string().min(1),
  fieldId: z.string().min(1),
  operation: deereOpsFieldOperationSchema,
  measurements: z.array(deereFieldOperationMeasurementSchema),
  coverage: deereBoundarySchema.nullable(),
  coverageStatus: z.enum(COVERAGE_STATUSES),
});
export type DeereOperationRaw = z.infer<typeof deereOperationRawSchema>;

/** The measurements an operation carries embedded (`embed=measurementTypes`), or null. */
export function embeddedMeasurementsOf(
  op: DeereOpsFieldOperation,
): z.infer<typeof deereFieldOperationMeasurementSchema>[] | null {
  const m = op.measurementTypes;
  if (!m) return null;
  return Array.isArray(m) ? m : m.values;
}
