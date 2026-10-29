/**
 * Load mapped tile lines into farm.tile_lines (plan 1d `import:tile`), in ONE transaction:
 * upsert by (source 'import', source_id `<file name>#<feature id>`) with deterministic ids, so
 * a re-import of the same file changes nothing and a corrected file updates its lines in place;
 * each line's field is the one given (--field) or the field holding most of its length;
 * `--replace` deletes earlier imported lines of the same file name (source_ref) that this file
 * no longer has. Publishes `layers`/`updated { key: 'tile_lines' }` on commit when anything
 * changed.
 */
import type pg from 'pg';
import { publishTileLinesChanged } from '../../src/db/queries/tile-lines';
import type { TileOrigin } from '../../src/db/queries/tile-lines-schema';
import type { TileRecord } from './tile-map';

export interface TileImportMeta {
  origin: TileOrigin;
  /** The file name (source_ref): --replace works per file name. */
  sourceRef: string;
  /** Pin every line to this field (uuid); else each line finds its own. */
  fieldId: string | null;
}

export interface TileLoadSummary {
  inserted: number;
  updated: number;
  unchanged: number;
  deleted: number;
  /** Lines in no field (outside every current boundary). */
  noField: number;
  version: string | null;
}

const UPSERT_SQL = `
  with src as (
    select r.id, r.source_id, r.kind, r.size_in, r.depth_ft, r.installed_on, r.installer, r.notes,
           extensions.ST_Multi(extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON(r.geom), 4326))
             as geom
      from jsonb_to_recordset($1::jsonb) as r(id uuid, source_id text, kind text, size_in numeric,
             depth_ft numeric, installed_on date, installer text, notes text, geom text)
  )
  insert into farm.tile_lines as t (id, field_id, geom, kind, size_in, depth_ft, installed_on,
                                    origin, installer, notes, source, source_id, source_ref)
  select src.id,
         coalesce($2::uuid, (
           select b.field_id
             from farm.current_boundaries b
             join farm.fields f on f.id = b.field_id and f.active
            where extensions.ST_Intersects(b.geom, src.geom)
            order by extensions.ST_Length(extensions.ST_Intersection(b.geom, src.geom)::extensions.geography) desc,
                     b.field_id
            limit 1)),
         src.geom, src.kind, src.size_in, src.depth_ft, src.installed_on, $3, src.installer,
         src.notes, 'import', src.source_id, $4
    from src
  on conflict (source, source_id) do update
     set field_id = excluded.field_id, geom = excluded.geom, kind = excluded.kind,
         size_in = excluded.size_in, depth_ft = excluded.depth_ft,
         installed_on = excluded.installed_on, origin = excluded.origin,
         installer = excluded.installer, notes = excluded.notes,
         source_ref = excluded.source_ref, updated_at = clock_timestamp()
   where (t.field_id, t.kind, t.size_in, t.depth_ft, t.installed_on, t.origin, t.installer,
          t.notes, t.source_ref)
           is distinct from
         (excluded.field_id, excluded.kind, excluded.size_in, excluded.depth_ft,
          excluded.installed_on, excluded.origin, excluded.installer, excluded.notes,
          excluded.source_ref)
      or not extensions.ST_Equals(t.geom, excluded.geom)
  returning t.id::text as id, (xmax = 0) as inserted, t.field_id is null as no_field`;

export async function loadTileLines(
  pool: pg.Pool,
  records: readonly TileRecord[],
  meta: TileImportMeta,
  opts: { replace?: boolean; batchSize?: number } = {},
): Promise<TileLoadSummary> {
  const batchSize = opts.batchSize ?? 500;
  const c = await pool.connect();
  try {
    await c.query('begin');
    if (meta.fieldId) {
      const f = await c.query('select 1 from farm.fields where id = $1::uuid', [meta.fieldId]);
      if (f.rowCount === 0) throw new Error(`no field ${meta.fieldId}`);
    }
    let inserted = 0;
    let updated = 0;
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize).map((r) => ({
        id: r.id,
        source_id: r.sourceId,
        kind: r.kind,
        size_in: r.sizeIn,
        depth_ft: r.depthFt,
        installed_on: r.installedOn,
        installer: r.installer,
        notes: r.notes,
        geom: JSON.stringify(r.geometry),
      }));
      const r = await c.query<{ inserted: boolean }>(UPSERT_SQL, [
        JSON.stringify(batch),
        meta.fieldId,
        meta.origin,
        meta.sourceRef,
      ]);
      for (const row of r.rows) {
        if (row.inserted) inserted += 1;
        else updated += 1;
      }
    }
    let deleted = 0;
    if (opts.replace) {
      const d = await c.query(
        `delete from farm.tile_lines
          where source = 'import' and source_ref = $1 and not (source_id = any($2::text[]))`,
        [meta.sourceRef, records.map((r) => r.sourceId)],
      );
      deleted = d.rowCount ?? 0;
    }
    const noField = await c.query<{ n: number }>(
      `select count(*)::int as n from farm.tile_lines
        where source = 'import' and source_id = any($1::text[]) and field_id is null`,
      [records.map((r) => r.sourceId)],
    );
    const changed = inserted + updated + deleted > 0;
    const version = changed ? await publishTileLinesChanged(c) : null;
    await c.query('commit');
    return {
      inserted,
      updated,
      unchanged: records.length - inserted - updated,
      deleted,
      noField: noField.rows[0]?.n ?? 0,
      version,
    };
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
