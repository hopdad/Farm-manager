/**
 * Deere stand-in route module `ops` (1f, owner: deere-ops; docs/contracts-1f.md §7.1): this crop
 * season's field operations of the simulated farm (./ops-world.ts: finished work from the day
 * reports, the spring planting, the full-day sprayer knob), in the shapes of Deere's Field
 * Operations API (src/connectors/deere/ops/schemas.ts):
 *
 *   GET /platform/organizations/{org}/fields/{field}/fieldOperations
 *       ?cropSeason=&fieldOperationType=&embed=measurementTypes&pageOffset=&itemLimit=
 *       the owning org's operations on the field (a sharing org lists none); `cropSeason` and
 *       `fieldOperationType` filter (the type case-insensitively); `embed=measurementTypes`
 *       puts each operation's measurements on it
 *   GET /platform/fieldOperations/{id}[?embed=measurementTypes]
 *   GET /platform/fieldOperations/{id}/measurementTypes
 *   GET /platform/fieldOperations/{id}/boundary      the worked area; 400 on the fields that
 *       "have an active boundary" (./ops-world.ts simCoverageRefused), as Deere answers
 *
 * Every one of these needs scope `ag2`: a grant without it gets Deere's 403 "The client does not
 * have a proper access for this API" (what `deereDenialOf` reads as a scope problem). Knobs:
 * ./ops-control-types.ts.
 */
import type { MultiPolygon, Position } from 'geojson';
import { deterministicId } from '../../../domain/ids';
import { rngFor } from '../../rng';
import { type Crop, CURRENT_CROP_YEAR, yieldFor } from '../../seasons';
import { currentClock } from '../clock';
import type { VendorControlContext } from '../context';
import { bearerToken, json, type SimRequest, type SimResponse } from '../http';
import { simDeereOnlyField } from './fields-world';
import { type DeerePlatformRequest, type DeereRouteModule, deereModuleState } from './modules';
import {
  type DeereOpsKnobStatus,
  deereOpsFullDayRequestSchema,
  deereOpsRefuseRequestSchema,
} from './ops-control-types';
import {
  fullDaySprayerCoverage,
  parseSimOperationId,
  type SimOperation,
  type SimOpsContext,
  type SimOpsKnobs,
  simOperations,
} from './ops-world';
import { apiError, pagedReply, simDeereFields, simDeereOrgs } from './platform';

/** Deere crop tokens of the demo crops (ISG crop list). */
const CROP_TOKENS: Record<Crop, string> = {
  corn: 'CORN_WET',
  soybeans: 'SOYBEANS',
  wheat: 'WHEAT_SOFT_RED_WINTER',
};

const SEEDS_PER_ACRE: Record<Crop, number> = {
  corn: 34_000,
  soybeans: 140_000,
  wheat: 1_600_000,
};

const ADAPT_MACHINE: Record<SimOperation['kind'], string> = {
  seeding: 'planter',
  application: 'sprayer',
  harvest: 'combine',
};

/** The stand-in's burndown tank mix (gal / fl oz / lb per acre). */
const TANK_MIX = {
  rate: 15,
  components: [
    { name: 'Glyphosate 5.5', value: 32, unitId: 'floz1ac-1', epa: '524-549' },
    { name: '2,4-D LV6', value: 16, unitId: 'floz1ac-1', epa: '34704-125' },
    { name: 'AMS', value: 8.5, unitId: 'lb1ac-1', epa: null },
  ],
} as const;

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const ev = (value: number, unitId: string) => ({ '@type': 'EventMeasurement', value, unitId });

/** The module's knobs, read leniently from the persisted bag. */
export function simOpsKnobs(ctx: {
  state: { vendors?: Record<string, Record<string, unknown>> };
}): SimOpsKnobs {
  const bag = deereModuleState(ctx, 'ops');
  const fd = bag.fullDay as SimOpsKnobs['fullDay'];
  const refuse = Array.isArray(bag.refuse) ? (bag.refuse as unknown[]).map(String) : [];
  return {
    fullDay:
      fd && typeof fd.fieldKey === 'string' && typeof fd.at === 'string'
        ? { fieldKey: fd.fieldKey, at: fd.at }
        : null,
    refuse,
  };
}

function opsContext(r: DeerePlatformRequest): SimOpsContext {
  const now = r.ctx.now();
  return {
    world: r.ctx.world,
    days: r.ctx.days,
    now,
    simNow: r.ctx.simAt(now),
    clock: currentClock(r.ctx.state.clock),
    knobs: simOpsKnobs(r.ctx),
  };
}

/** Scope `ag2` on the request's grant? Null when it has it, else Deere's 403. */
function needsAg2(r: DeerePlatformRequest): SimResponse | null {
  const token = bearerToken(r.req.headers);
  const grant = token ? r.ctx.state.deere.accessTokens[token] : undefined;
  const scopes = (grant?.scope ?? '').split(/\s+/);
  if (scopes.includes('ag2')) return null;
  return apiError(
    403,
    'The client does not have a proper access for this API (Field Operations needs scope ag2)',
  );
}

function moistureOf(c: SimOpsContext, o: SimOperation): number {
  const r = rngFor(c.world.seed, 'ops-moisture', o.field.key, o.cropSeason);
  if (o.crop === 'corn') return r1(r.range(16.5, 21.5));
  if (o.crop === 'soybeans') return r1(r.range(11.5, 13.5));
  return r1(r.range(12.5, 14.5));
}

/** The operation's measurement types (Deere's FieldOperationMeasurement). */
export function simMeasurements(c: SimOpsContext, o: SimOperation): unknown[] {
  const area = ev(o.acres, 'ac');
  const base = (name: string) => ({
    '@type': 'FieldOperationMeasurement',
    measurementName: name,
    measurementCategory: 'Result',
  });
  if (o.kind === 'seeding') {
    const rate = SEEDS_PER_ACRE[o.crop];
    return [
      {
        ...base('SeedingRateResult'),
        area,
        averageMaterial: ev(rate, 'seeds1ac-1'),
        totalMaterial: ev(Math.round(rate * o.acres), 'seeds'),
      },
      { ...base('SeedingSpeedResult'), area, averageSpeed: ev(5.5, 'mi1hr-1') },
    ];
  }
  if (o.kind === 'application') {
    return [
      {
        ...base('ApplicationRateResult'),
        area,
        averageMaterial: ev(TANK_MIX.rate, 'gal1ac-1'),
        totalMaterial: ev(r1(TANK_MIX.rate * o.acres), 'gal'),
      },
      { ...base('ApplicationSpeedResult'), area, averageSpeed: ev(12, 'mi1hr-1') },
    ];
  }
  const avg = yieldFor(c.world.seed, o.field, CURRENT_CROP_YEAR, o.crop);
  const moisture = ev(moistureOf(c, o), 'prcnt');
  return [
    {
      ...base('HarvestYieldResult'),
      area,
      yield: ev(r1(avg * o.acres), 'bu'),
      averageYield: ev(r2(avg), 'bu1ac-1'),
      averageMoisture: moisture,
    },
    { ...base('HarvestMoistureResult'), area, averageMoisture: moisture },
    { ...base('HarvestSpeedResult'), area, averageSpeed: ev(4.5, 'mi1hr-1') },
  ];
}

function machineIdOf(deereId: string | undefined): { machineId?: number | string } {
  if (!deereId) return {};
  return { machineId: /^\d+$/.test(deereId) ? Number(deereId) : deereId };
}

/** One operation as Deere's FieldOperation JSON. */
export function simOperationJson(
  c: SimOpsContext,
  o: SimOperation,
  base: string,
  embed: boolean,
): Record<string, unknown> {
  const org = `${base}/organizations/${encodeURIComponent(o.orgId)}`;
  const self = `${base}/fieldOperations/${encodeURIComponent(o.id)}`;
  const variety = {
    '@type': 'Product',
    productType: 'SEED',
    name: o.variety,
    brand: 'NorthField Seed',
    tankMix: false,
  };
  const measurements = embed ? simMeasurements(c, o) : [];
  return {
    '@type': 'FieldOperation',
    id: o.id,
    fieldOperationType: o.kind,
    adaptMachineType: ADAPT_MACHINE[o.kind],
    cropSeason: o.cropSeason,
    cropName: CROP_TOKENS[o.crop],
    startDate: o.startDate,
    endDate: o.endDate,
    modifiedTime: o.modifiedTime,
    ...(o.kind === 'application'
      ? {
          products: {
            '@type': 'Product',
            name: 'Tank Mix',
            tankMix: true,
            rate: ev(TANK_MIX.rate, 'gal1ac-1'),
            carrier: { '@type': 'Component', name: 'Water', rate: ev(TANK_MIX.rate, 'gal1ac-1') },
            components: TANK_MIX.components.map((p) => ({
              '@type': 'Component',
              name: p.name,
              ...(p.epa ? { agencyRegistrationNumber: p.epa } : {}),
              rate: ev(p.value, p.unitId),
            })),
          },
        }
      : { varieties: [variety] }),
    fieldOperationMachines: o.machines.map((m) => ({
      '@type': 'FieldOperationMachine',
      erid: deterministicId('sim-deere-erid', `${o.id}:${m.key}`),
      ...machineIdOf(m.vendorIds.deere),
      vin: `SIM-${m.unitNo}-${m.year}`,
      name: m.unitNo,
      make: m.make,
      model: m.model,
      modelYear: String(m.year),
      operators: (o.operatorsByMachine[m.id] ?? []).map((name) => ({
        '@type': 'Operator',
        name,
      })),
    })),
    ...(embed
      ? {
          measurementTypes: {
            '@type': 'FieldOperationMeasurements',
            total: measurements.length,
            values: measurements,
          },
        }
      : {}),
    links: [
      { '@type': 'Link', rel: 'organization', uri: org },
      {
        '@type': 'Link',
        rel: 'field',
        uri: `${org}/fields/${encodeURIComponent(o.deereFieldId)}`,
      },
      { '@type': 'Link', rel: 'self', uri: self },
      { '@type': 'Link', rel: 'measurementTypes', uri: `${self}/measurementTypes` },
      {
        '@type': 'Link',
        rel: 'shapeFileAsync',
        uri: `${base}/fieldOps/${encodeURIComponent(o.id)}`,
      },
    ],
  };
}

const HA_PER_ACRE = 0.40468564224;

function boundaryJson(o: SimOperation, geom: MultiPolygon, base: string) {
  const ring = (points: Position[], type: 'exterior' | 'interior') => ({
    '@type': 'Ring',
    type,
    passable: true,
    points: points.map((p) => ({ lat: p[1], lon: p[0] })),
  });
  const ha = r2(o.acres * HA_PER_ACRE);
  return {
    '@type': 'Boundary',
    name: `${o.field.name} ${o.kind} ${o.cropSeason} worked area`,
    sourceType: 'Auto',
    createdTime: o.modifiedTime,
    modifiedTime: o.modifiedTime,
    area: { '@type': 'MeasurementAsDouble', valueAsDouble: ha, unit: 'ha' },
    workableArea: { '@type': 'MeasurementAsDouble', valueAsDouble: ha, unit: 'ha' },
    multipolygons: geom.coordinates.map((poly) => ({
      '@type': 'Polygon',
      rings: poly.map((r, i) => ring(r, i === 0 ? 'exterior' : 'interior')),
    })),
    active: false,
    archived: false,
    irrigated: false,
    links: [
      {
        '@type': 'Link',
        rel: 'fieldOperation',
        uri: `${base}/fieldOperations/${encodeURIComponent(o.id)}`,
      },
    ],
  };
}

/** The last full-day payload served (≈ 9 MB of JSON: built once per field and knob time). */
let fullDayCache: { key: string; body: string } | null = null;

/** The coverage reply of one operation: the worked-area Boundary, or Deere's 400. */
export function simCoverageReply(o: SimOperation, base: string): SimResponse {
  if (o.coverageRefused) {
    return apiError(
      400,
      'A boundary cannot be generated for this field operation: the field already has an active boundary',
    );
  }
  if (!o.fullDay) return json(200, boundaryJson(o, o.coverage, base));
  const key = `${o.id}|${o.modifiedTime}|${base}`;
  if (fullDayCache?.key !== key) {
    const body = JSON.stringify(boundaryJson(o, fullDaySprayerCoverage(o.field), base));
    fullDayCache = { key, body };
  }
  return {
    kind: 'reply',
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: fullDayCache.body,
  };
}

function wantsEmbed(req: SimRequest): boolean {
  return (req.url.searchParams.get('embed') ?? '')
    .split(',')
    .map((s) => s.trim())
    .includes('measurementTypes');
}

function listing(r: DeerePlatformRequest, orgId: string, fieldId: string): SimResponse {
  const farm = r.ctx.world.farm;
  if (!simDeereOrgs(farm).some((o) => o.id === orgId)) {
    return apiError(403, `No access to organization ${orgId}`);
  }
  if (!simDeereFields(farm).some((f) => f.orgId === orgId && f.deereFieldId === fieldId)) {
    // deere-data's Deere-only field (fields module): a real field with no operations yet, so an
    // empty collection as Deere answers, never a 404.
    const only = simDeereOnlyField(farm);
    if (only && only.orgId === orgId && only.deereFieldId === fieldId) return pagedReply(r.req, []);
    return apiError(404, `Field ${fieldId} not found`);
  }
  const season = r.req.url.searchParams.get('cropSeason');
  if (season !== null && !/^\d{4}$/.test(season)) {
    return apiError(400, 'cropSeason must be a year');
  }
  const type = r.req.url.searchParams.get('fieldOperationType')?.trim().toLowerCase() || null;
  const c = opsContext(r);
  const embed = wantsEmbed(r.req);
  const ops = simOperations(c)
    .filter((o) => o.orgId === orgId && o.deereFieldId === fieldId)
    .filter((o) => season === null || o.cropSeason === season)
    .filter((o) => type === null || o.kind === type)
    .map((o) => simOperationJson(c, o, r.base, embed));
  return pagedReply(r.req, ops);
}

function findOperation(
  r: DeerePlatformRequest,
  id: string,
): { c: SimOpsContext; o: SimOperation } | null {
  if (!parseSimOperationId(id)) return null;
  const c = opsContext(r);
  const o = simOperations(c).find((x) => x.id === id);
  return o ? { c, o } : null;
}

function opsRoute(r: DeerePlatformRequest): SimResponse | null {
  if (r.api !== 'platform') return null;
  const p = r.parts;
  const isListing =
    p.length === 5 && p[0] === 'organizations' && p[2] === 'fields' && p[4] === 'fieldOperations';
  const isOp =
    p[0] === 'fieldOperations' &&
    (p.length === 2 || (p.length === 3 && (p[2] === 'measurementTypes' || p[2] === 'boundary')));
  if (!isListing && !isOp) return null;
  const refused = needsAg2(r);
  if (refused) return refused;
  if (isListing) return listing(r, p[1] as string, p[3] as string);

  const hit = findOperation(r, p[1] as string);
  if (!hit) return apiError(404, `Field operation ${p[1]} not found`);
  if (p.length === 2) return json(200, simOperationJson(hit.c, hit.o, r.base, wantsEmbed(r.req)));
  if (p[2] === 'measurementTypes') return pagedReply(r.req, simMeasurements(hit.c, hit.o));
  return simCoverageReply(hit.o, r.base);
}

// ---------------------------------------------------------------------------------------------
// Knobs (./ops-control-types.ts)
// ---------------------------------------------------------------------------------------------

function status(ctx: VendorControlContext): DeereOpsKnobStatus {
  const k = simOpsKnobs(ctx);
  return { fullDay: k.fullDay ?? null, refuse: k.refuse ?? [] };
}

function parseBody(req: SimRequest): unknown {
  try {
    return req.body ? JSON.parse(req.body) : {};
  } catch {
    return undefined;
  }
}

function opsControl(req: SimRequest, ctx: VendorControlContext): SimResponse | null {
  const path = req.path.replace(/\/+$/, '') || '/';
  if (path === '/') return req.method === 'GET' ? json(200, status(ctx)) : null;
  if (path !== '/full-day' && path !== '/refuse') return null;
  if (req.method !== 'POST') return json(405, { error: 'POST required' });
  const bag = deereModuleState(ctx, 'ops');
  if (path === '/full-day') {
    const p = deereOpsFullDayRequestSchema.safeParse(parseBody(req));
    if (!p.success) return json(400, { error: 'expected { fieldKey: string | null }' });
    const key = p.data.fieldKey;
    if (key !== null && !ctx.world.farm.fields.some((f) => f.key === key)) {
      return json(400, { error: `no demo field '${key}'` });
    }
    bag.fullDay = key === null ? null : { fieldKey: key, at: ctx.now().toISOString() };
    ctx.persist();
    ctx.log(`deere ops: full-day sprayer ${key ?? 'off'}`);
    return json(200, status(ctx));
  }
  const p = deereOpsRefuseRequestSchema.safeParse(parseBody(req));
  if (!p.success) return json(400, { error: 'expected { fieldKeys: string[] }' });
  bag.refuse = [...new Set(p.data.fieldKeys)].sort();
  ctx.persist();
  return json(200, status(ctx));
}

export const deereOpsRoutes: DeereRouteModule = {
  key: 'ops',
  route: opsRoute,
  control: opsControl,
};
