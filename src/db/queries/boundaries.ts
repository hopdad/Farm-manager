/**
 * Boundary versions (plan 1c; docs/contracts-m1.md §3.1, §5.1 D6): the import that turns an
 * Operations Center shapefile export or a GeoJSON file into versions, drawn edits of non-Deere
 * fields, and the "change this in Ops Center" requests that replace edits of Deere fields.
 *
 * Versions (contracts §4): a field has at most one version at any instant (EXCLUDE on
 * (field_id, valid)). A new version closes the open one at `at` ([from, at)) and starts
 * [at, null); acres come from the trigger, soils from gis.rebuild_field_soils (trigger).
 *
 * D6 (default until Derrick decides): Deere is the boundary master for every field with a
 * deere_field_id. The app never edits those boundaries: a drawn edit becomes a
 * farm.boundary_change_requests row, and the import leaves boundaries a sync wrote (source
 * deere, or the demo/sim world standing in for it) alone. A field the import itself created
 * from an Ops Center export keeps taking new versions from later exports.
 */
import type { MultiPolygon } from 'geojson';
import type pg from 'pg';
import type { Tenure } from '../../domain/farm';
import { boundaryEditPolicy, DEERE_BOUNDARY_READ_ONLY } from '../../domain/fields';
import type { Queryable } from '../client';
import {
  ACRES,
  type Actor,
  FieldChanges,
  FieldDataError,
  iso,
  MIN_BOUNDARY_ACRES,
  NORM_TEXT,
  NORMALIZED_POLYGON,
  normText,
  withTransaction,
} from './boundaries-sql';

// ---------------------------------------------------------------------------------------------
// Writing one version
// ---------------------------------------------------------------------------------------------

/** Boundary sources the app writes (BOUNDARY_SOURCES in src/domain/farm.ts). */
export type WrittenBoundarySource = 'import' | 'drawn';

/** Normalize a geometry and measure it; refuses empty or tiny shapes. */
export async function measureBoundary(
  ex: Queryable,
  geometry: MultiPolygon,
): Promise<{ acres: number; geojson: MultiPolygon }> {
  const r = await ex.query<{ empty: boolean; acres: number | null; geojson: MultiPolygon | null }>(
    `select extensions.ST_IsEmpty(g) as empty, ${ACRES('g')}::float8 as acres,
            extensions.ST_AsGeoJSON(g, 9)::json as geojson
       from (select ${NORMALIZED_POLYGON('$1')} as g) q`,
    [JSON.stringify(geometry)],
  );
  const row = r.rows[0];
  if (!row || row.empty || row.acres === null || !row.geojson) {
    throw new FieldDataError(
      'the shape has no area (check that its outline does not cross itself)',
    );
  }
  if (row.acres < MIN_BOUNDARY_ACRES) {
    throw new FieldDataError(
      `the shape is only ${row.acres.toFixed(2)} ac (smallest accepted: ${MIN_BOUNDARY_ACRES} ac)`,
    );
  }
  return { acres: row.acres, geojson: row.geojson };
}

export interface WrittenVersion {
  boundaryId: string;
  acres: number;
  /** The version this one replaced (closed at `at`), if any. */
  previousId: string | null;
  previousAcres: number | null;
}

/**
 * Close the field's open version at `at` and insert the new one [at, null). Locks the field row.
 * `expectedCurrentId` (optimistic editing): refuse if the open version changed meanwhile.
 */
export async function writeBoundaryVersion(
  c: pg.PoolClient,
  args: {
    fieldId: string;
    geometry: MultiPolygon;
    source: WrittenBoundarySource;
    sourceRef: string | null;
    at?: Date | null;
    expectedCurrentId?: string | null;
  },
): Promise<WrittenVersion> {
  const field = await c.query<{ id: string }>(
    'select id from farm.fields where id = $1 for update',
    [args.fieldId],
  );
  if (field.rowCount === 0) throw new FieldDataError('field not found', 'not_found');
  await measureBoundary(c, args.geometry);
  const open = await c.query<{ id: string; from_at: Date | null; acres: number; at: Date }>(
    `select id, lower(valid) as from_at, acres::float8 as acres,
            coalesce($2::timestamptz, now()) as at
       from farm.field_boundaries
      where field_id = $1 and upper_inf(valid)
      order by lower(valid) desc nulls first
      limit 1`,
    [args.fieldId, args.at ?? null],
  );
  const prev = open.rows[0] ?? null;
  if (args.expectedCurrentId !== undefined && (prev?.id ?? null) !== args.expectedCurrentId) {
    throw new FieldDataError(
      'someone changed this boundary since you opened it: reload and edit again',
      'stale',
    );
  }
  if (prev?.from_at && prev.from_at.getTime() >= prev.at.getTime()) {
    throw new FieldDataError(
      `the current boundary starts ${prev.from_at.toISOString().slice(0, 10)}: a new version must start after it`,
      'conflict',
    );
  }
  if (prev) {
    await c.query(
      `update farm.field_boundaries
          set valid = tstzrange(lower(valid), coalesce($2::timestamptz, now()), '[)')
        where id = $1`,
      [prev.id, args.at ?? null],
    );
  }
  const ins = await c.query<{ id: string; acres: number }>(
    `insert into farm.field_boundaries (field_id, geom, valid, source, source_ref)
     values ($1, ${NORMALIZED_POLYGON('$2')},
             tstzrange(coalesce($3::timestamptz, now()), null, '[)'), $4, $5)
     returning id, acres::float8 as acres`,
    [args.fieldId, JSON.stringify(args.geometry), args.at ?? null, args.source, args.sourceRef],
  );
  await c.query('update farm.fields set updated_at = now() where id = $1', [args.fieldId]);
  const row = ins.rows[0] as { id: string; acres: number };
  return {
    boundaryId: row.id,
    acres: row.acres,
    previousId: prev?.id ?? null,
    previousAcres: prev?.acres ?? null,
  };
}

/** True when the geometry equals the field's current boundary (less than 1 m² different). */
export async function sameAsCurrent(
  ex: Queryable,
  boundaryId: string,
  geometry: MultiPolygon,
): Promise<boolean> {
  const r = await ex.query<{ diff_m2: number | null }>(
    `select extensions.ST_Area(extensions.ST_SymDifference(
              extensions.ST_MakeValid(b.geom), ${NORMALIZED_POLYGON('$2')})::extensions.geography)::float8 as diff_m2
       from farm.field_boundaries b where b.id = $1`,
    [boundaryId, JSON.stringify(geometry)],
  );
  const d = r.rows[0]?.diff_m2;
  return d !== null && d !== undefined && d < 1;
}

// ---------------------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------------------

/** One field's boundary from a file (tools/import/boundary-file.ts builds these). */
export interface IncomingBoundary {
  name: string;
  /** Where the name came from: a column, or the shapefile/folder name. */
  nameSource: 'attribute' | 'file name';
  farmName: string | null;
  clientName: string | null;
  /** John Deere field id, when the file carries one. */
  deereFieldId: string | null;
  geometry: MultiPolygon;
  featureCount: number;
  /** For the report and field_boundaries.source_ref: '<file>: <layer>#<n>, …'. */
  sourceRef: string;
}

export interface BoundaryImportOptions {
  /** Plan and report everything, then roll back. */
  dryRun?: boolean;
  /** When the new versions start (default: now). */
  effectiveAt?: Date | null;
  /** Put every field in this farm (overrides the file's farm column). */
  farm?: string | null;
  /** Farm for fields whose row names none (default DEFAULT_IMPORT_FARM). */
  defaultFarm?: string | null;
  /** Tenure of created fields (default: 'custom' in a customer's farm, else 'owned'). */
  tenure?: Tenure | null;
  /** County of created fields (5-digit FIPS), if known. */
  countyFips?: string | null;
  /** Create fields no existing field matches (default true). */
  create?: boolean;
  /** A same-name field must overlap at least this much (intersection / smaller area). */
  minNameOverlap?: number;
  /** A differently named field overlapping this much is the same field (plan 2b uses 0.8). */
  minShapeOverlap?: number;
  /** Deactivate the demo farm's fields after importing (your fields replace the demo). */
  hideDemo?: boolean;
}

export const DEFAULT_IMPORT_FARM = 'Home farm';
export const DEFAULT_MIN_NAME_OVERLAP = 0.5;
export const DEFAULT_MIN_SHAPE_OVERLAP = 0.8;
/** Other fields overlapped at least this much are named in the report. */
const OVERLAP_WARNING = 0.05;

export type ImportAction = 'create' | 'update' | 'unchanged' | 'skip';
export type MatchedBy = 'deere_id' | 'name' | 'shape';

export interface BoundaryImportItem {
  name: string;
  sourceRef: string;
  action: ImportAction;
  fieldId: string | null;
  fieldName: string | null;
  farmName: string | null;
  matchedBy: MatchedBy | null;
  acresBefore: number | null;
  acresAfter: number | null;
  boundaryId: string | null;
  /** Why a row was skipped. */
  reason: string | null;
  warnings: string[];
}

export interface BoundaryImportReport {
  dryRun: boolean;
  effectiveAt: string;
  items: BoundaryImportItem[];
  counts: Record<ImportAction, number>;
  farmsCreated: string[];
  demoHidden: number;
}

/** A field the incoming shape might be (from candidatesFor). */
export interface MatchCandidate {
  fieldId: string;
  name: string;
  farmId: string;
  farmName: string;
  deereFieldId: string | null;
  active: boolean;
  boundaryId: string | null;
  boundarySource: string | null;
  acres: number | null;
  /** Intersection / smaller area, 0-1; null when the field has no current boundary. */
  overlap: number | null;
  idMatch: boolean;
  nameMatch: boolean;
  farmMatch: boolean;
}

export type MatchDecision =
  | { kind: 'match'; candidate: MatchCandidate; by: MatchedBy; warnings: string[] }
  | { kind: 'create'; warnings: string[] }
  | { kind: 'skip'; reason: string; candidate: MatchCandidate | null; warnings: string[] };

const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * Which existing field an incoming boundary is (pure; the rules of plan 1c):
 *  1. the field with the same Deere field id;
 *  2. else an active field with the same name (in the same farm when the file names one) whose
 *     boundary overlaps it by at least `minNameOverlap` (or that has no boundary yet); a
 *     same-name field elsewhere is a conflict, not a silent second field;
 *  3. else an active field overlapping it by at least `minShapeOverlap` (renamed);
 *  4. else a new field.
 * A field carrying a different Deere id is never matched by name or shape.
 */
export function decideMatch(
  incoming: Pick<IncomingBoundary, 'name' | 'deereFieldId'>,
  candidates: readonly MatchCandidate[],
  opts: { minNameOverlap: number; minShapeOverlap: number },
): MatchDecision {
  const warnings: string[] = [];
  const byId = candidates.filter((c) => c.idMatch);
  if (byId.length > 1) {
    return {
      kind: 'skip',
      reason: `${byId.length} fields share Deere id ${incoming.deereFieldId}`,
      candidate: null,
      warnings,
    };
  }
  const overlapWarnings = (chosen: MatchCandidate | null) => {
    for (const c of candidates) {
      if (c === chosen || !c.active || c.overlap === null || c.overlap < OVERLAP_WARNING) continue;
      warnings.push(`overlaps '${c.name}' (${c.farmName}) by ${pct(c.overlap)}`);
    }
  };
  const idHit = byId[0];
  if (idHit) {
    if (!idHit.active) warnings.push(`'${idHit.name}' is inactive`);
    overlapWarnings(idHit);
    return { kind: 'match', candidate: idHit, by: 'deere_id', warnings };
  }
  const eligible = candidates.filter(
    (c) =>
      c.active &&
      !(c.deereFieldId && incoming.deereFieldId && c.deereFieldId !== incoming.deereFieldId),
  );
  const named = eligible.filter((c) => c.nameMatch && c.farmMatch);
  if (named.length > 0) {
    const overlapping = named
      .filter((c) => c.overlap !== null && c.overlap >= opts.minNameOverlap)
      .sort((a, b) => (b.overlap ?? 0) - (a.overlap ?? 0));
    const noShape = named.filter((c) => c.boundaryId === null);
    const hit = overlapping[0] ?? (noShape.length === 1 ? noShape[0] : undefined);
    if (hit) {
      overlapWarnings(hit);
      return { kind: 'match', candidate: hit, by: 'name', warnings };
    }
    const best = [...named].sort((a, b) => (b.overlap ?? 0) - (a.overlap ?? 0))[0] ?? null;
    overlapWarnings(null);
    return {
      kind: 'skip',
      reason:
        named.length > 1 && noShape.length > 1
          ? `${named.length} fields are named '${incoming.name}': give the file a farm column (or --farm)`
          : `'${incoming.name}' exists but its boundary overlaps this one by only ${pct(best?.overlap ?? 0)}; rename one, or edit the field on /admin/fields`,
      candidate: best,
      warnings,
    };
  }
  const shaped = eligible
    .filter((c) => c.overlap !== null && c.overlap >= opts.minShapeOverlap)
    .sort((a, b) => (b.overlap ?? 0) - (a.overlap ?? 0));
  const shapeHit = shaped[0];
  if (shapeHit) {
    warnings.push(
      `matched by shape (${pct(shapeHit.overlap ?? 0)}): the app calls it '${shapeHit.name}'`,
    );
    overlapWarnings(shapeHit);
    return { kind: 'match', candidate: shapeHit, by: 'shape', warnings };
  }
  overlapWarnings(null);
  return { kind: 'create', warnings };
}

/**
 * D6 for the import: may it write a new version for this field? A field with a Deere id whose
 * current boundary came from a sync (deere) or from the demo/sim world standing in for one is
 * read-only; a field the import or the app wrote keeps taking new versions.
 */
export function importMayUpdate(c: Pick<MatchCandidate, 'deereFieldId' | 'boundarySource'>): {
  ok: boolean;
  reason: string | null;
} {
  if (!c.deereFieldId || c.boundarySource === null) return { ok: true, reason: null };
  if (c.boundarySource === 'import' || c.boundarySource === 'drawn')
    return { ok: true, reason: null };
  return {
    ok: false,
    reason:
      c.boundarySource === 'deere'
        ? DEERE_BOUNDARY_READ_ONLY
        : 'demo field: its boundary stands in for an Operations Center sync (read-only)',
  };
}

async function candidatesFor(
  ex: Queryable,
  b: IncomingBoundary,
  farmName: string | null,
): Promise<MatchCandidate[]> {
  const r = await ex.query<{
    field_id: string;
    name: string;
    farm_id: string;
    farm_name: string;
    deere_field_id: string | null;
    active: boolean;
    boundary_id: string | null;
    boundary_source: string | null;
    acres: number | null;
    overlap: number | null;
    id_match: boolean;
    name_match: boolean;
    farm_match: boolean;
  }>(
    `with g as (select ${NORMALIZED_POLYGON('$1')} as geom)
     select f.id as field_id, f.name, fa.id as farm_id, fa.name as farm_name, f.deere_field_id,
            f.active, b.id as boundary_id, b.source as boundary_source, b.acres::float8 as acres,
            case when b.id is null then null else
              (extensions.ST_Area(extensions.ST_Intersection(extensions.ST_MakeValid(b.geom), g.geom)::extensions.geography)
               / nullif(least(extensions.ST_Area(b.geom::extensions.geography),
                              extensions.ST_Area(g.geom::extensions.geography)), 0))::float8
            end as overlap,
            coalesce(f.deere_field_id = $2, false) as id_match,
            ${NORM_TEXT('f.name')} = $3 as name_match,
            ($4::text is null or ${NORM_TEXT('fa.name')} = $4) as farm_match
       from g
       cross join farm.fields f
       join farm.farms fa on fa.id = f.farm_id
       left join farm.current_boundaries b on b.field_id = f.id
      where ($2::text is not null and f.deere_field_id = $2)
         or (f.active and ${NORM_TEXT('f.name')} = $3)
         or (f.active and b.geom is not null and extensions.ST_Intersects(b.geom, g.geom))`,
    [
      JSON.stringify(b.geometry),
      b.deereFieldId,
      normText(b.name),
      farmName ? normText(farmName) : null,
    ],
  );
  return r.rows.map((x) => ({
    fieldId: x.field_id,
    name: x.name,
    farmId: x.farm_id,
    farmName: x.farm_name,
    deereFieldId: x.deere_field_id,
    active: x.active,
    boundaryId: x.boundary_id,
    boundarySource: x.boundary_source,
    acres: x.acres,
    overlap: x.overlap === null ? null : Math.min(1, x.overlap),
    idMatch: x.id_match,
    nameMatch: x.name_match,
    farmMatch: x.farm_match,
  }));
}

async function findOrCreateFarm(
  c: pg.PoolClient,
  name: string,
  clientName: string | null,
  created: string[],
  warnings: string[],
): Promise<{ id: string; name: string; clientPartyId: string | null }> {
  const found = await c.query<{ id: string; name: string; client_party_id: string | null }>(
    `select id, name, client_party_id from farm.farms where ${NORM_TEXT('name')} = $1
      order by (source in ('demo', 'sim')), created_at limit 1`,
    [normText(name)],
  );
  if (found.rows[0]) {
    const f = found.rows[0];
    return { id: f.id, name: f.name, clientPartyId: f.client_party_id };
  }
  let clientPartyId: string | null = null;
  if (clientName) {
    const p = await c.query<{ id: string }>(
      `select id from farm.parties where ${NORM_TEXT('display_name')} = $1 and 'customer' = any(roles)
        order by (source in ('demo', 'sim')), created_at limit 1`,
      [normText(clientName)],
    );
    clientPartyId = p.rows[0]?.id ?? null;
    if (!clientPartyId) {
      warnings.push(
        `client '${clientName}' is not a customer in the app: farm '${name}' was created as your own operation (link the customer on /admin/parties)`,
      );
    }
  }
  const ins = await c.query<{ id: string }>(
    `insert into farm.farms (name, client_party_id, source) values ($1, $2, 'import') returning id`,
    [name, clientPartyId],
  );
  created.push(name);
  return { id: (ins.rows[0] as { id: string }).id, name, clientPartyId };
}

const emptyCounts = (): Record<ImportAction, number> => ({
  create: 0,
  update: 0,
  unchanged: 0,
  skip: 0,
});

/**
 * Import boundaries in ONE transaction (plan, write, publish), or plan and roll back when
 * `dryRun`. The report is the same either way, so a preview shows exactly what applying does.
 */
export async function importBoundaries(
  pool: pg.Pool,
  incoming: readonly IncomingBoundary[],
  opts: BoundaryImportOptions = {},
): Promise<BoundaryImportReport> {
  const minNameOverlap = opts.minNameOverlap ?? DEFAULT_MIN_NAME_OVERLAP;
  const minShapeOverlap = opts.minShapeOverlap ?? DEFAULT_MIN_SHAPE_OVERLAP;
  const create = opts.create ?? true;
  const dryRun = opts.dryRun ?? false;
  return withTransaction(
    pool,
    async (c) => {
      // One import at a time (two would race on "create the field named X").
      await c.query(`select pg_advisory_xact_lock(hashtext('farm.boundary_import'))`);
      const now = await c.query<{ at: Date }>('select coalesce($1::timestamptz, now()) as at', [
        opts.effectiveAt ?? null,
      ]);
      const at = (now.rows[0] as { at: Date }).at;
      const items: BoundaryImportItem[] = [];
      const counts = emptyCounts();
      const farmsCreated: string[] = [];
      const changes = new FieldChanges();
      const claimed = new Map<string, string>();

      for (const b of incoming) {
        const item: BoundaryImportItem = {
          name: b.name,
          sourceRef: b.sourceRef,
          action: 'skip',
          fieldId: null,
          fieldName: null,
          farmName: null,
          matchedBy: null,
          acresBefore: null,
          acresAfter: null,
          boundaryId: null,
          reason: null,
          warnings: [],
        };
        items.push(item);
        try {
          await c.query('savepoint item');
          const farmName = opts.farm ?? b.farmName;
          const measured = await measureBoundary(c, b.geometry);
          item.acresAfter = measured.acres;
          const decision = decideMatch(b, await candidatesFor(c, b, farmName), {
            minNameOverlap,
            minShapeOverlap,
          });
          item.warnings.push(...decision.warnings);

          if (decision.kind === 'skip') {
            item.reason = decision.reason;
            item.fieldId = decision.candidate?.fieldId ?? null;
            item.fieldName = decision.candidate?.name ?? null;
          } else if (decision.kind === 'create') {
            if (!create) {
              item.reason = 'no existing field matches (creating fields is off)';
            } else {
              const farm = await findOrCreateFarm(
                c,
                farmName ?? opts.defaultFarm ?? DEFAULT_IMPORT_FARM,
                b.clientName,
                farmsCreated,
                item.warnings,
              );
              const tenure = opts.tenure ?? (farm.clientPartyId ? 'custom' : 'owned');
              const f = await c.query<{ id: string }>(
                `insert into farm.fields (farm_id, name, tenure, county_fips, deere_field_id, source)
                 values ($1, $2, $3, $4, $5, 'import') returning id`,
                [farm.id, b.name, tenure, opts.countyFips ?? null, b.deereFieldId],
              );
              const fieldId = (f.rows[0] as { id: string }).id;
              const v = await writeBoundaryVersion(c, {
                fieldId,
                geometry: b.geometry,
                source: 'import',
                sourceRef: b.sourceRef,
                at,
              });
              item.action = 'create';
              item.fieldId = fieldId;
              item.fieldName = b.name;
              item.farmName = farm.name;
              item.boundaryId = v.boundaryId;
              item.acresAfter = v.acres;
              claimed.set(fieldId, b.name);
              changes.add(fieldId, 'identity', 'boundary');
            }
          } else {
            const m = decision.candidate;
            item.fieldId = m.fieldId;
            item.fieldName = m.name;
            item.farmName = m.farmName;
            item.matchedBy = decision.by;
            item.acresBefore = m.acres;
            const prior = claimed.get(m.fieldId);
            const may = importMayUpdate(m);
            if (prior) {
              item.reason = `the same field as '${prior}' earlier in the file`;
            } else if (!may.ok) {
              item.reason = may.reason;
            } else if (m.boundaryId && (await sameAsCurrent(c, m.boundaryId, b.geometry))) {
              item.action = 'unchanged';
              item.boundaryId = m.boundaryId;
              item.acresAfter = m.acres;
            } else {
              const v = await writeBoundaryVersion(c, {
                fieldId: m.fieldId,
                geometry: b.geometry,
                source: 'import',
                sourceRef: b.sourceRef,
                at,
              });
              item.action = 'update';
              item.boundaryId = v.boundaryId;
              item.acresAfter = v.acres;
              changes.add(m.fieldId, 'boundary');
            }
            if (item.action !== 'skip' && b.deereFieldId && !m.deereFieldId) {
              await c.query(
                'update farm.fields set deere_field_id = $2, updated_at = now() where id = $1',
                [m.fieldId, b.deereFieldId],
              );
              item.warnings.push(
                `now linked to Deere field ${b.deereFieldId}: its boundary is edited in Operations Center from here on`,
              );
              changes.add(m.fieldId, 'identity');
            }
            if (item.action !== 'skip') claimed.set(m.fieldId, b.name);
          }
          await c.query('release savepoint item');
        } catch (e) {
          await c.query('rollback to savepoint item');
          if (!(e instanceof FieldDataError)) throw e;
          item.action = 'skip';
          item.reason = e.message;
        }
        counts[item.action]++;
      }

      let demoHidden = 0;
      if (opts.hideDemo) demoHidden = await setDemoFieldsActive(c, false, changes);
      await changes.publish(c);
      return {
        dryRun,
        effectiveAt: at.toISOString(),
        items,
        counts,
        farmsCreated,
        demoHidden,
      };
    },
    { rollback: dryRun },
  );
}

/** Show or hide the demo farm's fields (your own fields replace the demo, plan 1c). */
export async function setDemoFieldsActive(
  c: pg.PoolClient,
  active: boolean,
  changes: FieldChanges,
): Promise<number> {
  const r = await c.query<{ id: string }>(
    `update farm.fields set active = $1, updated_at = now()
      where source in ('demo', 'sim') and active <> $1 returning id`,
    [active],
  );
  for (const row of r.rows) changes.add(row.id, 'identity');
  return r.rowCount ?? 0;
}

// ---------------------------------------------------------------------------------------------
// Drawn edits (non-Deere fields) and change requests (Deere fields), D6
// ---------------------------------------------------------------------------------------------

export interface FieldBoundaryState {
  fieldId: string;
  name: string;
  active: boolean;
  deereFieldId: string | null;
  farmId: string;
  boundaryId: string | null;
  boundarySource: string | null;
  acres: number | null;
  geometry: MultiPolygon | null;
  editable: boolean;
  readOnlyReason: string | null;
}

export async function loadFieldBoundary(
  ex: Queryable,
  fieldId: string,
): Promise<FieldBoundaryState | null> {
  const r = await ex.query<{
    id: string;
    name: string;
    active: boolean;
    deere_field_id: string | null;
    farm_id: string;
    boundary_id: string | null;
    boundary_source: string | null;
    acres: number | null;
    geojson: MultiPolygon | null;
  }>(
    `select f.id, f.name, f.active, f.deere_field_id, f.farm_id, b.id as boundary_id,
            b.source as boundary_source, b.acres::float8 as acres,
            extensions.ST_AsGeoJSON(b.geom, 9)::json as geojson
       from farm.fields f
       left join farm.current_boundaries b on b.field_id = f.id
      where f.id = $1`,
    [fieldId],
  );
  const x = r.rows[0];
  if (!x) return null;
  const policy = boundaryEditPolicy({ deereFieldId: x.deere_field_id });
  return {
    fieldId: x.id,
    name: x.name,
    active: x.active,
    deereFieldId: x.deere_field_id,
    farmId: x.farm_id,
    boundaryId: x.boundary_id,
    boundarySource: x.boundary_source,
    acres: x.acres,
    geometry: x.geojson,
    editable: policy.editable,
    readOnlyReason: policy.reason,
  };
}

export type SaveBoundaryResult =
  | {
      kind: 'version';
      boundaryId: string;
      acres: number;
      previousAcres: number | null;
      warnings: string[];
    }
  | { kind: 'change_request'; requestId: string; message: string };

/** Other active fields this shape overlaps (warnings for a drawn edit). */
async function overlapWarnings(
  ex: Queryable,
  fieldId: string,
  geometry: MultiPolygon,
): Promise<string[]> {
  const r = await ex.query<{ name: string; overlap: number }>(
    `with g as (select ${NORMALIZED_POLYGON('$2')} as geom)
     select f.name,
            (extensions.ST_Area(extensions.ST_Intersection(extensions.ST_MakeValid(b.geom), g.geom)::extensions.geography)
             / nullif(least(extensions.ST_Area(b.geom::extensions.geography),
                            extensions.ST_Area(g.geom::extensions.geography)), 0))::float8 as overlap
       from g
       join farm.current_boundaries b on extensions.ST_Intersects(b.geom, g.geom)
       join farm.fields f on f.id = b.field_id
      where f.active and f.id <> $1
      order by 2 desc`,
    [fieldId, JSON.stringify(geometry)],
  );
  return r.rows
    .filter((x) => x.overlap >= 0.01)
    .map((x) => `overlaps '${x.name}' by ${pct(Math.min(1, x.overlap))}`);
}

/**
 * Save a drawn boundary. Non-Deere field: a new version (source 'drawn'). Deere field (D6): a
 * "change this in Ops Center" request holding the drawn shape; the boundary stays as it is.
 */
export async function saveDrawnBoundary(
  pool: pg.Pool,
  args: {
    fieldId: string;
    geometry: MultiPolygon;
    actor: Actor;
    /** The version the editor started from (optimistic: refuse if it changed). */
    expectedBoundaryId: string | null;
    note?: string | null;
  },
): Promise<SaveBoundaryResult> {
  return withTransaction(pool, async (c) => {
    const state = await loadFieldBoundary(c, args.fieldId);
    if (!state) throw new FieldDataError('field not found', 'not_found');
    const changes = new FieldChanges();
    if (!state.editable) {
      const requestId = await createChangeRequest(c, {
        fieldId: state.fieldId,
        geometry: args.geometry,
        note: args.note?.trim() || 'Boundary edit drawn in the app',
        actor: args.actor,
      });
      changes.add(state.fieldId, 'boundary');
      await changes.publish(c);
      return {
        kind: 'change_request',
        requestId,
        message: `${DEERE_BOUNDARY_READ_ONLY} Your drawing was saved as a change request.`,
      };
    }
    if (!state.active) throw new FieldDataError('this field is inactive', 'conflict');
    const warnings = await overlapWarnings(c, state.fieldId, args.geometry);
    const v = await writeBoundaryVersion(c, {
      fieldId: state.fieldId,
      geometry: args.geometry,
      source: 'drawn',
      sourceRef: `drawn by ${args.actor.displayName}`,
      expectedCurrentId: args.expectedBoundaryId,
    });
    changes.add(state.fieldId, 'boundary');
    await changes.publish(c);
    return {
      kind: 'version',
      boundaryId: v.boundaryId,
      acres: v.acres,
      previousAcres: v.previousAcres,
      warnings,
    };
  });
}

export async function createChangeRequest(
  c: pg.PoolClient,
  args: { fieldId: string; geometry: MultiPolygon | null; note: string; actor: Actor },
): Promise<string> {
  if (!args.note.trim()) throw new FieldDataError('say what should change');
  if (args.note.length > 2000) throw new FieldDataError('the note is longer than 2000 characters');
  const r = await c.query<{ id: string }>(
    `insert into farm.boundary_change_requests (field_id, proposed_geom, note, requested_by)
     values ($1, case when $2::text is null then null else ${NORMALIZED_POLYGON('$2')} end, $3, $4)
     returning id`,
    [
      args.fieldId,
      args.geometry ? JSON.stringify(args.geometry) : null,
      args.note.trim(),
      args.actor.appUserId,
    ],
  );
  return (r.rows[0] as { id: string }).id;
}

/** A "change this in Ops Center" note without a drawing (any field; Deere ones mostly). */
export async function requestBoundaryChange(
  pool: pg.Pool,
  args: { fieldId: string; note: string; actor: Actor },
): Promise<string> {
  return withTransaction(pool, async (c) => {
    const f = await c.query('select 1 from farm.fields where id = $1', [args.fieldId]);
    if (f.rowCount === 0) throw new FieldDataError('field not found', 'not_found');
    const id = await createChangeRequest(c, { ...args, geometry: null });
    const changes = new FieldChanges();
    changes.add(args.fieldId, 'boundary');
    await changes.publish(c);
    return id;
  });
}

export async function resolveChangeRequest(
  pool: pg.Pool,
  args: { requestId: string; resolution: string; actor: Actor },
): Promise<void> {
  const resolution = args.resolution.trim() || 'done in Operations Center';
  await withTransaction(pool, async (c) => {
    const r = await c.query<{ field_id: string }>(
      `update farm.boundary_change_requests
          set resolved_at = now(), resolved_by = $2, resolution = $3
        where id = $1 and resolved_at is null
        returning field_id`,
      [args.requestId, args.actor.appUserId, resolution.slice(0, 2000)],
    );
    const row = r.rows[0];
    if (!row) throw new FieldDataError('that request is already resolved or gone', 'conflict');
    const changes = new FieldChanges();
    changes.add(row.field_id, 'boundary');
    await changes.publish(c);
  });
}

export interface ChangeRequestRow {
  id: string;
  fieldId: string;
  note: string;
  hasDrawing: boolean;
  proposedGeometry: MultiPolygon | null;
  requestedAt: string;
  requestedByName: string | null;
  resolvedAt: string | null;
  resolution: string | null;
}

export async function listChangeRequests(
  ex: Queryable,
  fieldId: string,
  opts: { includeResolved?: boolean } = {},
): Promise<ChangeRequestRow[]> {
  const r = await ex.query<{
    id: string;
    field_id: string;
    note: string;
    geojson: MultiPolygon | null;
    requested_at: Date;
    requested_by_name: string | null;
    resolved_at: Date | null;
    resolution: string | null;
  }>(
    `select r.id, r.field_id, r.note, extensions.ST_AsGeoJSON(r.proposed_geom, 9)::json as geojson,
            r.requested_at, p.display_name as requested_by_name, r.resolved_at, r.resolution
       from farm.boundary_change_requests r
       left join farm.app_users u on u.id = r.requested_by
       left join farm.parties p on p.id = u.party_id
      where r.field_id = $1 and ($2 or r.resolved_at is null)
      order by r.resolved_at is null desc, r.requested_at desc
      limit 50`,
    [fieldId, opts.includeResolved ?? false],
  );
  return r.rows.map((x) => ({
    id: x.id,
    fieldId: x.field_id,
    note: x.note,
    hasDrawing: x.geojson !== null,
    proposedGeometry: x.geojson,
    requestedAt: iso(x.requested_at) as string,
    requestedByName: x.requested_by_name,
    resolvedAt: iso(x.resolved_at),
    resolution: x.resolution,
  }));
}

/** Boundary versions of a field, newest first (the admin page's history list). */
export async function listBoundaryVersions(
  ex: Queryable,
  fieldId: string,
): Promise<
  {
    id: string;
    acres: number;
    source: string;
    sourceRef: string | null;
    from: string | null;
    to: string | null;
  }[]
> {
  const r = await ex.query<{
    id: string;
    acres: number;
    source: string;
    source_ref: string | null;
    from_at: Date | null;
    to_at: Date | null;
  }>(
    `select id, acres::float8 as acres, source, source_ref, lower(valid) as from_at, upper(valid) as to_at
       from farm.field_boundaries where field_id = $1
      order by lower(valid) desc nulls last limit 50`,
    [fieldId],
  );
  return r.rows.map((x) => ({
    id: x.id,
    acres: x.acres,
    source: x.source,
    sourceRef: x.source_ref,
    from: iso(x.from_at),
    to: iso(x.to_at),
  }));
}
