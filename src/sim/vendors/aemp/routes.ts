/**
 * ISO 15143-3 (AEMP 2.0) stand-in (mounted at /aemp; slice 1f.2, owner: the machines builder,
 * docs/contracts-1f.md part B): one provider per path prefix, for SIM_AEMP_PROVIDERS:
 *
 *   GET /aemp/<provider>/Fleet/{pageNumber}                       the snapshot (100 a page)
 *   GET /aemp/kubota/Fleet/Equipment/ID/{id}/Faults/{start}/{end}/{page}   the fault series
 *   Authorization: Bearer SIM_CREDENTIALS.aemp.token
 *
 *  - `kubota` (the loader L1): XML per the ISO edition-1 XSDs (Kubota's real format is unknown:
 *    the dealer gives it), PIN and SerialNumber = the machine id, the sections Kubota's data set
 *    lists (Location, CumulativeOperatingHours, FuelRemaining, DEFRemaining; Geotab's Kubota data
 *    set), a fault series in Trackunit's path form whose occurrences come from the knob
 *    (./control-types.ts).
 *  - `samsara` (Samsara's asset-gateway machines: the RoGator SP2): JSON wrapped in
 *    `{"Fleet": …}` with `version` a string, `EquipmentID` the Samsara equipment id, the sections
 *    Samsara's getAempEquipmentList documents (Location, CumulativeOperatingHours, Distance,
 *    FuelRemaining, DEFRemaining, EngineStatus without EngineNumber), no fault series, and a 500
 *    with an XML-ish GoaError body when the request prefers `application/xml` (as Samsara does).
 * Machines: `simTelematicsMachines(farm, 'aemp', { provider })`, each section sampled from the
 * world at its OWN `datetime`: the snapshot is the OEM's cached view (Location every 5 min, the
 * counters every 15 min, wall time), stamped with wall time (contracts §9). `Links` carry `self`
 * and `next` while pages remain, with the vendor's own host (Samsara's example omits /beta), so
 * the client must rebuild page URLs from its own base. Diesel exhaust fluid isn't in the world's
 * sample: the stand-in reports a steady level per machine.
 */
import { randomUUID } from 'node:crypto';
import { hash32 } from '../../rng';
import {
  SIM_AEMP_PROVIDERS,
  SIM_CREDENTIALS,
  type SimMachine,
  simTelematicsMachines,
} from '../../types';
import type { VendorContext, VendorControlContext, VendorModule } from '../context';
import { firstIssue } from '../control';
import { bearerToken, header, json, type SimRequest, type SimResponse } from '../http';
import {
  AEMP_SIM_FAULT_PROVIDERS,
  type AempSimFault,
  aempSimFaultRequestSchema,
} from './control-types';
import { el, isoLinks, isoXmlDocument, type XmlNode } from './iso-xml';

/** Machines per Fleet page (every documented provider: 100, not settable). */
export const AEMP_SIM_PAGE_SIZE = 100;
/** The cached snapshot's grids (wall ms): positions every 5 min, counters every 15 min. */
export const AEMP_SIM_LOCATION_GRID_MS = 5 * 60_000;
export const AEMP_SIM_COUNTER_GRID_MS = 15 * 60_000;
const MAX_SIM_FAULTS = 200;

type ProviderId = (typeof SIM_AEMP_PROVIDERS)[number];

interface ProviderSpec {
  format: 'xml' | 'json';
  /** The host the provider's own `Links` name (never this stand-in's). */
  hrefBase: string;
}

const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  kubota: { format: 'xml', hrefBase: 'https://kubota-aemp.example.invalid' },
  samsara: { format: 'json', hrefBase: 'https://api.samsara.com/aemp' },
};

const isProvider = (p: string): p is ProviderId =>
  (SIM_AEMP_PROVIDERS as readonly string[]).includes(p);

function aempError(status: number, message: string, headers: Record<string, string> = {}) {
  return json(status, { message, requestId: randomUUID() }, headers);
}

function xml(status: number, body: string): SimResponse {
  return {
    kind: 'reply',
    status,
    headers: { 'content-type': 'application/xml; charset=utf-8' },
    body,
  };
}

/** The media type an Accept header prefers most (q values; ties: the first listed). */
export function preferredType(accept: string | undefined): string | null {
  let best: { type: string; q: number } | null = null;
  for (const part of (accept ?? '').split(',')) {
    const [type = '', ...params] = part.trim().split(';');
    if (!type.trim()) continue;
    const qParam = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    const q = qParam ? Number(qParam.slice(2)) : 1;
    if (!best || q > best.q) best = { type: type.trim().toLowerCase(), q };
  }
  return best?.type ?? null;
}

const floorTo = (t: number, step: number) => Math.floor(t / step) * step;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const r1 = (v: number) => Math.round(v * 10) / 10;
const iso = (ms: number) => new Date(ms).toISOString();

/** A steady diesel-exhaust-fluid level per machine (the world doesn't model DEF). */
export const simDefPct = (machineId: string) => 40 + (hash32('sim-aemp-def', machineId) % 50);

interface Sampled {
  m: SimMachine;
  id: string;
  locAt: number;
  counterAt: number;
  loc: { lat: number; lng: number } | null;
  counters: { hours: number; odometerMi: number; fuelPct: number; engineOn: boolean } | null;
}

function sampleMachine(ctx: VendorContext, m: SimMachine): Sampled {
  const now = ctx.now().getTime();
  const locAt = floorTo(now, AEMP_SIM_LOCATION_GRID_MS);
  const counterAt = floorTo(now, AEMP_SIM_COUNTER_GRID_MS);
  const at = (wall: number) => ctx.world.machineAt(m.id, ctx.simAt(new Date(wall)));
  const l = at(locAt);
  const c = at(counterAt);
  return {
    m,
    id: m.telematics?.id ?? '',
    locAt,
    counterAt,
    loc: l ? { lat: l.lat, lng: l.lng } : null,
    counters: c
      ? { hours: c.engineHours, odometerMi: c.odometerMi, fuelPct: c.fuelPct, engineOn: c.engineOn }
      : null,
  };
}

function linksFor(provider: ProviderId, page: number, pages: number) {
  const base = PROVIDERS[provider].hrefBase;
  return [
    { rel: 'self', href: `${base}/Fleet/${page}` },
    ...(page < pages ? [{ rel: 'next', href: `${base}/Fleet/${page + 1}` }] : []),
    ...(page > 1 ? [{ rel: 'prev', href: `${base}/Fleet/${page - 1}` }] : []),
    { rel: 'last', href: `${base}/Fleet/${pages}` },
  ];
}

/** Kubota: ISO XML (the sections of Geotab's Kubota data set). */
function kubotaEquipment(s: Sampled): XmlNode {
  const children: XmlNode[] = [
    el('EquipmentHeader', [
      el('OEMName', 'Kubota'),
      el('Model', s.m.model),
      el('EquipmentID', s.m.unitNo),
      el('SerialNumber', s.id),
      el('PIN', s.id),
    ]),
  ];
  if (s.loc) {
    children.push(
      el('Location', [el('Latitude', r6(s.loc.lat)), el('Longitude', r6(s.loc.lng))], {
        datetime: iso(s.locAt),
      }),
    );
  }
  if (s.counters) {
    const datetime = iso(s.counterAt);
    children.push(
      el('CumulativeOperatingHours', [el('Hour', r1(s.counters.hours))], { datetime }),
      el('FuelRemaining', [el('Percent', Math.round(s.counters.fuelPct))], { datetime }),
      el('DEFRemaining', [el('Percent', simDefPct(s.m.id))], { datetime }),
    );
  }
  return el('Equipment', children);
}

/** Samsara: the JSON of getAempEquipmentList (PascalCase sections, lower-case datetime). */
function samsaraEquipment(s: Sampled): Record<string, unknown> {
  const out: Record<string, unknown> = {
    EquipmentHeader: {
      EquipmentID: s.id,
      OEMName: s.m.make,
      Model: s.m.model,
      SerialNumber: `SN-${s.m.unitNo}`,
    },
  };
  if (s.loc) {
    out.Location = { Latitude: r6(s.loc.lat), Longitude: r6(s.loc.lng), datetime: iso(s.locAt) };
  }
  if (s.counters) {
    const datetime = iso(s.counterAt);
    out.CumulativeOperatingHours = { Hour: r1(s.counters.hours), datetime };
    out.Distance = {
      Odometer: r1(s.counters.odometerMi * 1.609344),
      OdometerUnits: 'kilometre',
      datetime,
    };
    out.FuelRemaining = { Percent: Math.round(s.counters.fuelPct), datetime };
    out.DEFRemaining = { Percent: simDefPct(s.m.id), datetime };
    out.EngineStatus = { Running: s.counters.engineOn, datetime };
  }
  return out;
}

function machinesOf(world: VendorContext['world'], provider: ProviderId): SimMachine[] {
  return simTelematicsMachines(world.farm, 'aemp', { provider });
}

function fleetPage(provider: ProviderId, page: number, ctx: VendorContext): SimResponse {
  const all = machinesOf(ctx.world, provider);
  const pages = Math.max(1, Math.ceil(all.length / AEMP_SIM_PAGE_SIZE));
  const slice = all.slice((page - 1) * AEMP_SIM_PAGE_SIZE, page * AEMP_SIM_PAGE_SIZE);
  const sampled = slice.map((m) => sampleMachine(ctx, m));
  const snapshotTime = ctx.now().toISOString();
  const links = linksFor(provider, page, pages);
  if (PROVIDERS[provider].format === 'json') {
    return json(200, {
      Fleet: { version: '1', snapshotTime, Links: links, Equipment: sampled.map(samsaraEquipment) },
    });
  }
  return xml(
    200,
    isoXmlDocument(
      el('Fleet', [...isoLinks(links), ...sampled.map(kubotaEquipment)], {
        version: '1',
        snapshotTime,
      }),
    ),
  );
}

// ---- the fault series (kubota) --------------------------------------------------------------

function faultBag(ctx: { state: { vendors?: Record<string, Record<string, unknown>> } }): {
  faults: AempSimFault[];
} {
  ctx.state.vendors ??= {};
  ctx.state.vendors.aemp ??= {};
  const bag = ctx.state.vendors.aemp as { faults?: AempSimFault[] };
  bag.faults ??= [];
  return bag as { faults: AempSimFault[] };
}

function faultSeries(
  provider: ProviderId,
  id: string,
  start: string,
  end: string,
  page: number,
  ctx: VendorContext,
): SimResponse {
  const from = Date.parse(start);
  const to = Date.parse(end);
  if (Number.isNaN(from) || Number.isNaN(to) || from > to) {
    return aempError(400, 'startDate and endDate must be ISO 8601 date-times, start before end');
  }
  if (!machinesOf(ctx.world, provider).some((m) => m.telematics?.id === id)) {
    return aempError(404, `Unknown equipment ${id}`);
  }
  const base = PROVIDERS[provider].hrefBase;
  const items = faultBag(ctx).faults.filter((f) => {
    const t = Date.parse(f.datetime);
    // The window is inclusive at both ends (Trackunit's wording).
    return f.provider === provider && f.machineId === id && t >= from && t <= to;
  });
  const self = `${base}/Fleet/Equipment/ID/${encodeURIComponent(id)}/Faults/${start}/${end}/${page}`;
  return xml(
    200,
    isoXmlDocument(
      el('DiagnosticTroubleCode', [
        ...isoLinks([{ rel: 'self', href: self }]),
        ...(page === 1 ? items : []).map((f) =>
          el(
            'FaultCode',
            [
              el('CodeIdentifier', f.CodeIdentifier),
              ...(f.CodeDescription ? [el('CodeDescription', f.CodeDescription)] : []),
              ...(f.CodeSeverity ? [el('CodeSeverity', f.CodeSeverity)] : []),
            ],
            { datetime: f.datetime },
          ),
        ),
      ]),
    ),
  );
}

function faultsControl(req: SimRequest, ctx: VendorControlContext): SimResponse {
  const bag = faultBag(ctx);
  if (req.method === 'GET') return json(200, { faults: bag.faults });
  if (req.method !== 'POST') return json(405, { error: 'GET or POST' });
  let body: unknown;
  try {
    body = req.body ? JSON.parse(req.body) : {};
  } catch {
    return json(400, { error: 'body must be JSON' });
  }
  const r = aempSimFaultRequestSchema.safeParse(body);
  if (!r.success) return json(400, { error: firstIssue(r.error) });
  if (r.data.action === 'clear') {
    bag.faults = [];
    ctx.persist();
    return json(200, { faults: [] });
  }
  const { provider, machine } = r.data;
  const m = machinesOf(ctx.world, provider).find(
    (x) => x.unitNo === machine || x.telematics?.id === machine,
  );
  if (!m?.telematics) return json(404, { error: `no ${provider} machine '${machine}'` });
  bag.faults.push({
    provider,
    machineId: m.telematics.id,
    datetime: r.data.at ? new Date(r.data.at).toISOString() : ctx.now().toISOString(),
    CodeIdentifier: r.data.code,
    ...(r.data.description ? { CodeDescription: r.data.description } : {}),
    ...(r.data.severity ? { CodeSeverity: r.data.severity } : {}),
  });
  bag.faults = bag.faults.slice(-MAX_SIM_FAULTS);
  ctx.persist();
  return json(200, { faults: bag.faults });
}

const FAULTS_PATH = /^\/Fleet\/Equipment\/ID\/([^/]+)\/Faults\/([^/]+)\/([^/]+)\/(\d+)$/;

export const aempModule: VendorModule = {
  vendor: 'aemp',
  error: aempError,
  handle(req, ctx) {
    const [, provider = '', ...rest] = req.path.split('/');
    if (!isProvider(provider)) return aempError(404, `Not found: ${req.path} (no such provider)`);
    if (bearerToken(req.headers) !== SIM_CREDENTIALS.aemp.token) {
      return aempError(401, 'invalid token');
    }
    if (req.method !== 'GET') return aempError(405, 'Method not allowed');
    if (
      PROVIDERS[provider].format === 'json' &&
      preferredType(header(req.headers, 'accept')) === 'application/xml'
    ) {
      // Samsara's /beta/aemp answers 500 to Accept: application/xml (probed Oct 30, 2026).
      return {
        kind: 'reply',
        status: 500,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: '<GoaError><Message>internal error</Message></GoaError>',
      };
    }
    const path = `/${rest.join('/')}`;
    const fleet = /^\/Fleet\/(\d+)$/.exec(path);
    if (fleet) {
      const page = Number(fleet[1]);
      if (page < 1) return aempError(400, 'pageNumber starts at 1');
      return fleetPage(provider, page, ctx);
    }
    const faults = FAULTS_PATH.exec(path);
    if (faults && (AEMP_SIM_FAULT_PROVIDERS as readonly string[]).includes(provider)) {
      return faultSeries(
        provider,
        decodeURIComponent(faults[1] ?? ''),
        decodeURIComponent(faults[2] ?? ''),
        decodeURIComponent(faults[3] ?? ''),
        Number(faults[4]),
        ctx,
      );
    }
    return aempError(404, `Not found: ${req.path} (not simulated)`);
  },
  control(req, ctx) {
    if (req.path === '/faults') return faultsControl(req, ctx);
    return json(404, { error: `no AEMP control at ${req.path}` });
  },
};
