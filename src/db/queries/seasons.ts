/**
 * Crop history (farm.field_seasons, plan 1c): the `import:seasons` CSV import, and the History
 * tab's view and edits (src/ui/fields/tabs/history.tsx). Seasons follow a field through splits
 * and merges by farm.field_lineage: a field split from another shows its parent's earlier
 * seasons ("5-season history survives boundary edits", plan §4).
 *
 * Source: 'import' (CSV), 'app' (typed in the History tab), next to the demo seed's 'demo' and
 * the Deere backfill's 'deere' (1f). Rows that came from Operations Center are only replaced
 * on request (`replaceDeere`), so a CSV can't silently overwrite synced history.
 */
import type pg from 'pg';
import type { LineageKind } from '../../domain/farm';
import type { LineageRef, SeasonRow } from '../../domain/fields';
import type { Queryable } from '../client';
import {
  type Actor,
  FieldChanges,
  FieldDataError,
  NORM_TEXT,
  normText,
  withTransaction,
} from './boundaries-sql';

/** One season's values (a CSV row or the History tab's form, already checked). */
export interface SeasonInput {
  cropYear: number;
  crop: string | null;
  variety: string | null;
  /** YYYY-MM-DD. */
  plantedOn: string | null;
  harvestedOn: string | null;
  yieldBuAc: number | null;
}

/** A row of the CSV after its own checks (tools/import/seasons-csv.ts). */
export interface SeasonImportRow extends SeasonInput {
  line: number;
  field: string;
  farm: string | null;
  fieldId: string | null;
}

export type SeasonAction = 'insert' | 'update' | 'unchanged';

export interface SeasonImportRowResult {
  line: number;
  field: string;
  cropYear: number;
  fieldId: string | null;
  fieldName: string | null;
  farmName: string | null;
  /** 'blocked': the row is fine but nothing was written because other rows have errors. */
  action: SeasonAction | 'error' | 'blocked';
  message: string | null;
}

export interface SeasonImportReport {
  dryRun: boolean;
  /** False when any row had a problem: then nothing was written. */
  written: boolean;
  rows: SeasonImportRowResult[];
  counts: Record<SeasonImportRowResult['action'], number>;
}

interface FieldRef {
  id: string;
  name: string;
  farmName: string;
  active: boolean;
}

/** Edit distance (for "did you mean" suggestions). */
function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] as number;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j] as number;
      prev[j] = Math.min(
        up + 1,
        (prev[j - 1] as number) + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = up;
    }
  }
  return prev[b.length] as number;
}

export function suggestNames(name: string, names: readonly string[], max = 3): string[] {
  const n = normText(name);
  return [...new Set(names)]
    .map((x) => ({ x, d: distance(n, normText(x)) }))
    .filter((c) => c.d <= Math.max(2, Math.floor(n.length / 4)))
    .sort((a, b) => a.d - b.d || a.x.localeCompare(b.x))
    .slice(0, max)
    .map((c) => c.x);
}

/**
 * Which field a row means: its field_id, else its name (active fields first, narrowed by the
 * farm column). Pure over the loaded field list.
 */
export function resolveSeasonField(
  row: Pick<SeasonImportRow, 'field' | 'farm' | 'fieldId'>,
  fields: readonly FieldRef[],
): { ok: true; field: FieldRef } | { ok: false; message: string } {
  if (row.fieldId) {
    const f = fields.find((x) => x.id === row.fieldId);
    return f ? { ok: true, field: f } : { ok: false, message: `no field has id ${row.fieldId}` };
  }
  const want = normText(row.field);
  let hits = fields.filter((f) => normText(f.name) === want);
  if (row.farm) hits = hits.filter((f) => normText(f.farmName) === normText(row.farm as string));
  if (hits.length > 1) {
    const active = hits.filter((f) => f.active);
    if (active.length >= 1) hits = active;
  }
  if (hits.length === 1) return { ok: true, field: hits[0] as FieldRef };
  if (hits.length > 1) {
    return {
      ok: false,
      message: `${hits.length} fields are named '${row.field}' (farms: ${hits.map((h) => h.farmName).join(', ')}): add a farm column`,
    };
  }
  const near = suggestNames(
    row.field,
    fields.map((f) => f.name),
  );
  return {
    ok: false,
    message: `no field named '${row.field}'${row.farm ? ` in farm '${row.farm}'` : ''}${near.length ? ` (did you mean ${near.map((x) => `'${x}'`).join(', ')}?)` : ''}`,
  };
}

async function loadFieldRefs(ex: Queryable): Promise<FieldRef[]> {
  const r = await ex.query<{ id: string; name: string; farm_name: string; active: boolean }>(
    `select f.id, f.name, fa.name as farm_name, f.active
       from farm.fields f join farm.farms fa on fa.id = f.farm_id`,
  );
  return r.rows.map((x) => ({ id: x.id, name: x.name, farmName: x.farm_name, active: x.active }));
}

const UPSERT_SEASON = `
  insert into farm.field_seasons as t
    (field_id, crop_year, crop, variety, planted_on, harvested_on, yield_bu_ac, source)
  values ($1, $2, $3, $4, $5::date, $6::date, $7, $8)
  on conflict (field_id, crop_year) do update set
    crop = excluded.crop, variety = excluded.variety, planted_on = excluded.planted_on,
    harvested_on = excluded.harvested_on, yield_bu_ac = excluded.yield_bu_ac,
    source = excluded.source, source_id = null, updated_at = now()
  where (t.crop, t.variety, t.planted_on, t.harvested_on, t.yield_bu_ac)
        is distinct from (excluded.crop, excluded.variety, excluded.planted_on,
                          excluded.harvested_on, excluded.yield_bu_ac)
  returning (xmax = 0) as inserted`;

const seasonValues = (fieldId: string, s: SeasonInput, source: string) => [
  fieldId,
  s.cropYear,
  s.crop,
  s.variety,
  s.plantedOn,
  s.harvestedOn,
  s.yieldBuAc,
  source,
];

/**
 * Import checked CSV rows. All or nothing: when any row can't be placed (unknown or ambiguous
 * field, a Deere season without `replaceDeere`), nothing is written and every problem is
 * reported by line. `dryRun` reports what would happen and rolls back.
 */
export async function importSeasons(
  pool: pg.Pool,
  rows: readonly SeasonImportRow[],
  opts: { dryRun?: boolean; replaceDeere?: boolean } = {},
): Promise<SeasonImportReport> {
  const dryRun = opts.dryRun ?? false;
  return withTransaction(
    pool,
    async (c) => {
      const fields = await loadFieldRefs(c);
      const results: SeasonImportRowResult[] = [];
      const placed: { row: SeasonImportRow; field: FieldRef; result: SeasonImportRowResult }[] = [];
      const seen = new Map<string, number>();
      for (const row of rows) {
        const result: SeasonImportRowResult = {
          line: row.line,
          field: row.field || (row.fieldId ?? ''),
          cropYear: row.cropYear,
          fieldId: null,
          fieldName: null,
          farmName: null,
          action: 'error',
          message: null,
        };
        results.push(result);
        const f = resolveSeasonField(row, fields);
        if (!f.ok) {
          result.message = f.message;
          continue;
        }
        result.fieldId = f.field.id;
        result.fieldName = f.field.name;
        result.farmName = f.field.farmName;
        const key = `${f.field.id}|${row.cropYear}`;
        const earlier = seen.get(key);
        if (earlier) {
          result.message = `line ${earlier} is the same field and crop year`;
          continue;
        }
        seen.set(key, row.line);
        placed.push({ row, field: f.field, result });
      }
      if (placed.length) {
        const existing = await c.query<{ field_id: string; crop_year: number; source: string }>(
          `select field_id, crop_year, source from farm.field_seasons
            where (field_id, crop_year) in (select * from unnest($1::uuid[], $2::int[]))`,
          [placed.map((p) => p.field.id), placed.map((p) => p.row.cropYear)],
        );
        const deere = new Set(
          existing.rows
            .filter((e) => e.source === 'deere')
            .map((e) => `${e.field_id}|${e.crop_year}`),
        );
        if (!opts.replaceDeere) {
          for (const p of placed) {
            if (deere.has(`${p.field.id}|${p.row.cropYear}`)) {
              p.result.action = 'error';
              p.result.message = `${p.row.cropYear} on '${p.field.name}' came from Operations Center; leave the row out, or replace it on purpose (--replace-deere)`;
            }
          }
        }
      }
      const failed = results.some((r) => r.message !== null);
      const changes = new FieldChanges();
      if (failed) {
        for (const r of results) if (r.message === null) r.action = 'blocked';
      } else {
        for (const p of placed) {
          const r = await c.query<{ inserted: boolean }>(
            UPSERT_SEASON,
            seasonValues(p.field.id, p.row, 'import'),
          );
          const row = r.rows[0];
          p.result.action = !row ? 'unchanged' : row.inserted ? 'insert' : 'update';
          if (row) changes.add(p.field.id, 'seasons');
        }
        await changes.publish(c);
      }
      const counts = { insert: 0, update: 0, unchanged: 0, error: 0, blocked: 0 };
      for (const r of results) counts[r.action]++;
      return { dryRun, written: !failed && !dryRun, rows: results, counts };
    },
    { rollback: dryRun },
  );
}

// ---------------------------------------------------------------------------------------------
// History (the field panel's History tab)
// ---------------------------------------------------------------------------------------------

export interface HistorySeason extends SeasonRow {
  id: string;
}

export interface AncestorHistory {
  fieldId: string;
  name: string;
  /** How this ancestor became (part of) the field below it. */
  kind: LineageKind;
  /** YYYY-MM-DD. */
  effectiveOn: string;
  /** 1 = a direct parent. */
  depth: number;
  /** Its seasons up to the year of the split/merge, newest first. */
  seasons: SeasonRow[];
}

export interface FieldHistory {
  fieldId: string;
  name: string;
  active: boolean;
  seasons: HistorySeason[];
  ancestors: AncestorHistory[];
  children: LineageRef[];
}

const SEASON_COLUMNS_SQL = `s.id, s.crop_year, s.crop, s.variety, s.planted_on::text as planted_on,
  s.harvested_on::text as harvested_on, s.yield_bu_ac::float8 as yield_bu_ac, s.source`;

interface SeasonDbRow {
  id: string;
  crop_year: number;
  crop: string | null;
  variety: string | null;
  planted_on: string | null;
  harvested_on: string | null;
  yield_bu_ac: number | null;
  source: string;
}

const toSeasonRow = (s: Omit<SeasonDbRow, 'id'>): SeasonRow => ({
  cropYear: s.crop_year,
  crop: s.crop,
  variety: s.variety,
  plantedOn: s.planted_on,
  harvestedOn: s.harvested_on,
  yieldBuAc: s.yield_bu_ac,
  source: s.source,
});

const toSeason = (s: SeasonDbRow): HistorySeason => ({ id: s.id, ...toSeasonRow(s) });

/** Everything the History tab shows: all seasons, ancestors' earlier seasons, children. */
export async function fieldHistory(ex: Queryable, fieldId: string): Promise<FieldHistory | null> {
  const f = await ex.query<{ id: string; name: string; active: boolean }>(
    'select id, name, active from farm.fields where id = $1',
    [fieldId],
  );
  const field = f.rows[0];
  if (!field) return null;
  const [seasons, ancestors, children] = await Promise.all([
    ex.query<SeasonDbRow>(
      `select ${SEASON_COLUMNS_SQL} from farm.field_seasons s where s.field_id = $1
        order by s.crop_year desc`,
      [fieldId],
    ),
    ex.query<{
      field_id: string;
      name: string;
      kind: LineageKind;
      effective_on: string;
      depth: number;
    }>(
      `with recursive anc (field_id, kind, effective_on, depth, path) as (
         select l.parent_field_id, l.kind, l.effective_on, 1, array[l.child_field_id, l.parent_field_id]
           from farm.field_lineage l where l.child_field_id = $1
         union all
         select l.parent_field_id, l.kind, l.effective_on, a.depth + 1, a.path || l.parent_field_id
           from farm.field_lineage l join anc a on l.child_field_id = a.field_id
          where a.depth < 5 and not (l.parent_field_id = any (a.path))
       )
       select a.field_id, f.name, a.kind, a.effective_on::text as effective_on, a.depth
         from anc a join farm.fields f on f.id = a.field_id
        order by a.depth, a.effective_on desc, f.name`,
      [fieldId],
    ),
    ex.query<{ field_id: string; name: string; kind: LineageKind; effective_on: string }>(
      `select l.child_field_id as field_id, f.name, l.kind, l.effective_on::text as effective_on
         from farm.field_lineage l join farm.fields f on f.id = l.child_field_id
        where l.parent_field_id = $1 order by l.effective_on desc, f.name`,
      [fieldId],
    ),
  ]);
  const ancestorIds = [...new Set(ancestors.rows.map((a) => a.field_id))];
  const ancestorSeasons = ancestorIds.length
    ? await ex.query<SeasonDbRow & { field_id: string }>(
        `select s.field_id, ${SEASON_COLUMNS_SQL} from farm.field_seasons s
          where s.field_id = any ($1::uuid[]) order by s.crop_year desc`,
        [ancestorIds],
      )
    : { rows: [] };
  const seen = new Set<string>();
  return {
    fieldId: field.id,
    name: field.name,
    active: field.active,
    seasons: seasons.rows.map(toSeason),
    ancestors: ancestors.rows
      .filter((a) => {
        // A field reachable two ways (merge of a split) is listed once, nearest first.
        if (seen.has(a.field_id)) return false;
        seen.add(a.field_id);
        return true;
      })
      .map((a) => {
        const year = Number(a.effective_on.slice(0, 4));
        return {
          fieldId: a.field_id,
          name: a.name,
          kind: a.kind,
          effectiveOn: a.effective_on,
          depth: a.depth,
          seasons: ancestorSeasons.rows
            .filter((s) => s.field_id === a.field_id && s.crop_year <= year)
            .map(toSeasonRow),
        };
      }),
    children: children.rows.map((c) => ({
      fieldId: c.field_id,
      name: c.name,
      kind: c.kind,
      effectiveOn: c.effective_on,
    })),
  };
}

/**
 * Add or change one season from the History tab (source 'app'). `originalCropYear` is the row
 * being edited (null: a new season); changing the year moves the row, refused if that year is
 * already there.
 */
export async function saveSeason(
  pool: pg.Pool,
  args: { fieldId: string; season: SeasonInput; originalCropYear: number | null; actor: Actor },
): Promise<{ action: SeasonAction }> {
  return withTransaction(pool, async (c) => {
    const f = await c.query('select 1 from farm.fields where id = $1 for update', [args.fieldId]);
    if (f.rowCount === 0) throw new FieldDataError('field not found', 'not_found');
    const { season } = args;
    const original = args.originalCropYear;
    if (original === null || original !== season.cropYear) {
      const clash = await c.query(
        'select 1 from farm.field_seasons where field_id = $1 and crop_year = $2',
        [args.fieldId, season.cropYear],
      );
      if (clash.rowCount) {
        throw new FieldDataError(
          `${season.cropYear} is already in the history: edit that row`,
          'conflict',
        );
      }
    }
    let action: SeasonAction;
    if (original !== null && original !== season.cropYear) {
      const moved = await c.query(
        `update farm.field_seasons
            set crop_year = $3, crop = $4, variety = $5, planted_on = $6::date,
                harvested_on = $7::date, yield_bu_ac = $8, source = 'app', source_id = null,
                updated_at = now()
          where field_id = $1 and crop_year = $2`,
        [
          args.fieldId,
          original,
          season.cropYear,
          season.crop,
          season.variety,
          season.plantedOn,
          season.harvestedOn,
          season.yieldBuAc,
        ],
      );
      if (moved.rowCount === 0) {
        throw new FieldDataError(`${original} is no longer in the history: reload`, 'stale');
      }
      action = 'update';
    } else {
      if (original !== null) {
        const still = await c.query(
          'select 1 from farm.field_seasons where field_id = $1 and crop_year = $2',
          [args.fieldId, original],
        );
        if (still.rowCount === 0) {
          throw new FieldDataError(`${original} is no longer in the history: reload`, 'stale');
        }
      }
      const r = await c.query<{ inserted: boolean }>(
        UPSERT_SEASON,
        seasonValues(args.fieldId, season, 'app'),
      );
      const row = r.rows[0];
      action = !row ? 'unchanged' : row.inserted ? 'insert' : 'update';
    }
    if (action !== 'unchanged') {
      const changes = new FieldChanges();
      changes.add(args.fieldId, 'seasons');
      await changes.publish(c);
    }
    return { action };
  });
}

export async function deleteSeason(
  pool: pg.Pool,
  args: { fieldId: string; cropYear: number; actor: Actor },
): Promise<void> {
  await withTransaction(pool, async (c) => {
    const r = await c.query(
      'delete from farm.field_seasons where field_id = $1 and crop_year = $2',
      [args.fieldId, args.cropYear],
    );
    if (r.rowCount === 0)
      throw new FieldDataError(`${args.cropYear} is not in the history`, 'stale');
    const changes = new FieldChanges();
    changes.add(args.fieldId, 'seasons');
    await changes.publish(c);
  });
}

/** Seasons by name lookup for scripts and tests. */
export async function seasonsOf(ex: Queryable, fieldName: string): Promise<SeasonRow[]> {
  const r = await ex.query<SeasonDbRow>(
    `select ${SEASON_COLUMNS_SQL} from farm.field_seasons s join farm.fields f on f.id = s.field_id
      where ${NORM_TEXT('f.name')} = $1 order by s.crop_year desc`,
    [normText(fieldName)],
  );
  return r.rows.map(toSeasonRow);
}
