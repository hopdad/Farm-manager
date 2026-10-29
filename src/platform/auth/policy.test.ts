/** Who may manage whom (D8 defaults), role ordering as the policy uses it, safe `next` paths. */
import { describe, expect, test } from 'vitest';
import { DEVICE_KINDS } from '../../domain/farm';
import {
  canManagePerson,
  canSetPin,
  DEFAULT_DEVICE_ROLE,
  homePathFor,
  isSharedKind,
  PERSON_SIGN_IN_MIN_ROLE,
  roleNeededToManage,
  safeNextPath,
} from './policy';
import { makeSession } from './testing';
import { ROLES, type Role, roleAtLeast } from './types';

const ME = '6a1d2f8c-3e4b-4c5d-8e9f-0a1b2c3d4e5f';
const OTHER = '0b9cfe4e-7b0e-4bb4-9a4e-6c1f7a0d2a11';
const as = (role: Role) => makeSession({ role, appUserId: ME });

describe('role ordering', () => {
  test('each role includes every role below it, and no role above', () => {
    ROLES.forEach((r, i) => {
      ROLES.forEach((min, j) => {
        expect(roleAtLeast(r, min), `${r} >= ${min}`).toBe(i >= j);
      });
    });
  });
});

describe('canManagePerson', () => {
  test('crew roles: managers and owners; manager and owner roles: owners only', () => {
    for (const target of ROLES) {
      expect(roleNeededToManage(target)).toBe(roleAtLeast(target, 'manager') ? 'owner' : 'manager');
      for (const actor of ROLES) {
        const ok = canManagePerson(as(actor), { id: OTHER, role: target }).ok;
        expect(ok, `${actor} manages ${target}`).toBe(
          roleAtLeast(actor, 'manager') && roleAtLeast(actor, roleNeededToManage(target)),
        );
      }
    }
  });

  test('promoting someone to manager needs the owner', () => {
    expect(
      canManagePerson(as('manager'), { id: OTHER, role: 'driver' }, { role: 'operator' }).ok,
    ).toBe(true);
    const r = canManagePerson(as('manager'), { id: OTHER, role: 'driver' }, { role: 'manager' });
    expect(r).toEqual({ ok: false, reason: 'only the owner can manage managers' });
    expect(
      canManagePerson(as('owner'), { id: OTHER, role: 'driver' }, { role: 'manager' }).ok,
    ).toBe(true);
  });

  test('nobody changes their own role or switches themselves off', () => {
    expect(canManagePerson(as('owner'), { id: ME, role: 'owner' }, { role: 'manager' }).ok).toBe(
      false,
    );
    expect(canManagePerson(as('owner'), { id: ME, role: 'owner' }, { active: false }).ok).toBe(
      false,
    );
    expect(canManagePerson(as('owner'), { id: ME, role: 'owner' }, { role: 'owner' }).ok).toBe(
      true,
    );
  });

  test('a device or the admin key acts by its role (no appUserId: never "self")', () => {
    const key = makeSession({ role: 'owner', appUserId: null, provisional: true });
    expect(canManagePerson(key, { id: OTHER, role: 'owner' }, { active: false }).ok).toBe(true);
    const wall = makeSession({ kind: 'device', role: 'viewer', deviceId: OTHER });
    expect(canManagePerson(wall, { id: null, role: 'viewer' }).ok).toBe(false);
  });
});

describe('canSetPin', () => {
  test('your own PIN from your own browser; others as for managing', () => {
    expect(canSetPin(as('driver'), { id: ME, role: 'driver' }).ok).toBe(true);
    expect(canSetPin(as('driver'), { id: OTHER, role: 'driver' }).ok).toBe(false);
    expect(canSetPin(as('manager'), { id: OTHER, role: 'operator' }).ok).toBe(true);
    expect(canSetPin(as('manager'), { id: OTHER, role: 'owner' }).ok).toBe(false);
    const operatorOnWall = makeSession({ kind: 'device', role: 'operator', appUserId: ME });
    expect(canSetPin(operatorOnWall, { id: ME, role: 'operator' }).ok).toBe(false);
  });
});

describe('devices', () => {
  test('D8: the wall and the cab/truck iPads are shared, phones personal', () => {
    expect(DEVICE_KINDS.filter(isSharedKind)).toEqual(['wall', 'cab_ipad', 'truck_ipad']);
    expect(isSharedKind(null)).toBe(false);
  });

  test('a device on its own is at most an operator; the wall is a viewer', () => {
    for (const k of DEVICE_KINDS)
      expect(roleAtLeast(DEFAULT_DEVICE_ROLE[k], 'manager')).toBe(false);
    expect(DEFAULT_DEVICE_ROLE.wall).toBe('viewer');
    expect(homePathFor('wall')).toBe('/board');
    expect(homePathFor('cab_ipad')).toBe('/m');
    expect(homePathFor(null)).toBe('/m');
  });

  test('name + PIN on a personal browser is for managers and the owner', () => {
    expect(PERSON_SIGN_IN_MIN_ROLE).toBe('manager');
  });
});

describe('safeNextPath', () => {
  test('same-origin paths pass, everything else is dropped', () => {
    expect(safeNextPath('/board')).toBe('/board');
    expect(safeNextPath('/admin/people?x=1')).toBe('/admin/people?x=1');
    for (const bad of [
      'https://evil.example/',
      '//evil.example',
      '/\\evil.example',
      'board',
      '/login',
      '/login?next=/x',
      '/a\nb',
      null,
      '/'.repeat(600),
    ]) {
      expect(safeNextPath(bad), String(bad)).toBeNull();
    }
  });
});
