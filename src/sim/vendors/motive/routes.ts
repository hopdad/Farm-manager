/**
 * Motive stand-in (mounted at /motive; slice 1f.2, the trucks builder, docs/contracts-1f.md
 * §B.7), in Motive's documented shapes (its OpenAPI 3.1; the shared zod schemas in
 * src/connectors/motive/schemas.ts type both sides):
 *
 *   GET /v1/companies                                  the simulated hauler's company
 *   GET /v1|v2/vehicle_locations?per_page=&page_no=    every Motive vehicle: `speed` (mph), the
 *                                                      stats (true_engine_hours, engine_hours,
 *                                                      true_odometer, odometer, fuel %)
 *   GET /v3/vehicle_locations?per_page=&page_no=       Vehicle Gateway units only: `kph`,
 *                                                      `vehicle_state` on/off, no stats
 *   GET /v1/fault_codes?start_date=&end_date=&per_page=&page_no=   the knob's fault records,
 *                                                      paging at the TOP level
 *   GET /v1/vehicles, /v1/groups                       the vehicle list and its group names
 *   X-Api-Key: SIM_CREDENTIALS.motive.apiKey           (else Motive's 401 `invalid API key`)
 *
 * Vehicles are `simTelematicsMachines(farm, 'motive')` (the hired hauler H1, on a gateway),
 * sampled at the latest grid instant (`gpsIntervalMs`, or the vehicle's `reportEverySeconds`)
 * with `world.machineAt(id, simAt(wall))` and stamped with that wall instant: no jitter, so a
 * paused simulation keeps H1 fresh and still (the M0 demo). Motive's unit header decides the
 * units: `X-Metric-Units: false` → mph and miles; without it (or `true`) the stand-in answers
 * metric (km/h, km), the ambiguity Motive's docs leave, so a client that forgets it reads wrong.
 * Control (./control-types.ts): fault records open → closed, and the gateway override.
 */
import type {
  MotiveCompanies,
  MotiveFaultCodes,
  MotiveGroups,
  MotiveVehicleLocations,
  MotiveVehicles,
} from '../../../connectors/motive/schemas';
import { SIM_CREDENTIALS, type SimMachine, simTelematicsMachines } from '../../types';
import type { VendorContext, VendorControlContext, VendorModule } from '../context';
import { firstOfKind } from '../faults';
import { round } from '../feed';
import { header, json, type SimRequest, type SimResponse } from '../http';
import {
  EMPTY_MOTIVE_SIM_STATE,
  type MotiveSimFault,
  type MotiveSimFaultKind,
  type MotiveSimState,
  type MotiveSimStatus,
  motiveSimFaultRequestSchema,
  motiveSimGatewayRequestSchema,
  motiveSimStateSchema,
  SIM_MOTIVE_COMPANY_CODE,
  SIM_MOTIVE_COMPANY_ID,
} from './control-types';

const KMH_PER_MPH = 1.609344;
/** The gateway's own counters started later than the truck's (true_* = "adjusted for accuracy"). */
const VIRTUAL_HOURS_BEHIND = 12.5;
const VIRTUAL_MILES_BEHIND = 1_520.3;

function motiveError(status: number, message: string, headers: Record<string, string> = {}) {
  return json(status, { error_message: message }, headers);
}

function readState(ctx: { state: { vendors?: Record<string, Record<string, unknown>> } }) {
  const r = motiveSimStateSchema.safeParse(ctx.state.vendors?.motive);
  return r.success ? r.data : structuredClone(EMPTY_MOTIVE_SIM_STATE);
}

function writeState(ctx: VendorControlContext, next: MotiveSimState) {
  ctx.state.vendors = { ...(ctx.state.vendors ?? {}), motive: { ...next } };
  ctx.persist();
}

function vehicles(ctx: { world: VendorContext['world'] }): SimMachine[] {
  return simTelematicsMachines(ctx.world.farm, 'motive');
}

const idOf = (m: SimMachine) => m.telematics?.id ?? '';

function hasGateway(m: SimMachine, s: MotiveSimState): boolean {
  return s.gateway[idOf(m)] ?? m.telematics?.gateway === true;
}

/** The wall instant a vehicle last reported at (its own grid; epoch-aligned, no jitter). */
function reportedAt(ctx: VendorContext, m: SimMachine): number {
  const every = m.telematics?.reportEverySeconds;
  const step = every ? every * 1000 : ctx.tuning.gpsIntervalMs;
  return Math.floor(ctx.now().getTime() / step) * step;
}

function page<T>(req: SimRequest, all: T[]) {
  const perPage = Math.min(
    100,
    Math.max(1, Number(req.url.searchParams.get('per_page') ?? 25) || 25),
  );
  const pageNo = Math.max(1, Number(req.url.searchParams.get('page_no') ?? 1) || 1);
  return {
    items: all.slice((pageNo - 1) * perPage, pageNo * perPage),
    pagination: { per_page: perPage, page_no: pageNo, total: all.length },
  };
}

function vehicleLocations(req: SimRequest, ctx: VendorContext, api: 'v1' | 'v2' | 'v3') {
  const imperial = header(req.headers, 'x-metric-units')?.trim().toLowerCase() === 'false';
  const s = readState(ctx);
  const all: MotiveVehicleLocations['vehicles'] = [];
  for (const m of vehicles(ctx)) {
    if (api === 'v3' && !hasGateway(m, s)) continue;
    const t = reportedAt(ctx, m);
    const x = ctx.world.machineAt(m.id, ctx.simAt(new Date(t)));
    const base = {
      id: idOf(m),
      number: m.unitNo,
      year: String(m.year),
      make: m.make,
      model: m.model,
      vin: null,
    };
    if (!x) {
      all.push({ vehicle: { ...base, current_location: null } });
      continue;
    }
    const lat = round(x.lat, 6);
    const lon = round(x.lng, 6);
    const located_at = new Date(t).toISOString();
    const mph = Math.max(0, x.speedMph);
    if (api === 'v3') {
      all.push({
        vehicle: {
          ...base,
          current_location: {
            lat,
            lon,
            bearing: round(x.heading, 1) % 360,
            located_at,
            kph: round(mph * KMH_PER_MPH, 1),
            vehicle_state: x.engineOn ? 'on' : 'off',
          },
        },
      });
      continue;
    }
    const miles = (mi: number) => (imperial ? round(mi, 1) : round(mi * KMH_PER_MPH, 1));
    all.push({
      vehicle: {
        ...base,
        current_location: {
          lat,
          lon,
          bearing: Math.round(x.heading) % 360,
          located_at,
          description: null,
          speed: imperial ? round(mph, 1) : round(mph * KMH_PER_MPH, 1),
          true_engine_hours: round(x.engineHours, 1),
          engine_hours: round(Math.max(0, x.engineHours - VIRTUAL_HOURS_BEHIND), 1),
          true_odometer: miles(x.odometerMi),
          odometer: miles(Math.max(0, x.odometerMi - VIRTUAL_MILES_BEHIND)),
          fuel_primary_remaining_percentage: round(x.fuelPct, 1),
        },
      },
    });
  }
  const p = page(req, all);
  const body: MotiveVehicleLocations = { vehicles: p.items, pagination: p.pagination };
  return json(200, body);
}

/** The code each knob kind raises (Motive's example shapes: obdii, `SPN-<n>` + FMI, OEM). */
const FAULT_PRESETS: Record<MotiveSimFaultKind, Record<string, unknown>> = {
  j1939: {
    code: '110',
    code_label: 'SPN-110',
    code_description: 'Engine Coolant Temperature',
    fmi: 0,
    fmi_description: 'Data Valid But Above Normal Operational Range - Most Severe Level',
    source_address: '0',
    source_address_label: 'Engine #1',
    occurrence_count: 1,
    is_sid: false,
    dtc_status: null,
    dtc_severity: null,
    network: 'j1939',
  },
  obd2: {
    code: 'P0217',
    code_label: 'P0217',
    code_description: 'Engine Coolant Over Temperature Condition',
    fmi: null,
    fmi_description: null,
    source_address: '2024',
    source_address_label: '2024',
    occurrence_count: null,
    is_sid: false,
    dtc_status: null,
    dtc_severity: null,
    network: 'obdii',
  },
  oem: {
    code: 'D1234',
    code_label: 'D1234',
    code_description: 'Aftertreatment derate',
    fmi: null,
    fmi_description: null,
    source_address: null,
    source_address_label: null,
    occurrence_count: null,
    is_sid: false,
    dtc_status: 'active',
    dtc_severity: 'High',
    network: null,
  },
};

const MINUTE = 60_000;

function faultRecord(ctx: VendorContext, f: MotiveSimFault, m: SimMachine | undefined) {
  const opened = Date.parse(f.openedAt);
  const last = f.closedAt
    ? Date.parse(f.closedAt)
    : Math.max(opened, Math.floor(ctx.now().getTime() / MINUTE) * MINUTE);
  const observations = Math.max(1, Math.floor((last - opened) / MINUTE) + 1);
  return {
    fault_code: {
      id: Number(f.id),
      ...FAULT_PRESETS[f.kind],
      status: f.closedAt ? 'closed' : 'open',
      first_observed_at: new Date(opened).toISOString(),
      last_observed_at: new Date(last).toISOString(),
      type: 'constant',
      num_observations: observations,
      sum_num_observations: observations,
      source_address_name: null,
      functional_grp_id: null,
      ftb: null,
      eld_device: { id: 63_621, identifier: `SIM${f.vehicleId}`, model: 'lbb-3.6ca' },
      vehicle: {
        id: Number(f.vehicleId) || f.vehicleId,
        number: m?.unitNo ?? f.vehicleId,
        year: m ? String(m.year) : '',
        make: m?.make ?? '',
        model: m?.model ?? '',
        vin: '',
        metric_units: false,
      },
    },
  };
}

function faultCodes(req: SimRequest, ctx: VendorContext) {
  const s = readState(ctx);
  const byId = new Map(vehicles(ctx).map((m) => [idOf(m), m]));
  const from = req.url.searchParams.get('start_date');
  const to = req.url.searchParams.get('end_date');
  const status = req.url.searchParams.get('status');
  const all = s.faults
    .map((f) => faultRecord(ctx, f, byId.get(f.vehicleId)))
    .filter(({ fault_code: f }) => {
      const day = f.last_observed_at.slice(0, 10);
      if (from && day < from) return false;
      if (to && day > to) return false;
      return !status || f.status === status;
    });
  const p = page(req, all);
  // /v1/fault_codes: paging fields at the TOP level (Motive's spec and example).
  const body: MotiveFaultCodes = { fault_codes: p.items, ...p.pagination };
  return json(200, body);
}

function groupId(name: string): number {
  let h = 0;
  for (const c of name.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) % 90_000;
  return 10_000 + h;
}

/** The hauler's group names for a vehicle: its tags, else "Semi" for a semi. */
function groupNames(m: SimMachine): string[] {
  return m.telematics?.tags ?? (m.kind === 'semi' ? ['Semi'] : []);
}

function vehicleList(req: SimRequest, ctx: VendorContext) {
  const s = readState(ctx);
  const all: MotiveVehicles['vehicles'] = vehicles(ctx).map((m) => ({
    vehicle: {
      id: Number(idOf(m)) || idOf(m),
      company_id: Number(SIM_MOTIVE_COMPANY_ID),
      number: m.unitNo,
      status: 'active',
      make: m.make,
      model: m.model,
      year: String(m.year),
      vin: '',
      metric_units: false,
      group_ids: groupNames(m).map(groupId),
      eld_device: hasGateway(m, s)
        ? { id: 746_694, identifier: `SIM${idOf(m)}`, model: 'lbb-3.6ca' }
        : null,
    },
  }));
  const p = page(req, all);
  const body: MotiveVehicles = { vehicles: p.items, pagination: p.pagination };
  return json(200, body);
}

function groups(req: SimRequest, ctx: VendorContext) {
  const names = [...new Set(vehicles(ctx).flatMap(groupNames))].sort();
  const all: MotiveGroups['groups'] = names.map((name) => ({
    group: {
      id: groupId(name),
      name,
      company_id: Number(SIM_MOTIVE_COMPANY_ID),
      parent_id: null,
    },
  }));
  const p = page(req, all);
  const body: MotiveGroups = { groups: p.items, pagination: p.pagination };
  return json(200, body);
}

function companies() {
  const body: MotiveCompanies = {
    companies: [
      {
        company: {
          id: Number(SIM_MOTIVE_COMPANY_ID),
          company_id: SIM_MOTIVE_COMPANY_CODE,
          name: 'Hired hauler (simulated)',
          time_zone: 'Eastern Time (US & Canada)',
          metric_units: false,
          subscription_plan: 'Enterprise',
        },
      },
    ],
    pagination: { per_page: 25, page_no: 1, total: 1 },
  };
  return json(200, body);
}

// ---- control ----------------------------------------------------------------------------------

function status(ctx: VendorControlContext): MotiveSimStatus {
  const s = readState(ctx);
  return {
    companyId: SIM_MOTIVE_COMPANY_ID,
    vehicles: vehicles(ctx).map((m) => ({
      id: idOf(m),
      unitNo: m.unitNo,
      gateway: hasGateway(m, s),
    })),
    faults: s.faults,
  };
}

function parseBody(req: SimRequest): unknown | SimResponse {
  try {
    return req.body ? JSON.parse(req.body) : {};
  } catch {
    return json(400, { error: 'body must be JSON' });
  }
}

const issue = (e: { issues: { path: PropertyKey[]; message: string }[] }) => {
  const i = e.issues[0];
  return i ? `${i.path.join('.') || '(body)'}: ${i.message}` : 'bad request';
};

function control(req: SimRequest, ctx: VendorControlContext): SimResponse {
  const path = req.path.replace(/\/+$/, '') || '/';
  if (path !== '/fault-codes' && path !== '/gateway') {
    return json(404, { error: `unknown Motive control path ${path}` });
  }
  if (req.method === 'GET') return json(200, status(ctx));
  if (req.method !== 'POST') return json(405, { error: `${req.method} not allowed on ${path}` });
  const value = parseBody(req);
  if (value && typeof value === 'object' && 'kind' in value && value.kind === 'reply') {
    return value as SimResponse;
  }
  const s = readState(ctx);
  const now = new Date(Math.floor(ctx.now().getTime() / 1000) * 1000).toISOString();
  if (path === '/gateway') {
    const r = motiveSimGatewayRequestSchema.safeParse(value);
    if (!r.success) return json(400, { error: issue(r.error) });
    const gateway = { ...s.gateway };
    if (r.data.gateway === null) delete gateway[r.data.vehicleId];
    else gateway[r.data.vehicleId] = r.data.gateway;
    writeState(ctx, { ...s, gateway });
    ctx.log(`motive gateway: ${r.data.vehicleId} → ${r.data.gateway ?? '(world)'}`);
    return json(200, status(ctx));
  }
  const r = motiveSimFaultRequestSchema.safeParse(value);
  if (!r.success) return json(400, { error: issue(r.error) });
  const req2 = r.data;
  if (req2.action === 'clear') {
    writeState(ctx, { ...s, faults: [] });
  } else if (req2.action === 'open') {
    const vehicleId =
      req2.vehicleId ?? (vehicles(ctx)[0] ? idOf(vehicles(ctx)[0] as SimMachine) : '');
    if (!vehicleId) return json(409, { error: 'no Motive vehicle in this world' });
    const fault: MotiveSimFault = {
      id: String(s.nextFaultId),
      vehicleId,
      kind: req2.kind ?? 'j1939',
      openedAt: now,
      closedAt: null,
    };
    writeState(ctx, { ...s, faults: [...s.faults, fault], nextFaultId: s.nextFaultId + 1 });
    ctx.log(`motive fault ${fault.id} opened (${fault.kind}) on ${vehicleId}`);
  } else {
    const f = s.faults.find((x) => x.id === req2.id);
    if (!f) return json(404, { error: `no Motive fault ${req2.id}` });
    writeState(ctx, {
      ...s,
      faults: s.faults.map((x) => (x.id === f.id && !x.closedAt ? { ...x, closedAt: now } : x)),
    });
    ctx.log(`motive fault ${f.id} closed`);
  }
  return json(200, status(ctx));
}

export const motiveModule: VendorModule = {
  vendor: 'motive',
  error: motiveError,
  handle(req, ctx) {
    if (header(req.headers, 'x-api-key') !== SIM_CREDENTIALS.motive.apiKey) {
      return motiveError(401, 'invalid API key');
    }
    if (firstOfKind(ctx.faults, 'token_revoked') ?? firstOfKind(ctx.faults, 'token_expired')) {
      return motiveError(401, 'API key expired or revoked');
    }
    if (req.method !== 'GET') return motiveError(404, `Not found: ${req.path} (not simulated)`);
    switch (req.path.replace(/\/+$/, '')) {
      case '/v1/companies':
        return companies();
      case '/v1/vehicle_locations':
        return vehicleLocations(req, ctx, 'v1');
      case '/v2/vehicle_locations':
        return vehicleLocations(req, ctx, 'v2');
      case '/v3/vehicle_locations':
        return vehicleLocations(req, ctx, 'v3');
      case '/v1/fault_codes':
        return faultCodes(req, ctx);
      case '/v1/vehicles':
        return vehicleList(req, ctx);
      case '/v1/groups':
        return groups(req, ctx);
      default:
        return motiveError(404, `Not found: ${req.path} (not simulated)`);
    }
  },
  control,
};
