/**
 * Contract tests: the LIVE CNH FieldOps client against its stand-in (in-process, the real demo
 * world: C3 and T1 by VIN in SIM_CNH_COMPANY_ID). The OAuth round trip with audience and
 * connection on /authorize, the secret in the form body, the refresh with redirect_uri; the
 * subscription key on every call (APIM's 401 for a wrong one, with a clear message); a VIN without
 * the EULA skipped and listed once; a 429's Retry-After; companies, overview, boundaries,
 * equipment, metrics, the Fleet snapshot and the Locations / CautionCodes / Faults series.
 * No replay: CNH has no replay mode.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createSimWorld } from '../../sim/index';
import { SIM_CNH_COMPANY_ID, SIM_CREDENTIALS, simTelematicsMachines } from '../../sim/types';
import { startVendorSim, type VendorSim } from '../../sim/vendors/server';
import { type ConnectorConfig, ConnectorModeError, cnhEndpoints } from '../endpoints';
import { VendorHttpError } from '../http';
import { MemoryTokenStore } from '../oauth/memory-store';
import { CnhClient, CnhEulaError, CnhNotConnectedError, CnhSubscriptionKeyError } from './client';
import { cnhBoundaryGeometry, mapCnhFault, mapCnhFleet, mapCnhPosition } from './mapper';
import {
  cnhAuthorizeUrl,
  cnhSimAutoConnect,
  exchangeCnhCode,
  newCnhState,
  refreshCnhTokens,
  revokeCnhToken,
} from './oauth';
import {
  type CnhPositionsCursor,
  parseCnhCursor,
  pollCnhFaults,
  pollCnhFleet,
  pollCnhPositions,
} from './sync';

const NOW = Date.parse('2026-11-30T15:07:12.000Z');
let wall = NOW;
let sim: VendorSim;
let cfg: ConnectorConfig;
const http = { now: () => new Date(wall), sleep: async () => {}, timeoutMs: 5000 };
const clock = { now: () => new Date(wall) };

beforeAll(async () => {
  sim = await startVendorSim({ createWorld: createSimWorld, port: 0, now: () => new Date(wall) });
  cfg = { VENDOR_SIM_URL: sim.url, PUBLIC_URL: 'http://localhost:3116' };
});
afterAll(() => sim.close());
beforeEach(() => {
  wall = NOW;
  sim.control.reset({ scenario: 'harvest-day' });
});

const ep = () => cnhEndpoints('sim', cfg);
const client = (store = new MemoryTokenStore('cnh', null, { now: () => new Date(wall) })) =>
  new CnhClient({ endpoints: ep(), tokens: store, http });
const knob = (path: string, body: unknown) =>
  fetch(`${sim.url}/_control/vendor/cnh${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const machines = () => simTelematicsMachines(sim.world.farm, 'cnh');
const vin = (unit: string) => machines().find((m) => m.unitNo === unit)?.telematics?.id as string;

describe('CNH OAuth (sim)', () => {
  test('/authorize refuses a request without audience or connection', async () => {
    const u = new URL(cnhAuthorizeUrl(ep(), 'st'));
    u.searchParams.delete('audience');
    expect((await fetch(u)).status).toBe(400);
    const w = new URL(cnhAuthorizeUrl(ep(), 'st'));
    w.searchParams.set('connection', 'PROD-ADFS-CONN');
    expect((await fetch(w)).status).toBe(400);
    const ok = await fetch(cnhAuthorizeUrl(ep(), 'st'));
    expect(ok.status).toBe(200); // the consent page
    expect(await ok.text()).toMatch(/Sign in to FieldOps \(simulated\)/);
  });

  test('the round trip: consent → code → tokens (secret in the body) → API calls → refresh', async () => {
    const state = newCnhState();
    const form = new URLSearchParams(new URL(cnhAuthorizeUrl(ep(), state)).searchParams);
    form.set('decision', 'allow');
    const consent = await fetch(`${sim.url}/cnh/identity/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      redirect: 'manual',
    });
    expect(consent.status).toBe(302);
    const back = new URL(consent.headers.get('location') as string);
    expect(back.origin + back.pathname).toBe('http://localhost:3116/api/oauth/cnh');
    expect(back.searchParams.get('state')).toBe(state);
    const tokens = await exchangeCnhCode(ep(), back.searchParams.get('code') as string, http);
    const store = new MemoryTokenStore('cnh', tokens, { now: () => new Date(wall) });
    const c = client(store);
    expect(await c.companies()).toEqual([
      { id: SIM_CNH_COMPANY_ID, name: 'Demo farm (simulated)' },
    ]);
    // Past the access token's lifetime: refreshed (with redirect_uri) and rotated.
    wall += 3600_000;
    expect((await c.userProfile()).companyId).toBe(SIM_CNH_COMPANY_ID);
    expect(store.refreshes).toBe(1);
    expect(store.tokens?.refreshToken).not.toBe(tokens.refreshToken);
    expect(sim.counters.tokenGrants).toMatchObject({ authorization_code: 1, refresh_token: 1 });
  });

  test('the token endpoint wants the secret in the form body and redirect_uri on refresh', async () => {
    const basic = await fetch(`${sim.url}/cnh/identity/oauth/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${SIM_CREDENTIALS.cnh.clientId}:${SIM_CREDENTIALS.cnh.clientSecret}`).toString('base64')}`,
      },
      body: 'grant_type=refresh_token&refresh_token=x',
    });
    expect(basic.status).toBe(401);
    const noRedirect = await fetch(`${sim.url}/cnh/identity/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: SIM_CREDENTIALS.cnh.clientId,
        client_secret: SIM_CREDENTIALS.cnh.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: 'x',
      }).toString(),
    });
    expect(noRedirect.status).toBe(400);
    expect(((await noRedirect.json()) as { error_description: string }).error_description).toMatch(
      /redirect_uri/,
    );
  });

  test('revoke (JSON body): the refresh token stops working', async () => {
    const store = new MemoryTokenStore('cnh');
    await cnhSimAutoConnect(ep(), store, http);
    const rt = store.tokens?.refreshToken as string;
    await revokeCnhToken(ep(), rt, http);
    await expect(refreshCnhTokens(ep(), rt, http)).rejects.toMatchObject({
      oauthError: 'invalid_grant',
    });
  });

  test('sim connects unattended; sandbox/live without a grant ask a person to sign in', async () => {
    const store = new MemoryTokenStore('cnh');
    await cnhSimAutoConnect(ep(), store, http);
    expect(store.tokens?.accessToken).toBeTruthy();
    expect((await client().equipment()).items).toHaveLength(2); // auto-connects on first call
    const staging = cnhEndpoints('sandbox', {
      ...cfg,
      CNH_CLIENT_ID: 'c',
      CNH_CLIENT_SECRET: 's',
      CNH_SUBSCRIPTION_KEY: 'k',
    });
    const real = new CnhClient({ endpoints: staging, tokens: new MemoryTokenStore('cnh'), http });
    await expect(real.companies()).rejects.toBeInstanceOf(CnhNotConnectedError);
    await expect(real.companies()).rejects.toThrow(/sign in at \/api\/oauth\/cnh/);
    expect(() => cnhEndpoints('replay', cfg)).toThrow(ConnectorModeError);
  });
});

describe('CNH API calls (sim)', () => {
  test('companies, overview, field boundaries and one boundary with its geometry', async () => {
    const c = client();
    const overview = await c.overview(SIM_CNH_COMPANY_ID);
    const field = overview.growers[0]?.farms[0]?.fields[0];
    expect(field?.name).toBe(sim.world.farm.fields[0]?.name);
    const list = await c.fieldBoundaries(SIM_CNH_COMPANY_ID, field?.id as string);
    expect(list.boundaries[0]).toMatchObject({ boundaryType: 'OUTER' });
    const b = await c.boundary(SIM_CNH_COMPANY_ID, list.boundaries[0]?.id as string);
    expect(cnhBoundaryGeometry(b)?.coordinates[0]).toEqual(
      sim.world.farm.fields[0]?.boundary.coordinates[0],
    );
  });

  test('equipment by VIN (and its modem subscription), metrics with a cursor', async () => {
    const c = client();
    const { items } = await c.equipment();
    expect(items.map((e) => e.nickName).sort()).toEqual(['C3', 'T1']);
    expect(items.every((e) => e.companyId === SIM_CNH_COMPANY_ID)).toBe(true);
    const detail = await c.equipmentDetail(vin('C3'));
    expect(detail.devices?.[0]?.subscription?.[0]?.name).toBe('AFS Connect');
    const page = await c.metrics(vin('C3'), NOW - 10 * 60_000, NOW, { limit: 4 });
    expect(page.items).toHaveLength(4);
    const next = page.links.find((l) => l.rel === 'next')?.href as string;
    const cursor = new URL(next).searchParams.get('cursor') as string;
    const page2 = await c.metrics(vin('C3'), NOW - 10 * 60_000, NOW, { limit: 4, cursor });
    expect(page2.items[0]?.systemDatetime).not.toBe(page.items[0]?.systemDatetime);
  });

  test('every call carries the subscription key: a wrong one is APIM 401 with a clear message', async () => {
    const res = await fetch(`${sim.url}/cnh/v1/equipment`, {
      headers: { authorization: 'Bearer x' },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/AzureApiManagementKey/);
    expect((await knob('/settings', { wrongKey: true })).status).toBe(200);
    const c = client();
    await expect(c.equipment()).rejects.toBeInstanceOf(CnhSubscriptionKeyError);
    await expect(c.equipment()).rejects.toThrow(/CNH_SUBSCRIPTION_KEY.*sim environment/);
  });

  test('a 429 with an integer Retry-After is honoured (a long one becomes the next run)', async () => {
    sim.control.faults({
      action: 'add',
      rule: {
        vendor: 'cnh',
        pathPrefix: '/v1/equipment',
        kind: 'rate_limit',
        retryAfterSeconds: 30,
      },
    });
    const err = await client()
      .equipment()
      .catch((e) => e);
    expect(err).toBeInstanceOf(VendorHttpError);
    expect(err).toMatchObject({ status: 429, retryAfterSeconds: 30 });
    sim.control.faults({ action: 'clear' });
  });
});

describe('CNH polls (sim)', () => {
  test('positions: the Locations trail of both VINs as live fixes; then only what is new', async () => {
    const c = client();
    const first = await pollCnhPositions(c, null, clock);
    const vins = new Set(first.items.map((i) => i.payload.vin));
    expect(vins).toEqual(new Set([vin('C3'), vin('T1')]));
    // 15 minutes of a 5 s grid per VIN (two pages each)
    expect(first.items.filter((i) => i.payload.vin === vin('C3')).length).toBe(180);
    const fix = mapCnhPosition(JSON.parse(JSON.stringify(first.items.at(-1)?.payload)))[0];
    expect(fix).toMatchObject({
      source: 'cnh',
      sourceOrg: SIM_CNH_COMPANY_ID,
      positionSource: 'eld',
    });
    expect(fix?.positionKind).toBeUndefined();
    wall += 30_000;
    const next = await pollCnhPositions(c, first.cursor, clock);
    // The last fix again (deduped by raw_events) and the six new ones.
    expect(next.items.filter((i) => i.payload.vin === vin('C3')).length).toBe(7);
  });

  test('a VIN without the EULA is skipped and listed once; its machine info still answers', async () => {
    expect((await knob('/settings', { eulaMissing: ['T1'] })).status).toBe(200);
    const c = client();
    await expect(c.locations(vin('T1'), NOW - 60_000, NOW)).rejects.toBeInstanceOf(CnhEulaError);
    expect((await c.equipment()).items).toHaveLength(2);
    const r = await pollCnhPositions(c, null, clock);
    expect(new Set(r.items.map((i) => i.payload.vin))).toEqual(new Set([vin('C3')]));
    expect(r.newlyNeedsEula).toEqual([vin('T1')]);
    const cur = parseCnhCursor<CnhPositionsCursor>(r.cursor);
    expect(cur.needsEula?.[vin('T1')]?.reason).toMatch(/EULA not accepted for the VIN/);
    wall += 30_000;
    const again = await pollCnhPositions(c, r.cursor, clock);
    expect(again.newlyNeedsEula).toEqual([]); // listed once, not retried for an hour
    // The Fleet page leaves it out.
    const fleet = await pollCnhFleet(c, null, clock);
    expect(fleet.items.map((i) => i.payload.vin)).toEqual([vin('C3')]);
  });

  test('fleet: stats and a last-known Location per VIN, at most hourly', async () => {
    const c = client();
    const r = await pollCnhFleet(c, null, clock);
    expect(r.items).toHaveLength(2);
    const items = mapCnhFleet(JSON.parse(JSON.stringify(r.items[0]?.payload)));
    expect(items.find((i) => i.kind === 'position')).toMatchObject({
      position: { positionKind: 'last_known', source: 'cnh', ts: '2026-11-30T15:00:00.000Z' },
    });
    const stat = items.find((i) => i.kind === 'stat');
    expect(stat?.kind === 'stat' && Object.keys(stat.stat.readings ?? {}).sort()).toEqual([
      'defPct',
      'engineHours',
      'engineOn',
      'fuelPct',
      'odometerMi',
    ]);
    wall += 30 * 60_000;
    const calls = sim.counters.requests.cnh ?? 0;
    expect((await pollCnhFleet(c, r.cursor, clock)).items).toEqual([]);
    expect(sim.counters.requests.cnh ?? 0).toBe(calls); // not due: no call at all
  });

  test('locationsEmpty: no trail for that VIN (the snapshot still has its Location)', async () => {
    expect((await knob('/settings', { locationsEmpty: ['C3'] })).status).toBe(200);
    const c = client();
    const r = await pollCnhPositions(c, null, clock);
    expect(new Set(r.items.map((i) => i.payload.vin))).toEqual(new Set([vin('T1')]));
    const fleet = await pollCnhFleet(c, null, clock);
    expect(fleet.items.map((i) => i.payload.vin).sort()).toEqual([vin('C3'), vin('T1')].sort());
  });

  test('faults: caution codes (open, then closed) and fault occurrences, as delta faults', async () => {
    expect(
      (
        await knob('/codes', {
          action: 'caution',
          machine: 'C3',
          code: '5021',
          description: 'Low coolant',
          severity: 'Amber',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await knob('/codes', {
          action: 'fault',
          machine: 'C3',
          code: 'SPN 110 FMI 16',
          severity: 'High',
        })
      ).status,
    ).toBe(200);
    wall += 60_000;
    const c = client();
    const r = await pollCnhFaults(c, null, clock);
    const stats = r.items.flatMap((i) => mapCnhFault(JSON.parse(JSON.stringify(i.payload))));
    expect(stats.map((s) => s.faultCodes?.[0]?.code).sort()).toEqual([
      'J1939 SPN 110 FMI 16',
      'OEM caution 5021',
    ]);
    expect(stats.find((s) => s.faultCodes?.[0]?.system === 'oem')?.faultCodes?.[0]).toMatchObject({
      state: 'open',
      severity: 'warning',
    });
    // The caution clears: CNH reports Active false; the next window has only that.
    expect(
      (await knob('/codes', { action: 'caution', machine: 'C3', code: '5021', active: false }))
        .status,
    ).toBe(200);
    wall += 5 * 60_000;
    const later = await pollCnhFaults(c, r.cursor, clock);
    const cleared = later.items.flatMap((i) => mapCnhFault(JSON.parse(JSON.stringify(i.payload))));
    expect(cleared.map((s) => s.faultCodes?.[0]?.state)).toEqual(['closed']);
  });
});
