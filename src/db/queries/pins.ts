/**
 * farm.pins (slice 1f, docs/contracts-1f.md §5.2; owner: deere-data): the Deere flags writer and
 * the read behind GET /api/pins.
 *
 *  - `applyDeereFlags`: the flags of every org a deere.fields run listed, in ONE transaction:
 *    each flag upserted as a read-only pin (`source 'deere_flag'`, `source_id` = the flag id, id
 *    = deterministicId('deere_flag', flag id)), kind from its category (`pinKindOfCategory`), its
 *    field through the ('deere', 'field', …) ref of the org it was read from; an archived flag
 *    resolves its pin (`resolved_at`, kept from the first time), an un-archived one reopens it;
 *    the open pins of a listed org whose flag Deere no longer lists (deleted in Operations
 *    Center) are resolved. A pin is written only when something about it changed, and
 *    `pins`/`updated` is published once, in the same transaction, when any did (contracts-1f §6;
 *    the decision table records the trigger-less batch).
 *  - `listPins`: open pins (or every pin), with the field's name, as `PinView`s.
 */
import { pinKindOfCategory } from '../../connectors/deere/fields/mapper';
import type { NormalizedFlag } from '../../connectors/types';
import { deterministicId } from '../../domain/ids';
import {
  type PinGeometry,
  type PinKind,
  type PinSource,
  type PinView,
  pinGeometrySchema,
} from '../../domain/pins';
import { publish } from '../../platform/realtime/publish';
import type { PinsUpdatedPayload } from '../../platform/realtime/types';
import { type Executor, exec, toDate } from '../exec';
import { resolveExternalRefs } from '../external-refs';

/** pins.source of a Deere flag. */
export const DEERE_FLAG_SOURCE: PinSource = 'deere_flag';

/** The pin id of a Deere flag. */
export const deereFlagPinId = (flagId: string): string =>
  deterministicId(DEERE_FLAG_SOURCE, flagId);

export interface DeereFlagsResult {
  /** Pins inserted or changed (resolved, reopened, moved …). */
  changed: number;
  /** Open pins resolved because their flag is no longer listed. */
  removed: number;
  /** The payload published (null when nothing changed). */
  published: PinsUpdatedPayload | null;
}

/** One org's flags as the writer takes them. */
export interface OrgFlags {
  orgId: string;
  flags: readonly NormalizedFlag[];
}

/** See the file comment. */
export async function applyDeereFlags(
  ex: Executor,
  orgs: readonly OrgFlags[],
): Promise<DeereFlagsResult> {
  const touched = new Set<string | null>();
  let changed = 0;
  let removed = 0;
  for (const { orgId, flags } of orgs) {
    const fieldIds = await resolveExternalRefs(
      ex,
      'deere',
      'field',
      orgId,
      flags.map((f) => f.fieldExternalId).filter((x): x is string => !!x),
    );
    for (const f of flags) {
      const fieldId = f.fieldExternalId ? (fieldIds.get(f.fieldExternalId) ?? null) : null;
      const kind: PinKind = pinKindOfCategory(f.category);
      const resolvedAt = f.archived ? (f.modifiedAt ?? new Date().toISOString()) : null;
      const r = await exec<{ field_id: string | null; prev_field_id: string | null }>(
        ex,
        `with prev as (
           select field_id from farm.pins where source = $8 and source_id = $9
         )
         insert into farm.pins as p (id, kind, field_id, geom, note, category, resolved_at,
                                     read_only, source, source_id, source_org, source_modified_at,
                                     created_at)
         values ($1::uuid, $2, $3::uuid,
                 extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON($4::text), 4326),
                 $5, $6, $7::timestamptz, true, $8, $9, $10, $11::timestamptz,
                 coalesce($12::timestamptz, now()))
         on conflict (source, source_id) do update
           set kind = excluded.kind,
               field_id = excluded.field_id,
               geom = excluded.geom,
               note = excluded.note,
               category = excluded.category,
               resolved_at = case when excluded.resolved_at is null then null
                                  else coalesce(p.resolved_at, excluded.resolved_at) end,
               read_only = true,
               source_org = excluded.source_org,
               source_modified_at = excluded.source_modified_at,
               updated_at = now()
         where p.kind is distinct from excluded.kind
            or p.field_id is distinct from excluded.field_id
            or extensions.ST_AsBinary(p.geom) is distinct from extensions.ST_AsBinary(excluded.geom)
            or p.note is distinct from excluded.note
            or p.category is distinct from excluded.category
            or (p.resolved_at is null) <> (excluded.resolved_at is null)
            or p.read_only is distinct from true
            or p.source_org is distinct from excluded.source_org
            or p.source_modified_at is distinct from excluded.source_modified_at
         returning p.field_id::text as field_id, (select field_id::text from prev) as prev_field_id`,
        [
          deereFlagPinId(f.externalId),
          kind,
          fieldId,
          JSON.stringify(f.geometry),
          f.note,
          f.category,
          resolvedAt,
          DEERE_FLAG_SOURCE,
          f.externalId,
          orgId,
          f.modifiedAt,
          f.createdAt,
        ],
      );
      const row = r.rows[0];
      if (!row) continue;
      changed++;
      touched.add(row.field_id);
      if (row.prev_field_id !== row.field_id) touched.add(row.prev_field_id);
    }
    const gone = await exec<{ field_id: string | null }>(
      ex,
      `update farm.pins set resolved_at = now(), updated_at = now()
        where source = $1 and source_org = $2 and resolved_at is null
          and not (source_id = any($3::text[]))
        returning field_id::text as field_id`,
      [DEERE_FLAG_SOURCE, orgId, flags.map((f) => f.externalId)],
    );
    removed += gone.rowCount;
    for (const g of gone.rows) touched.add(g.field_id);
  }
  if (changed + removed === 0) return { changed, removed, published: null };
  const payload: PinsUpdatedPayload = {
    fieldIds: [...touched].filter((x): x is string => x !== null).sort(),
    hasUnfielded: touched.has(null),
  };
  await publish('pins', 'updated', payload, ex);
  return { changed, removed, published: payload };
}

interface PinRow {
  id: string;
  kind: PinKind;
  field_id: string | null;
  field_name: string | null;
  note: string | null;
  category: string | null;
  geometry: PinGeometry;
  source: PinSource;
  read_only: boolean;
  resolved_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const isoOf = (v: Date | string): string => (toDate(v) as Date).toISOString();

/** A geometry as GET /api/pins sends it (validated; anything else is dropped from the list). */
function pinGeometry(g: unknown): PinGeometry | null {
  const r = pinGeometrySchema.safeParse(g);
  return r.success ? (r.data as PinGeometry) : null;
}

/** Pins for GET /api/pins: open ones (or all with `resolved`), optionally of one field. */
export async function listPins(
  ex: Executor,
  opts: { fieldId?: string | null; resolved?: boolean } = {},
): Promise<PinView[]> {
  const r = await exec<PinRow>(
    ex,
    `select p.id::text as id, p.kind, p.field_id::text as field_id, f.name as field_name, p.note,
            p.category, extensions.ST_AsGeoJSON(p.geom, 7)::json as geometry, p.source,
            p.read_only, p.resolved_at, p.created_at, p.updated_at
       from farm.pins p left join farm.fields f on f.id = p.field_id
      where ($1::uuid is null or p.field_id = $1::uuid)
        and ($2::boolean or p.resolved_at is null)
      order by p.created_at, p.id`,
    [opts.fieldId ?? null, opts.resolved === true],
  );
  const out: PinView[] = [];
  for (const row of r.rows) {
    const geometry = pinGeometry(row.geometry);
    if (!geometry) continue;
    out.push({
      id: row.id,
      kind: row.kind,
      fieldId: row.field_id,
      fieldName: row.field_name,
      note: row.note,
      category: row.category,
      geometry,
      source: row.source,
      readOnly: row.read_only,
      resolvedAt: row.resolved_at === null ? null : isoOf(row.resolved_at),
      createdAt: isoOf(row.created_at),
      updatedAt: isoOf(row.updated_at),
    });
  }
  return out;
}
