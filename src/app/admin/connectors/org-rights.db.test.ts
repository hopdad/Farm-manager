/**
 * /admin/connectors' data-rights column against a real database (D17; docs/contracts-2a.md
 * §4.4, §1.2; done-when §11.4): the demo's two customer orgs as the seed links them (Halvorsen
 * with the agreement: "agreement on file"; Juniper Hill without: "no agreement: blocked in live"
 * in sim, "blocked" in sandbox), an org with no party yet offers "link to customer", and the
 * link action (manager only, customers only, never re-pointing) makes the org resolve. (Next's
 * revalidatePath and the app pool are swapped for the test's.)
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { seedSimFarm } from '@/connectors/testkit';
import { externalRef } from '@/connectors/types';
import { upsertExternalRef } from '@/db/external-refs';
import { dataRightsAgreements } from '@/db/schema';
import { makeSession, runWithSession } from '@/platform/auth/testing';
import { buildDemoFarm } from '@/sim/farm/build';
import { SIM_DEERE_HOME_ORG, simCustomerOrgParties } from '@/sim/types';
import { setupTestDb } from '@/test/db';
import { loadOrgRights } from './org-rights';

const t = setupTestDb(import.meta.url);
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/db/client', async (orig) => ({
  ...(await orig<typeof import('@/db/client')>()),
  getPool: () => t().pool,
}));
const { linkDeereOrgAction } = await import('./org-rights-actions');

const farm = buildDemoFarm(1);
const ORGS = [SIM_DEERE_HOME_ORG, 'org-customer-1', 'org-customer-2', 'org-new'];
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

beforeAll(async () => {
  await seedSimFarm(t().adminDb, farm);
  // As the demo seed does (tools/seed/work.ts): both orgs linked, Halvorsen signed.
  for (const { orgId, partyId } of simCustomerOrgParties(farm)) {
    await upsertExternalRef(t().pool, externalRef('deere', 'party', orgId, orgId), partyId);
    if (orgId === 'org-customer-1') {
      await t()
        .db.insert(dataRightsAgreements)
        .values({
          partyId,
          signedOn: '2026-10-01',
          permittedUses: ['billing', 'agronomy', 'prospecting', 'landlord_sharing'],
        });
    }
  }
});
afterAll(() => vi.restoreAllMocks());

describe('loadOrgRights', () => {
  test('sim: home, agreement on file, blocked in live, and link to customer', async () => {
    const snap = await loadOrgRights(t().pool, {
      mode: 'sim',
      homeOrgId: SIM_DEERE_HOME_ORG,
      orgIds: ORGS,
    });
    const v = (org: string) => snap.views.get(org);
    expect(v(SIM_DEERE_HOME_ORG)).toMatchObject({ state: 'home', canLink: false });
    expect(v('org-customer-1')).toMatchObject({
      state: 'agreed',
      label: 'agreement on file',
      party: { name: 'Halvorsen Bros. Farms', linkedBy: 'ref' },
    });
    expect(v('org-customer-2')).toMatchObject({
      state: 'reported',
      label: 'no agreement: blocked in live',
      party: { name: 'Juniper Hill Farms LLC' },
      canLink: false,
    });
    expect(v('org-new')).toMatchObject({ state: 'reported', party: null, canLink: true });
    expect(snap.customers.map((c) => c.name)).toContain('Juniper Hill Farms LLC');
    expect(snap.customers[0]?.kind).toBe('org');
  });

  test('sandbox: the unsigned org is blocked; with the home org unknown, the own org too', async () => {
    const known = await loadOrgRights(t().pool, {
      mode: 'sandbox',
      homeOrgId: SIM_DEERE_HOME_ORG,
      orgIds: ORGS,
    });
    expect(known.views.get('org-customer-2')?.state).toBe('blocked');
    expect(known.views.get('org-customer-1')?.state).toBe('agreed');
    const unknown = await loadOrgRights(t().pool, { mode: 'live', homeOrgId: null, orgIds: ORGS });
    expect(unknown.views.get(SIM_DEERE_HOME_ORG)?.state).toBe('blocked');
    expect(unknown.views.get('org-customer-1')?.state).toBe('agreed');
  });
});

describe('linkDeereOrgAction', () => {
  const juniper = () =>
    simCustomerOrgParties(farm).find((p) => p.orgId === 'org-customer-2')?.partyId as string;

  test('a viewer or driver is refused on the server; nothing is linked', async () => {
    for (const role of ['viewer', 'driver'] as const) {
      const r = await runWithSession(makeSession({ role }), () =>
        linkDeereOrgAction(null, form({ orgId: 'org-new', partyId: juniper() })),
      );
      expect(r.ok, role).toBe(false);
    }
    const snap = await loadOrgRights(t().pool, {
      mode: 'sim',
      homeOrgId: null,
      orgIds: ['org-new'],
    });
    expect(snap.views.get('org-new')?.party).toBeNull();
  });

  test('a manager links an org with no party; a linked org is never re-pointed', async () => {
    const m = makeSession({ role: 'manager' });
    expect(
      await runWithSession(m, () =>
        linkDeereOrgAction(null, form({ orgId: 'org new', partyId: juniper() })),
      ),
    ).toMatchObject({ ok: false, message: 'unknown Deere org' });
    expect(
      await runWithSession(m, () =>
        linkDeereOrgAction(null, form({ orgId: 'org-new', partyId: '' })),
      ),
    ).toMatchObject({ ok: false, message: 'pick a customer' });
    expect(
      await runWithSession(m, () =>
        linkDeereOrgAction(null, form({ orgId: 'org-new', partyId: juniper() })),
      ),
    ).toMatchObject({ ok: true });
    const after = await loadOrgRights(t().pool, {
      mode: 'sim',
      homeOrgId: null,
      orgIds: ['org-new'],
    });
    expect(after.views.get('org-new')).toMatchObject({
      party: { name: 'Juniper Hill Farms LLC', linkedBy: 'ref' },
      canLink: false,
    });
    const halvorsen = simCustomerOrgParties(farm).find((p) => p.orgId === 'org-customer-1');
    expect(
      await runWithSession(m, () =>
        linkDeereOrgAction(null, form({ orgId: 'org-new', partyId: halvorsen?.partyId as string })),
      ),
    ).toMatchObject({
      ok: false,
      message: "Deere org org-new is already Juniper Hill Farms LLC's",
    });
  });
});
