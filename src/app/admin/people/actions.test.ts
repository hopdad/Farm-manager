/**
 * Server-side authorization of every people and device action: requireRole runs first, so a
 * signed-out browser, a device on its own or a crew member gets a refusal (and the database is
 * never touched). What a manager may do to whom is tested with the store (store.db.test.ts).
 */
import { describe, expect, test } from 'vitest';
import { makeSession, runWithSession } from '@/platform/auth/testing';
import type { Role, Session } from '@/platform/auth/types';
import * as devices from '../devices/actions';
import * as people from './actions';

const form = (fields: Record<string, string> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

const ID = '6a1d2f8c-3e4b-4c5d-8e9f-0a1b2c3d4e5f';
const ACTIONS: [string, (prev: null, f: FormData) => Promise<{ ok: boolean; message: string }>][] =
  [
    ['addPerson', people.addPersonAction],
    ['setRole', people.setRoleAction],
    ['setActive', people.setActiveAction],
    ['setPin', people.setPinAction],
    ['unlock', people.unlockAction],
    ['signOutEverywhere', people.signOutEverywhereAction],
    ['addDevice', devices.addDeviceAction],
    ['newCode', devices.newCodeAction],
    ['setDeviceRole', devices.setDeviceRoleAction],
    ['revokeDevice', devices.revokeDeviceAction],
  ];
const FIELDS = {
  id: ID,
  role: 'manager',
  name: 'Mallory',
  pin: '4071',
  kind: 'wall',
  active: 'false',
};

const as = (session: Session | null, fn: () => Promise<unknown>) => runWithSession(session, fn);

describe('people and device actions refuse before doing anything', () => {
  test('signed out: "Sign in first."', async () => {
    for (const [name, action] of ACTIONS) {
      const r = await as(null, () => action(null, form(FIELDS)));
      expect(r, name).toMatchObject({ ok: false, message: 'Sign in first.' });
    }
  });

  test('viewer, driver and operator sessions (devices and people) are refused', async () => {
    const sessions: Session[] = (['viewer', 'driver', 'operator'] as Role[]).flatMap((role) => [
      makeSession({ role, kind: 'person', appUserId: ID }),
      makeSession({ role, kind: 'device', deviceId: ID, deviceKind: 'wall' }),
    ]);
    for (const s of sessions) {
      for (const [name, action] of ACTIONS) {
        const r = (await as(s, () => action(null, form(FIELDS)))) as {
          ok: boolean;
          message: string;
        };
        expect(r.ok, `${name} as ${s.kind} ${s.role}`).toBe(false);
        expect(r.message).toMatch(/needs the manager role/);
      }
    }
  });

  test('switching the demo people off needs the owner (one of them is a manager)', async () => {
    const r = await as(makeSession({ role: 'manager' }), () => people.deactivateDemoAction(null));
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/owner role/) });
  });
});
