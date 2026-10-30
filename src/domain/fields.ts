/**
 * Field panel contract (plan 1a/1c "tap a field"; docs/contracts-m1.md §5).
 *
 * `GET /api/fields/<id>` (field-panel builder, src/app/api/fields/**, query in
 * src/db/queries/fields.ts) returns a `FieldDetail`; the panel and every tab render from it
 * (src/ui/fields/tabs.ts). One query, one response: the tap-to-panel budget is 200 ms.
 * `FieldSummary` is the light form (lists, search, map popups). Pure TS.
 */
import type { Tenure } from './farm';
import type { FieldParcelRow } from './parcels';
import type { FieldSoilRow, FieldSoilsSummary } from './soils';
import type { SprayAssessmentView } from './weather';

/** A party as the panel shows it (landlord, custom-work customer). */
export interface PartyRef {
  id: string;
  displayName: string;
  kind: 'person' | 'org';
  phone: string | null;
  email: string | null;
}

export interface FieldSummary {
  id: string;
  name: string;
  farmId: string;
  farmName: string;
  tenure: Tenure;
  /** Current boundary's acres (null: no boundary yet). */
  acres: number | null;
  countyFips: string | null;
  /** Landlord for cash rent / share ground. */
  landlord: PartyRef | null;
  /** Custom-work customer: the farm's client party (null = your own operation). */
  customer: PartyRef | null;
  /** Set when the field comes from Operations Center: Deere is its boundary master (D6). */
  deereFieldId: string | null;
  active: boolean;
}

/** The current boundary version. */
export interface BoundaryInfo {
  id: string;
  acres: number;
  /** farm.field_boundaries.source: deere, import, drawn, demo, sim. */
  source: string;
  sourceRef: string | null;
  /** Start of this version's validity (UTC ISO). */
  validFrom: string;
  /** [west, south, east, north] for fly-to. */
  bbox: [number, number, number, number];
  /** Whether the app may edit it, and why not (D6; see boundaryEditPolicy). */
  editable: boolean;
  readOnlyReason: string | null;
}

/** One crop year (farm.field_seasons), newest first in FieldDetail.seasons. */
export interface SeasonRow {
  cropYear: number;
  crop: string | null;
  variety: string | null;
  /** YYYY-MM-DD. */
  plantedOn: string | null;
  harvestedOn: string | null;
  yieldBuAc: number | null;
  /** demo, import, deere, app. */
  source: string;
}

/** The panel's notes, with who last changed them. `version` is for optimistic saves. */
export interface FieldNotes {
  text: string | null;
  updatedAt: string | null;
  updatedByName: string | null;
  /** farm.fields.updated_at as ISO: send it back when saving; a mismatch means someone else saved. */
  version: string;
}

/** A field this one was split from / merged into (farm.field_lineage). */
export interface LineageRef {
  fieldId: string;
  name: string;
  kind: 'split' | 'merge';
  /** YYYY-MM-DD. */
  effectiveOn: string;
}

export interface FieldDetail {
  field: FieldSummary;
  boundary: BoundaryInfo | null;
  /** Newest first, at most FIELD_PANEL_SEASONS. */
  seasons: SeasonRow[];
  /** gis.field_soils of the current boundary, largest first. */
  soils: FieldSoilRow[];
  /** summarizeFieldSoils(soils); null when no soils are loaded for this boundary. */
  soilsSummary: FieldSoilsSummary | null;
  /** Parcels overlapping the current boundary (private data), largest overlap first. */
  parcels: FieldParcelRow[];
  /** Open jobs arrive in M2 (2a); 1a shows a placeholder. */
  openJobs: { count: number; placeholder: true };
  notes: FieldNotes;
  lineage: { parents: LineageRef[]; children: LineageRef[] };
  /** Open "change this in Ops Center" requests (farm.boundary_change_requests). */
  openBoundaryRequests: number;
  /** The latest go/no-go for the current hour, when assessed (1b). */
  spray: SprayAssessmentView | null;
}

/** Seasons the panel shows (plan: "5 seasons"). */
export const FIELD_PANEL_SEASONS = 5;

/**
 * Parts of a field a change can touch: the `parts` of realtime fields/updated, and what a panel
 * refetches. 'identity' = name, tenure, farm, landlord, active. 'operations' (1f): the field's
 * farm.operations changed (the History tab refetches GET /api/fields/<id>/operations).
 */
export const FIELD_PARTS = [
  'identity',
  'boundary',
  'notes',
  'seasons',
  'soils',
  'parcels',
  'lineage',
  'spray',
  'operations',
] as const;
export type FieldPart = (typeof FIELD_PARTS)[number];

export const DEERE_BOUNDARY_READ_ONLY =
  'This boundary comes from John Deere Operations Center. Change it there; the app picks it up on the next sync.';

/**
 * D6 (default until Derrick decides): Deere is the boundary master for every field with a
 * deere_field_id, so the app never edits those boundaries (an attempted edit becomes a
 * farm.boundary_change_requests note). Fields without one (prospects, customers not in Ops
 * Center) can be drawn, edited, split and merged, with lineage. Server code checks this before
 * every boundary write; the UI uses it to hide the tools.
 */
export function boundaryEditPolicy(field: {
  deereFieldId: string | null;
}): { editable: true; reason: null } | { editable: false; reason: string } {
  return field.deereFieldId
    ? { editable: false, reason: DEERE_BOUNDARY_READ_ONLY }
    : { editable: true, reason: null };
}

/** Properties of a feature in the `fields` vector tile layer (app.mvt_fields). */
export interface FieldTileProperties {
  id: string;
  name: string;
  acres: number;
  tenure: Tenure;
  farm_id: string;
  /** The custom-work customer (farm.farms.client_party_id), absent for your own operation. */
  client_id?: string;
  client?: string;
}
