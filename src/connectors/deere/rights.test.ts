/**
 * The data-rights gate's predicate (D17, docs/contracts-2a.md §4.4; done-when §11.4): every
 * connector mode × the home org (configured, the only member, the simulated one), an org with
 * an agreement on file, one without (revoked or never linked: the loader leaves both out of
 * `agreedOrgIds`), and the home org UNKNOWN (sandbox/live with several member orgs and
 * DEERE_HOME_ORG_ID unset: fail closed, the farm's own org refused too); no rights = allowed.
 */
import { describe, expect, test } from 'vitest';
import { SIM_DEERE_HOME_ORG } from '../../sim/types';
import { CONNECTOR_MODES, type Mode } from '../types';
import { DEERE_REPLAY_HOME_ORG } from './orgs';
import {
  blockedOrgAccess,
  GATE_REPORTED_MODES,
  gateEnforced,
  HOME_ORG_UNKNOWN_DETAIL,
  NO_AGREEMENT_DETAIL,
  type OrgReadRights,
  orgReadAllowed,
  orgReadDecision,
  orgRefusalDetail,
} from './rights';

const HOME = 'org-home-1';
const AGREED = 'org-agreed';
const NONE = 'org-none';
/** A listing with several member orgs: the home org is unknown unless configured. */
const SEVERAL = [
  { id: HOME, member: true },
  { id: AGREED, member: true },
  { id: NONE, member: true },
];
/** A listing where HOME is the only member org (sandbox/live then know it). */
const ONLY_MEMBER = [{ id: HOME, member: true }, { id: AGREED, member: false }, { id: NONE }];

const rights = (mode: Mode, homeOrgId: string | null, agreed: string[] = [AGREED]) =>
  ({ mode, homeOrgId, agreedOrgIds: new Set(agreed) }) satisfies OrgReadRights;

const ENFORCED: Mode[] = ['sandbox', 'live', 'off'];
const REPORTED: Mode[] = ['sim', 'replay'];

describe('modes', () => {
  test('enforced in sandbox and live (and off: fail closed); reported in sim and replay', () => {
    expect([...GATE_REPORTED_MODES].sort()).toEqual(['replay', 'sim']);
    for (const m of CONNECTOR_MODES) expect(gateEnforced(m)).toBe(!REPORTED.includes(m));
    expect(ENFORCED.every(gateEnforced)).toBe(true);
  });
});

describe('no rights (tests, tools)', () => {
  test.each([null, undefined])('%s: every org is read', (r) => {
    for (const org of [HOME, AGREED, NONE]) {
      expect(orgReadAllowed(org, SEVERAL, r)).toBe(true);
      expect(orgReadDecision(org, SEVERAL, r)).toEqual({ allowed: true, reason: 'no_rights' });
    }
  });
});

describe.each(ENFORCED)('%s (enforced)', (mode) => {
  test('the configured home org is read even with no agreement on file', () => {
    expect(orgReadDecision(HOME, SEVERAL, rights(mode, HOME, []))).toEqual({
      allowed: true,
      reason: 'home',
    });
  });

  test('a customer org with an agreement on file is read', () => {
    expect(orgReadDecision(AGREED, SEVERAL, rights(mode, HOME))).toEqual({
      allowed: true,
      reason: 'agreed',
    });
  });

  test('a customer org with no agreement (revoked, or never linked to a party) is refused', () => {
    expect(orgReadDecision(NONE, SEVERAL, rights(mode, HOME))).toEqual({
      allowed: false,
      reason: 'no_agreement',
    });
    expect(orgReadAllowed(NONE, SEVERAL, rights(mode, HOME))).toBe(false);
    // An org the listing doesn't even show is no different.
    expect(orgReadAllowed('org-unlisted', SEVERAL, rights(mode, HOME))).toBe(false);
  });

  test('home org unknown: fail closed, the own org refused too; an agreed org still read', () => {
    const r = rights(mode, null);
    expect(orgReadDecision(HOME, SEVERAL, r)).toEqual({ allowed: false, reason: 'home_unknown' });
    expect(orgReadDecision(NONE, SEVERAL, r)).toEqual({ allowed: false, reason: 'home_unknown' });
    expect(orgReadDecision(AGREED, SEVERAL, r)).toEqual({ allowed: true, reason: 'agreed' });
    // No listing at all: nothing is "the home org" either.
    expect(orgReadAllowed(HOME, [], r)).toBe(false);
  });
});

describe.each(['sandbox', 'live'] as const)('%s with no DEERE_HOME_ORG_ID', (mode) => {
  test('the only member org is the home org (read); the others need an agreement', () => {
    const r = rights(mode, null);
    expect(orgReadDecision(HOME, ONLY_MEMBER, r)).toEqual({ allowed: true, reason: 'home' });
    expect(orgReadDecision(AGREED, ONLY_MEMBER, r).allowed).toBe(true);
    expect(orgReadDecision(NONE, ONLY_MEMBER, r)).toEqual({
      allowed: false,
      reason: 'no_agreement',
    });
  });

  test('DEERE_HOME_ORG_ID wins over the listing', () => {
    const r = rights(mode, NONE, []);
    expect(orgReadDecision(NONE, ONLY_MEMBER, r).reason).toBe('home');
    expect(orgReadDecision(HOME, ONLY_MEMBER, r)).toEqual({
      allowed: false,
      reason: 'no_agreement',
    });
  });
});

describe.each(REPORTED)('%s (reported, never enforced)', (mode) => {
  test('every org is read; the decision says which ones live would block', () => {
    const home = mode === 'sim' ? SIM_DEERE_HOME_ORG : DEERE_REPLAY_HOME_ORG;
    const r = rights(mode, null);
    expect(orgReadDecision(home, SEVERAL, r)).toEqual({ allowed: true, reason: 'home' });
    expect(orgReadDecision(AGREED, SEVERAL, r)).toEqual({ allowed: true, reason: 'agreed' });
    expect(orgReadDecision(NONE, SEVERAL, r)).toEqual({ allowed: true, reason: 'reported' });
    // Their home org is known without the listing (the simulated / the fixtures' own org).
    for (const org of [HOME, AGREED, NONE]) expect(orgReadAllowed(org, [], r)).toBe(true);
  });

  test('a configured home org is home here too', () => {
    expect(orgReadDecision(HOME, [], rights(mode, HOME, [])).reason).toBe('home');
  });
});

describe('details', () => {
  test('the refusal texts name the reason', () => {
    expect(orgRefusalDetail('no_agreement')).toBe(NO_AGREEMENT_DETAIL);
    expect(orgRefusalDetail('home_unknown')).toBe(HOME_ORG_UNKNOWN_DETAIL);
    expect(HOME_ORG_UNKNOWN_DETAIL).toContain('home org unknown: set DEERE_HOME_ORG_ID');
    for (const r of ['home', 'agreed', 'reported', 'no_rights'] as const) {
      expect(orgRefusalDetail(r)).toBeNull();
    }
  });

  test('a blocked org is stored as needs approval with the agreement detail', () => {
    const org = { id: NONE, name: 'Customer', links: [] };
    expect(blockedOrgAccess(org)).toMatchObject({
      orgId: NONE,
      name: 'Customer',
      status: 'needs_approval',
      detail: NO_AGREEMENT_DETAIL,
      approvalUrl: null,
    });
    expect(blockedOrgAccess(org, HOME_ORG_UNKNOWN_DETAIL).detail).toBe(HOME_ORG_UNKNOWN_DETAIL);
  });
});
