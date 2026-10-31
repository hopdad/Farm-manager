/**
 * Deere field operation → NormalizedOperation (slice 1f, deere-ops; docs/contracts-1f.md §5.1).
 * Pure: the `map` of the `operations` sync step.
 *
 *  - kind: `operationKindOf(fieldOperationType)` (seeding, application, harvest, tillage; case
 *    as Deere sends it). Anything else (CARTING, construction work) maps to nothing.
 *  - crop year: `cropSeason` (a string, "2026"); crop: `normalizeDeereCrop(cropName)`.
 *  - measurements, in US units (src/domain/operations.ts): area from the operation's result
 *    measurement (`ac`, or `ha` converted), harvest yield (`bu1ac-1`) and total (`bu`), moisture
 *    (`prcnt`), average speed (`mi1hr-1` / `km1hr-1`). A value in a unit we can't convert
 *    (metric yield: needs a test weight) is left out rather than stored wrong.
 *  - products: seed varieties (seeding and harvest; the seeding rate when there is one
 *    variety), and the products of an application: a tank mix as one line plus its carrier and
 *    components, a single product with the application's rate and total.
 *  - machines: `fieldOperationMachines[].machineId` (the JDLink machine id, the principalId the
 *    machine refs use); operator: the first named operator.
 *  - coverage: the boundary Deere generated around the worked area, as a MultiPolygon; null
 *    when Deere refused it (400: the field has an active boundary) or sent none.
 */
import type { MultiPolygon } from 'geojson';
import { currentCropYear, normalizeDeereCrop } from '../../../domain/crops';
import {
  type OperationKind,
  type OperationMeasurements,
  type OperationProduct,
  operationKindOf,
  operationMeasurementsSchema,
} from '../../../domain/operations';
import type { NormalizedOperation } from '../../types';
import { areaAcres, deereBoundaryToMultiPolygon, deereLinkId, speedToMph } from '../mapper';
import type { DeereFieldOperationMeasurement } from '../schemas';
import {
  type DeereOperationRaw,
  type DeereOpsFieldOperation,
  type DeereProduct,
  deereOperationRawSchema,
} from './schemas';

type Measurement = DeereFieldOperationMeasurement;
type EventValue = { value: number; unitId: string };

/** The result measurement that carries the operation's area and totals, per kind (first wins). */
const RESULT_MEASUREMENTS: Record<OperationKind, readonly string[]> = {
  seeding: ['SeedingRateResult', 'SeedingVarietiesResult', 'SeedingSpeedResult'],
  application: ['ApplicationRateResult', 'ApplicationSpeedResult'],
  harvest: [
    'HarvestYieldResult',
    'HarvestYieldContourResult',
    'HarvestMoistureResult',
    'HarvestWetMassResult',
    'HarvestSpeedResult',
  ],
  tillage: ['TillageDepthResult', 'TillageSpeedResult', 'TillagePressureResult'],
};

const SPEED_MEASUREMENT: Record<OperationKind, string> = {
  seeding: 'SeedingSpeedResult',
  application: 'ApplicationSpeedResult',
  harvest: 'HarvestSpeedResult',
  tillage: 'TillageSpeedResult',
};

const round = (v: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

const unit = (u: string) => u.trim().toLowerCase();

function byName(ms: readonly Measurement[], names: readonly string[]): Measurement | undefined {
  for (const n of names) {
    const hit = ms.find((m) => m.measurementName === n);
    if (hit) return hit;
  }
  return undefined;
}

function acresOf(v: EventValue | undefined): number | null {
  return v ? areaAcres({ value: v.value, unit: v.unitId }) : null;
}

/** The operation's measured totals in US units (src/domain/operations.ts OperationMeasurements). */
export function deereOperationMeasurements(
  kind: OperationKind,
  ms: readonly Measurement[],
): OperationMeasurements {
  const out: OperationMeasurements = {};
  const result = byName(ms, RESULT_MEASUREMENTS[kind]);
  const area =
    acresOf(result?.area) ??
    acresOf(ms.find((m) => m.measurementName.endsWith('Result') && m.area)?.area) ??
    acresOf(ms.find((m) => m.area)?.area);
  if (area !== null && area >= 0) out.areaAc = round(area, 2);

  if (kind === 'harvest') {
    const y = byName(ms, ['HarvestYieldResult', 'HarvestYieldContourResult']);
    if (y?.averageYield && unit(y.averageYield.unitId) === 'bu1ac-1' && y.averageYield.value >= 0) {
      out.yieldBuAc = round(y.averageYield.value, 2);
    }
    if (y?.yield && unit(y.yield.unitId) === 'bu' && y.yield.value >= 0) {
      out.totalBu = round(y.yield.value, 1);
    }
    const moist = byName(ms, ['HarvestMoistureResult'])?.averageMoisture ?? y?.averageMoisture;
    if (moist && unit(moist.unitId) === 'prcnt' && moist.value >= 0 && moist.value <= 100) {
      out.moisturePct = round(moist.value, 1);
    }
  }

  const speed = byName(ms, [SPEED_MEASUREMENT[kind]])?.averageSpeed;
  const mph = speed ? speedToMph({ value: speed.value, unit: speed.unitId }) : null;
  if (mph !== null) out.avgSpeedMph = round(mph, 1);
  return operationMeasurementsSchema.parse(out);
}

const PRODUCT_KINDS: Record<string, OperationProduct['kind']> = {
  SEED: 'seed',
  CHEMICAL: 'chemical',
  FERTILIZER: 'fertilizer',
  OTHER: 'other',
  FEED: 'other',
};

function productLine(
  name: string | undefined,
  kind: OperationProduct['kind'],
  rate: EventValue | undefined,
  total?: EventValue,
): OperationProduct | null {
  const n = name?.trim();
  if (!n) return null;
  return {
    name: n,
    kind,
    rate: rate ? round(rate.value, 4) : null,
    rateUnit: rate ? rate.unitId : null,
    total: total ? round(total.value, 4) : null,
    totalUnit: total ? total.unitId : null,
  };
}

function asList(p: DeereOpsFieldOperation['products']): DeereProduct[] {
  if (!p) return [];
  return Array.isArray(p) ? p : [p];
}

/** Seed varieties, tank mixes and products → OperationProduct[] (no duplicates, in Deere's order). */
export function deereOperationProducts(
  kind: OperationKind,
  op: Pick<DeereOpsFieldOperation, 'products' | 'varieties'>,
  ms: readonly Measurement[],
): OperationProduct[] {
  const lines: (OperationProduct | null)[] = [];
  const varieties = op.varieties ?? [];
  const seeding = kind === 'seeding' ? byName(ms, ['SeedingRateResult']) : undefined;
  for (const v of varieties) {
    // One variety: the seeding rate is its rate. Several: per-variety rates aren't in the totals.
    const one = varieties.length === 1;
    lines.push(
      productLine(
        v.name,
        'seed',
        v.rate ?? (one ? seeding?.averageMaterial : undefined),
        one ? seeding?.totalMaterial : undefined,
      ),
    );
  }
  const products = asList(op.products);
  const applied = kind === 'application' ? byName(ms, ['ApplicationRateResult']) : undefined;
  for (const p of products) {
    const one = products.length === 1;
    const isMix = p.tankMix === true || (p.components?.length ?? 0) > 0;
    if (isMix) {
      lines.push(
        productLine(
          p.name ?? 'Tank mix',
          'other',
          p.rate ?? (one ? applied?.averageMaterial : undefined),
          one ? applied?.totalMaterial : undefined,
        ),
      );
      if (p.carrier) lines.push(productLine(p.carrier.name, 'other', p.carrier.rate));
      for (const c of p.components ?? []) lines.push(productLine(c.name, 'chemical', c.rate));
    } else {
      const k = p.productType ? (PRODUCT_KINDS[p.productType.toUpperCase()] ?? null) : null;
      lines.push(
        productLine(
          p.name,
          k,
          p.rate ?? (one ? applied?.averageMaterial : undefined),
          one ? applied?.totalMaterial : undefined,
        ),
      );
    }
  }
  const seen = new Set<string>();
  const out: OperationProduct[] = [];
  for (const l of lines) {
    if (!l) continue;
    const key = JSON.stringify(l);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

function cropYearOf(op: DeereOpsFieldOperation): number {
  const y = op.cropSeason?.trim();
  if (y && /^\d{4}$/.test(y)) return Number(y);
  return currentCropYear(new Date(op.startDate));
}

const iso = (t: string | undefined) => (t ? new Date(t).toISOString() : null);

function coverageOf(raw: DeereOperationRaw): MultiPolygon | null {
  if (!raw.coverage) return null;
  try {
    return deereBoundaryToMultiPolygon(raw.coverage);
  } catch {
    return null; // a boundary with no exterior ring: no coverage
  }
}

/** One landed `operations` raw item → its NormalizedOperation ([] for a kind we don't store). */
export function mapDeereOperation(input: unknown): NormalizedOperation[] {
  const raw = deereOperationRawSchema.parse(input);
  const op = raw.operation;
  const kind = operationKindOf(op.fieldOperationType);
  if (!kind) return [];
  const measurements = deereOperationMeasurements(kind, raw.measurements);
  const machines = op.fieldOperationMachines ?? [];
  const machineExternalIds = [
    ...new Set(
      machines
        .map((m) => (m.machineId === undefined ? '' : String(m.machineId).trim()))
        .filter(Boolean),
    ),
  ];
  const operatorName =
    machines
      .flatMap((m) => m.operators ?? [])
      .map((o) => o.name?.trim() ?? '')
      .find(Boolean) ?? null;
  const startedAt = new Date(op.startDate).toISOString();
  let endedAt = iso(op.endDate);
  if (endedAt && endedAt < startedAt) endedAt = startedAt;
  return [
    {
      source: 'deere',
      sourceOrg: raw.orgId,
      externalId: op.id,
      fieldExternalId: raw.fieldId || deereLinkId(op.links, 'field'),
      kind,
      cropYear: cropYearOf(op),
      crop: normalizeDeereCrop(op.cropName),
      startedAt,
      endedAt,
      areaAc: measurements.areaAc ?? null,
      products: deereOperationProducts(kind, op, raw.measurements),
      measurements,
      machineExternalIds,
      operatorName,
      coverage: coverageOf(raw),
      modifiedAt: iso(op.modifiedTime),
    },
  ];
}
