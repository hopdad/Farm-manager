/** The auth contract: role order, the requireRole core, the error type and the stand-in sessions. */
import { describe, expect, expectTypeOf, test } from 'vitest';
import { APP_ROLES, DEVICE_ROLES } from '../../domain/farm';
import {
  ANONYMOUS_VIEWER,
  AuthError,
  type AuthIdentity,
  checkRole,
  isAuthError,
  isRole,
  PIN_RULES,
  ROLE_FOR,
  ROLES,
  type Role,
  roleAtLeast,
  roleRank,
  type Session,
} from './types';

const session = (role: Role): Session => ({ ...ANONYMOUS_VIEWER, role, provisional: false });

describe('roles', () => {
  test('are ordered lowest first and match the database CHECK list', () => {
    expect(ROLES).toEqual(['viewer', 'driver', 'operator', 'manager', 'owner']);
    expect(ROLES).toBe(APP_ROLES);
    expect(ROLES.map(roleRank)).toEqual([0, 1, 2, 3, 4]);
  });

  test('roleAtLeast follows the order', () => {
    expect(roleAtLeast('manager', 'operator')).toBe(true);
    expect(roleAtLeast('operator', 'operator')).toBe(true);
    expect(roleAtLeast('driver', 'operator')).toBe(false);
    expect(roleAtLeast('viewer', 'viewer')).toBe(true);
    expect(roleAtLeast('owner', 'manager')).toBe(true);
  });

  test('isRole', () => {
    expect(isRole('manager')).toBe(true);
    expect(isRole('admin')).toBe(false);
    expect(isRole(3)).toBe(false);
  });

  test('ROLE_FOR names real roles, and devices alone never reach manager actions', () => {
    for (const r of Object.values(ROLE_FOR)) expect(isRole(r)).toBe(true);
    for (const d of DEVICE_ROLES) {
      expect(roleAtLeast(d, ROLE_FOR.admin)).toBe(false);
      expect(roleAtLeast(d, ROLE_FOR.editFieldNotes)).toBe(false);
    }
    expect(roleAtLeast('driver', ROLE_FOR.markMachineDown)).toBe(true);
  });
});

describe('checkRole (the requireRole core)', () => {
  test('no session: 401', () => {
    try {
      checkRole(null, 'viewer');
      expect.unreachable();
    } catch (e) {
      expect(isAuthError(e)).toBe(true);
      expect((e as AuthError).status).toBe(401);
    }
  });

  test('role too low: 403 naming the requirement', () => {
    try {
      checkRole(session('driver'), 'manager');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AuthError);
      expect((e as AuthError).status).toBe(403);
      expect((e as AuthError).required).toBe('manager');
      expect((e as AuthError).message).toMatch(/manager/);
    }
  });

  test('enough role: the session itself', () => {
    const s = session('operator');
    expect(checkRole(s, 'driver')).toBe(s);
  });

  test('the anonymous viewer is a provisional viewer device with no ids', () => {
    expect(ANONYMOUS_VIEWER).toMatchObject({
      kind: 'device',
      deviceId: null,
      appUserId: null,
      partyId: null,
      role: 'viewer',
      provisional: true,
    });
    expect(Object.isFrozen(ANONYMOUS_VIEWER)).toBe(true);
    expect(checkRole({ ...ANONYMOUS_VIEWER }, 'viewer').role).toBe('viewer');
    expect(() => checkRole({ ...ANONYMOUS_VIEWER }, 'driver')).toThrow(AuthError);
  });
});

describe('types', () => {
  test('Session and AuthIdentity carry only our ids', () => {
    expectTypeOf<Session['kind']>().toEqualTypeOf<'device' | 'person'>();
    expectTypeOf<Session['deviceId']>().toEqualTypeOf<string | null>();
    expectTypeOf<Session['role']>().toEqualTypeOf<Role>();
    expectTypeOf<Extract<AuthIdentity, { kind: 'device' }>>().toHaveProperty('deviceId');
    expectTypeOf<Extract<AuthIdentity, { kind: 'person' }>>().toHaveProperty('appUserId');
  });

  test('PIN rules are sane', () => {
    expect(PIN_RULES.minLength).toBeGreaterThanOrEqual(4);
    expect(PIN_RULES.maxLength).toBeGreaterThanOrEqual(PIN_RULES.minLength);
    expect(PIN_RULES.maxFailures).toBeGreaterThan(0);
    expect(PIN_RULES.lockoutMinutes).toBeGreaterThan(0);
  });
});
