/**
 * Splitting and merging fields (plan 1c, plan §4 farm.field_lineage), for fields the app may
 * edit (no deere_field_id, D6). A split or merge never rewrites history: the old field(s) end
 * (their open boundary version is closed and they become inactive) and new fields start, with
 * lineage rows linking them, so the History tab can show the old seasons under the new fields.
 *
 *  - split: a line drawn across the field cuts its current boundary into pieces (ST_Split);
 *    each piece becomes a new field (same farm, tenure, landlord, county) named by the user.
 *  - merge: two adjacent fields (touching, or less than MERGE_GAP_M apart) become one field;
 *    a gap that thin (a fence line, a slightly off drawing) is closed so the result is one shape.
 *
 * Effective date (America/Detroit): today = now; an earlier day = its midnight, which must fall
 * after the current versions started. Never in the future.
 */
import type { LineString, MultiPolygon } from 'geojson';
import type pg from 'pg';
import type { Tenure } from '../../domain/farm';
import { boundaryEditPolicy } from '../../domain/fields';
import { localParts, localToUtc } from '../../sim/time';
import type { Queryable } from '../client';
import {
  ACRES,
  type Actor,
  FieldChanges,
  FieldDataError,
  MIN_BOUNDARY_ACRES,
  NORM_TEXT,
  NORMALIZED_POLYGON,
  normText,
  withTransaction,
} from './boundaries-sql';

/** Two fields this close (metres) count as adjacent; the gap between them is closed. */
export const MERGE_GAP_M = 5;
export const MAX_SPLIT_PIECES = 10;

export interface Piece {
  geometry: MultiPolygon;
  acres: number;
  /** [lng, lat] of a point inside the piece (map labels). */
  label: [number, number];
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The instant a change dated `effectiveOn` takes effect (see the header). */
export function effectiveInstant(effectiveOn: string, now: Date = new Date()): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(effectiveOn);
  if (!m) throw new FieldDataError(`'${effectiveOn}' is not a date (YYYY-MM-DD)`);
  const p = localParts(now.getTime());
  const today = `${p.y}-${pad(p.m)}-${pad(p.d)}`;
  if (effectiveOn > today) throw new FieldDataError('the date cannot be in the future');
  if (effectiveOn === today) return now;
  return new Date(localToUtc(Number(m[1]), Number(m[2]), Number(m[3])));
}

/** Default names for split pieces: '<name> A', '<name> B', … */
export function defaultPieceNames(name: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${name} ${String.fromCharCode(65 + i)}`);
}

interface EditableField {
  id: string;
  name: string;
  farmId: string;
  tenure: Tenure;
  landlordPartyId: string | null;
  countyFips: string | null;
  boundaryFrom: Date | null;
}

/** Lock a field and check the app may change its boundary (D6, active, has a boundary). */
async function lockEditable(c: pg.PoolClient, fieldId: string): Promise<EditableField> {
  const r = await c.query<{
    id: string;
    name: string;
    farm_id: string;
    tenure: Tenure;
    landlord_party_id: string | null;
    county_fips: string | null;
    deere_field_id: string | null;
    active: boolean;
    boundary_from: Date | null;
    has_boundary: boolean;
  }>(
    `select f.id, f.name, f.farm_id, f.tenure, f.landlord_party_id, f.county_fips,
            f.deere_field_id, f.active,
            (select lower(b.valid) from farm.field_boundaries b
              where b.field_id = f.id and upper_inf(b.valid) order by lower(b.valid) desc limit 1) as boundary_from,
            exists (select 1 from farm.current_boundaries b where b.field_id = f.id) as has_boundary
       from farm.fields f where f.id = $1 for update of f`,
    [fieldId],
  );
  const f = r.rows[0];
  if (!f) throw new FieldDataError('field not found', 'not_found');
  const policy = boundaryEditPolicy({ deereFieldId: f.deere_field_id });
  if (!policy.editable) throw new FieldDataError(`'${f.name}': ${policy.reason}`, 'read_only');
  if (!f.active) throw new FieldDataError(`'${f.name}' is inactive`, 'conflict');
  if (!f.has_boundary) throw new FieldDataError(`'${f.name}' has no boundary`, 'conflict');
  return {
    id: f.id,
    name: f.name,
    farmId: f.farm_id,
    tenure: f.tenure,
    landlordPartyId: f.landlord_party_id,
    countyFips: f.county_fips,
    boundaryFrom: f.boundary_from,
  };
}

function checkAt(f: EditableField, at: Date): void {
  if (f.boundaryFrom && f.boundaryFrom.getTime() >= at.getTime()) {
    throw new FieldDataError(
      `'${f.name}' has a boundary starting ${f.boundaryFrom.toISOString().slice(0, 10)}: pick a later date`,
      'conflict',
    );
  }
}

/** New field names: present, unique among themselves and among the farm's active fields. */
async function checkNames(
  c: pg.PoolClient,
  farmId: string,
  names: readonly string[],
  except: readonly string[],
): Promise<string[]> {
  const clean = names.map((n) => n.replace(/\s+/g, ' ').trim());
  if (clean.some((n) => !n)) throw new FieldDataError('every new field needs a name');
  if (clean.some((n) => n.length > 120))
    throw new FieldDataError('a name is longer than 120 characters');
  const norm = clean.map(normText);
  if (new Set(norm).size !== norm.length) throw new FieldDataError('the new names must differ');
  const taken = await c.query<{ name: string }>(
    `select name from farm.fields
      where farm_id = $1 and active and ${NORM_TEXT('name')} = any ($2::text[]) and id <> all ($3::uuid[])`,
    [farmId, norm, except],
  );
  if (taken.rows[0]) {
    throw new FieldDataError(
      `this farm already has a field named '${taken.rows[0].name}'`,
      'conflict',
    );
  }
  return clean;
}

/** Close a field's open version at `at` and make the field inactive. */
async function endField(c: pg.PoolClient, fieldId: string, at: Date): Promise<void> {
  await c.query(
    `update farm.field_boundaries set valid = tstzrange(lower(valid), $2::timestamptz, '[)')
      where field_id = $1 and upper_inf(valid)`,
    [fieldId, at],
  );
  await c.query('update farm.fields set active = false, updated_at = now() where id = $1', [
    fieldId,
  ]);
}

/** Insert a field like `template` with its first boundary version [at, null). */
async function startField(
  c: pg.PoolClient,
  template: EditableField,
  args: { name: string; tenure?: Tenure; geometry: MultiPolygon; at: Date; sourceRef: string },
): Promise<string> {
  const f = await c.query<{ id: string }>(
    `insert into farm.fields (farm_id, name, tenure, landlord_party_id, county_fips, source)
     values ($1, $2, $3, $4, $5, 'app') returning id`,
    [
      template.farmId,
      args.name,
      args.tenure ?? template.tenure,
      template.landlordPartyId,
      template.countyFips,
    ],
  );
  const id = (f.rows[0] as { id: string }).id;
  await c.query(
    `insert into farm.field_boundaries (field_id, geom, valid, source, source_ref)
     values ($1, ${NORMALIZED_POLYGON('$2')}, tstzrange($3::timestamptz, null, '[)'), 'drawn', $4)`,
    [id, JSON.stringify(args.geometry), args.at, args.sourceRef],
  );
  return id;
}

async function lineage(
  c: pg.PoolClient,
  parent: string,
  child: string,
  kind: 'split' | 'merge',
  effectiveOn: string,
  actor: Actor,
  note: string,
): Promise<void> {
  await c.query(
    `insert into farm.field_lineage (parent_field_id, child_field_id, kind, effective_on, note, created_by)
     values ($1, $2, $3, $4::date, $5, $6)`,
    [parent, child, kind, effectiveOn, note, actor.appUserId],
  );
}

// ---------------------------------------------------------------------------------------------
// Split
// ---------------------------------------------------------------------------------------------

function checkLine(line: LineString): void {
  if (
    line?.type !== 'LineString' ||
    !Array.isArray(line.coordinates) ||
    line.coordinates.length < 2
  ) {
    throw new FieldDataError('draw a line of at least two points across the field');
  }
  if (line.coordinates.length > 500) throw new FieldDataError('the line has too many points');
}

async function cutPieces(ex: Queryable, fieldId: string, line: LineString): Promise<Piece[]> {
  checkLine(line);
  const r = await ex.query<{ geojson: MultiPolygon; acres: number; lng: number; lat: number }>(
    `with f as (select extensions.ST_MakeValid(geom) as geom from farm.current_boundaries where field_id = $1),
          l as (select extensions.ST_Force2D(extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON($2::text), 4326)) as line),
          parts as (
            select (extensions.ST_Dump(extensions.ST_CollectionExtract(extensions.ST_Split(f.geom, l.line), 3))).geom as g
              from f, l)
     select extensions.ST_AsGeoJSON(extensions.ST_Multi(g), 9)::json as geojson, ${ACRES('g')}::float8 as acres,
            extensions.ST_X(extensions.ST_PointOnSurface(g)) as lng,
            extensions.ST_Y(extensions.ST_PointOnSurface(g)) as lat
       from parts
      order by extensions.ST_X(extensions.ST_Centroid(g)), extensions.ST_Y(extensions.ST_Centroid(g))`,
    [fieldId, JSON.stringify(line)],
  );
  const pieces = r.rows.map((x) => ({
    geometry: x.geojson,
    acres: x.acres,
    label: [x.lng, x.lat] as [number, number],
  }));
  if (pieces.length < 2) {
    throw new FieldDataError('the line does not cut the field: draw it all the way across');
  }
  if (pieces.length > MAX_SPLIT_PIECES) {
    throw new FieldDataError(
      `the line cuts the field into ${pieces.length} pieces (at most ${MAX_SPLIT_PIECES})`,
    );
  }
  const small = pieces.find((p) => p.acres < MIN_BOUNDARY_ACRES);
  if (small) {
    throw new FieldDataError(
      `one piece would be only ${small.acres.toFixed(2)} ac: draw the line again`,
    );
  }
  return pieces;
}

/** The pieces a line would cut the field into (for the preview on the map). */
export async function previewSplit(
  ex: Queryable,
  fieldId: string,
  line: LineString,
): Promise<Piece[]> {
  const f = await ex.query<{ deere_field_id: string | null }>(
    'select deere_field_id from farm.fields where id = $1',
    [fieldId],
  );
  if (!f.rows[0]) throw new FieldDataError('field not found', 'not_found');
  const policy = boundaryEditPolicy({ deereFieldId: f.rows[0].deere_field_id });
  if (!policy.editable) throw new FieldDataError(policy.reason, 'read_only');
  return cutPieces(ex, fieldId, line);
}

export async function splitField(
  pool: pg.Pool,
  args: {
    fieldId: string;
    line: LineString;
    names: string[];
    effectiveOn: string;
    actor: Actor;
    now?: Date;
  },
): Promise<{ childIds: string[]; pieces: Piece[] }> {
  const at = effectiveInstant(args.effectiveOn, args.now);
  return withTransaction(pool, async (c) => {
    const parent = await lockEditable(c, args.fieldId);
    checkAt(parent, at);
    const pieces = await cutPieces(c, parent.id, args.line);
    if (args.names.length !== pieces.length) {
      throw new FieldDataError(
        `the line cuts the field into ${pieces.length} pieces but ${args.names.length} names were given`,
        'stale',
      );
    }
    const names = await checkNames(c, parent.farmId, args.names, [parent.id]);
    await endField(c, parent.id, at);
    const changes = new FieldChanges();
    changes.add(parent.id, 'identity', 'boundary', 'lineage');
    const childIds: string[] = [];
    for (const [i, piece] of pieces.entries()) {
      const id = await startField(c, parent, {
        name: names[i] as string,
        geometry: piece.geometry,
        at,
        sourceRef: `split from ${parent.name}`,
      });
      await lineage(
        c,
        parent.id,
        id,
        'split',
        args.effectiveOn,
        args.actor,
        `split by ${args.actor.displayName}`,
      );
      changes.add(id, 'identity', 'boundary', 'lineage');
      childIds.push(id);
    }
    await changes.publish(c);
    return { childIds, pieces };
  });
}

// ---------------------------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------------------------

export interface AdjacentField {
  fieldId: string;
  name: string;
  farmName: string;
  sameFarm: boolean;
  editable: boolean;
  /** Metres between the two boundaries (0 = touching or overlapping). */
  gapM: number;
}

/** Active fields touching (or within MERGE_GAP_M of) this one: the merge candidates. */
export async function adjacentFields(ex: Queryable, fieldId: string): Promise<AdjacentField[]> {
  const r = await ex.query<{
    id: string;
    name: string;
    farm_name: string;
    same_farm: boolean;
    deere_field_id: string | null;
    gap_m: number;
  }>(
    `select f.id, f.name, fa.name as farm_name, f.farm_id = me.farm_id as same_farm, f.deere_field_id,
            extensions.ST_Distance(b.geom::extensions.geography, mb.geom::extensions.geography)::float8 as gap_m
       from farm.fields me
       join farm.current_boundaries mb on mb.field_id = me.id
       join farm.current_boundaries b
         on b.field_id <> me.id
        and extensions.ST_DWithin(b.geom::extensions.geography, mb.geom::extensions.geography, $2)
       join farm.fields f on f.id = b.field_id and f.active
       join farm.farms fa on fa.id = f.farm_id
      where me.id = $1
      order by gap_m, f.name`,
    [fieldId, MERGE_GAP_M],
  );
  return r.rows.map((x) => ({
    fieldId: x.id,
    name: x.name,
    farmName: x.farm_name,
    sameFarm: x.same_farm,
    editable: boundaryEditPolicy({ deereFieldId: x.deere_field_id }).editable,
    gapM: x.gap_m,
  }));
}

async function mergedShape(ex: Queryable, a: string, b: string): Promise<Piece> {
  const r = await ex.query<{
    adjacent: boolean;
    geojson: MultiPolygon | null;
    acres: number | null;
    lng: number | null;
    lat: number | null;
  }>(
    `with a as (select extensions.ST_MakeValid(geom) as g from farm.current_boundaries where field_id = $1),
          b as (select extensions.ST_MakeValid(geom) as g from farm.current_boundaries where field_id = $2),
          u as (select extensions.ST_Union(a.g, b.g) as g,
                       extensions.ST_DWithin(a.g::extensions.geography, b.g::extensions.geography, $3) as adjacent
                  from a, b),
          closed as (
            select u.adjacent, u.g as raw,
                   extensions.ST_Buffer(extensions.ST_Buffer(u.g::extensions.geography, $3 / 2.0, 'join=mitre')::extensions.geometry::extensions.geography,
                                        -$3 / 2.0, 'join=mitre')::extensions.geometry as shut
              from u),
          best as (
            select adjacent,
                   extensions.ST_Multi(extensions.ST_CollectionExtract(extensions.ST_MakeValid(
                     case when extensions.ST_NumGeometries(raw) > 1
                               and extensions.ST_NumGeometries(shut) < extensions.ST_NumGeometries(raw)
                          then shut else raw end), 3)) as g
              from closed)
     select adjacent, extensions.ST_AsGeoJSON(g, 9)::json as geojson, ${ACRES('g')}::float8 as acres,
            extensions.ST_X(extensions.ST_PointOnSurface(g)) as lng,
            extensions.ST_Y(extensions.ST_PointOnSurface(g)) as lat
       from best`,
    [a, b, MERGE_GAP_M],
  );
  const x = r.rows[0];
  if (!x?.geojson || x.acres === null) {
    throw new FieldDataError('both fields need a boundary to merge', 'conflict');
  }
  if (!x.adjacent) {
    throw new FieldDataError(
      `the fields are not next to each other (more than ${MERGE_GAP_M} m apart)`,
      'conflict',
    );
  }
  return { geometry: x.geojson, acres: x.acres, label: [x.lng ?? 0, x.lat ?? 0] };
}

export async function previewMerge(ex: Queryable, a: string, b: string): Promise<Piece> {
  if (a === b) throw new FieldDataError('pick two different fields');
  return mergedShape(ex, a, b);
}

export async function mergeFields(
  pool: pg.Pool,
  args: {
    fieldIds: [string, string];
    name: string;
    tenure?: Tenure | null;
    effectiveOn: string;
    actor: Actor;
    now?: Date;
  },
): Promise<{ childId: string; acres: number }> {
  const [aId, bId] = args.fieldIds;
  if (aId === bId) throw new FieldDataError('pick two different fields');
  const at = effectiveInstant(args.effectiveOn, args.now);
  return withTransaction(pool, async (c) => {
    // Lock in a fixed order so two merges of the same pair can't deadlock.
    const [first, second] = [aId, bId].sort();
    const locked = new Map<string, EditableField>();
    for (const id of [first, second] as string[]) locked.set(id, await lockEditable(c, id));
    const a = locked.get(aId) as EditableField;
    const b = locked.get(bId) as EditableField;
    if (a.farmId !== b.farmId) {
      throw new FieldDataError(
        `'${a.name}' and '${b.name}' are in different farms: move one first`,
        'conflict',
      );
    }
    checkAt(a, at);
    checkAt(b, at);
    const shape = await mergedShape(c, a.id, b.id);
    const [name] = await checkNames(c, a.farmId, [args.name], [a.id, b.id]);
    await endField(c, a.id, at);
    await endField(c, b.id, at);
    const childId = await startField(c, a, {
      name: name as string,
      tenure: args.tenure ?? undefined,
      geometry: shape.geometry,
      at,
      sourceRef: `merged from ${a.name} + ${b.name}`,
    });
    const note = `merged by ${args.actor.displayName}`;
    await lineage(c, a.id, childId, 'merge', args.effectiveOn, args.actor, note);
    await lineage(c, b.id, childId, 'merge', args.effectiveOn, args.actor, note);
    const changes = new FieldChanges();
    for (const id of [a.id, b.id, childId]) changes.add(id, 'identity', 'boundary', 'lineage');
    await changes.publish(c);
    return { childId, acres: shape.acres };
  });
}
