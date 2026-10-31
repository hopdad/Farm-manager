/**
 * deere.ops's Deere calls (slice 1f, deere-ops), on the client seam of ../client.ts (`apiUrl`,
 * `getOne`, `getPaged`: bearer token, one refresh-and-retry on 401, `nextPage` paging). Every
 * call here needs scope `ag2` (docs/contracts-1f.md §5.1):
 *
 *   GET /organizations/{org}/fields/{field}/fieldOperations?cropSeason=&fieldOperationType=
 *       &embed=measurementTypes        one call per field (Deere has no org-wide listing)
 *   GET /fieldOperations/{id}/measurementTypes      only when the listing didn't embed them
 *   GET /fieldOperations/{id}/boundary              the coverage; 400 = refused (an active field
 *                                                   boundary, or a merged field)
 */

import { VendorHttpError } from '../../http';
import type { DeereClient } from '../client';
import {
  type DeereBoundary,
  type DeereFieldOperationMeasurement,
  deereBoundarySchema,
  deereFieldOperationMeasurementsSchema,
} from '../schemas';
import {
  type DeereOpsFieldOperation,
  deereOpsFieldOperationsSchema,
  embeddedMeasurementsOf,
} from './schemas';

export interface ListOperationsOptions {
  /** The crop year (Deere's `cropSeason`, an integer in the query). */
  cropSeason: number;
  /** One of DEERE_FIELD_OPERATION_TYPES (as documented: upper case). Default: every type. */
  fieldOperationType?: string;
  /** Ask Deere to embed each operation's measurement types (saves one call per operation). Default true. */
  embedMeasurements?: boolean;
}

/** GET …/fields/{fieldId}/fieldOperations for one crop season (every page). */
export function listFieldOperations(
  client: DeereClient,
  orgId: string,
  fieldId: string,
  opts: ListOperationsOptions,
): Promise<DeereOpsFieldOperation[]> {
  const u = new URL(client.apiUrl('organizations', orgId, 'fields', fieldId, 'fieldOperations'));
  u.searchParams.set('cropSeason', String(opts.cropSeason));
  if (opts.fieldOperationType) u.searchParams.set('fieldOperationType', opts.fieldOperationType);
  if (opts.embedMeasurements ?? true) u.searchParams.set('embed', 'measurementTypes');
  return client.getPaged(deereOpsFieldOperationsSchema, u.toString());
}

/** GET /fieldOperations/{id}/measurementTypes (every page). */
export function fieldOperationMeasurements(
  client: DeereClient,
  operationId: string,
): Promise<DeereFieldOperationMeasurement[]> {
  return client.getPaged(
    deereFieldOperationMeasurementsSchema,
    client.apiUrl('fieldOperations', operationId, 'measurementTypes'),
  );
}

/** The operation's measurements: embedded in the listing, else one call. */
export async function measurementsOf(
  client: DeereClient,
  op: DeereOpsFieldOperation,
): Promise<DeereFieldOperationMeasurement[]> {
  return embeddedMeasurementsOf(op) ?? fieldOperationMeasurements(client, op.id);
}

export type CoverageReply = { status: 'ok'; boundary: DeereBoundary } | { status: 'refused' };

/**
 * GET /fieldOperations/{id}/boundary: the boundary Deere generates around the worked area.
 * Deere answers 400 when the field already has an active boundary (and for a merged field):
 * that is `refused`, not an error. Other failures throw.
 */
export async function fieldOperationCoverage(
  client: DeereClient,
  operationId: string,
): Promise<CoverageReply> {
  try {
    const boundary = await client.getOne(
      deereBoundarySchema,
      client.apiUrl('fieldOperations', operationId, 'boundary'),
    );
    return { status: 'ok', boundary };
  } catch (e) {
    if (e instanceof VendorHttpError && e.status === 400) return { status: 'refused' };
    throw e;
  }
}
