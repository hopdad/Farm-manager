/**
 * Contract tests in REPLAY mode (contracts-m1 §10; plan 1a done-when "CONNECTOR_DEERE=replay
 * runs on the doc-derived fixtures"): the live Deere client (`DeereClient.forReplay`, no OAuth)
 * reads organizations, machines (paged), breadcrumbs, fields (paged), boundaries, field
 * operations with their measurements and coverage, and flags; everything validated by the same
 * schemas as live responses and time-shifted to the moment of the call.
 */
import { describe, expect, test } from 'vitest';
import { buildDemoFarm } from '../../sim/farm/build';
import { simExternalRefs } from '../../sim/types';
import { simDeereOrgs } from '../../sim/vendors/deere/routes';
import type { ConnectorConfig } from '../endpoints';
import { VendorHttpError } from '../http';
import { REPLAY_ORIGIN } from '../replay';
import { DeereClient } from './client';
import { LOCATIONS_ANCHOR, LOCATIONS_PERIOD_SECONDS, OPERATIONS_ANCHOR } from './fixtures/build';
import {
  areaAcres,
  deereBoundaryToMultiPolygon,
  deereFlagGeometry,
  deereLinkId,
  mapDeereBreadcrumb,
} from './mapper';

const cfg: ConnectorConfig = {
  VENDOR_SIM_URL: 'http://127.0.0.1:1',
  PUBLIC_URL: 'http://localhost:3104',
};
const farm = buildDemoFarm();
const refs = simExternalRefs(farm, 'samsara');
const mapped = (kind: string, org: string, id: string) =>
  refs.find((r) => r.ref.kind === kind && r.ref.sourceOrg === org && r.ref.externalId === id)
    ?.entityId ?? null;
const inDemoArea = (lng: number, lat: number) =>
  lng > -84.5 && lng < -83.3 && lat > 41.6 && lat < 42.2;

const PERIOD_MS = LOCATIONS_PERIOD_SECONDS * 1000;
/** A wall time `offsetMs` into some later replay period. */
const inPeriod = (offsetMs: number) =>
  new Date(Date.parse(LOCATIONS_ANCHOR) + 1000 * PERIOD_MS + offsetMs);

function client(at: () => Date) {
  return DeereClient.forReplay(cfg, { now: at, timeoutMs: 2_000 });
}

describe('Deere in replay mode: machine locations', () => {
  test('no OAuth, the replay origin, every org and every machine (following nextPage)', async () => {
    const c = client(() => inPeriod(0));
    expect(c.endpoints.apiBase).toBe(`${REPLAY_ORIGIN}/deere/platform`);
    const orgs = await c.organizations();
    expect(orgs.map((o) => o.id)).toEqual(simDeereOrgs(farm).map((o) => o.id));
    expect(orgs.map((o) => o.id)).toContain('org-home');
    const machines = await c.machines('org-home');
    expect(machines).toHaveLength(6); // 4 + 2 across two pages
    for (const m of machines) expect(mapped('machine', 'org-home', m.id)).not.toBeNull();
    expect(await c.machines('org-customer-1')).toEqual([]);
  });

  test('a first poll sees the last 10 minutes of working breadcrumbs, none in the future', async () => {
    const now = inPeriod(12 * 60_000);
    const r = await client(() => now).pollLocations(null);
    const positions = r.items.flatMap((i) => mapDeereBreadcrumb(i.payload));
    expect(positions.length).toBeGreaterThan(20);
    for (const p of positions) {
      const t = Date.parse(p.ts);
      expect(t).toBeLessThanOrEqual(now.getTime());
      expect(t).toBeGreaterThan(now.getTime() - 10 * 60_000);
      expect(p.positionSource).toBe('deere_working');
      expect(p.speedMph).toBeGreaterThanOrEqual(0);
      expect(p.heading).not.toBeNull();
      expect(inDemoArea(p.lng, p.lat)).toBe(true);
      expect(mapped('machine', p.sourceOrg, p.externalMachineId)).not.toBeNull();
    }
    expect(new Set(positions.map((p) => p.externalMachineId)).size).toBeGreaterThanOrEqual(2);
    expect(r.cursor).toBe(now.toISOString());
  });

  test('later polls get only what happened since: the combines advance in real time', async () => {
    let t = inPeriod(5 * 60_000).getTime();
    const c = client(() => new Date(t));
    let r = await c.pollLocations(null);
    const last = (items: typeof r.items, id: string) =>
      items.filter((i) => i.payload.machineId === id).at(-1)?.payload.breadcrumb;
    const c1 = '8348986';
    const first = last(r.items, c1);
    t += 2 * 60_000;
    r = await c.pollLocations(r.cursor);
    const ts = r.items.map((i) => Date.parse(i.payload.breadcrumb.eventTimestamp));
    expect(ts.every((x) => x > t - 2 * 60_000 && x <= t)).toBe(true);
    const later = last(r.items, c1);
    expect(later).toBeDefined();
    expect([later?.point.lat, later?.point.lon]).not.toEqual([first?.point.lat, first?.point.lon]);
  });

  test('a new period starts the pass over; replays inside one period are identical', async () => {
    const end = inPeriod(PERIOD_MS - 1_000);
    const c = client(() => end);
    const tail = await c.pollLocations(null);
    const next = inPeriod(PERIOD_MS + 60_000);
    const r = await client(() => next).pollLocations(end.toISOString());
    for (const i of r.items) {
      const t = Date.parse(i.payload.breadcrumb.eventTimestamp);
      expect(t).toBeGreaterThan(end.getTime());
      expect(t).toBeLessThanOrEqual(next.getTime());
    }
    expect(tail.items.length).toBeGreaterThan(0);
    const a = await client(() => inPeriod(60_000)).breadcrumbs('8348986', new Date(0), new Date());
    const b = await client(() => inPeriod(25 * 60_000)).breadcrumbs(
      '8348986',
      new Date(0),
      new Date(),
    );
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('Deere in replay mode: fields, boundaries, operations, flags', () => {
  const now = new Date('2026-11-30T15:00:00.000Z');
  const c = client(() => now);

  test('fields of each org (following nextPage) map onto the demo fields', async () => {
    const home = await c.fields('org-home');
    expect(home.length).toBeGreaterThan(25);
    for (const f of home) expect(mapped('field', 'org-home', f.id)).not.toBeNull();
    const shared = await c.fields('org-customer-1');
    for (const f of shared) expect(mapped('field', 'org-customer-1', f.id)).not.toBeNull();
    expect(home.length + shared.length).toBeGreaterThanOrEqual(farm.fields.length);
  });

  test('org boundaries are the demo boundaries, as GeoJSON, with their field links', async () => {
    const boundaries = await c.orgBoundaries('org-home');
    for (const b of boundaries) {
      const fieldId = deereLinkId(b.links, 'field') as string;
      const entity = mapped('field', 'org-home', fieldId);
      const field = farm.fields.find((f) => f.id === entity);
      expect(field).toBeDefined();
      expect(mapped('boundary', 'org-home', b.id as string)).toBe(field?.boundaryId);
      const mp = deereBoundaryToMultiPolygon(b);
      expect(mp.coordinates[0]?.[0]?.length).toBe(field?.boundary.coordinates[0]?.[0]?.length);
      const acres = areaAcres({ value: b.area?.valueAsDouble ?? 0, unit: b.area?.unit ?? '' });
      expect(acres).toBeCloseTo(field?.acres ?? 0, -1);
    }
    const one = farm.fields[0];
    const single = await c.fieldBoundaries('org-home', one?.deereFieldId as string);
    expect(single.map((b) => b.id)).toEqual([one?.deereBoundaryId]);
  });

  test('operations with measurements and coverage, time-shifted by whole minutes', async () => {
    const harvested = farm.fields.filter((f) => f.name === 'Hollinger North 160');
    expect(harvested).toHaveLength(1);
    const field = harvested[0];
    const ops = await c.fieldOperations('org-home', field?.deereFieldId as string);
    expect(ops.map((o) => o.fieldOperationType).sort()).toEqual(['harvest', 'seeding']);
    const shift = now.getTime() - Date.parse(OPERATIONS_ANCHOR);
    const harvest = ops.find((o) => o.fieldOperationType === 'harvest');
    expect(harvest?.cropSeason).toBe('2026');
    expect(Date.parse(harvest?.endDate as string)).toBeLessThanOrEqual(now.getTime());
    expect(
      (Date.parse(harvest?.startDate as string) - Date.parse('2026-10-15T11:10:52.875Z')) % 60_000,
    ).toBe(0);
    expect(shift % 60_000).toBe(0);
    expect(harvest?.fieldOperationMachines?.map((m) => String(m.machineId))).toContain('8348986');

    const measurements = await c.fieldOperationMeasurements(harvest?.id as string);
    const yieldResult = measurements.find((m) => m.measurementName === 'HarvestYieldResult');
    expect(yieldResult?.area?.unitId).toBe('ac');
    expect(yieldResult?.averageYield?.value).toBeGreaterThan(100);

    const coverage = await c.fieldOperationCoverage(harvest?.id as string);
    const cov = deereBoundaryToMultiPolygon(coverage).coordinates[0]?.[0] ?? [];
    const fieldRing = field?.boundary.coordinates[0]?.[0] ?? [];
    const xs = fieldRing.map((p) => p[0] as number);
    const ys = fieldRing.map((p) => p[1] as number);
    for (const [x, y] of cov as [number, number][]) {
      expect(x).toBeGreaterThanOrEqual(Math.min(...xs) - 1e-6);
      expect(x).toBeLessThanOrEqual(Math.max(...xs) + 1e-6);
      expect(y).toBeGreaterThanOrEqual(Math.min(...ys) - 1e-6);
      expect(y).toBeLessThanOrEqual(Math.max(...ys) + 1e-6);
    }
  });

  test('flags: GeoJSON from the geometry string, inside the field they link to', async () => {
    const flags = await c.flags('org-home');
    expect(flags.length).toBe(4);
    expect(new Set(flags.map((f) => deereFlagGeometry(f).type))).toEqual(
      new Set(['Point', 'Polygon', 'LineString']),
    );
    for (const f of flags) {
      const entity = mapped('field', 'org-home', deereLinkId(f.links, 'field') as string);
      expect(farm.fields.some((x) => x.id === entity)).toBe(true);
    }
    const first = flags[0];
    const fieldFlags = await c.fieldFlags('org-home', deereLinkId(first?.links, 'field') as string);
    expect(fieldFlags.map((f) => f.id)).toEqual([first?.id]);
    expect(await c.flags('org-customer-1')).toEqual([]);
  });

  test('a request no fixture answers is a 404 from the transport, as a vendor error', async () => {
    await expect(c.fields('org-nobody')).rejects.toBeInstanceOf(VendorHttpError);
    await expect(c.fields('org-nobody')).rejects.toMatchObject({ status: 404 });
  });
});
