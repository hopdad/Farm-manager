/**
 * Field operations (slice 1f, plan §4 `farm.operations`): what a machine did on a field, as
 * Operations Center reports it (seeding, application, harvest, tillage), with the products, the
 * measured totals and a simplified coverage MultiPolygon. Written by the `deere.ops` job and the
 * `deere:backfill` CLI (deere-ops builder, docs/contracts-1f.md §5.1); read by the field panel's
 * History tab through `GET /api/fields/<id>/operations`.
 *
 * Pure TS + zod, no runtime imports beyond zod. Owned by the 1f foundation (contract file):
 * changes go through the builder's report.
 */
import { z } from 'zod';

/** Deere's fieldOperationType values, lower case (Deere mixes the case: "Tillage", "application"). */
export const OPERATION_KINDS = ['seeding', 'application', 'harvest', 'tillage'] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

/**
 * `provisional`: Deere may still change it (the operation is recent or still running);
 * `final`: settled (billing reads only final ones in M3).
 */
export const OPERATION_STATUSES = ['provisional', 'final'] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];

/** Deere's `fieldOperationType` → our kind (case-insensitive); null for anything else. */
export function operationKindOf(fieldOperationType: string): OperationKind | null {
  const k = fieldOperationType.trim().toLowerCase();
  return (OPERATION_KINDS as readonly string[]).includes(k) ? (k as OperationKind) : null;
}

/**
 * One product of an operation (`farm.operations.products` jsonb is an array of these): a seed
 * variety, a chemical or fertilizer of a tank mix. Units are the ADAPT unit ids Deere sends
 * (`seeds1ac-1`, `gal1ac-1`, `lb1ac-1`, …), kept as sent; the panel formats them.
 */
export interface OperationProduct {
  name: string;
  /** seed | chemical | fertilizer | other, or null when Deere doesn't say. */
  kind: 'seed' | 'chemical' | 'fertilizer' | 'other' | null;
  /** Average applied rate and its unit, when reported. */
  rate: number | null;
  rateUnit: string | null;
  /** Total applied and its unit, when reported. */
  total: number | null;
  totalUnit: string | null;
}

export const operationProductSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['seed', 'chemical', 'fertilizer', 'other']).nullable(),
  rate: z.number().nullable(),
  rateUnit: z.string().nullable(),
  total: z.number().nullable(),
  totalUnit: z.string().nullable(),
}) satisfies z.ZodType<OperationProduct>;

/**
 * The measured totals of an operation (`farm.operations.measurements` jsonb), in US units. Every
 * key is optional: an operation carries what Deere measured for its kind (a harvest: area,
 * yield, moisture; a seeding: area and rate in its product).
 */
export interface OperationMeasurements {
  /** Area worked, acres (Deere's measurement `area`). */
  areaAc?: number;
  /** Harvest: average dry yield, bu/ac (`HarvestYieldResult.averageYield`, unit bu1ac-1). */
  yieldBuAc?: number;
  /** Harvest: total dry yield, bu. */
  totalBu?: number;
  /** Harvest: average moisture, %. */
  moisturePct?: number;
  /** Average ground speed, mph. */
  avgSpeedMph?: number;
}

export const operationMeasurementsSchema = z.object({
  areaAc: z.number().nonnegative().optional(),
  yieldBuAc: z.number().nonnegative().optional(),
  totalBu: z.number().nonnegative().optional(),
  moisturePct: z.number().min(0).max(100).optional(),
  avgSpeedMph: z.number().nonnegative().optional(),
}) satisfies z.ZodType<OperationMeasurements>;

/**
 * Observed weather during the operation (`farm.operations.weather` jsonb, plan §4: "observed,
 * with its source"). Filled from 2b; null until then.
 */
export interface OperationWeather {
  /** Where it came from, e.g. 'nws:<stationId>'. */
  source: string;
  windMph: number | null;
  gustMph: number | null;
  tempF: number | null;
  observedAt: string;
}

/** One operation as the field panel shows it. */
export interface OperationView {
  /** farm.operations.id (deterministicId('deere', <Deere operation id>) for Deere rows). */
  id: string;
  kind: OperationKind;
  cropYear: number;
  /** Normalized crop (src/domain/crops.ts, deere-ops), or null. */
  crop: string | null;
  /** UTC ISO. */
  startedAt: string;
  endedAt: string | null;
  /** Area Deere reported, and the part inside the field's boundary (acres, 1 decimal). */
  areaReportedAc: number | null;
  areaClippedAc: number | null;
  products: OperationProduct[];
  measurements: OperationMeasurements;
  /** Machines that did the work (farm.machines ids, with their unit numbers). */
  machines: { id: string; unitNo: string }[];
  /** Display name of the operator party, when known. */
  operatorName: string | null;
  status: OperationStatus;
  /** Row source: 'deere' (synced) or 'app' (later slices). */
  source: string;
  /** True when a coverage polygon is stored (the map can draw it). */
  hasCoverage: boolean;
}

/** GET /api/fields/<id>/operations (viewer and up). */
export interface FieldOperationsResponse {
  fieldId: string;
  /** The crop year listed (default: the current one, America/Detroit). */
  cropYear: number;
  /** Oldest first. */
  operations: OperationView[];
}

export const fieldOperationsUrl = (fieldId: string, cropYear?: number) =>
  `/api/fields/${encodeURIComponent(fieldId)}/operations${cropYear ? `?cropYear=${cropYear}` : ''}`;
