/**
 * What the Deere stand-in's `ops` module serves (slice 1f, deere-ops; docs/contracts-1f.md §7.1,
 * §7.2): this crop season's field operations of the simulated farm, as pure functions of the
 * world, its day reports, the clock and the module's knobs.
 *
 *  - **Work from the day reports.** Every work range (machine, field, op) of the scenario's days
 *    that ENDED before sim-now is finished work; the ranges of one field and op are one Deere
 *    operation (Operations Center keeps one operation per field, type and season, spanning days
 *    and machines), with their acres, machines and operators, so a field the simulation
 *    finishes shows up as an operation and a field worked over two days grows. Harvest =
 *    `harvest`, plant = `seeding`, spray = `application` (a burndown tank mix).
 *  - **This season's planting.** The day reports of a harvest scenario plant nothing, yet every
 *    field was planted in spring: `simPlanting` (a pure helper of this module; src/sim/seasons.ts
 *    stays as is) gives each field's planting of its CURRENT_CROP_YEAR crop (`cropFor`), served
 *    when it happened before the scenario's first day and the scenario doesn't plant that crop
 *    itself (planting-day plants the corn; its soybean fields planted earlier still show).
 *  - **Time base (§7.2).** Work from the day reports is stamped in WALL time with the current
 *    clock segment's inverse of `wallToSim`: sim instant s → anchorWall + (s − anchorSim) / speed
 *    (= wall_now − (sim_now − s) / speed while the clock runs; stable while it is paused), so
 *    the 24 h provisional → final rule runs on wall time. The spring planting, which predates
 *    the scenario's clock, is served on its written month, day and time in the wall's crop
 *    year (never after wall-now), like past seasons are served as written. `cropSeason` is the
 *    wall's crop year (America/Detroit), so "this crop season" is the same in the app and here.
 *  - **Coverage.** The field boundary (contract §7.1), or for a field worked less than 90 % the
 *    rectangle around its passes (± half the implement), clamped to the field. Fields whose
 *    index in the farm is ≡ 5 mod SIM_OPS_REFUSED_EVERY (and fields named by the knob) answer
 *    400 on GET /fieldOperations/{id}/boundary, as Deere does for a field with an active
 *    boundary, so the null-coverage path runs in sim.
 *  - **Full-day sprayer (knob).** One application operation on a chosen field whose coverage is
 *    a full day of sprayer passes at one polygon per second (plan §5's full-size payload:
 *    about 43 000 polygons, ~9 MB of JSON), for the map + upsert timing test.
 *
 * Operation ids are opaque and deterministic: base64url of
 * `sim-fieldop:<field key>:<kind>:<crop season>[:full-day]`.
 */
import type { MultiPolygon, Position } from 'geojson';
import { currentCropYear } from '../../../domain/crops';
import { rngFor } from '../../rng';
import { type Crop, CURRENT_CROP_YEAR, cropFor } from '../../seasons';
import { localToUtc } from '../../time';
import type { SimClockState, SimField, SimMachine, SimWorld } from '../../types';
import type { SimDayReport, SimWorkReport } from '../../world';
import type { SimDayReports } from '../context';
import { simDeereFields } from './platform';

/** Every n-th field (index ≡ 5 mod n) answers 400 for its operations' coverage. */
export const SIM_OPS_REFUSED_EVERY = 6;
/** Below this share of the field worked, coverage is the passes' rectangle, not the boundary. */
const FULL_FIELD_SHARE = 0.9;
const SQ_M_PER_ACRE = 4046.86;

export type SimOpKind = 'seeding' | 'application' | 'harvest';

/** The knobs of the ops module (persisted in state.vendors['deere.ops']). */
export interface SimOpsKnobs {
  /** Emit the full-day sprayer operation on this field (SimField.key), stamped at `at`. */
  fullDay?: { fieldKey: string; at: string } | null;
  /** Extra fields (SimField.key) whose coverage call answers 400. */
  refuse?: string[];
}

/** One served operation (before it is shaped as Deere JSON, ./ops-routes.ts). */
export interface SimOperation {
  id: string;
  orgId: string;
  deereFieldId: string;
  field: SimField;
  kind: SimOpKind;
  crop: Crop;
  cropSeason: string;
  variety: string;
  /** Wall-clock ISO instants as served. */
  startDate: string;
  endDate: string;
  modifiedTime: string;
  acres: number;
  machines: SimMachine[];
  /** Who ran each machine (farm.machines id → operator names). */
  operatorsByMachine: Record<string, string[]>;
  coverage: MultiPolygon;
  coverageRefused: boolean;
  /** The full-day sprayer payload (coverage built lazily: it is large). */
  fullDay: boolean;
}

export interface SimOpsContext {
  world: SimWorld;
  days: SimDayReports | null;
  /** Wall clock now. */
  now: Date;
  /** Sim time at `now`. */
  simNow: Date;
  /** The current clock segment (the last of the timeline). */
  clock: SimClockState;
  knobs: SimOpsKnobs;
}

// ---------------------------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------------------------

/**
 * Wall time of sim instant `s` under clock segment `clock` (its inverse of `wallToSim`):
 * anchorWall + (s − anchorSim) / speed, never after `wallNow`. While the clock runs this is
 * wall_now − (sim_now − s) / speed; while it is paused it stays where it was when it paused.
 */
export function simToWall(clock: SimClockState, s: Date, wallNow: Date): Date {
  const t =
    Date.parse(clock.anchorWall) + (s.getTime() - Date.parse(clock.anchorSim)) / clock.speed;
  return new Date(Math.min(Math.round(t), wallNow.getTime()));
}

const iso = (ms: number) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------------------------
// The spring planting
// ---------------------------------------------------------------------------------------------

export interface SimPlanting {
  crop: Crop;
  variety: string;
  /** Local planting date and start (America/Detroit); wheat goes in the fall before `year`. */
  date: { y: number; m: number; d: number };
  startMinute: number;
  /** Minutes the planter took (field acres at about 20 ac/h). */
  minutes: number;
}

/** The crop's variety on a field and year (stand-in only; names like the seed's). */
export function simVariety(seed: number, field: SimField, year: number, crop: Crop): string {
  const r = rngFor(seed, 'ops-variety', field.key, year);
  if (crop === 'corn') return `NF ${r.int(102, 112)}-${r.int(10, 89)}`;
  if (crop === 'soybeans') return `NF ${(r.int(20, 32) / 10).toFixed(1)}E${r.int(1, 9)}`;
  return `NF W${r.int(200, 299)} SRW`;
}

/** When and what `field` was planted for crop year `year` (pure; usual SE Michigan windows). */
export function simPlanting(seed: number, field: SimField, year: number): SimPlanting {
  const crop = cropFor(seed, field, year);
  const r = rngFor(seed, 'ops-planting', field.key, year);
  const at = (y: number, m: number, d: number) => {
    const t = new Date(Date.UTC(y, m - 1, d));
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
  };
  const date =
    crop === 'corn'
      ? at(year, 4, 24 + r.int(0, 21))
      : crop === 'soybeans'
        ? at(year, 5, 4 + r.int(0, 24))
        : at(year - 1, 10, 2 + r.int(0, 16));
  return {
    crop,
    variety: simVariety(seed, field, year, crop),
    date,
    startMinute: 7 * 60 + 30 + r.int(0, 150),
    minutes: Math.max(45, Math.round((field.acres / 20) * 60)),
  };
}

// ---------------------------------------------------------------------------------------------
// Day reports
// ---------------------------------------------------------------------------------------------

/** Day reports per world (the days already passed never change; a report costs tens of ms). */
const REPORTS = new WeakMap<SimWorld, Map<number, SimDayReport | null>>();

function reportOf(world: SimWorld, days: SimDayReports, index: number): SimDayReport | null {
  let byDay = REPORTS.get(world);
  if (!byDay) {
    byDay = new Map();
    REPORTS.set(world, byDay);
  }
  if (byDay.has(index)) return byDay.get(index) ?? null;
  let r: SimDayReport | null = null;
  try {
    r = days.dayReport(index);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e; // after the scenario's last day
  }
  byDay.set(index, r);
  return r;
}

/** Work ranges of the scenario's days up to sim-now that ended by then. */
function endedWork(c: SimOpsContext): SimWorkReport[] {
  if (!c.days) return [];
  const last = Math.min(c.days.dayIndexAt(c.simNow), 400);
  const out: SimWorkReport[] = [];
  for (let d = 0; d <= last; d++) {
    const r = reportOf(c.world, c.days, d);
    if (!r) break;
    for (const w of r.work) {
      if (Date.parse(w.lastAt) <= c.simNow.getTime()) out.push(w);
    }
  }
  return out;
}

/** Crops the scenario plants itself (any field of its first day's `plant` work). */
function cropsPlantedByScenario(c: SimOpsContext): Set<Crop> {
  const out = new Set<Crop>();
  if (!c.days) return out;
  const r = reportOf(c.world, c.days, 0);
  for (const w of r?.work ?? []) {
    if (w.op !== 'plant') continue;
    const f = c.world.farm.fields.find((x) => x.id === w.fieldId);
    if (f) out.add(cropFor(c.world.seed, f, CURRENT_CROP_YEAR));
  }
  return out;
}

const OP_KIND: Record<SimWorkReport['op'], SimOpKind> = {
  harvest: 'harvest',
  plant: 'seeding',
  spray: 'application',
};

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

function fieldBbox(f: SimField) {
  const pts = f.boundary.coordinates.flat(2);
  const xs = pts.map((p) => p[0] as number);
  const ys = pts.map((p) => p[1] as number);
  return {
    w: Math.min(...xs),
    e: Math.max(...xs),
    s: Math.min(...ys),
    n: Math.max(...ys),
  };
}

function rectangle(w: number, s: number, e: number, n: number): MultiPolygon {
  const ring: Position[] = [
    [r6(w), r6(s)],
    [r6(e), r6(s)],
    [r6(e), r6(n)],
    [r6(w), r6(n)],
    [r6(w), r6(s)],
  ];
  return { type: 'MultiPolygon', coordinates: [[ring]] };
}

/** The rectangle around the passes (± half the implement), kept inside the field's box. */
function passesCoverage(f: SimField, work: readonly SimWorkReport[]): MultiPolygon {
  const pts = work.flatMap((w) => w.passes.flat());
  const box = fieldBbox(f);
  if (!pts.length) return f.boundary;
  const half = Math.max(...work.map((w) => w.widthM)) / 2;
  const lat0 = pts[0]?.[1] ?? 0;
  const dLng = half / (111_320 * Math.cos((lat0 * Math.PI) / 180));
  const dLat = half / 110_574;
  return rectangle(
    Math.max(box.w, Math.min(...pts.map((p) => p[0])) - dLng),
    Math.max(box.s, Math.min(...pts.map((p) => p[1])) - dLat),
    Math.min(box.e, Math.max(...pts.map((p) => p[0])) + dLng),
    Math.min(box.n, Math.max(...pts.map((p) => p[1])) + dLat),
  );
}

/** Sprayer of the full-day payload: 120 ft boom at 12 mph, 12 hours, one polygon a second. */
export const FULL_DAY_SPRAYER = {
  boomM: 36.576,
  speedMps: 5.364,
  seconds: 12 * 3600,
} as const;

/**
 * A full day of sprayer passes centred on `field` (plan §5's full-size payload): serpentine
 * passes one boom width apart over a square that one day at FULL_DAY_SPRAYER covers, one
 * rectangle per second of travel (≈ 43 200 polygons, ≈ 2 100 acres). Deterministic.
 */
export function fullDaySprayerCoverage(field: SimField): MultiPolygon {
  const box = fieldBbox(field);
  const lng0 = (box.w + box.e) / 2;
  const lat0 = (box.s + box.n) / 2;
  const mLng = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const mLat = 110_574;
  const { boomM, speedMps, seconds } = FULL_DAY_SPRAYER;
  const side = Math.sqrt(boomM * speedMps * seconds);
  const perPass = Math.max(1, Math.floor(side / speedMps));
  const polygons: Position[][][] = [];
  for (let i = 0; polygons.length < seconds; i++) {
    const x0 = -side / 2 + i * boomM;
    for (let k = 0; k < perPass && polygons.length < seconds; k++) {
      // Serpentine: odd passes run back north to south.
      const step = i % 2 === 0 ? k : perPass - 1 - k;
      const y0 = -side / 2 + step * speedMps;
      const w = lng0 + x0 / mLng;
      const e = lng0 + (x0 + boomM) / mLng;
      const s = lat0 + y0 / mLat;
      const n = lat0 + (y0 + speedMps) / mLat;
      polygons.push(rectangle(w, s, e, n).coordinates[0] as Position[][]);
    }
  }
  return { type: 'MultiPolygon', coordinates: polygons };
}

// ---------------------------------------------------------------------------------------------
// The operations
// ---------------------------------------------------------------------------------------------

/** The opaque, deterministic Deere id of a stand-in operation. */
export function simOperationId(
  fieldKey: string,
  kind: SimOpKind,
  cropSeason: string,
  fullDay = false,
): string {
  return Buffer.from(`sim-fieldop:${fieldKey}:${kind}:${cropSeason}${fullDay ? ':full-day' : ''}`)
    .toString('base64url')
    .replace(/=+$/, '');
}

/** The parts of a stand-in operation id, or null for an id the stand-in never issued. */
export function parseSimOperationId(
  id: string,
): { fieldKey: string; kind: SimOpKind; cropSeason: string; fullDay: boolean } | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const m = /^sim-fieldop:(.+):(seeding|application|harvest):(\d{4})(:full-day)?$/.exec(text);
  if (!m) return null;
  return {
    fieldKey: m[1] as string,
    kind: m[2] as SimOpKind,
    cropSeason: m[3] as string,
    fullDay: !!m[4],
  };
}

/** Does `field`'s coverage call answer 400 (Deere: the field has an active boundary)? */
export function simCoverageRefused(
  world: SimWorld,
  field: SimField,
  knobs: SimOpsKnobs = {},
): boolean {
  if (knobs.refuse?.includes(field.key)) return true;
  const i = world.farm.fields.findIndex((f) => f.id === field.id);
  return i >= 0 && i % SIM_OPS_REFUSED_EVERY === SIM_OPS_REFUSED_EVERY - 1;
}

/** Crew who run each Deere machine in the stand-in (farm.parties keys; unknown = no operator). */
const OPERATOR_OF: Record<string, string> = {
  'combine-1': 'crew-dale',
  'combine-2': 'crew-jake',
  'sprayer-1': 'crew-luis',
  'planter-1': 'crew-dale',
};

function operatorsOf(world: SimWorld, machines: readonly SimMachine[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const m of machines) {
    const key = OPERATOR_OF[m.key];
    const name = world.farm.parties.find((p) => p.key === key)?.displayName;
    out[m.id] = name ? [name] : [];
  }
  return out;
}

/**
 * Every operation the stand-in serves at `c.now`, in farm order (field, then season order:
 * seeding, application, harvest). Only owning orgs list operations.
 */
export function simOperations(c: SimOpsContext): SimOperation[] {
  const { world } = c;
  const seed = world.seed;
  const cropSeason = String(currentCropYear(c.now));
  const owners = new Map(
    simDeereFields(world.farm)
      .filter((f) => !f.shared)
      .map((f) => [f.field.id, f]),
  );
  const work = endedWork(c);
  const byFieldOp = new Map<string, SimWorkReport[]>();
  for (const w of work) {
    const k = `${w.fieldId}|${OP_KIND[w.op]}`;
    byFieldOp.set(k, [...(byFieldOp.get(k) ?? []), w]);
  }
  const plantedHere = cropsPlantedByScenario(c);
  const out: SimOperation[] = [];
  for (const field of world.farm.fields) {
    const owner = owners.get(field.id);
    if (!owner) continue;
    const crop = cropFor(seed, field, CURRENT_CROP_YEAR);
    const variety = simVariety(seed, field, CURRENT_CROP_YEAR, crop);
    const refused = simCoverageRefused(world, field, c.knobs);
    const base = {
      orgId: owner.orgId,
      deereFieldId: owner.deereFieldId,
      field,
      crop,
      cropSeason,
      variety,
      coverageRefused: refused,
      fullDay: false,
    };

    // The spring planting (before the scenario's clock), unless the scenario plants this crop.
    const p = simPlanting(seed, field, CURRENT_CROP_YEAR);
    const plantedSim = localToUtc(p.date.y, p.date.m, p.date.d, 0, p.startMinute);
    const planter = world.farm.machines.find((m) => m.kind === 'planter');
    if (!byFieldOp.has(`${field.id}|seeding`) && !plantedHere.has(crop)) {
      const wallYear = Number(cropSeason) - (CURRENT_CROP_YEAR - p.date.y);
      const start = localToUtc(wallYear, p.date.m, p.date.d, 0, p.startMinute);
      const end = start + p.minutes * 60_000;
      if (plantedSim < world.startsAt.getTime() && end <= c.now.getTime()) {
        const machines = planter ? [planter] : [];
        out.push({
          ...base,
          id: simOperationId(field.key, 'seeding', cropSeason),
          kind: 'seeding',
          startDate: iso(start),
          endDate: iso(end),
          modifiedTime: iso(end),
          acres: Math.round(field.acres * 10) / 10,
          machines,
          operatorsByMachine: operatorsOf(world, machines),
          coverage: field.boundary,
        });
      }
    }

    // Finished work from the day reports, stamped in wall time.
    for (const kind of ['seeding', 'application', 'harvest'] as const) {
      const ranges = byFieldOp.get(`${field.id}|${kind}`);
      if (!ranges?.length) continue;
      const first = Math.min(...ranges.map((w) => Date.parse(w.firstAt)));
      const last = Math.max(...ranges.map((w) => Date.parse(w.lastAt)));
      const acres = Math.min(
        ranges.reduce((s, w) => s + w.acres, 0),
        field.acres,
      );
      const machines = world.farm.machines.filter((m) => ranges.some((w) => w.machineId === m.id));
      const end = simToWall(c.clock, new Date(last), c.now).toISOString();
      out.push({
        ...base,
        id: simOperationId(field.key, kind, cropSeason),
        kind,
        startDate: simToWall(c.clock, new Date(first), c.now).toISOString(),
        endDate: end,
        modifiedTime: end,
        acres: Math.round(acres * 10) / 10,
        machines,
        operatorsByMachine: operatorsOf(world, machines),
        coverage:
          acres >= FULL_FIELD_SHARE * field.acres ? field.boundary : passesCoverage(field, ranges),
      });
    }

    // The full-day sprayer payload (knob).
    const fd = c.knobs.fullDay;
    if (fd && fd.fieldKey === field.key) {
      const at = Date.parse(fd.at);
      const sprayer = world.farm.machines.find((m) => m.kind === 'sprayer');
      const machines = sprayer ? [sprayer] : [];
      const acres =
        (FULL_DAY_SPRAYER.boomM * FULL_DAY_SPRAYER.speedMps * FULL_DAY_SPRAYER.seconds) /
        SQ_M_PER_ACRE;
      out.push({
        ...base,
        id: simOperationId(field.key, 'application', cropSeason, true),
        kind: 'application',
        startDate: iso(at - FULL_DAY_SPRAYER.seconds * 1000 - 30 * 60_000),
        endDate: iso(at - 30 * 60_000),
        modifiedTime: iso(at),
        acres: Math.round(acres * 10) / 10,
        machines,
        operatorsByMachine: operatorsOf(world, machines),
        coverage: field.boundary, // replaced by fullDaySprayerCoverage when served
        coverageRefused: false,
        fullDay: true,
      });
    }
  }
  return out;
}
