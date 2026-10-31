/**
 * deere-ops's unconfirmed Deere paths and shapes (1f): field operations by crop season,
 * products, measurement types and coverage as deere.ops uses them (and the deferred deere:backfill
 * will). Appended to the admin list by src/connectors/doc-derived.ts. Each entry cites where the
 * assumption lives; `spec` = from Deere's own spec feed (developer.deere.com/devDoc/apiDetails,
 * read Oct 30, 2026), only a recorded response is missing; `doc` = the docs don't say.
 */
import type { DocDerivedItem } from '../../doc-derived';

export const DEERE_OPS_DOC_DERIVED: readonly DocDerivedItem[] = [
  {
    source: 'deere',
    what: 'GET /platform/organizations/{orgId}/fields/{fieldId}/fieldOperations?cropSeason=&embed=measurementTypes (scope ag2)',
    confirm:
      'where embed=measurementTypes puts the measurements on each operation (the spec names the embed, not its shape: the client reads a list or a { values } collection and falls back to GET /fieldOperations/{id}/measurementTypes), and that cropSeason filters as documented (an integer)',
    file: 'src/connectors/deere/ops/schemas.ts, src/connectors/deere/ops/client.ts',
    basis: 'doc',
  },
  {
    source: 'deere',
    what: 'fieldOperationType values (SEEDING, APPLICATION, HARVEST, TILLAGE as documented; responses mix the case)',
    confirm:
      'whether the fieldOperationType query is case-sensitive (deere.ops lists every type and maps the response case-insensitively, so it sends none today)',
    file: 'src/connectors/deere/ops/schemas.ts (DEERE_FIELD_OPERATION_TYPES), src/domain/operations.ts',
    basis: 'spec',
  },
  {
    source: 'deere',
    what: 'FieldOperation products / varieties and FieldOperationMeasurement units',
    confirm:
      "product shapes as our org sends them (a tank mix's carrier and components, a single product's rate), and the unit ids under our org's unit preference: yield is read only in bu1ac-1 and bu, moisture in prcnt, area in ac or ha, speed in mi1hr-1 or km1hr-1 (a metric yield is left out, not converted)",
    file: 'src/connectors/deere/ops/mapper.ts',
    basis: 'spec',
  },
  {
    source: 'deere',
    what: 'GET /platform/fieldOperations/{operationId}/boundary (operation coverage, scope ag2)',
    confirm:
      "Deere answers 400 when the field has an active boundary (and for merged fields): the operation is then stored with its measured area and no coverage, and the field's next operations skip the call for 7 days. Coverage on such fields needs the shapefile flow (GET /fieldOps/{id}?shapeType=Polygon: 202 poll, 307 to a pre-signed URL, a zipped shapefile; 406 for tillage), which joins M2 2b's file reading",
    file: 'src/connectors/deere/ops/client.ts, src/connectors/deere/ops/poll.ts',
    basis: 'spec',
  },
  {
    source: 'deere',
    what: 'cropName crop tokens (CORN_WET, SOYBEANS, WHEAT_SOFT_RED_WINTER, …)',
    confirm:
      'the token list (GET /cropTypes on a real account): known tokens map to corn, soybeans and wheat, unknown ones are stored in words',
    file: 'src/domain/crops.ts (normalizeDeereCrop)',
    basis: 'doc',
  },
];
