/**
 * Builds the DOC-DERIVED Deere replay fixtures (contracts-m1 §10; plan 1a: "Doc-derived replay
 * fixtures for Deere (fields, boundaries, operations with coverage, machine locations, flags)").
 *
 * SHAPES come from Deere's public API reference (cited per fixture in `reference`; see
 * ../schemas.ts for the documents and the mirrors read on Oct 29, 2026, when
 * developer.deere.com itself was unreachable from the build machine). VALUES come from the
 * simulated demo farm (src/sim, seed 1, scenario harvest-day): no real farm data, and every
 * vendor id is one the demo seed maps through ingest.external_refs, so `CONNECTOR_DEERE=replay`
 * drives the seeded board.
 *
 * The committed JSON under ./doc-derived/ is this module's output; ./fixtures.test.ts fails when
 * they drift (after a change to the sim farm, say). Regenerate with
 *   pnpm exec tsx src/connectors/deere/fixtures/write.ts   then   pnpm lint:fix
 *
 * MOVING MACHINES. A breadcrumb fixture holds one 30-minute period of working breadcrumbs
 * (`shiftStepSeconds` = the period, `anchor` = its start). Replayed, the whole period moves to the
 * current one; the client keeps only breadcrumbs in the window it asked for (cursor, now], so the
 * combines and carts advance in real time and start the period again every 30 minutes.
 */
import type { MultiPolygon, Polygon, Position } from 'geojson';
import { deterministicId } from '../../../domain/ids';
import { buildDemoFarm } from '../../../sim/farm/build';
import { cropFor, yieldFor } from '../../../sim/seasons';
import type { LngLat, SimField, SimMachine } from '../../../sim/types';
import { simDeereOrgs } from '../../../sim/vendors/deere/routes';
import { createDemoWorld, type DemoWorld } from '../../../sim/world';
import type { ReplayExchange, ReplayFixture } from '../../replay';

/** The real API roots the fixtures' links name (the transport never contacts them). */
const API = 'https://sandboxapi.deere.com/platform';
/** Deere's Equipment API (machines; one host for sandbox and production apps). */
const EQUIPMENT_API = 'https://equipmentapi.deere.com';
/** Request path of the Equipment API's listing (below the client's equipmentBase's origin path). */
const EQUIPMENT_PATH = '/isg/equipment';
const SEED = 1;

/** Breadcrumb period: 13:00-13:30 UTC (09:00 EDT) on the harvest-day scenario's first day. */
export const LOCATIONS_ANCHOR = '2026-10-15T13:00:00.000Z';
export const LOCATIONS_PERIOD_SECONDS = 30 * 60;
const BREADCRUMB_SPACING_S = 30;
/** Fields, boundaries, flags: "now" is the same morning. */
const SETUP_ANCHOR = LOCATIONS_ANCHOR;
/** Operations: the end of that harvest day (05:00 EDT next morning): every operation finished. */
export const OPERATIONS_ANCHOR = '2026-10-16T09:00:00.000Z';
const FIELDS_PAGE_SIZE = 25;
const MACHINES_PAGE_SIZE = 4;

const REF = {
  locations:
    'https://developer.deere.com/dev-docs/machine-locations (GET /machines/{principalId}/breadcrumbs, Breadcrumb, MeasurementAsDouble/Integer, nextPage paging with pageOffset/itemLimit); https://developer.deere.com/dev-docs/equipment (GET https://equipmentapi.deere.com/isg/equipment?organizationIds=, equipmentForList: id, principalId, isgType, type, make, model, modelYear as a string); https://developer.deere.com/dev-docs/organizations (self and manage_connections links)',
  fields:
    'https://developer.deere.com/dev-docs/fields (GET /organizations/{orgId}/fields, Field and its links); recorded shape: RealmFive/my_john_deere_api test/support/vcr/get_field.yml',
  boundaries:
    'https://developer.deere.com/dev-docs/boundaries (GET /organizations/{orgId}/boundaries, /organizations/{orgId}/fields/{fieldId}/boundaries, Boundary multipolygons/rings/points)',
  operations:
    'https://developer.deere.com/dev-docs/field-operations (GET /organizations/{orgId}/fields/{fieldId}/fieldOperations, /fieldOperations/{id}/measurementTypes); https://developer.deere.com/dev-docs/boundaries (GET /fieldOperations/{operationId}/boundary: coverage)',
  flags:
    'https://developer.deere.com/dev-docs/flags (GET /organizations/{orgId}/flags, /organizations/{orgId}/fields/{fieldId}/flags, geometry as a GeoJSON string)',
};

const SIMULATED =
  'Values: the simulated demo farm (src/sim, seed 1, harvest-day), no real farm data.';

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const link = (rel: string, path: string) => ({ '@type': 'Link', rel, uri: `${API}${path}` });
const enc = encodeURIComponent;

function collection(
  selfPath: string,
  values: unknown[],
  total = values.length,
  next?: string,
  root = API,
) {
  return {
    links: [
      { rel: 'self', uri: `${root}${selfPath}` },
      ...(next ? [{ rel: 'nextPage', uri: `${root}${next}` }] : []),
    ],
    total,
    values,
  };
}

const withQuery = (path: string, query: Record<string, string>) => {
  const q = new URLSearchParams(query).toString();
  return q ? `${path}?${q}` : path;
};

function get(path: string, body: unknown, query?: Record<string, string>): ReplayExchange {
  return {
    request: { method: 'GET', path, ...(query ? { query } : {}) },
    response: { status: 200, body },
  };
}

/**
 * Deere collection paging (since 2024): `nextPage` links carry `?pageOffset=<n>&itemLimit=<size>`
 * (the old matrix form `;start=<n>;count=<size>` fails since June 1, 2024). A later page's
 * exchange names `pageOffset` in its query and is listed BEFORE the first page's, which names
 * only `query` (the first request carries no offset; first match wins).
 */
function paged<T>(
  path: string,
  all: T[],
  size: number,
  query: Record<string, string> = {},
  root = API,
): ReplayExchange[] {
  const out: ReplayExchange[] = [];
  for (let start = 0; start < Math.max(all.length, 1); start += size) {
    const own = start === 0 ? query : { ...query, pageOffset: String(start) };
    const self = withQuery(
      path,
      start === 0 ? query : { ...query, pageOffset: String(start), itemLimit: String(size) },
    );
    const nextStart = start + size;
    const next =
      nextStart < all.length
        ? withQuery(path, { ...query, pageOffset: String(nextStart), itemLimit: String(size) })
        : undefined;
    const body = collection(self, all.slice(start, start + size), all.length, next, root);
    out.push(get(path, body, Object.keys(own).length ? own : undefined));
  }
  return out.reverse();
}

function fixture(
  stream: string,
  reference: string,
  anchor: string,
  exchanges: ReplayExchange[],
  shiftStepSeconds?: number,
): ReplayFixture {
  return {
    format: 1,
    source: 'deere',
    stream,
    kind: 'doc-derived',
    reference: `${reference}. ${SIMULATED}`,
    anchor,
    ...(shiftStepSeconds ? { shiftStepSeconds } : {}),
    basePath: '/platform',
    exchanges,
  };
}

interface Ctx {
  world: DemoWorld;
  farm: DemoWorld['farm'];
  orgOfField: Map<string, string>;
}

function context(): Ctx {
  const world = createDemoWorld({ scenario: 'harvest-day', seed: SEED });
  const farm = world.farm;
  const orgOfFarm = new Map(farm.farms.map((u) => [u.id, u.deereOrgId]));
  const orgOfField = new Map(farm.fields.map((f) => [f.id, orgOfFarm.get(f.farmId) as string]));
  return { world, farm, orgOfField };
}

const deereMachines = (farm: Ctx['farm']): SimMachine[] =>
  farm.machines.filter((m) => m.vendorIds.deere);

// ---------------------------------------------------------------------------------------------
// Organizations and machine locations
// ---------------------------------------------------------------------------------------------

function organizationsFixture(c: Ctx): ReplayFixture {
  const orgs = simDeereOrgs(c.farm).map((o) => ({
    '@type': 'Organization',
    name: o.name,
    type: 'customer',
    member: true,
    id: o.id,
    links: [
      link('self', `/organizations/${enc(o.id)}`),
      // Every fixture org is connected (decision 5): `manage_connections`, never `connections`.
      {
        '@type': 'Link',
        rel: 'manage_connections',
        uri: 'https://connections.deere.com/connections',
      },
      link('fields', `/organizations/${enc(o.id)}/fields`),
      link('boundaries', `/organizations/${enc(o.id)}/boundaries`),
      link('flags', `/organizations/${enc(o.id)}/flags`),
    ],
  }));
  return fixture('organizations', REF.locations, SETUP_ANCHOR, paged('/organizations', orgs, 10));
}

function breadcrumbsFor(c: Ctx, m: SimMachine): unknown[] {
  const anchor = Date.parse(LOCATIONS_ANCHOR);
  const id = m.vendorIds.deere as string;
  const crumbs: unknown[] = [];
  for (let t = 0; t < LOCATIONS_PERIOD_SECONDS; t += BREADCRUMB_SPACING_S) {
    const at = new Date(anchor + t * 1000);
    const s = c.world.machineAt(m.id, at);
    if (s?.activity !== 'working') continue; // Deere records breadcrumbs only while working
    crumbs.push({
      '@type': 'Breadcrumb',
      createTimestamp: new Date(at.getTime() + 2000).toISOString(),
      eventTimestamp: at.toISOString(),
      point: {
        '@type': 'Point',
        lat: r6(s.lat),
        lon: r6(s.lng),
        altitude: { '@type': 'measurementAsDouble', valueAsDouble: 212, unit: 'm' },
      },
      speed: {
        '@type': 'measurementAsDouble',
        valueAsDouble: r1(Math.max(0, s.speedMph) * 1.609344),
        unit: 'km1hr-1',
      },
      heading: { '@type': 'measurementAsInteger', valueAsInteger: Math.round(s.heading) % 360 },
      machineState: { '@type': 'Breadcrumb$MachineState', value: 'Working' },
      fuelLevel: { '@type': 'measurementAsDouble', valueAsDouble: r1(s.fuelPct), unit: 'prcnt' },
      origin: 'JDLINK',
      correlationId: deterministicId('replay-deere', `${id}:${at.toISOString()}`),
      links: [link('machine', `/machines/${enc(id)}`)],
    });
  }
  return crumbs;
}

/** Deere's ISG type name of a demo machine (JDLink sits in the tractor of a cart or planter). */
const ISG_TYPE: Partial<Record<SimMachine['kind'], string>> = {
  combine: 'Combine',
  sprayer: 'Sprayer',
};

function locationsFixture(c: Ctx): ReplayFixture {
  const exchanges: ReplayExchange[] = [];
  for (const org of simDeereOrgs(c.farm)) {
    // The Equipment API (machines; the /platform machines API is deprecated): `id` is the
    // organization-equipment id, `principalId` the machine id the /platform paths take.
    const machines = deereMachines(c.farm)
      .filter((m) => m.deereOrgId === org.id)
      .map((m) => {
        const isgType = { id: `isg-${m.kind}`, name: ISG_TYPE[m.kind] ?? 'Tractor' };
        return {
          '@type': 'Machine',
          id: deterministicId('replay-deere-equipment', m.key),
          principalId: Number(m.vendorIds.deere),
          name: m.unitNo,
          serialNumber: `SIM${m.unitNo}${m.year}`,
          modelYear: String(m.year),
          make: { id: 'make-john-deere', name: 'JOHN DEERE' },
          type: isgType,
          isgType,
          model: { id: `model-${m.key}`, name: m.model },
          organization: [{ '@type': 'Resource', id: org.id }],
          organizationRole: { type: 'Controlling', inPossession: true },
          telematicsCapable: true,
          archived: false,
        };
      });
    exchanges.push(
      ...paged(
        EQUIPMENT_PATH,
        machines,
        MACHINES_PAGE_SIZE,
        { organizationIds: org.id },
        EQUIPMENT_API,
      ),
    );
  }
  for (const m of deereMachines(c.farm)) {
    const path = `/machines/${enc(m.vendorIds.deere as string)}/breadcrumbs`;
    exchanges.push(get(path, collection(path, breadcrumbsFor(c, m))));
  }
  return fixture('locations', REF.locations, LOCATIONS_ANCHOR, exchanges, LOCATIONS_PERIOD_SECONDS);
}

// ---------------------------------------------------------------------------------------------
// Fields and boundaries
// ---------------------------------------------------------------------------------------------

/** Every (org, field id, boundary id) under which Deere knows a demo field. */
function fieldCopies(c: Ctx, f: SimField) {
  const own = {
    org: c.orgOfField.get(f.id) as string,
    id: f.deereFieldId,
    boundaryId: f.deereBoundaryId,
  };
  if (!f.sharedWith) return [own];
  return [
    own,
    {
      org: f.sharedWith.deereOrgId,
      id: f.sharedWith.deereFieldId,
      boundaryId: deterministicId('replay-deere-boundary', `${f.sharedWith.deereOrgId}:${f.key}`),
    },
  ];
}

function fieldPath(org: string, fieldId: string): string {
  return `/organizations/${enc(org)}/fields/${enc(fieldId)}`;
}

function fieldsFixture(c: Ctx): ReplayFixture {
  const exchanges: ReplayExchange[] = [];
  for (const org of simDeereOrgs(c.farm)) {
    const values = c.farm.fields.flatMap((f) =>
      fieldCopies(c, f)
        .filter((copy) => copy.org === org.id)
        .map((copy) => {
          const p = fieldPath(copy.org, copy.id);
          return {
            '@type': 'Field',
            name: f.name,
            archived: false,
            id: copy.id,
            lastModifiedTime: '2026-03-02T15:41:15.205Z',
            links: [
              link('self', p),
              link('clients', `${p}/clients`),
              link('farms', `${p}/farms`),
              link('owningOrganization', `/organizations/${enc(copy.org)}`),
              link('boundaries', `${p}/boundaries`),
              link('simplifiedBoundaries', `${p}/boundaries?simple=true`),
              link('activeBoundary', `${p}/boundaries/${enc(copy.boundaryId)}`),
              link('fieldOperation', `${p}/fieldOperations`),
            ],
          };
        }),
    );
    exchanges.push(...paged(`/organizations/${enc(org.id)}/fields`, values, FIELDS_PAGE_SIZE));
  }
  return fixture('fields', REF.fields, SETUP_ANCHOR, exchanges);
}

const point = ([lon, lat]: Position) => ({
  '@type': 'Point',
  lat: r6(lat as number),
  lon: r6(lon as number),
});

/** Geodesic-enough area of a small lng/lat polygon (local tangent plane), in hectares. */
function hectares(rings: Position[][]): number {
  const ring = rings[0] ?? [];
  const lat0 = ((ring[0]?.[1] as number) * Math.PI) / 180;
  const mx = 111_320 * Math.cos(lat0);
  const my = 110_574;
  let a = 0;
  for (let k = 0; k + 1 < ring.length; k++) {
    const p = ring[k] as Position;
    const q = ring[k + 1] as Position;
    a +=
      (p[0] as number) * mx * ((q[1] as number) * my) -
      (q[0] as number) * mx * ((p[1] as number) * my);
  }
  return Math.abs(a / 2) / 10_000;
}

function extentOf(geom: MultiPolygon) {
  const pts = geom.coordinates.flat(2);
  const lons = pts.map((p) => p[0] as number);
  const lats = pts.map((p) => p[1] as number);
  return {
    '@type': 'Extent',
    topLeft: { '@type': 'Point', lat: r6(Math.max(...lats)), lon: r6(Math.min(...lons)) },
    bottomRight: { '@type': 'Point', lat: r6(Math.min(...lats)), lon: r6(Math.max(...lons)) },
  };
}

function boundaryBody(
  geom: MultiPolygon,
  extra: { id?: string; name: string; sourceType: string; links: unknown[]; active: boolean },
) {
  const ha = r2(geom.coordinates.reduce((s, poly) => s + hectares(poly), 0));
  return {
    '@type': 'Boundary',
    ...(extra.id ? { id: extra.id } : {}),
    name: extra.name,
    sourceType: extra.sourceType,
    createdTime: '2026-03-02T15:40:11Z',
    modifiedTime: '2026-03-02T15:41:15.205Z',
    area: { '@type': 'MeasurementAsDouble', valueAsDouble: ha, unit: 'ha' },
    workableArea: { '@type': 'MeasurementAsDouble', valueAsDouble: ha, unit: 'ha' },
    multipolygons: geom.coordinates.map((poly) => ({
      '@type': 'Polygon',
      rings: poly.map((ring, i) => ({
        '@type': 'Ring',
        points: ring.map(point),
        type: i === 0 ? 'exterior' : 'interior',
        passable: true,
      })),
    })),
    extent: extentOf(geom),
    links: extra.links,
    active: extra.active,
    irrigated: false,
    archived: false,
    signalType: 'dtiSignalTypeRTK',
  };
}

function fieldBoundary(c: Ctx, f: SimField, copy: ReturnType<typeof fieldCopies>[number]) {
  const p = fieldPath(copy.org, copy.id);
  return boundaryBody(f.boundary, {
    id: copy.boundaryId,
    name: copy.org === c.orgOfField.get(f.id) ? f.name : `${f.name} (shared)`,
    sourceType: 'HandDrawn',
    active: true,
    links: [
      link('self', `${p}/boundaries/${enc(copy.boundaryId)}`),
      link('owningOrganization', `/organizations/${enc(copy.org)}`),
      link('field', p),
    ],
  });
}

function boundariesFixture(c: Ctx): ReplayFixture {
  const exchanges: ReplayExchange[] = [];
  for (const org of simDeereOrgs(c.farm)) {
    const values = c.farm.fields.flatMap((f) =>
      fieldCopies(c, f)
        .filter((copy) => copy.org === org.id)
        .map((copy) => fieldBoundary(c, f, copy)),
    );
    const path = `/organizations/${enc(org.id)}/boundaries`;
    exchanges.push(get(path, collection(path, values)));
  }
  // One field's own boundaries resource, as the 1f sync reads a single field.
  const first = c.farm.fields[0] as SimField;
  const copy = fieldCopies(c, first)[0] as ReturnType<typeof fieldCopies>[number];
  const path = `${fieldPath(copy.org, copy.id)}/boundaries`;
  exchanges.push(get(path, collection(path, [fieldBoundary(c, first, copy)])));
  return fixture('boundaries', REF.boundaries, SETUP_ANCHOR, exchanges);
}

// ---------------------------------------------------------------------------------------------
// Field operations with measurements and coverage
// ---------------------------------------------------------------------------------------------

const operationId = (key: string) =>
  Buffer.from(`replay-fieldop:${key}`).toString('base64url').replace(/=+$/, '');

/** Bounding rectangle of the worked passes (± half the header), kept inside the field. */
function coverageOf(f: SimField, passes: [LngLat, LngLat][], widthM: number): MultiPolygon {
  const pts = passes.flat();
  const lat0 = pts[0]?.[1] ?? 0;
  const half = widthM / 2;
  const dLng = half / (111_320 * Math.cos((lat0 * Math.PI) / 180));
  const dLat = half / 110_574;
  const field = f.boundary.coordinates.flat(2);
  const fw = Math.min(...field.map((p) => p[0] as number));
  const fe = Math.max(...field.map((p) => p[0] as number));
  const fs = Math.min(...field.map((p) => p[1] as number));
  const fn = Math.max(...field.map((p) => p[1] as number));
  const w = Math.max(fw, Math.min(...pts.map((p) => p[0])) - dLng);
  const e = Math.min(fe, Math.max(...pts.map((p) => p[0])) + dLng);
  const s = Math.max(fs, Math.min(...pts.map((p) => p[1])) - dLat);
  const n = Math.min(fn, Math.max(...pts.map((p) => p[1])) + dLat);
  const ring: Position[] = [
    [r6(w), r6(s)],
    [r6(e), r6(s)],
    [r6(e), r6(n)],
    [r6(w), r6(n)],
    [r6(w), r6(s)],
  ];
  const polygon: Polygon['coordinates'] = [ring];
  return { type: 'MultiPolygon', coordinates: [polygon] };
}

interface OperationSpec {
  key: string;
  field: SimField;
  type: 'harvest' | 'seeding';
  crop: string;
  start: string;
  end: string;
  machines: SimMachine[];
  acres: number;
  coverage: MultiPolygon;
}

function operationSpecs(c: Ctx): OperationSpec[] {
  const day = c.world.dayReport(c.world.dayIndexAt(new Date(LOCATIONS_ANCHOR)));
  const byField = new Map<string, typeof day.work>();
  for (const w of day.work.filter((x) => x.op === 'harvest')) {
    byField.set(w.fieldId, [...(byField.get(w.fieldId) ?? []), w]);
  }
  const specs: OperationSpec[] = [];
  for (const [fieldId, work] of byField) {
    const field = c.farm.fields.find((f) => f.id === fieldId) as SimField;
    const crop = cropFor(SEED, field, 2026);
    const machines = c.farm.machines.filter((m) => work.some((w) => w.machineId === m.id));
    const passes = work.flatMap((w) => w.passes);
    const width = Math.max(...work.map((w) => w.widthM));
    specs.push({
      key: `${field.key}:harvest:2026`,
      field,
      type: 'harvest',
      crop,
      start: work.map((w) => w.firstAt).sort()[0] as string,
      end: work
        .map((w) => w.lastAt)
        .sort()
        .at(-1) as string,
      machines,
      acres: r1(work.reduce((s, w) => s + w.acres, 0)),
      coverage: coverageOf(field, passes, width),
    });
    // The same field's spring planting (the whole field), as the season's first operation.
    const planter = c.farm.machines.find((m) => m.kind === 'planter') as SimMachine;
    specs.push({
      key: `${field.key}:seeding:2026`,
      field,
      type: 'seeding',
      crop,
      start: '2026-05-06T13:12:00.000Z',
      end: '2026-05-06T19:47:30.000Z',
      machines: [planter],
      acres: r1(field.acres),
      coverage: field.boundary,
    });
  }
  return specs.sort((a, b) => a.key.localeCompare(b.key));
}

const CROP_NAMES: Record<string, string> = {
  corn: 'CORN_WET',
  soybeans: 'SOYBEANS',
  wheat: 'WHEAT_SOFT_RED_WINTER',
};

function operationBody(c: Ctx, op: OperationSpec) {
  const org = c.orgOfField.get(op.field.id) as string;
  const p = fieldPath(org, op.field.deereFieldId);
  const id = operationId(op.key);
  return {
    '@type': 'FieldOperation',
    fieldOperationType: op.type,
    adaptMachineType: op.type === 'harvest' ? 'combine' : 'planter',
    cropSeason: '2026',
    cropName: CROP_NAMES[op.crop] ?? op.crop.toUpperCase(),
    modifiedTime: op.end,
    startDate: op.start,
    endDate: op.end,
    fieldOperationMachines: op.machines.map((m) => ({
      '@type': 'FieldOperationMachine',
      erid: deterministicId('replay-deere-erid', `${op.key}:${m.key}`),
      ...(m.vendorIds.deere ? { machineId: Number(m.vendorIds.deere) } : {}),
      vin: `SIM-${m.unitNo}-${m.year}`,
      operators: [],
    })),
    id,
    links: [
      link('organization', `/organizations/${enc(org)}`),
      link('field', p),
      link('self', `/fieldOperations/${id}`),
      link('measurementTypes', `/fieldOperations/${id}/measurementTypes`),
      link('shapeFileAsync', `/fieldOps/${id}`),
      link('boundary', `/fieldOperations/${id}/boundary`),
    ],
  };
}

function measurements(op: OperationSpec) {
  const ac = { '@type': 'EventMeasurement', value: op.acres, unitId: 'ac' };
  if (op.type === 'harvest') {
    const avg = yieldFor(SEED, op.field, 2026, op.crop as 'corn' | 'soybeans' | 'wheat');
    return [
      {
        '@type': 'FieldOperationMeasurement',
        measurementName: 'HarvestYieldResult',
        measurementCategory: 'Result',
        area: ac,
        yield: { '@type': 'EventMeasurement', value: r1(avg * op.acres), unitId: 'bu' },
        averageYield: { '@type': 'EventMeasurement', value: r2(avg), unitId: 'bu1ac-1' },
        averageMoisture: {
          '@type': 'EventMeasurement',
          value: op.crop === 'corn' ? 18.4 : 12.6,
          unitId: 'prcnt',
        },
      },
      {
        '@type': 'FieldOperationMeasurement',
        measurementName: 'HarvestMoistureResult',
        measurementCategory: 'Result',
        area: ac,
        averageMoisture: {
          '@type': 'EventMeasurement',
          value: op.crop === 'corn' ? 18.4 : 12.6,
          unitId: 'prcnt',
        },
      },
    ];
  }
  return [
    {
      '@type': 'FieldOperationMeasurement',
      measurementName: 'SeedingRateResult',
      measurementCategory: 'Result',
      area: ac,
      averageMaterial: {
        '@type': 'EventMeasurement',
        value: op.crop === 'corn' ? 34_000 : 140_000,
        unitId: 'seeds1ac-1',
      },
    },
  ];
}

function operationsFixture(c: Ctx): ReplayFixture {
  const specs = operationSpecs(c);
  const exchanges: ReplayExchange[] = [];
  const fields = [...new Set(specs.map((s) => s.field))];
  for (const f of fields) {
    const org = c.orgOfField.get(f.id) as string;
    const path = `${fieldPath(org, f.deereFieldId)}/fieldOperations`;
    const ops = specs.filter((s) => s.field === f).map((s) => operationBody(c, s));
    exchanges.push(get(path, collection(path, ops)));
  }
  for (const s of specs) {
    const id = operationId(s.key);
    const mPath = `/fieldOperations/${id}/measurementTypes`;
    exchanges.push(get(mPath, collection(mPath, measurements(s))));
    exchanges.push(
      get(
        `/fieldOperations/${id}/boundary`,
        boundaryBody(s.coverage, {
          name: `${s.field.name} ${s.type} 2026 worked area`,
          sourceType: 'Auto',
          active: false,
          links: [link('fieldOperation', `/fieldOperations/${id}`)],
        }),
      ),
    );
  }
  return fixture('operations', REF.operations, OPERATIONS_ANCHOR, exchanges);
}

// ---------------------------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------------------------

function flagsFixture(c: Ctx): ReplayFixture {
  const orgs = simDeereOrgs(c.farm).map((o) => o.id);
  const ownFields = c.farm.fields.filter((f) => c.orgOfField.get(f.id) === 'org-home');
  const at = (f: SimField, fx: number, fy: number): [number, number] => {
    const ring = f.boundary.coordinates[0]?.[0] ?? [];
    const xs = ring.map((p) => p[0] as number);
    const ys = ring.map((p) => p[1] as number);
    const w = Math.min(...xs);
    const s = Math.min(...ys);
    return [r6(w + (Math.max(...xs) - w) * fx), r6(s + (Math.max(...ys) - s) * fy)];
  };
  const defs: {
    field: SimField;
    notes: string;
    category: string;
    geometry: object;
    created: string;
  }[] = [
    {
      field: ownFields[0] as SimField,
      notes: 'Big rock, west headland',
      category: 'rock',
      geometry: { type: 'Point', coordinates: at(ownFields[0] as SimField, 0.08, 0.5) },
      created: '2026-05-06T15:02:11Z',
    },
    {
      field: ownFields[1] as SimField,
      notes: 'Tile blowout, wet after rain',
      category: 'tile',
      geometry: { type: 'Point', coordinates: at(ownFields[1] as SimField, 0.62, 0.41) },
      created: '2026-06-18T12:30:00Z',
    },
    {
      field: ownFields[2] as SimField,
      notes: 'Wet hole: go around in spring',
      category: 'wet',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            at(ownFields[2] as SimField, 0.4, 0.4),
            at(ownFields[2] as SimField, 0.5, 0.4),
            at(ownFields[2] as SimField, 0.5, 0.5),
            at(ownFields[2] as SimField, 0.4, 0.5),
            at(ownFields[2] as SimField, 0.4, 0.4),
          ],
        ],
      },
      created: '2026-04-21T14:10:00Z',
    },
    {
      field: ownFields[3] as SimField,
      notes: 'Washout along the waterway',
      category: 'washout',
      geometry: {
        type: 'LineString',
        coordinates: [
          at(ownFields[3] as SimField, 0.2, 0.3),
          at(ownFields[3] as SimField, 0.45, 0.35),
        ],
      },
      created: '2026-07-02T21:45:00Z',
    },
  ];
  const flag = (d: (typeof defs)[number], i: number) => {
    const org = c.orgOfField.get(d.field.id) as string;
    return {
      '@type': 'Flag',
      geometry: JSON.stringify(d.geometry),
      notes: d.notes,
      archived: false,
      proximityAlertEnabled: d.category === 'rock',
      links: [
        link('owningOrganization', `/organizations/${enc(org)}`),
        link(
          'flagCategoryWithPrefrences',
          `/flagCategories/${deterministicId('replay-deere-flag-category', d.category)}?embed=preferences`,
        ),
        link('createdBy', '/users/simulated-operator'),
        link('field', fieldPath(org, d.field.deereFieldId)),
      ],
      id: deterministicId('replay-deere-flag', `${d.field.key}:${i}`),
      createdTime: d.created,
      lastModifiedTime: d.created,
    };
  };
  const all = defs.map(flag);
  const exchanges: ReplayExchange[] = [];
  for (const org of orgs) {
    const path = `/organizations/${enc(org)}/flags`;
    exchanges.push(
      get(
        path,
        collection(
          path,
          all.filter(
            (_, i) => c.orgOfField.get((defs[i] as (typeof defs)[number]).field.id) === org,
          ),
        ),
      ),
    );
  }
  const d0 = defs[0] as (typeof defs)[number];
  const fPath = `${fieldPath(c.orgOfField.get(d0.field.id) as string, d0.field.deereFieldId)}/flags`;
  exchanges.push(get(fPath, collection(fPath, [all[0]])));
  return fixture('flags', REF.flags, SETUP_ANCHOR, exchanges);
}

/** Every Deere doc-derived fixture, by its path under ./doc-derived/. */
export function buildDeereDocDerivedFixtures(): Record<string, ReplayFixture> {
  const c = context();
  return {
    'organizations/01-organizations.json': organizationsFixture(c),
    'locations/01-machine-locations.json': locationsFixture(c),
    'fields/01-fields.json': fieldsFixture(c),
    'boundaries/01-boundaries.json': boundariesFixture(c),
    'operations/01-field-operations.json': operationsFixture(c),
    'flags/01-flags.json': flagsFixture(c),
  };
}

/** The demo farm the fixtures were built from (tests check the ids map onto it). */
export function fixtureFarm() {
  return buildDemoFarm(SEED);
}
