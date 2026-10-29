/**
 * Spray go/no-go storage (plan 1b; docs/contracts-m1.md §3.1 farm.spray_assessments, §13): the
 * job's assessment pass and the reads the map, the strip, the field tab and /admin/spray use.
 *
 * farm.spray_assessments is the audit trail: one row per (field, hour, rules version, forecast
 * issue), written with `on conflict on constraint spray_assessments_run_key`. A re-run with the
 * same inputs writes nothing. One refinement: when the SAME inputs come back after something
 * else was said for that field and hour (thresholds changed and then changed back while the
 * forecast issue stayed the same), the existing row's `assessed_at` is moved to now, so "the
 * newest row per (field, hour)" stays what the farm is being told (the readers', the field
 * panel's and the retention's rule). Reasons and inputs are never rewritten.
 */
import { assessSprayHour, countVerdicts } from '../../domain/spray';
import {
  type SprayAssessmentView,
  type SprayReason,
  type SprayThresholds,
  type SprayVerdict,
  sprayAssessmentHours,
  sprayRulesVersion,
} from '../../domain/weather';
import { type Executor, exec, toDate } from '../exec';
import { forecastHours, newestIssues } from './weather';

const HOUR_MS = 3_600_000;
/** Rows per insert statement. */
const WRITE_CHUNK = 1_000;

export interface SprayTarget {
  fieldId: string;
  name: string;
  gridId: string | null;
  /** The looked-up point (else a point on the current boundary). */
  lng: number;
  lat: number;
  acres: number;
}

/** Active fields with a current boundary, by name. */
export async function sprayTargets(ex: Executor): Promise<SprayTarget[]> {
  const r = await exec<{
    field_id: string;
    name: string;
    grid_id: string | null;
    lng: number;
    lat: number;
    acres: number | string;
  }>(
    ex,
    `select f.id::text as field_id, f.name, w.grid_id,
            extensions.ST_X(p.pt) as lng, extensions.ST_Y(p.pt) as lat, b.acres
       from farm.fields f
       join farm.current_boundaries b on b.field_id = f.id
       left join farm.field_weather_grids w on w.field_id = f.id
       cross join lateral (
         select coalesce(w.point, extensions.ST_PointOnSurface(b.geom)) as pt) p
      where f.active
      order by f.name, f.id`,
  );
  return r.rows.map((x) => ({
    fieldId: x.field_id,
    name: x.name,
    gridId: x.grid_id,
    lng: Number(x.lng),
    lat: Number(x.lat),
    acres: Number(x.acres),
  }));
}

export interface AssessmentRow {
  fieldId: string;
  forHour: string;
  verdict: SprayVerdict;
  reasons: SprayReason[];
  inputs: unknown;
  rulesVersion: string;
  forecastIssuedAt: string | null;
  gridId: string | null;
}

/**
 * Insert assessments (see the header). Returns the rows written now: inserted, or an older
 * identical row re-asserted.
 */
export async function writeAssessments(
  ex: Executor,
  rows: AssessmentRow[],
): Promise<{ fieldId: string; forHour: string; verdict: SprayVerdict; inserted: boolean }[]> {
  const out: { fieldId: string; forHour: string; verdict: SprayVerdict; inserted: boolean }[] = [];
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const chunk = rows.slice(i, i + WRITE_CHUNK);
    const r = await exec<{
      field_id: string;
      for_hour: unknown;
      verdict: SprayVerdict;
      inserted: boolean;
    }>(
      ex,
      `insert into farm.spray_assessments as s
         (field_id, for_hour, verdict, reasons, inputs, rules_version, forecast_issued_at, grid_id)
       select (x->>'fieldId')::uuid, (x->>'forHour')::timestamptz, x->>'verdict', x->'reasons',
              x->'inputs', x->>'rulesVersion', (x->>'forecastIssuedAt')::timestamptz, x->>'gridId'
         from jsonb_array_elements($1::jsonb) as x
       on conflict on constraint spray_assessments_run_key do update
         set assessed_at = now()
       where exists (select 1 from farm.spray_assessments n
                      where n.field_id = s.field_id and n.for_hour = s.for_hour
                        and (n.assessed_at, n.id) > (s.assessed_at, s.id))
       returning s.field_id::text as field_id, s.for_hour, s.verdict, (s.xmax = 0) as inserted`,
      [JSON.stringify(chunk)],
    );
    for (const x of r.rows) {
      out.push({
        fieldId: x.field_id,
        forHour: (toDate(x.for_hour) as Date).toISOString(),
        verdict: x.verdict,
        inserted: x.inserted === true,
      });
    }
  }
  return out;
}

function viewOf(x: Record<string, unknown>): SprayAssessmentView {
  return {
    fieldId: String(x.field_id),
    forHour: (toDate(x.for_hour) as Date).toISOString(),
    verdict: x.verdict as SprayVerdict,
    reasons: (x.reasons as SprayReason[]) ?? [],
    rulesVersion: String(x.rules_version),
    forecastIssuedAt: toDate(x.forecast_issued_at)?.toISOString() ?? null,
    assessedAt: (toDate(x.assessed_at) as Date).toISOString(),
  };
}

/** What each field was told last for `forHour` (newest row per field). */
export async function verdictsForHour(
  ex: Executor,
  forHour: string,
): Promise<Map<string, SprayAssessmentView>> {
  const r = await exec<Record<string, unknown>>(
    ex,
    `select distinct on (s.field_id) s.field_id::text as field_id, s.for_hour, s.verdict,
            s.reasons, s.rules_version, s.forecast_issued_at, s.assessed_at
       from farm.spray_assessments s
       join farm.fields f on f.id = s.field_id and f.active
      where s.for_hour = $1::timestamptz
      order by s.field_id, s.assessed_at desc, s.id desc`,
    [forHour],
  );
  return new Map(r.rows.map((x) => [String(x.field_id), viewOf(x)] as const));
}

/** One field's newest assessment per hour in [from, to), ascending. */
export async function fieldSprayHours(
  ex: Executor,
  fieldId: string,
  from: string,
  to: string,
): Promise<SprayAssessmentView[]> {
  const r = await exec<Record<string, unknown>>(
    ex,
    `select distinct on (s.for_hour) s.field_id::text as field_id, s.for_hour, s.verdict,
            s.reasons, s.rules_version, s.forecast_issued_at, s.assessed_at
       from farm.spray_assessments s
      where s.field_id = $1::uuid and s.for_hour >= $2::timestamptz and s.for_hour < $3::timestamptz
      order by s.for_hour, s.assessed_at desc, s.id desc`,
    [fieldId, from, to],
  );
  return r.rows.map(viewOf);
}

export interface SprayPassResult {
  /** The current hour (UTC ISO). */
  forHour: string;
  /** Rows inserted or re-asserted. */
  written: number;
  /** Fields with a row written this pass. */
  fieldIds: string[];
  /** Fields whose current-hour verdict differs from what they were told before this pass. */
  changedFieldIds: string[];
  /** Fields per verdict for the current hour after the pass. */
  counts: { go: number; caution: number; noGo: number };
  rulesVersion: string;
}

/**
 * Assess every active field for the current hour plus SPRAY_ASSESS_AHEAD_HOURS
 * (`sprayAssessmentHours(now)`) from the newest forecast issue of its cell, and store the rows.
 */
export async function runSprayPass(
  ex: Executor,
  now: Date,
  thresholds: SprayThresholds,
): Promise<SprayPassResult> {
  const hours = sprayAssessmentHours(now);
  const forHour = hours[0] as string;
  const rulesVersion = sprayRulesVersion(thresholds);
  const targets = await sprayTargets(ex);
  const gridIds = [...new Set(targets.map((t) => t.gridId).filter((g): g is string => !!g))];
  const issues = await newestIssues(ex, gridIds);
  const from = new Date(forHour);
  const to = new Date(
    Date.parse(hours.at(-1) as string) + (thresholds.rainFreeHours + 1) * HOUR_MS,
  );
  const byGrid = new Map<string, Awaited<ReturnType<typeof forecastHours>>>();
  for (const [gridId, issuedAt] of issues) {
    byGrid.set(gridId, await forecastHours(ex, gridId, issuedAt, from, to));
  }

  const rows: AssessmentRow[] = [];
  for (const t of targets) {
    const issuedAt = t.gridId ? (issues.get(t.gridId) ?? null) : null;
    const issueHours = t.gridId ? (byGrid.get(t.gridId) ?? []) : [];
    for (const h of hours) {
      const a = assessSprayHour(
        {
          forHour: h,
          location: { lng: t.lng, lat: t.lat },
          gridId: t.gridId,
          forecastIssuedAt: issuedAt,
          hours: issueHours,
          now,
        },
        thresholds,
      );
      rows.push({
        fieldId: t.fieldId,
        forHour: h,
        verdict: a.verdict,
        reasons: a.reasons,
        inputs: a.inputs,
        rulesVersion,
        forecastIssuedAt: issuedAt,
        gridId: t.gridId,
      });
    }
  }

  const before = await verdictsForHour(ex, forHour);
  const written = await writeAssessments(ex, rows);
  const after = await verdictsForHour(ex, forHour);
  const changedFieldIds = targets
    .map((t) => t.fieldId)
    .filter((id) => after.get(id)?.verdict !== before.get(id)?.verdict);
  return {
    forHour,
    written: written.length,
    fieldIds: [...new Set(written.map((w) => w.fieldId))].sort(),
    changedFieldIds,
    counts: countVerdicts(
      targets.map((t) => after.get(t.fieldId)?.verdict).filter((v): v is SprayVerdict => !!v),
    ),
    rulesVersion,
  };
}
