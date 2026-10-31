/**
 * Deere stand-in route module `fields` (slice 1f, docs/contracts-1f.md §7.1; owner: deere-data):
 * the Operations Center data the deere.fields sync reads, computed from the simulated farm with
 * the ids of the demo seed's external refs (./fields-world.ts), so sim mode matches the seeded
 * fields, farms and machines instead of duplicating them:
 *
 *   GET /organizations/{org}/farms?recordFilter=        the org's Deere farms
 *   GET /organizations/{org}/clients?recordFilter=      the org's Deere clients
 *   GET /organizations/{org}/fields?recordFilter=&embed=farms,clients
 *                                                       the org's fields (shadows the core's
 *                                                       minimal listing, same ids), plus the one
 *                                                       Deere-only field in the home org
 *   GET /organizations/{org}/fields/{f}                 one field
 *   GET /organizations/{org}/boundaries?recordFilter=   each listed field's active boundary
 *   GET /organizations/{org}/fields/{f}/boundaries
 *   GET /organizations/{org}/flags?recordFilter=&embed=flagCategory
 *   GET /organizations/{org}/fields/{f}/flags           ../../farm/flags.ts; archived flags only
 *                                                       with recordFilter=all|archived (as Deere)
 *   GET /machines/{principalId}/engineHours?lastKnown=&startDate=&endDate=
 *                                                       readings on a 15-minute wall-clock grid
 *                                                       from the world's engine-hour counters
 * Org links: fields, farms, boundaries, flags. Equipment is the core's Equipment API listing,
 * never shadowed. An org the world doesn't have answers 403, like Deere's "Access Denied".
 */
import { simFlags } from '../../farm/flags';
import type { SimFarm } from '../../types';
import type { VendorContext } from '../context';
import { json, type SimResponse } from '../http';
import {
  deereBoundaryJson,
  deereClientJson,
  deereEngineHoursJson,
  deereFarmJson,
  deereFieldJson,
  deereFlagJson,
  type SimDeereFieldRecord,
  simDeereFieldRecords,
  simOrgClients,
  simOrgFarms,
} from './fields-world';
import type { DeerePlatformRequest, DeereRouteModule } from './modules';
import { apiError, collection, pagedReply, paging, simDeereOrgs } from './platform';

/** Engine hours are reported on this wall-clock grid (a JDLink modem's periodic report). */
export const ENGINE_HOURS_GRID_MS = 15 * 60_000;
/** Most readings one engineHours window returns. */
const MAX_HOUR_READINGS = 500;

interface WorldData {
  records: SimDeereFieldRecord[];
  flags: ReturnType<typeof simFlags>;
}

/** Per-farm memo: the records and flags are pure functions of the farm (and the seed). */
const memo = new WeakMap<SimFarm, Map<number, WorldData>>();

function worldData(ctx: VendorContext): WorldData {
  const farm = ctx.world.farm;
  let bySeed = memo.get(farm);
  if (!bySeed) {
    bySeed = new Map();
    memo.set(farm, bySeed);
  }
  let d = bySeed.get(ctx.world.seed);
  if (!d) {
    d = { records: simDeereFieldRecords(farm), flags: simFlags(farm, ctx.world.seed) };
    bySeed.set(ctx.world.seed, d);
  }
  return d;
}

type RecordFilter = 'active' | 'archived' | 'all';

/** recordFilter as each API spells it (AVAILABLE, ACTIVE, active, ALL, all, …): what it keeps. */
function recordFilterOf(r: DeerePlatformRequest): RecordFilter {
  const v = (r.req.url.searchParams.get('recordFilter') ?? '').toLowerCase();
  if (v === 'all') return 'all';
  if (v === 'archived') return 'archived';
  return 'active';
}

const embedsOf = (r: DeerePlatformRequest) =>
  new Set(
    (r.req.url.searchParams.get('embed') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

/** Whether a record with this archived state passes the filter. */
const passes = (archived: boolean, f: RecordFilter) =>
  f === 'all' || (f === 'archived') === archived;

function engineHours(r: DeerePlatformRequest, principalId: string): SimResponse {
  const machine = r.ctx.world.farm.machines.find((m) => m.vendorIds.deere === principalId);
  if (!machine) return apiError(404, `Machine ${principalId} not found`);
  const pg = paging(r.req.url, 10);
  if ('kind' in pg) return pg;
  const q = r.req.url.searchParams;
  const nowMs = r.ctx.now().getTime();
  const last = Math.floor(nowMs / ENGINE_HOURS_GRID_MS) * ENGINE_HOURS_GRID_MS;
  let times: number[];
  if (q.get('lastKnown') === 'true') times = [last];
  else {
    const endQ = q.get('endDate');
    const startQ = q.get('startDate');
    const end = Math.min(endQ ? Date.parse(endQ) : nowMs, nowMs);
    const start = startQ ? Date.parse(startQ) : end - 86_400_000;
    if (Number.isNaN(start) || Number.isNaN(end)) return apiError(400, 'dates must be ISO 8601');
    times = [];
    const first = Math.ceil(start / ENGINE_HOURS_GRID_MS) * ENGINE_HOURS_GRID_MS;
    for (let t = first; t <= end && times.length < MAX_HOUR_READINGS; t += ENGINE_HOURS_GRID_MS) {
      times.push(t);
    }
    times.reverse();
  }
  const values = times.flatMap((t) => {
    const s = r.ctx.world.machineAt(machine.id, r.ctx.simAt(new Date(t)));
    if (!s) return [];
    return [deereEngineHoursJson(r.base, principalId, s.engineHours, new Date(t).toISOString())];
  });
  return json(200, collection(r.req.url, values, pg.offset, pg.limit));
}

const ORG_COLLECTIONS = new Set(['farms', 'clients', 'fields', 'boundaries', 'flags']);

function orgRoute(r: DeerePlatformRequest, orgId: string, rest: string[]): SimResponse | null {
  const { req, base } = r;
  const [what, fieldId, sub] = rest;
  if (!ORG_COLLECTIONS.has(what as string)) return null;
  if (!simDeereOrgs(r.ctx.world.farm).some((o) => o.id === orgId)) {
    return apiError(403, `No access to organization ${orgId}`);
  }
  const { records, flags } = worldData(r.ctx);
  const mine = records.filter((x) => x.orgId === orgId);
  const filter = recordFilterOf(r);
  // The stand-in's fields, boundaries, farms and clients are all available (not archived).
  const available = passes(false, filter);
  const fieldRec = (id: string | undefined) => mine.find((x) => x.deereFieldId === id);
  const withRefs = () => {
    const e = embedsOf(r);
    return e.has('farms') || e.has('clients');
  };
  const flagsWhere = (pred: (f: WorldData['flags'][number]) => boolean) => {
    const embed = embedsOf(r).has('flagCategory');
    const all = flags.filter((f) => f.orgId === orgId && pred(f) && passes(f.archived, filter));
    return pagedReply(
      req,
      all.map((f) => deereFlagJson(base, f, embed)),
    );
  };

  if (rest.length === 1) {
    switch (what) {
      case 'farms':
        return pagedReply(
          req,
          available ? simOrgFarms(records, orgId).map((x) => deereFarmJson(base, orgId, x)) : [],
        );
      case 'clients':
        return pagedReply(
          req,
          available
            ? simOrgClients(records, orgId).map((c) => deereClientJson(base, orgId, c))
            : [],
        );
      case 'fields': {
        const embed = withRefs();
        return pagedReply(req, available ? mine.map((x) => deereFieldJson(base, x, embed)) : []);
      }
      case 'boundaries':
        return pagedReply(req, available ? mine.map((x) => deereBoundaryJson(base, x)) : []);
      case 'flags':
        return flagsWhere(() => true);
    }
  }
  if (what !== 'fields') return null;
  const rec = fieldRec(fieldId);
  if (rest.length === 2) {
    return rec
      ? json(200, deereFieldJson(base, rec, withRefs()))
      : apiError(404, `Field ${fieldId} not found`);
  }
  if (rest.length === 3 && (sub === 'boundaries' || sub === 'flags')) {
    if (!rec) return apiError(404, `Field ${fieldId} not found`);
    if (sub === 'boundaries') {
      return pagedReply(req, available ? [deereBoundaryJson(base, rec)] : []);
    }
    return flagsWhere((f) => f.deereFieldId === fieldId);
  }
  return null;
}

export const deereFieldsRoutes: DeereRouteModule = {
  key: 'fields',
  route: (r) => {
    if (r.api !== 'platform') return null;
    const [head, id, ...rest] = r.parts;
    if (head === 'organizations' && id && rest.length > 0) return orgRoute(r, id, rest);
    if (head === 'machines' && id && rest.length === 1 && rest[0] === 'engineHours') {
      return engineHours(r, id);
    }
    return null;
  },
  orgLinks: (org, { base }) => {
    const p = `${base}/organizations/${encodeURIComponent(org.id)}`;
    return [
      { rel: 'fields', uri: `${p}/fields` },
      { rel: 'farms', uri: `${p}/farms` },
      { rel: 'boundaries', uri: `${p}/boundaries` },
      { rel: 'flags', uri: `${p}/flags` },
    ];
  },
};
