/**
 * /admin/connectors' data-rights column (D17; docs/contracts-2a.md §4.4, §7.5
 * `deere-org-rights` data-state home / agreed / blocked / reported): the gate's own decision in
 * words, per mode, and "link to customer" only for a non-home org with no party.
 */
import { describe, expect, test } from 'vitest';
import type { DeereOrgParty } from '../../../db/queries/agreements';
import { SIM_DEERE_HOME_ORG } from '../../../sim/types';
import { orgRightsView } from './org-rights';

const party = (agreementsInForce: number): DeereOrgParty => ({
  orgId: 'org-c',
  partyId: '84162a8b-6504-52c6-97f2-7ed42b767f99',
  partyName: 'Halvorsen Bros. Farms',
  partyKind: 'org',
  linkedBy: 'ref',
  agreementsInForce,
});

describe('orgRightsView', () => {
  test('sim: the home org, an agreed customer, and one live would block', () => {
    const ctx = { mode: 'sim' as const, homeOrgId: SIM_DEERE_HOME_ORG };
    expect(orgRightsView(SIM_DEERE_HOME_ORG, { ...ctx, party: undefined })).toMatchObject({
      state: 'home',
      canLink: false,
    });
    expect(orgRightsView('org-c', { ...ctx, party: party(1) })).toMatchObject({
      state: 'agreed',
      label: 'agreement on file',
      party: { name: 'Halvorsen Bros. Farms', linkedBy: 'ref' },
      canLink: false,
    });
    expect(orgRightsView('org-c', { ...ctx, party: party(0) })).toMatchObject({
      state: 'reported',
      label: 'no agreement: blocked in live',
      canLink: false,
    });
    expect(orgRightsView('org-x', { ...ctx, party: undefined })).toMatchObject({
      state: 'reported',
      party: null,
      canLink: true,
    });
  });

  test('replay reports like sim', () => {
    expect(orgRightsView('org-c', { mode: 'replay', homeOrgId: null, party: party(0) }).state).toBe(
      'reported',
    );
  });

  test.each(['sandbox', 'live'] as const)('%s: no agreement = blocked', (mode) => {
    expect(orgRightsView('org-c', { mode, homeOrgId: 'org-h', party: party(0) })).toMatchObject({
      state: 'blocked',
      label: `no agreement: blocked (${mode})`,
    });
    expect(orgRightsView('org-c', { mode, homeOrgId: 'org-h', party: party(2) }).state).toBe(
      'agreed',
    );
    expect(orgRightsView('org-h', { mode, homeOrgId: 'org-h', party: undefined }).state).toBe(
      'home',
    );
  });

  test.each(['sandbox', 'live'] as const)('%s, home org unknown: every org blocked', (mode) => {
    const own = orgRightsView('org-h', { mode, homeOrgId: null, party: undefined });
    expect(own).toMatchObject({ state: 'blocked', canLink: true });
    expect(own.label).toContain('set DEERE_HOME_ORG_ID');
    expect(orgRightsView('org-c', { mode, homeOrgId: null, party: party(1) }).state).toBe('agreed');
  });
});
