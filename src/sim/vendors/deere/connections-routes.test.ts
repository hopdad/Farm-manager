/**
 * The Deere stand-in's `connections` module (1f decision 5, docs/contracts-1f.md §7.1) on the
 * demo world (several orgs), through the live client: the knob refuses an org the way Deere
 * does (needs approval: a `connections` link and 403 "Access Denied"; terms: 403 with
 * X-Deere-Terms-Location; scope: 403 naming the missing access), on /platform paths and on the
 * Equipment API alike, and the locations poll skips that org while the others keep flowing.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { DeereClient } from '../../../connectors/deere/client';
import { orgStatusView } from '../../../connectors/deere/connections';
import { deereDenialOf } from '../../../connectors/deere/orgs';
import { deereOrganizationsSchema } from '../../../connectors/deere/schemas';
import { type ConnectorConfig, deereEndpoints } from '../../../connectors/endpoints';
import { VendorHttpError } from '../../../connectors/http';
import { MemoryTokenStore } from '../../../connectors/oauth/memory-store';
import { createSimWorld } from '../../index';
import { SIM_CREDENTIALS, SIM_DEERE_HOME_ORG } from '../../types';
import { startVendorSim, type VendorSim } from '../server';
import {
  DEERE_SIM_CONNECTIONS_CONTROL_PATH,
  type DeereSimConnectionsStatus,
} from './connections-control-types';
import { deereConnectionsUrl } from './connections-routes';

let sim: VendorSim;
let client: DeereClient;
let orgIds: string[] = [];

const knob = async (body?: unknown) => {
  const res = await fetch(`${sim.url}${DEERE_SIM_CONNECTIONS_CONTROL_PATH}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as DeereSimConnectionsStatus };
};

const links = async (orgId: string) =>
  (await client.getOne(deereOrganizationsSchema, client.apiUrl('organizations'))).values
    .find((o) => o.id === orgId)
    ?.links?.map((l) => l.rel);

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('expected a 403');
    },
    (e: unknown) => {
      expect(e).toBeInstanceOf(VendorHttpError);
      return e as VendorHttpError;
    },
  );

beforeAll(async () => {
  sim = await startVendorSim({ createWorld: createSimWorld, port: 0 });
  const cfg: ConnectorConfig = { VENDOR_SIM_URL: sim.url, PUBLIC_URL: 'http://localhost:3114' };
  client = new DeereClient({
    endpoints: deereEndpoints('sim', cfg),
    tokens: new MemoryTokenStore('deere', null),
    http: { timeoutMs: 5_000, maxRetries: 0 },
  });
  orgIds = (await knob()).body.orgs.map((o) => o.id);
}, 60_000);
afterAll(() => sim?.close());

describe('the connections knob', () => {
  test('every simulated org starts connected; bad requests are refused', async () => {
    const { status, body } = await knob();
    expect(status).toBe(200);
    expect(body.orgs.length).toBeGreaterThanOrEqual(2);
    expect(body.orgs.map((o) => o.id)).toContain(SIM_DEERE_HOME_ORG);
    expect(body.orgs.every((o) => o.state === 'connected')).toBe(true);
    expect((await knob({ orgId: SIM_DEERE_HOME_ORG, state: 'nope' })).status).toBe(400);
    expect((await knob({ orgId: 'org-unknown', state: 'terms' })).status).toBe(404);
  });

  test('needs approval: a connections link, 403 on the platform and the Equipment API', async () => {
    const other = orgIds.find((id) => id !== SIM_DEERE_HOME_ORG) as string;
    expect(await links(other)).toContain('manage_connections');
    const set = await knob({ orgId: other, state: 'needs_approval' });
    expect(set.body.orgs.find((o) => o.id === other)?.state).toBe('needs_approval');

    const rels = await links(other);
    expect(rels).toContain('connections');
    expect(rels).not.toContain('manage_connections');
    const listed = (await client.organizations()).find((o) => o.id === other);
    expect(listed?.links?.find((l) => l.rel === 'connections')?.uri).toBe(
      deereConnectionsUrl(SIM_CREDENTIALS.deere.clientId),
    );

    const platform = await refusal(client.fields(other));
    expect(platform).toMatchObject({ status: 403, detail: 'Access Denied' });
    expect(deereDenialOf(platform)).toBe('needs_approval');
    const equipment = await refusal(client.machines(other));
    expect(equipment).toMatchObject({ status: 403, detail: 'Access Denied' }); // the bare array
    // The home org is untouched.
    expect(await client.machines(SIM_DEERE_HOME_ORG)).toEqual(expect.any(Array));
  });

  test('the locations poll skips the org that needs approval; the others keep flowing', async () => {
    const other = orgIds.find((id) => id !== SIM_DEERE_HOME_ORG) as string;
    const before = sim.counters.requests.deere ?? 0;
    const r = await client.pollLocationsWithOrgs(null);
    const seen = Object.fromEntries(r.orgs.map((o) => [o.orgId, o.status]));
    expect(seen[other]).toBe('needs_approval');
    expect(seen[SIM_DEERE_HOME_ORG]).toBe('connected');
    expect(r.orgs.find((o) => o.orgId === other)?.approvalUrl).toMatch(/select-organizations/);
    expect(r.listing.map((o) => o.id).sort()).toEqual([...orgIds].sort());
    // Its equipment was never asked for: one listing + one equipment call per other org + crumbs.
    expect((sim.counters.requests.deere ?? 0) - before).toBeGreaterThanOrEqual(orgIds.length);
    expect(r.items.every((i) => i.payload.orgId !== other)).toBe(true);
    await knob({ orgId: other, state: 'connected' });
    const back = await client.pollLocationsWithOrgs(r.cursor);
    expect(back.orgs.every((o) => o.status === 'connected')).toBe(true);
  });

  test("terms and scope: 403 kinds the org's status tells apart (the listing stays connected)", async () => {
    const [a, b] = orgIds.filter((id) => id !== SIM_DEERE_HOME_ORG);
    if (!a || !b) throw new Error('the demo world needs two customer orgs');
    await knob({ orgId: a, state: 'terms' });
    await knob({ orgId: b, state: 'scope' });
    expect(await links(a)).toContain('manage_connections');

    const terms = await refusal(client.machines(a));
    expect(terms.headers?.['x-deere-terms-location']).toMatch(/teammanager\.deere\.com/);
    expect(deereDenialOf(terms)).toBe('terms');
    const scope = await refusal(client.fields(b));
    expect(scope.detail).toMatch(/proper access/);
    expect(deereDenialOf(scope)).toBe('scope');

    const r = await client.pollLocationsWithOrgs(null);
    const byId = new Map(r.orgs.map((o) => [o.orgId, o]));
    const ta = byId.get(a);
    const sb = byId.get(b);
    expect(ta?.status).toBe('needs_approval');
    expect(orgStatusView({ status: ta?.status ?? '', detail: ta?.detail ?? null })).toMatchObject({
      kind: 'terms',
      termsUrl: expect.stringMatching(/^https:\/\/teammanager\.deere\.com\/organizations\//),
    });
    expect(orgStatusView({ status: sb?.status ?? '', detail: sb?.detail ?? null }).kind).toBe(
      'scope',
    );
    expect(byId.get(SIM_DEERE_HOME_ORG)?.status).toBe('connected');
  });

  test('reset clears the knob', async () => {
    sim.control.reset({});
    expect((await knob()).body.orgs.every((o) => o.state === 'connected')).toBe(true);
  });
});
