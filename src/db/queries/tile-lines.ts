/**
 * farm.tile_lines (plan 1d "tile_lines import and draw tool"; docs/contracts-m1.md §3.1): drawn
 * lines (source 'app', origin 'manual'), imported installer drawings and tile plow logs (source
 * 'import'), and later Deere tile plow data (source 'deere', read-only in the app like Deere
 * boundaries, D6).
 *
 * Every write bumps `updated_at` (the tiles' `?v=` version and the optimistic `version` of
 * PATCH/DELETE) and publishes `layers`/`updated { key: 'tile_lines', version }` in the same
 * transaction, so every board's tile layer reloads within the realtime budget. The caller checks
 * the role first (ROLE_FOR.editTileLines, manager+) and passes the session (created_by).
 *
 * A line's field: the one given, else the field whose current boundary holds most of the line's
 * length (none when it lies outside every field).
 */
import { TILE_LAYERS } from '../../app/api/tiles/layers';
import type { Session } from '../../platform/auth/types';
import { publish } from '../../platform/realtime/publish';
import type { Queryable } from '../client';
import type {
  CreateTileLineInput,
  TileAttributes,
  TileGeometry,
  TileKind,
  TileLineView,
  TileOrigin,
  TileSource,
  UpdateTileLineInput,
} from './tile-lines-schema';

/** Most lines one GET returns (a field has tens; a zoomed-out view gets "zoom in"). */
export const MAX_LINES_PER_READ = 500;

export class TileLineNotFoundError extends Error {
  override name = 'TileLineNotFoundError';
}

/** Someone else changed or deleted the line since it was read (HTTP 409). */
export class TileLineConflictError extends Error {
  override name = 'TileLineConflictError';
}

/** A Deere-synced line: edit it in Operations Center (HTTP 403). */
export class TileLineReadOnlyError extends Error {
  override name = 'TileLineReadOnlyError';
}

/** The field given doesn't exist (HTTP 400). */
export class TileLineFieldError extends Error {
  override name = 'TileLineFieldError';
}

const READ_ONLY_SOURCES: readonly TileSource[] = ['deere'];

interface Row {
  id: string;
  field_id: string | null;
  field_name: string | null;
  geom: string;
  kind: TileKind;
  size_in: string | null;
  depth_ft: string | null;
  installed_on: string | null;
  origin: TileOrigin;
  installer: string | null;
  notes: string | null;
  source: TileSource;
  length_ft: number;
  version: string;
}

const SELECT = `
  select t.id::text, t.field_id::text, f.name as field_name,
         extensions.ST_AsGeoJSON(t.geom, 7) as geom,
         t.kind, t.size_in::text, t.depth_ft::text,
         to_char(t.installed_on, 'YYYY-MM-DD') as installed_on,
         t.origin, t.installer, t.notes, t.source,
         round((extensions.ST_Length(t.geom::extensions.geography) * 3.28084)::numeric, 1)::float8
           as length_ft,
         to_char(t.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as version
    from farm.tile_lines t
    left join farm.fields f on f.id = t.field_id`;

function toView(r: Row): TileLineView {
  return {
    id: r.id,
    fieldId: r.field_id,
    fieldName: r.field_name,
    geometry: JSON.parse(r.geom) as TileLineView['geometry'],
    kind: r.kind,
    sizeIn: r.size_in === null ? null : Number(r.size_in),
    depthFt: r.depth_ft === null ? null : Number(r.depth_ft),
    installedOn: r.installed_on,
    origin: r.origin,
    installer: r.installer,
    notes: r.notes,
    source: r.source,
    lengthFt: Number(r.length_ft),
    version: r.version,
    editable: !READ_ONLY_SOURCES.includes(r.source),
  };
}

/** Lines in a bbox (w, s, e, n) or of one field, longest first; `truncated` past the limit. */
export async function listTileLines(
  ex: Queryable,
  q: { bbox?: readonly [number, number, number, number]; fieldId?: string },
  limit = MAX_LINES_PER_READ,
): Promise<{ lines: TileLineView[]; truncated: boolean }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.bbox) {
    params.push(...q.bbox);
    where.push(
      `t.geom && extensions.ST_MakeEnvelope($${params.length - 3}, $${params.length - 2}, $${params.length - 1}, $${params.length}, 4326)`,
    );
  }
  if (q.fieldId) {
    params.push(q.fieldId);
    where.push(`t.field_id = $${params.length}::uuid`);
  }
  if (where.length === 0) throw new Error('listTileLines needs a bbox or a field');
  params.push(limit + 1);
  const r = await ex.query<Row>(
    `${SELECT} where ${where.join(' and ')}
      order by extensions.ST_Length(t.geom::extensions.geography) desc, t.id
      limit $${params.length}`,
    params,
  );
  return { lines: r.rows.slice(0, limit).map(toView), truncated: r.rows.length > limit };
}

export async function getTileLine(ex: Queryable, id: string): Promise<TileLineView | null> {
  const r = await ex.query<Row>(`${SELECT} where t.id = $1::uuid`, [id]);
  return r.rows[0] ? toView(r.rows[0]) : null;
}

/** The geometry as a MultiLineString GeoJSON text (what the column stores). */
export function multiLineText(g: TileGeometry): string {
  const coordinates = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
  return JSON.stringify({
    type: 'MultiLineString',
    coordinates: coordinates.map((l) => l.map((p) => [p[0], p[1]])),
  });
}

/** SQL expression: the field holding most of the line `geomExpr` (null outside every field). */
const FIELD_FOR_LINE = (geomExpr: string) => `(
  select b.field_id
    from farm.current_boundaries b
    join farm.fields f on f.id = b.field_id and f.active
   where extensions.ST_Intersects(b.geom, ${geomExpr})
   order by extensions.ST_Length(extensions.ST_Intersection(b.geom, ${geomExpr})::extensions.geography) desc,
            b.field_id
   limit 1)`;

const GEOM_PARAM = (n: number) =>
  `extensions.ST_Multi(extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON($${n}), 4326))`;

async function assertField(ex: Queryable, fieldId: string | null | undefined): Promise<void> {
  if (!fieldId) return;
  const r = await ex.query('select 1 from farm.fields where id = $1::uuid', [fieldId]);
  if (r.rowCount === 0) throw new TileLineFieldError(`no field ${fieldId}`);
}

/** Publish the layer's new version (inside the write's transaction: delivered on commit). */
export async function publishTileLinesChanged(ex: Queryable): Promise<string> {
  const version = await TILE_LAYERS.tile_lines.version(ex);
  await publish('layers', 'updated', { key: 'tile_lines', version }, ex);
  return version;
}

/** Draw tool: a new line (source 'app', origin 'manual'). Run inside a transaction. */
export async function createTileLine(
  ex: Queryable,
  input: CreateTileLineInput,
  session: Session,
): Promise<TileLineView> {
  await assertField(ex, input.fieldId);
  const geom = GEOM_PARAM(1);
  const r = await ex.query<{ id: string }>(
    `insert into farm.tile_lines
       (geom, field_id, kind, size_in, depth_ft, installed_on, origin, installer, notes, source,
        created_by)
     values (${geom}, coalesce($2::uuid, ${FIELD_FOR_LINE(geom)}), $3, $4, $5, $6::date, 'manual',
             $7, $8, 'app', $9::uuid)
     returning id::text`,
    [
      multiLineText(input.geometry),
      input.fieldId ?? null,
      input.kind ?? 'lateral',
      input.sizeIn ?? null,
      input.depthFt ?? null,
      input.installedOn ?? null,
      input.installer ?? null,
      input.notes ?? null,
      session.appUserId,
    ],
  );
  const id = r.rows[0]?.id as string;
  await publishTileLinesChanged(ex);
  return (await getTileLine(ex, id)) as TileLineView;
}

/** Lock the row and check it may change at this version. */
async function lockForWrite(ex: Queryable, id: string, version: string): Promise<void> {
  const r = await ex.query<{ source: TileSource; version: string }>(
    `select source,
            to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as version
       from farm.tile_lines where id = $1::uuid for update`,
    [id],
  );
  const row = r.rows[0];
  if (!row) throw new TileLineNotFoundError(`no tile line ${id}`);
  if (READ_ONLY_SOURCES.includes(row.source)) {
    throw new TileLineReadOnlyError('this line comes from Operations Center: change it there');
  }
  if (row.version !== version) {
    throw new TileLineConflictError('the line changed since you opened it: reload and try again');
  }
}

/** Edit attributes and/or the shape. Run inside a transaction. */
export async function updateTileLine(
  ex: Queryable,
  id: string,
  patch: UpdateTileLineInput,
): Promise<TileLineView> {
  await lockForWrite(ex, id, patch.version);
  await assertField(ex, patch.fieldId);
  const sets: string[] = [];
  const params: unknown[] = [id];
  const set = (col: string, value: unknown, cast = '') => {
    params.push(value);
    sets.push(`${col} = $${params.length}${cast}`);
  };
  const attrs: [keyof TileAttributes, string, string][] = [
    ['kind', 'kind', ''],
    ['sizeIn', 'size_in', ''],
    ['depthFt', 'depth_ft', ''],
    ['installedOn', 'installed_on', '::date'],
    ['installer', 'installer', ''],
    ['notes', 'notes', ''],
  ];
  for (const [key, col, cast] of attrs) {
    if (patch[key] !== undefined) set(col, patch[key], cast);
  }
  let geomExpr = 't.geom';
  if (patch.geometry) {
    params.push(multiLineText(patch.geometry));
    geomExpr = GEOM_PARAM(params.length);
    sets.push(`geom = ${geomExpr}`);
  }
  if (patch.fieldId) set('field_id', patch.fieldId, '::uuid');
  // Unpinned (null), or reshaped without a pin: the field the line (now) mostly lies in.
  else if (patch.fieldId === null || patch.geometry) {
    sets.push(`field_id = ${FIELD_FOR_LINE(geomExpr)}`);
  }
  sets.push('updated_at = clock_timestamp()');
  await ex.query(
    `update farm.tile_lines as t set ${sets.join(', ')} where t.id = $1::uuid`,
    params,
  );
  await publishTileLinesChanged(ex);
  return (await getTileLine(ex, id)) as TileLineView;
}

/** Delete a line at the version read. Run inside a transaction. */
export async function deleteTileLine(ex: Queryable, id: string, version: string): Promise<void> {
  await lockForWrite(ex, id, version);
  await ex.query('delete from farm.tile_lines where id = $1::uuid', [id]);
  await publishTileLinesChanged(ex);
}
