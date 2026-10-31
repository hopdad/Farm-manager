/**
 * ingest.connector_orgs on a real database, as farm_app (1f decision 5): upsert per mode, the
 * rows a successful listing no longer has are deleted (that mode only), a failed listing deletes
 * nothing, and sync_state.extra merges keep other writers' keys.
 */
import { describe, expect, test } from 'vitest';
import type { DeereOrgAccess } from '../../connectors/deere/orgs';
import { setupTestDb } from '../../test/db';
import { ensureStream } from '../leases';
import {
  listConnectorOrgs,
  mergeSyncStateExtra,
  saveConnectorOrgs,
  storedHomeOrgOf,
} from './connector-orgs';

const t = setupTestDb(import.meta.url);

const org = (orgId: string, status: DeereOrgAccess['status'] = 'connected'): DeereOrgAccess => ({
  orgId,
  name: `Org ${orgId}`,
  status,
  approvalUrl:
    status === 'needs_approval'
      ? 'https://connections.deere.com/connections/c/select-organizations'
      : null,
  detail: status === 'needs_approval' ? 'the organization has not approved this app' : null,
});

describe('saveConnectorOrgs', () => {
  test('per mode; a successful listing drops the rows it no longer has', async () => {
    const p = t().pool;
    await saveConnectorOrgs(p, 'deere', 'sim', [org('a'), org('b', 'needs_approval')], {
      listed: true,
    });
    await saveConnectorOrgs(p, 'deere', 'sandbox', [org('1')], { listed: true });
    expect((await listConnectorOrgs(p, 'deere', 'sim')).map((o) => [o.orgId, o.status])).toEqual([
      ['a', 'connected'],
      ['b', 'needs_approval'],
    ]);
    const first = (await listConnectorOrgs(p, 'deere', 'sim'))[0]?.firstSeenAt;

    // b approved, a gone, c new: a is deleted (sim only), sandbox untouched.
    const res = await saveConnectorOrgs(p, 'deere', 'sim', [org('b'), org('c')], { listed: true });
    expect(res).toEqual({ saved: 2, removed: 1 });
    const sim = await listConnectorOrgs(p, 'deere', 'sim');
    expect(sim.map((o) => [o.orgId, o.status, o.approvalUrl])).toEqual([
      ['b', 'connected', null],
      ['c', 'connected', null],
    ]);
    expect((await listConnectorOrgs(p, 'deere', 'sandbox')).map((o) => o.orgId)).toEqual(['1']);
    expect(first).toBeInstanceOf(Date);

    // Not listed (the listing failed): upserts only, nothing deleted.
    await saveConnectorOrgs(p, 'deere', 'sim', [org('d')], { listed: false });
    expect((await listConnectorOrgs(p, 'deere', 'sim')).map((o) => o.orgId)).toEqual([
      'b',
      'c',
      'd',
    ]);
    // An empty successful listing clears the mode.
    await saveConnectorOrgs(p, 'deere', 'sim', [], { listed: true });
    expect(await listConnectorOrgs(p, 'deere', 'sim')).toEqual([]);
  });
});

describe('mergeSyncStateExtra / storedHomeOrgOf', () => {
  test("merges keys, keeps the others'; reads the home org back", async () => {
    const p = t().pool;
    await ensureStream(p, 'deere', 'locations', 'sim');
    await p.query(
      `update ingest.sync_state set extra = '{"callsPerRun": 7}' where source = 'deere' and stream = 'locations'`,
    );
    const homeOrg = {
      orgId: null,
      source: 'unknown',
      mode: 'sandbox',
      candidates: [{ id: '1', name: 'One', member: true }],
      at: '2026-10-31T00:00:00.000Z',
    };
    expect(await mergeSyncStateExtra(p, 'deere', 'locations', { homeOrg })).toBe(true);
    expect(await mergeSyncStateExtra(p, 'deere', 'none', { homeOrg })).toBe(false);
    const extra = (
      await p.query(
        `select extra from ingest.sync_state where source = 'deere' and stream = 'locations'`,
      )
    ).rows[0].extra;
    expect(extra.callsPerRun).toBe(7);
    expect(storedHomeOrgOf(extra)).toEqual(homeOrg);
    expect(storedHomeOrgOf({})).toBeNull();
    expect(storedHomeOrgOf({ homeOrg: { source: 'x', candidates: [{}, { id: '2' }] } })).toEqual({
      orgId: null,
      source: 'x',
      mode: '',
      candidates: [{ id: '2', name: null, member: null }],
      at: '',
    });
  });
});
