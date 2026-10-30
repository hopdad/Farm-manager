/**
 * The 1f seams on the Deere side (docs/contracts-1f.md §5): the public `apiUrl` / `getOne` /
 * `getPaged` helpers builders add their own calls with (here against the replay fixtures, so the
 * paging and the schema are the live client's), and the org-access helpers of decision 5.
 */
import { describe, expect, test } from 'vitest';
import type { ConnectorConfig } from '../endpoints';
import { VendorHttpError } from '../http';
import { DeereClient } from './client';
import { deereOrgAccess, deniedOrgAccess, isDeereOrgDenied } from './orgs';
import { deereFieldsSchema, deereOrganizationsSchema } from './schemas';

const cfg: ConnectorConfig = {
  VENDOR_SIM_URL: 'http://127.0.0.1:1',
  PUBLIC_URL: 'http://localhost:3104',
};

describe('DeereClient public helpers', () => {
  test('apiUrl encodes each segment below apiBase', () => {
    const c = DeereClient.forReplay(cfg);
    expect(c.apiUrl('organizations', 'org home', 'farms')).toBe(
      `${c.endpoints.apiBase}/organizations/org%20home/farms`,
    );
  });

  test('getPaged follows nextPage and validates each page; getOne reads one page', async () => {
    const c = DeereClient.forReplay(cfg, { timeoutMs: 2_000 });
    const fields = await c.getPaged(
      deereFieldsSchema,
      c.apiUrl('organizations', 'org-home', 'fields'),
    );
    expect(fields.length).toBeGreaterThan(25); // two pages in the fixtures
    expect(fields).toEqual(await c.fields('org-home'));
    const first = await c.getOne(deereOrganizationsSchema, c.apiUrl('organizations'));
    expect(first.values.map((o) => o.id)).toContain('org-home');
  });

  test('a call the fixtures do not answer surfaces as VendorHttpError 404', async () => {
    const c = DeereClient.forReplay(cfg, { timeoutMs: 2_000, maxRetries: 0 });
    await expect(
      c.getPaged(deereFieldsSchema, c.apiUrl('organizations', 'org-home', 'nothing-here')),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('Deere org access (decision 5)', () => {
  test('a connections link means the org needs approval, with that link', () => {
    expect(deereOrgAccess({ id: 'org-home', name: 'Home', links: [] })).toEqual({
      orgId: 'org-home',
      name: 'Home',
      status: 'connected',
      approvalUrl: null,
      detail: null,
    });
    const pending = deereOrgAccess({
      id: 'org-customer-1',
      links: [{ rel: 'connections', uri: 'https://connections.deere.com/connections/abc' }],
    });
    expect(pending).toMatchObject({
      status: 'needs_approval',
      approvalUrl: 'https://connections.deere.com/connections/abc',
    });
  });

  test('a 403 from Deere is an org that needs approval; other errors are not', () => {
    const denied = new VendorHttpError({
      vendor: 'deere',
      status: 403,
      path: '/platform/organizations/org-customer-1/fields',
    });
    expect(isDeereOrgDenied(denied)).toBe(true);
    expect(isDeereOrgDenied(new VendorHttpError({ vendor: 'deere', status: 500, path: '/' }))).toBe(
      false,
    );
    expect(
      isDeereOrgDenied(new VendorHttpError({ vendor: 'samsara', status: 403, path: '/' })),
    ).toBe(false);
    expect(isDeereOrgDenied(new Error('403'))).toBe(false);
    expect(deniedOrgAccess({ id: 'org-customer-1' }, denied)).toMatchObject({
      status: 'needs_approval',
      detail: '403 from /platform/organizations/org-customer-1/fields',
    });
  });
});
