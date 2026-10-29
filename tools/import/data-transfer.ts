/**
 * data:export / data:import (plan 1c, plan §3 Scripts, contracts-m1 §13): an app-level JSON
 * file of the data people typed in or imported, so it survives `pnpm db:reset`, a new PC, and
 * (at MD) the move to Supabase (`data:import --target=prod`).
 *
 * What is exported:
 *  - TABLE rows that were entered by hand or imported from files (sources app, import, drawn,
 *    manual), never rows of the demo farm or the simulator (source demo/sim), and never rows a
 *    sync writes (deere, samsara, ...): those come back by themselves, with the SAME ids
 *    (deterministic ids, plan §4), so hand-entered rows that point at them still fit.
 *  - OVERLAYS: hand-entered values that live on synced rows: a field's landlord when it is one
 *    of your own parties, field notes edited in the app, a hidden (inactive) field, a farm's
 *    customer when it is one of your own parties; on Deere fields also the tenure and county
 *    (Operations Center has neither), on Deere parties the contact details.
 *
 * Import upserts by id (`on conflict (id)`), table by table in foreign-key order, in ONE
 * transaction: all or nothing unless `partial`. Re-importing the same file changes nothing.
 * A boundary version that overlaps a synced version of the same field closes the synced one
 * where the hand-made one starts (what the original edit did).
 *
 * Format: { format: 'farm-ops-data', version: 1, exportedAt, tables: { 'farm.parties': [row…] },
 * overlays: { 'farm.fields': [{ id, …only the hand-entered columns }] } }. Rows are JSON objects
 * keyed by column name; geometry as GeoJSON (EPSG:4326); tstzrange as { from, to } ([from, to)).
 */
import type pg from 'pg';
import { withTransaction } from '../../src/db/queries/boundaries-sql';
import { publish } from '../../src/platform/realtime/publish';

export const EXPORT_FORMAT = 'farm-ops-data';
export const EXPORT_VERSION = 1;

type Row = Record<string, unknown>;

export interface ExportDoc {
  format: typeof EXPORT_FORMAT;
  version: number;
  exportedAt: string;
  /** Rows per table, in import order. */
  tables: Record<string, Row[]>;
  /** Hand-entered columns on synced rows. */
  overlays: Record<string, Row[]>;
}

interface TableSpec {
  table: string;
  /** Key column (upsert target). */
  key: string;
  /** Which rows are hand-entered (SQL on alias t). */
  where: string;
  /** Plain columns (key included), exported and imported. */
  columns: string[];
  /** Geometry columns (GeoJSON in the file). */
  geometry?: string[];
  /** tstzrange columns ({ from, to } in the file). */
  ranges?: string[];
  /** Self references, set in a second pass (the row they point at may come later). */
  deferred?: string[];
  /** Exported for people reading the file; recomputed by the database on import. */
  exportOnly?: string[];
  /** Export order (stable files diff well). */
  orderBy: string;
}

const STAMPS = ['created_at', 'updated_at'];

/** Import order = foreign-key order. */
export const TABLES: readonly TableSpec[] = [
  {
    table: 'farm.parties',
    key: 'id',
    where: `t.source in ('app', 'import')`,
    columns: [
      'id',
      'kind',
      'display_name',
      'roles',
      'phone',
      'email',
      'address',
      'notes',
      'source',
      'source_id',
      ...STAMPS,
    ],
    deferred: ['org_id', 'introduced_by'],
    orderBy: 't.created_at, t.id',
  },
  {
    table: 'farm.app_users',
    key: 'id',
    where: `t.source = 'app'`,
    columns: [
      'id',
      'party_id',
      'role',
      'auth_user_id',
      'pin_hash',
      'pin_set_at',
      'session_epoch',
      'active',
      'last_sign_in_at',
      'source',
      'source_id',
      ...STAMPS,
    ],
    orderBy: 't.created_at, t.id',
  },
  {
    table: 'farm.devices',
    key: 'id',
    where: `t.source = 'app'`,
    // Never the one-time enrollment code hash.
    columns: [
      'id',
      'kind',
      'name',
      'role',
      'app_user_id',
      'auth_user_id',
      'enrolled_at',
      'session_epoch',
      'last_seen_at',
      'revoked_at',
      'created_by',
      'source',
      'source_id',
      ...STAMPS,
    ],
    orderBy: 't.created_at, t.id',
  },
  {
    table: 'farm.farms',
    key: 'id',
    where: `t.source in ('app', 'import')`,
    columns: ['id', 'name', 'client_party_id', 'deere_farm_id', 'source', 'source_id', ...STAMPS],
    orderBy: 't.created_at, t.id',
  },
  {
    table: 'farm.fields',
    key: 'id',
    where: `t.source in ('app', 'import')`,
    columns: [
      'id',
      'farm_id',
      'name',
      'county_fips',
      'tenure',
      'landlord_party_id',
      'deere_field_id',
      'active',
      'notes',
      'notes_updated_at',
      'notes_updated_by',
      'source',
      'source_id',
      ...STAMPS,
    ],
    orderBy: 't.created_at, t.id',
  },
  {
    table: 'farm.field_boundaries',
    key: 'id',
    where: `t.source in ('import', 'drawn')`,
    columns: ['id', 'field_id', 'source', 'source_id', 'source_ref', 'derived_stale', 'created_at'],
    geometry: ['geom'],
    ranges: ['valid'],
    exportOnly: ['acres'],
    orderBy: 'lower(t.valid), t.id',
  },
  {
    table: 'farm.field_seasons',
    key: 'id',
    where: `t.source in ('app', 'import')`,
    columns: [
      'id',
      'field_id',
      'crop_year',
      'crop',
      'variety',
      'planted_on',
      'harvested_on',
      'yield_bu_ac',
      'source',
      'source_id',
      ...STAMPS,
    ],
    orderBy: 't.field_id, t.crop_year',
  },
  {
    table: 'farm.field_lineage',
    key: 'id',
    where: 'true',
    columns: [
      'id',
      'parent_field_id',
      'child_field_id',
      'kind',
      'effective_on',
      'note',
      'created_by',
      'created_at',
    ],
    orderBy: 't.effective_on, t.created_at, t.id',
  },
  {
    table: 'farm.boundary_change_requests',
    key: 'id',
    where: 'true',
    columns: [
      'id',
      'field_id',
      'note',
      'requested_by',
      'requested_at',
      'resolved_at',
      'resolved_by',
      'resolution',
    ],
    geometry: ['proposed_geom'],
    orderBy: 't.requested_at, t.id',
  },
  {
    table: 'farm.machines',
    key: 'id',
    where: `t.source = 'app'`,
    columns: [
      'id',
      'kind',
      'unit_no',
      'make',
      'model',
      'year',
      'vin_serial',
      'status',
      'down_reason',
      'down_at',
      'down_by',
      'engine_hours',
      'odometer_mi',
      'source',
      'source_id',
      ...STAMPS,
    ],
    orderBy: 't.created_at, t.id',
  },
  {
    table: 'farm.geofences',
    key: 'id',
    where: `t.source = 'app'`,
    columns: [
      'id',
      'kind',
      'name',
      'party_id',
      'field_id',
      'active',
      'source',
      'source_id',
      ...STAMPS,
    ],
    geometry: ['geom'],
    orderBy: 't.created_at, t.id',
  },
  {
    table: 'farm.soil_temp_readings',
    key: 'id',
    where: `t.source = 'manual'`,
    columns: [
      'id',
      'field_id',
      'observed_at',
      'depth_in',
      'temp_f',
      'source',
      'source_id',
      'entered_by',
      'device_id',
      'note',
      'created_at',
    ],
    geometry: ['geom'],
    orderBy: 't.observed_at, t.id',
  },
  {
    table: 'farm.tile_lines',
    key: 'id',
    where: `t.source in ('app', 'import')`,
    columns: [
      'id',
      'field_id',
      'kind',
      'size_in',
      'depth_ft',
      'installed_on',
      'origin',
      'installer',
      'notes',
      'source',
      'source_id',
      'source_ref',
      'created_by',
      ...STAMPS,
    ],
    geometry: ['geom'],
    orderBy: 't.created_at, t.id',
  },
  {
    // Settings people chose (not the job clock's pause, which is the PC's state).
    table: 'app.settings',
    key: 'key',
    // Only when someone set them (the defaults come back with `pnpm db:configure`).
    where: `t.key = 'spray.thresholds' and t.value -> 'isDefault' is distinct from 'true'::jsonb`,
    columns: ['key', 'value', 'updated_at'],
    orderBy: 't.key',
  },
];

interface OverlaySpec {
  table: string;
  /** Rows the overlay applies to (synced rows), alias t. */
  where: string;
  /** column -> SQL that is true when the column holds a hand-entered value. */
  columns: Record<string, string>;
}

const OWN_PARTY = (col: string) =>
  `exists (select 1 from farm.parties p where p.id = t.${col} and p.source in ('app', 'import'))`;

export const OVERLAYS: readonly OverlaySpec[] = [
  {
    table: 'farm.fields',
    where: `t.source not in ('app', 'import')`,
    columns: {
      landlord_party_id: OWN_PARTY('landlord_party_id'),
      notes: 't.notes_updated_at is not null',
      notes_updated_at: 't.notes_updated_at is not null',
      notes_updated_by: 't.notes_updated_at is not null',
      active: 'not t.active',
      tenure: `t.source = 'deere'`,
      county_fips: `t.source = 'deere'`,
    },
  },
  {
    table: 'farm.farms',
    where: `t.source not in ('app', 'import')`,
    columns: { client_party_id: OWN_PARTY('client_party_id') },
  },
  {
    table: 'farm.parties',
    where: `t.source = 'deere'`,
    columns: {
      phone: 'true',
      email: 'true',
      address: 'true',
      notes: 'true',
      roles: 'true',
    },
  },
];

const q = (c: string) => `"${c}"`;

function exportSql(s: TableSpec): string {
  const parts = [...s.columns, ...(s.deferred ?? []), ...(s.exportOnly ?? [])].map(
    (c) => `'${c}', t.${q(c)}`,
  );
  for (const g of s.geometry ?? []) {
    parts.push(`'${g}', extensions.ST_AsGeoJSON(t.${q(g)}, 9)::jsonb`);
  }
  for (const r of s.ranges ?? []) {
    parts.push(`'${r}', jsonb_build_object('from', lower(t.${q(r)}), 'to', upper(t.${q(r)}))`);
  }
  // jsonb_build_object takes at most 100 arguments: build in chunks.
  const chunks: string[] = [];
  for (let i = 0; i < parts.length; i += 40) {
    chunks.push(`jsonb_build_object(${parts.slice(i, i + 40).join(', ')})`);
  }
  return `select ${chunks.join(' || ')} as row from ${s.table} t where ${s.where} order by ${s.orderBy}`;
}

function overlaySql(o: OverlaySpec): string {
  const cols = Object.entries(o.columns);
  const obj = cols
    .map(
      ([c, cond]) =>
        `case when ${cond} then jsonb_build_object('${c}', t.${q(c)}) else '{}'::jsonb end`,
    )
    .join(' || ');
  return `select * from (select jsonb_build_object('id', t.id) || ${obj} as row
                           from ${o.table} t where ${o.where} order by t.id) x
           where (select count(*) from jsonb_object_keys(x.row)) > 1`;
}

/** Read every hand-entered row and overlay (one consistent snapshot). */
export async function exportData(pool: pg.Pool, now: Date = new Date()): Promise<ExportDoc> {
  return withTransaction(
    pool,
    async (c) => {
      await c.query('set transaction isolation level repeatable read, read only');
      const tables: Record<string, Row[]> = {};
      for (const s of TABLES) {
        const r = await c.query<{ row: Row }>(exportSql(s));
        tables[s.table] = r.rows.map((x) => x.row);
      }
      const overlays: Record<string, Row[]> = {};
      for (const o of OVERLAYS) {
        const r = await c.query<{ row: Row }>(overlaySql(o));
        overlays[o.table] = r.rows.map((x) => x.row);
      }
      return {
        format: EXPORT_FORMAT,
        version: EXPORT_VERSION,
        exportedAt: now.toISOString(),
        tables,
        overlays,
      };
    },
    { rollback: true },
  );
}

// ---------------------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------------------

export interface ImportCounts {
  inserted: number;
  updated: number;
  unchanged: number;
  failed: number;
}

export interface ImportProblem {
  table: string;
  id: string;
  message: string;
}

export interface ImportReport {
  dryRun: boolean;
  written: boolean;
  tables: Record<string, ImportCounts>;
  overlays: Record<string, ImportCounts>;
  errors: ImportProblem[];
  warnings: ImportProblem[];
}

export class ExportFormatError extends Error {
  override name = 'ExportFormatError';
}

/** Check a parsed file is an export this code can read. */
export function checkExportDoc(doc: unknown): ExportDoc {
  const d = doc as Partial<ExportDoc> | null;
  if (!d || typeof d !== 'object' || d.format !== EXPORT_FORMAT) {
    throw new ExportFormatError('not a farm-ops data export (format farm-ops-data)');
  }
  if (typeof d.version !== 'number' || d.version > EXPORT_VERSION) {
    throw new ExportFormatError(
      `export version ${String(d.version)} is newer than this app understands (${EXPORT_VERSION}): update the app first`,
    );
  }
  if (!d.tables || typeof d.tables !== 'object')
    throw new ExportFormatError('the export has no tables');
  for (const [name, rows] of Object.entries(d.tables)) {
    if (!TABLES.some((s) => s.table === name)) {
      throw new ExportFormatError(`unknown table '${name}' in the export`);
    }
    if (!Array.isArray(rows)) throw new ExportFormatError(`'${name}' is not a list of rows`);
  }
  for (const [name, rows] of Object.entries(d.overlays ?? {})) {
    if (!OVERLAYS.some((o) => o.table === name)) {
      throw new ExportFormatError(`unknown overlay '${name}' in the export`);
    }
    if (!Array.isArray(rows)) throw new ExportFormatError(`overlay '${name}' is not a list`);
  }
  return { ...(d as ExportDoc), overlays: d.overlays ?? {} };
}

/**
 * The upsert for one row. Only the columns the row carries are written (a missing column takes
 * its default on insert and is left alone on update), so older files and hand-trimmed ones
 * still import.
 */
function upsertSql(s: TableSpec, row: Row): string {
  const has = (c: string) => Object.hasOwn(row, c);
  const plain = s.columns.filter(has);
  const geoms = (s.geometry ?? []).filter(has);
  const ranges = (s.ranges ?? []).filter(has);
  const all = [...plain, ...geoms, ...ranges];
  if (!all.includes(s.key)) throw new Error(`a row has no '${s.key}'`);
  const strip = [
    ...(s.geometry ?? []),
    ...(s.ranges ?? []),
    ...(s.deferred ?? []),
    ...(s.exportOnly ?? []),
  ]
    .map((c) => ` - '${c}'`)
    .join('');
  const select = [
    ...plain.map((c) => `r.${q(c)}`),
    ...geoms.map(
      (g) =>
        `case when jsonb_typeof($1::jsonb -> '${g}') = 'object'
              then extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON(($1::jsonb -> '${g}')::text), 4326) end`,
    ),
    ...ranges.map(
      (rg) =>
        `tstzrange((($1::jsonb -> '${rg}') ->> 'from')::timestamptz, (($1::jsonb -> '${rg}') ->> 'to')::timestamptz, '[)')`,
    ),
  ];
  const updatable = all.filter((c) => c !== s.key);
  const onConflict = updatable.length
    ? `do update
             set (${updatable.map(q).join(', ')}) = row(${updatable.map((c) => `excluded.${q(c)}`).join(', ')})
           where (${updatable.map((c) => `t.${q(c)}`).join(', ')})
                 is distinct from (${updatable.map((c) => `excluded.${q(c)}`).join(', ')})`
    : 'do nothing';
  return `insert into ${s.table} as t (${all.map(q).join(', ')})
          select ${select.join(', ')}
            from jsonb_populate_record(null::${s.table}, $1::jsonb${strip}) r
          on conflict (${q(s.key)}) ${onConflict}
          returning (xmax = 0) as inserted`;
}

function deferredSql(s: TableSpec, row: Row): string | null {
  const d = (s.deferred ?? []).filter((c) => Object.hasOwn(row, c));
  if (!d.length) return null;
  return `update ${s.table} as t
             set (${d.map(q).join(', ')}) = row(${d.map((c) => `r.${q(c)}`).join(', ')})
            from jsonb_populate_record(null::${s.table}, $1::jsonb) r
           where t.${q(s.key)} = r.${q(s.key)}
             and (${d.map((c) => `t.${q(c)}`).join(', ')}) is distinct from (${d.map((c) => `r.${q(c)}`).join(', ')})`;
}

function overlayUpdateSql(o: OverlaySpec, cols: string[]): string {
  return `update ${o.table} as t
             set (${cols.map(q).join(', ')}) = row(${cols.map((c) => `r.${q(c)}`).join(', ')})
            from jsonb_populate_record(null::${o.table}, $1::jsonb) r
           where t.id = r.id
             and (${cols.map((c) => `t.${q(c)}`).join(', ')}) is distinct from (${cols.map((c) => `r.${q(c)}`).join(', ')})
          returning t.id`;
}

/**
 * Boundary versions: a synced (demo/sim/deere) version of the same field overlapping the one
 * being imported is closed where the imported one starts, as the original edit did. Anything
 * else overlapping is a real conflict (reported by the EXCLUDE constraint).
 */
async function makeRoomForBoundary(c: pg.PoolClient, row: Row): Promise<void> {
  const valid = row.valid as { from: string | null; to: string | null } | undefined;
  if (!valid?.from) return;
  await c.query(
    `update farm.field_boundaries b
        set valid = tstzrange(lower(b.valid), $3::timestamptz, '[)')
      where b.field_id = $1 and b.id <> $2
        and b.source not in ('import', 'drawn')
        and lower(b.valid) < $3::timestamptz
        and b.valid && tstzrange($3::timestamptz, $4::timestamptz, '[)')`,
    [row.field_id, row.id, valid.from, valid.to],
  );
}

/**
 * Seasons: the demo seed's row for the same field and year gives way to the hand-entered one
 * (unique (field_id, crop_year)); a synced Deere row does not (reported).
 */
async function makeRoomForSeason(c: pg.PoolClient, row: Row): Promise<void> {
  await c.query(
    `delete from farm.field_seasons
      where field_id = $1 and crop_year = $2 and id <> $3 and source in ('demo', 'sim')`,
    [row.field_id, row.crop_year, row.id],
  );
}

const emptyCounts = (): ImportCounts => ({ inserted: 0, updated: 0, unchanged: 0, failed: 0 });

function describePgError(e: unknown): string {
  const err = e as { message?: string; constraint?: string; detail?: string };
  const what = err.constraint ? ` (${err.constraint})` : '';
  return `${err.message ?? String(e)}${what}${err.detail ? `: ${err.detail}` : ''}`;
}

/**
 * Upsert an export into the database. All or nothing: any row that fails rolls everything
 * back (unless `partial`), and the report lists every failure with its table and id.
 */
export async function importData(
  pool: pg.Pool,
  input: unknown,
  opts: { dryRun?: boolean; partial?: boolean } = {},
): Promise<ImportReport> {
  const doc = checkExportDoc(input);
  const dryRun = opts.dryRun ?? false;
  const report: ImportReport = {
    dryRun,
    written: false,
    tables: {},
    overlays: {},
    errors: [],
    warnings: [],
  };
  const c = await pool.connect();
  try {
    await c.query('begin');
    for (const s of TABLES) {
      const rows = doc.tables[s.table] ?? [];
      const status: (keyof ImportCounts)[] = [];
      for (const row of rows) {
        await c.query('savepoint r');
        try {
          if (s.table === 'farm.field_boundaries') await makeRoomForBoundary(c, row);
          if (s.table === 'farm.field_seasons') await makeRoomForSeason(c, row);
          const r = await c.query<{ inserted: boolean }>(upsertSql(s, row), [JSON.stringify(row)]);
          const x = r.rows[0];
          status.push(!x ? 'unchanged' : x.inserted ? 'inserted' : 'updated');
          await c.query('release savepoint r');
        } catch (e) {
          await c.query('rollback to savepoint r');
          status.push('failed');
          report.errors.push({
            table: s.table,
            id: String(row[s.key] ?? '?'),
            message: describePgError(e),
          });
        }
      }
      // Second pass: references between rows of this table (a person's organization).
      if (s.deferred?.length) {
        for (const [i, row] of rows.entries()) {
          const dsql = deferredSql(s, row);
          if (status[i] === 'failed' || !dsql) continue;
          await c.query('savepoint r');
          try {
            const r = await c.query(dsql, [JSON.stringify(row)]);
            if (r.rowCount && status[i] === 'unchanged') status[i] = 'updated';
            await c.query('release savepoint r');
          } catch (e) {
            await c.query('rollback to savepoint r');
            status[i] = 'failed';
            report.errors.push({
              table: s.table,
              id: String(row[s.key] ?? '?'),
              message: describePgError(e),
            });
          }
        }
      }
      const counts = emptyCounts();
      for (const st of status) counts[st]++;
      report.tables[s.table] = counts;
    }
    for (const o of OVERLAYS) {
      const rows = doc.overlays[o.table] ?? [];
      const counts = emptyCounts();
      report.overlays[o.table] = counts;
      for (const row of rows) {
        const cols = Object.keys(row).filter((k) => k !== 'id' && k in o.columns);
        if (!cols.length) continue;
        await c.query('savepoint r');
        try {
          const exists = await c.query(`select 1 from ${o.table} where id = $1`, [row.id]);
          if (!exists.rowCount) {
            report.warnings.push({
              table: o.table,
              id: String(row.id),
              message:
                'this synced row is not in the database (yet): its hand-entered values were not restored; sync, then import again',
            });
            counts.failed++;
          } else {
            const r = await c.query(overlayUpdateSql(o, cols), [JSON.stringify(row)]);
            if (r.rowCount) counts.updated++;
            else counts.unchanged++;
          }
          await c.query('release savepoint r');
        } catch (e) {
          await c.query('rollback to savepoint r');
          counts.failed++;
          report.errors.push({ table: o.table, id: String(row.id), message: describePgError(e) });
        }
      }
    }
    const failed = report.errors.length > 0 && !opts.partial;
    if (dryRun || failed) {
      await c.query('rollback');
    } else {
      // Every open panel and map refetches (one message, not one per row).
      await publish('fields', 'invalidate', { event: 'updated', reason: 'changed' }, c);
      await c.query('commit');
      report.written = true;
    }
    return report;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
