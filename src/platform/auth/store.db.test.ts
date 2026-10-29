/**
 * LocalAuth against the real database, as farm_app (what the app runs as): PIN lockout,
 * people and the last-owner rule, devices and one-time enrollment, revocation, owner setup and
 * recovery, and the "device session + operator PIN" adapter contract through resolveBrowserAuth.
 */
import { scryptSync } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { setupTestDb } from '../../test/db';
import { AUTH_COOKIE, OPERATOR_COOKIE } from './cookies';
import { createLocalAuth } from './local';
import { setOperator } from './operator';
import { MemoryJar } from './provider-contract';
import { resolveBrowserAuth } from './resolve';
import {
  AuthStoreError,
  attemptPin,
  createDevice,
  createPerson,
  getDevice,
  getPerson,
  issueEnrollCode,
  issueOwnerReset,
  listPeople,
  listPickablePeople,
  ownerResetValid,
  previewEnrollment,
  realOwnerExists,
  redeemEnrollment,
  resetOwner,
  revokeDevice,
  setPersonPin,
  setupOwner,
  signOutEverywhere,
  unlockPerson,
  updatePerson,
} from './store';
import { makeSession } from './testing';
import { PIN_RULES, type Role } from './types';

const t = setupTestDb(import.meta.url);
const SECRET = 'store-db-test-secret-0123456789abcdef';
const NOW = new Date('2026-11-16T13:00:00Z');
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

let n = 0;
const uniq = (label: string) => `${label} ${++n}`;

const owner = makeSession({ role: 'owner', displayName: 'Owner (test)' });
const manager = makeSession({ role: 'manager', displayName: 'Manager (test)' });

async function person(role: Role, pin: string | null = '4071') {
  return createPerson(t().db, owner, { role, name: uniq(`Test ${role}`), pin });
}

async function storeError(p: Promise<unknown>): Promise<AuthStoreError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AuthStoreError) return e;
    throw e;
  }
  throw new Error('expected an AuthStoreError');
}

describe('operator PIN lockout', () => {
  test(`${PIN_RULES.maxFailures} wrong PINs lock for ${PIN_RULES.lockoutMinutes} minutes, even the right PIN`, async () => {
    const p = await person('operator');
    for (let i = 1; i < PIN_RULES.maxFailures; i++) {
      const a = await attemptPin(t().pool, p.id, '9999', NOW);
      expect(a).toMatchObject({ ok: false, reason: 'wrong', triesLeft: PIN_RULES.maxFailures - i });
    }
    const last = await attemptPin(t().pool, p.id, '9999', NOW);
    expect(last).toMatchObject({ ok: false, reason: 'locked', triesLeft: 0 });
    expect(last.ok ? null : last.lockedUntil).toEqual(at(PIN_RULES.lockoutMinutes));

    expect(await attemptPin(t().pool, p.id, '4071', at(1))).toMatchObject({
      ok: false,
      reason: 'locked',
    });
    expect(
      await attemptPin(t().pool, p.id, '4071', at(PIN_RULES.lockoutMinutes - 1)),
    ).toMatchObject({
      reason: 'locked',
    });
    // The lockout state lives in the row.
    const row = await getPerson(t().pool, p.id);
    expect(row?.lockedUntil).toEqual(at(PIN_RULES.lockoutMinutes));

    // After the lockout: a fresh count, and the right PIN clears everything.
    const after = at(PIN_RULES.lockoutMinutes + 1);
    expect(await attemptPin(t().pool, p.id, '9999', after)).toMatchObject({
      reason: 'wrong',
      triesLeft: PIN_RULES.maxFailures - 1,
    });
    expect(await attemptPin(t().pool, p.id, '4071', after)).toMatchObject({ ok: true });
    const cleared = await getPerson(t().pool, p.id);
    expect(cleared).toMatchObject({ failedPins: 0, lockedUntil: null });
    expect(cleared?.lastSignInAt).toEqual(after);
  });

  test('a PIN hash from before the pepper works once more and is rewritten peppered', async () => {
    const p = await person('operator', null);
    const salt = Buffer.alloc(16, 3);
    const key = scryptSync('4071', salt, 32, { N: 1 << 14, r: 8, p: 1 });
    const legacy = ['scrypt', 16384, 8, 1, salt.toString('base64url'), key.toString('base64url')];
    await t().admin.query(`update farm.app_users set pin_hash = $2 where id = $1`, [
      p.id,
      legacy.join('$'),
    ]);
    expect(await attemptPin(t().pool, p.id, '4071', NOW)).toMatchObject({ ok: true });
    const r = await t().pool.query<{ pin_hash: string }>(
      'select pin_hash from farm.app_users where id = $1',
      [p.id],
    );
    expect(r.rows[0]?.pin_hash).toMatch(/^scrypt-p1\$/);
    expect(await attemptPin(t().pool, p.id, '4071', NOW)).toMatchObject({ ok: true });
    expect(await attemptPin(t().pool, p.id, '4072', NOW)).toMatchObject({ ok: false });
  });

  test('repeated lockouts double (15, 30, 60 min ... a day); Unlock starts over', async () => {
    const p = await person('operator');
    const lockOnce = async (t0: Date) => {
      let last: Awaited<ReturnType<typeof attemptPin>> | null = null;
      for (let i = 0; i < PIN_RULES.maxFailures; i++)
        last = await attemptPin(t().pool, p.id, '9999', t0);
      return last && !last.ok ? last.lockedUntil : null;
    };
    const t1 = NOW;
    expect(await lockOnce(t1)).toEqual(new Date(t1.getTime() + 15 * 60_000));
    const t2 = at(16);
    expect(await lockOnce(t2)).toEqual(new Date(t2.getTime() + 30 * 60_000));
    const t3 = at(16 + 31);
    expect(await lockOnce(t3)).toEqual(new Date(t3.getTime() + 60 * 60_000));
    await unlockPerson(t().db, manager, p.id);
    const t4 = at(16 + 31 + 1);
    expect(await lockOnce(t4)).toEqual(new Date(t4.getTime() + 15 * 60_000));
  });

  test('a long history of lockouts stays capped at a day (no overflow)', async () => {
    const p = await person('operator');
    await t().pool.query(`update farm.app_users set failed_pins = 5 * 200 - 1 where id = $1`, [
      p.id,
    ]);
    const a = await attemptPin(t().pool, p.id, '9999', NOW);
    expect(a).toMatchObject({ ok: false, reason: 'locked', lockedUntil: at(24 * 60) });
  });

  test('the right PIN before the limit resets the count', async () => {
    const p = await person('driver');
    await attemptPin(t().pool, p.id, '9999', NOW);
    await attemptPin(t().pool, p.id, '9999', NOW);
    expect(await attemptPin(t().pool, p.id, '4071', NOW)).toMatchObject({
      ok: true,
      user: { id: p.id, role: 'driver', sessionEpoch: 0 },
    });
    expect(await attemptPin(t().pool, p.id, '9999', NOW)).toMatchObject({
      triesLeft: PIN_RULES.maxFailures - 1,
    });
  });

  test('parallel guesses never get more than the allowed tries', async () => {
    const p = await person('operator');
    const results = await Promise.all(
      Array.from({ length: 20 }, () => attemptPin(t().pool, p.id, '9999', NOW)),
    );
    const checked = results.filter((r) => !r.ok && (r.reason === 'wrong' || r.triesLeft === 0));
    const counted = results.filter((r) => !r.ok && r.reason === 'wrong').length;
    expect(counted).toBeLessThanOrEqual(PIN_RULES.maxFailures - 1);
    expect(checked.length).toBe(20);
    expect((await getPerson(t().pool, p.id))?.failedPins).toBeLessThanOrEqual(
      PIN_RULES.maxFailures,
    );
    expect(await attemptPin(t().pool, p.id, '4071', NOW)).toMatchObject({ reason: 'locked' });
  });

  test('a manager can unlock early; no PIN, switched off or unknown people cannot sign in', async () => {
    const p = await person('operator');
    for (let i = 0; i < PIN_RULES.maxFailures; i++) await attemptPin(t().pool, p.id, '9999', NOW);
    await unlockPerson(t().db, manager, p.id);
    expect(await attemptPin(t().pool, p.id, '4071', NOW)).toMatchObject({ ok: true });

    const noPin = await person('driver', null);
    expect(await attemptPin(t().pool, noPin.id, '4071', NOW)).toMatchObject({ reason: 'no_pin' });
    await updatePerson(t().db, manager, p.id, { active: false });
    expect(await attemptPin(t().pool, p.id, '4071', NOW)).toMatchObject({ reason: 'unknown' });
    expect(
      await attemptPin(t().pool, '00000000-0000-4000-8000-000000000000', '4071', NOW),
    ).toMatchObject({ reason: 'unknown' });
    expect(await attemptPin(t().pool, 'not-a-uuid', '4071', NOW)).toMatchObject({
      reason: 'unknown',
    });
  });
});

describe('people', () => {
  test('managers manage crew; only owners manage managers and owners', async () => {
    const crew = await createPerson(t().db, manager, {
      role: 'driver',
      name: uniq('Crew'),
      pin: '4071',
    });
    expect(crew).toMatchObject({ role: 'driver', active: true, hasPin: true, source: 'app' });
    expect(
      (await storeError(createPerson(t().db, manager, { role: 'manager', name: uniq('Mgr') })))
        .code,
    ).toBe('forbidden');
    expect(
      (await storeError(updatePerson(t().db, manager, crew.id, { role: 'manager' }))).code,
    ).toBe('forbidden');
    const promoted = await updatePerson(t().db, owner, crew.id, { role: 'manager' });
    expect(promoted.role).toBe('manager');
    expect((await storeError(setPersonPin(t().db, manager, crew.id, '2580'))).code).toBe(
      'forbidden',
    );
  });

  test('an existing person party gets a sign-in once; organizations never', async () => {
    const party = await t().pool.query<{ id: string }>(
      `insert into farm.parties (kind, display_name, roles) values ('person', $1, '{crew}') returning id::text as id`,
      [uniq('Crew party')],
    );
    const partyId = party.rows[0]?.id as string;
    const p = await createPerson(t().db, manager, { role: 'operator', partyId });
    expect(p.partyId).toBe(partyId);
    expect(p.hasPin).toBe(false);
    expect(
      (await storeError(createPerson(t().db, manager, { role: 'viewer', partyId }))).code,
    ).toBe('conflict');
    const org = await t().pool.query<{ id: string }>(
      `insert into farm.parties (kind, display_name) values ('org', $1) returning id::text as id`,
      [uniq('Org')],
    );
    expect(
      (
        await storeError(
          createPerson(t().db, manager, { role: 'viewer', partyId: org.rows[0]?.id }),
        )
      ).code,
    ).toBe('invalid');
  });

  test('guessable or malformed PINs and bad names are refused', async () => {
    expect((await storeError(person('driver', '1234'))).message).toMatch(/too easy/);
    expect((await storeError(person('driver', '12'))).code).toBe('invalid');
    expect(
      (await storeError(createPerson(t().db, owner, { role: 'driver', name: ' x ' }))).code,
    ).toBe('invalid');
  });

  test('the farm always keeps an active owner', async () => {
    // A fresh database has no owners: make two, then try to remove both.
    const a = await person('owner');
    const b = await person('owner');
    const others = (await listPeople(t().pool)).filter(
      (p) => p.role === 'owner' && p.active && p.id !== a.id && p.id !== b.id,
    );
    for (const o of others) await updatePerson(t().db, owner, o.id, { active: false });
    await updatePerson(t().db, owner, a.id, { role: 'manager' });
    const e = await storeError(updatePerson(t().db, owner, b.id, { active: false }));
    expect(e).toMatchObject({ code: 'conflict' });
    expect(e.message).toMatch(/at least one active owner/);
    const self = makeSession({ role: 'owner', appUserId: b.id });
    expect((await storeError(updatePerson(t().db, self, b.id, { role: 'manager' }))).code).toBe(
      'forbidden',
    );
  });

  test('switching someone off or "sign out everywhere" bumps their epoch', async () => {
    const p = await person('operator');
    await signOutEverywhere(t().db, manager, p.id);
    const r1 = await t().pool.query('select session_epoch from farm.app_users where id = $1', [
      p.id,
    ]);
    expect(r1.rows[0]?.session_epoch).toBe(1);
    await updatePerson(t().db, manager, p.id, { active: false });
    await updatePerson(t().db, manager, p.id, { active: true });
    const r2 = await t().pool.query('select session_epoch from farm.app_users where id = $1', [
      p.id,
    ]);
    expect(r2.rows[0]?.session_epoch).toBe(2);
  });

  test('the PIN pad lists active people with a PIN, from a minimum role', async () => {
    const op = await person('operator');
    const mgr = await person('manager');
    const off = await person('driver');
    await updatePerson(t().db, owner, off.id, { active: false });
    const all = (await listPickablePeople(t().pool, 'viewer')).map((p) => p.id);
    expect(all).toEqual(expect.arrayContaining([op.id, mgr.id]));
    expect(all).not.toContain(off.id);
    const managers = (await listPickablePeople(t().pool, 'manager')).map((p) => p.id);
    expect(managers).toContain(mgr.id);
    expect(managers).not.toContain(op.id);
  });
});

describe('devices and enrollment', () => {
  test('a code shows what it enrolls, works once, and expires', async () => {
    const issued = await createDevice(
      t().db,
      manager,
      SECRET,
      { name: uniq('Shop wall'), kind: 'wall', role: 'viewer' },
      NOW,
    );
    expect(issued.code).toMatch(/^[0-9A-Z]{10}$/);
    expect(issued.device).toMatchObject({
      kind: 'wall',
      role: 'viewer',
      codePending: true,
      enrolledAt: null,
    });
    const stored = await t().pool.query('select enroll_code_hash from farm.devices where id = $1', [
      issued.device.id,
    ]);
    expect(stored.rows[0]?.enroll_code_hash).not.toContain(issued.code);

    expect(await previewEnrollment(t().pool, SECRET, issued.code, NOW)).toMatchObject({
      status: 'ok',
    });
    expect(await previewEnrollment(t().pool, SECRET, issued.code, at(61))).toEqual({
      status: 'expired',
    });
    expect(await previewEnrollment(t().pool, SECRET, 'ZZZZZZZZZZ', NOW)).toEqual({
      status: 'unknown',
    });

    const used = await redeemEnrollment(t().db, SECRET, issued.code, at(5));
    expect(used.identity).toEqual({ kind: 'device', deviceId: issued.device.id, epoch: 1 });
    expect(used.device).toMatchObject({ enrolledAt: at(5), codePending: false });
    expect((await storeError(redeemEnrollment(t().db, SECRET, issued.code, at(6)))).code).toBe(
      'expired',
    );

    const late = await createDevice(
      t().db,
      manager,
      SECRET,
      { name: uniq('Cab'), kind: 'cab_ipad', role: 'operator' },
      NOW,
    );
    expect((await storeError(redeemEnrollment(t().db, SECRET, late.code, at(61)))).code).toBe(
      'expired',
    );
  });

  test('devices are never more than operators', async () => {
    const e = await storeError(
      createDevice(t().db, manager, SECRET, { name: 'Bad', kind: 'wall', role: 'manager' }, NOW),
    );
    expect(e.code).toBe('invalid');
    await expect(
      t().pool.query(`insert into farm.devices (kind, name, role) values ('wall', 'x', 'owner')`),
    ).rejects.toThrow(/devices_role_check/);
  });

  test("a personal phone signs in as its person; binding a manager's phone needs the owner", async () => {
    const crew = await person('driver');
    const issued = await createDevice(
      t().db,
      manager,
      SECRET,
      { name: uniq('Phone'), kind: 'phone', appUserId: crew.id },
      NOW,
    );
    expect(issued.device).toMatchObject({ appUserId: crew.id, personName: crew.displayName });
    const used = await redeemEnrollment(t().db, SECRET, issued.code, NOW);
    expect(used.identity).toEqual({
      kind: 'person',
      appUserId: crew.id,
      epoch: 0,
      deviceId: issued.device.id,
      deviceEpoch: 1,
    });

    const mgr = await person('manager');
    expect(
      (
        await storeError(
          createDevice(
            t().db,
            manager,
            SECRET,
            { name: 'Manager phone', kind: 'phone', appUserId: mgr.id },
            NOW,
          ),
        )
      ).code,
    ).toBe('forbidden');
    await createDevice(
      t().db,
      owner,
      SECRET,
      { name: uniq('Mgr phone'), kind: 'phone', appUserId: mgr.id },
      NOW,
    );
  });

  test('revoked devices take no new codes', async () => {
    const issued = await createDevice(
      t().db,
      manager,
      SECRET,
      { name: uniq('Truck'), kind: 'truck_ipad', role: 'driver' },
      NOW,
    );
    await redeemEnrollment(t().db, SECRET, issued.code, NOW);
    expect(await revokeDevice(t().db, issued.device.id, at(1))).toBe(true);
    expect(await revokeDevice(t().db, issued.device.id, at(2))).toBe(false);
    expect((await getDevice(t().pool, issued.device.id))?.revokedAt).toEqual(at(1));
    expect(
      (await storeError(issueEnrollCode(t().db, manager, SECRET, issued.device.id, at(3)))).code,
    ).toBe('conflict');
  });
});

describe('the device session + operator PIN contract (resolveBrowserAuth)', () => {
  const provider = createLocalAuth({ secret: SECRET, secure: false, now: () => NOW });
  const resolve = (jar: MemoryJar, now = NOW) =>
    resolveBrowserAuth({ provider, secret: SECRET, cookies: jar, ex: t().pool, now });

  async function enrolledWall() {
    const issued = await createDevice(
      t().db,
      manager,
      SECRET,
      { name: uniq('Wall'), kind: 'wall', role: 'viewer' },
      NOW,
    );
    const { identity } = await redeemEnrollment(t().db, SECRET, issued.code, NOW);
    const jar = new MemoryJar();
    if (identity.kind !== 'device') throw new Error('expected a device');
    await provider.signInDevice(jar, identity.deviceId, identity.epoch);
    return { jar, deviceId: identity.deviceId, name: issued.device.name };
  }

  test('an enrolled wall is a viewer device; last_seen is recorded', async () => {
    const wall = await enrolledWall();
    const auth = await resolve(wall.jar, at(10));
    expect(auth.session).toMatchObject({
      kind: 'device',
      deviceId: wall.deviceId,
      role: 'viewer',
      displayName: wall.name,
    });
    expect(auth.sharedDevice?.id).toBe(wall.deviceId);
    expect(auth.operatorSignedIn).toBe(false);
    expect((await getDevice(t().pool, wall.deviceId))?.lastSeenAt).toEqual(at(10));
  });

  test("an operator PIN layer gives the person's role on that device; switch user drops it", async () => {
    const wall = await enrolledWall();
    const dana = await person('operator');
    const a = await attemptPin(t().pool, dana.id, '4071', NOW);
    if (!a.ok) throw new Error('PIN refused');
    await setOperator(
      SECRET,
      false,
      wall.jar,
      { appUserId: dana.id, epoch: a.user.sessionEpoch, deviceId: wall.deviceId },
      NOW,
    );
    const auth = await resolve(wall.jar);
    expect(auth.session).toMatchObject({ kind: 'device', appUserId: dana.id, role: 'operator' });
    expect(auth.session?.displayName).toBe(`${dana.displayName} (${wall.name})`);
    expect(auth.operatorSignedIn).toBe(true);

    // The same operator cookie on another device is ignored.
    const other = await enrolledWall();
    other.jar.values.set(OPERATOR_COOKIE, wall.jar.get(OPERATOR_COOKIE)?.value as string);
    expect((await resolve(other.jar)).session).toMatchObject({ appUserId: null, role: 'viewer' });

    // Switched off: back to the bare device.
    await updatePerson(t().db, manager, dana.id, { active: false });
    expect((await resolve(wall.jar)).session).toMatchObject({ appUserId: null, role: 'viewer' });
  });

  test('revoking a device or re-enrolling it elsewhere ends its sessions at once', async () => {
    const wall = await enrolledWall();
    const issued = await issueEnrollCode(t().db, manager, SECRET, wall.deviceId, NOW);
    const moved = await redeemEnrollment(t().db, SECRET, issued.code, NOW);
    const newJar = new MemoryJar();
    if (moved.identity.kind !== 'device') throw new Error('expected a device');
    await provider.signInDevice(newJar, moved.identity.deviceId, moved.identity.epoch);
    expect(await resolve(wall.jar)).toMatchObject({ session: null, stale: true });
    expect((await resolve(newJar)).session?.deviceId).toBe(wall.deviceId);

    await revokeDevice(t().db, wall.deviceId, NOW);
    expect(await resolve(newJar)).toMatchObject({ session: null, stale: true, sharedDevice: null });
  });

  test("a personal phone given a new code signs the old phone's browser out", async () => {
    const crew = await person('operator');
    const issued = await createDevice(
      t().db,
      manager,
      SECRET,
      { name: uniq('Phone'), kind: 'phone', appUserId: crew.id },
      NOW,
    );
    const signIn = async (code: string) => {
      const used = await redeemEnrollment(t().db, SECRET, code, NOW);
      if (used.identity.kind !== 'person') throw new Error('expected a person');
      const jar = new MemoryJar();
      const id = used.identity;
      await provider.signInPerson(jar, id.appUserId, id.epoch, id.deviceId, id.deviceEpoch);
      return jar;
    };
    const oldPhone = await signIn(issued.code);
    expect((await resolve(oldPhone)).session).toMatchObject({
      kind: 'person',
      appUserId: crew.id,
      deviceId: issued.device.id,
    });

    const again = await issueEnrollCode(t().db, manager, SECRET, issued.device.id, NOW);
    const newPhone = await signIn(again.code);
    expect(await resolve(oldPhone)).toMatchObject({ session: null, stale: true });
    expect((await resolve(newPhone)).session).toMatchObject({ appUserId: crew.id });

    await revokeDevice(t().db, issued.device.id, NOW);
    expect(await resolve(newPhone)).toMatchObject({ session: null, stale: true });
  });

  test('a person session follows the row: role changes apply, sign-out-everywhere ends it', async () => {
    const mgr = await person('manager');
    const jar = new MemoryJar();
    await provider.signInPerson(jar, mgr.id, 0, null, null);
    expect((await resolve(jar)).session).toMatchObject({
      kind: 'person',
      role: 'manager',
      appUserId: mgr.id,
    });
    await updatePerson(t().db, owner, mgr.id, { role: 'driver' });
    expect((await resolve(jar)).session?.role).toBe('driver');
    await signOutEverywhere(t().db, owner, mgr.id);
    expect(await resolve(jar)).toMatchObject({ session: null, stale: true });
  });

  test('no cookie or a forged one: signed out, not stale', async () => {
    expect(await resolve(new MemoryJar())).toMatchObject({
      session: null,
      stale: false,
      identity: null,
    });
    const jar = new MemoryJar();
    jar.values.set(AUTH_COOKIE, 'eyJhbGciOiJub25lIn0.e30.');
    expect(await resolve(jar)).toMatchObject({ session: null, stale: false });
  });
});

describe('owner setup and recovery', () => {
  test('first run creates the owner once; demo and e2e owners do not count', async () => {
    await t().admin.query(`update farm.app_users set role = 'manager' where role = 'owner'`);
    expect(await realOwnerExists(t().pool)).toBe(false);
    const demoParty = await t().pool.query<{ id: string }>(
      `insert into farm.parties (kind, display_name) values ('person', 'Demo Owner') returning id::text as id`,
    );
    await t().pool.query(
      `insert into farm.app_users (party_id, role, pin_hash, source, source_id) values ($1, 'owner', 'x', 'demo', 'user:demo-owner')`,
      [demoParty.rows[0]?.id],
    );
    expect(await realOwnerExists(t().pool)).toBe(false);

    const created = await setupOwner(t().db, { name: 'Derrick Hopson', pin: '4071' }, NOW);
    expect(created.epoch).toBe(0);
    expect(await realOwnerExists(t().pool)).toBe(true);
    expect(await getPerson(t().pool, created.appUserId)).toMatchObject({
      displayName: 'Derrick Hopson',
      role: 'owner',
      hasPin: true,
      source: 'app',
    });
    expect(
      (await storeError(setupOwner(t().db, { name: 'Someone Else', pin: '2580' }, NOW))).code,
    ).toBe('conflict');
  });

  test('concurrent setups make exactly one owner', async () => {
    await t().admin.query(
      `update farm.app_users set role = 'manager' where role = 'owner' and source = 'app'`,
    );
    const results = await Promise.allSettled(
      [1, 2, 3].map((i) => setupOwner(t().db, { name: `Racer ${i}`, pin: '4071' }, NOW)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  test("a reset code sets a new PIN once, unlocks and signs out the owner's other sessions", async () => {
    const o = await person('owner');
    for (let i = 0; i < PIN_RULES.maxFailures; i++) await attemptPin(t().pool, o.id, '9999', NOW);
    const { code, expiresAt } = await issueOwnerReset(t().pool, SECRET, NOW);
    expect(expiresAt).toEqual(at(30));
    expect(await ownerResetValid(t().pool, SECRET, code, NOW)).toBe(true);
    expect(await ownerResetValid(t().pool, SECRET, code, at(31))).toBe(false);
    expect(await ownerResetValid(t().pool, SECRET, `${code.slice(0, -1)}x`, NOW)).toBe(false);
    expect(
      (await storeError(resetOwner(t().db, SECRET, code, { ownerId: o.id, pin: '2580' }, at(31))))
        .code,
    ).toBe('expired');

    const r = await resetOwner(t().db, SECRET, code, { ownerId: o.id, pin: '2580' }, at(1));
    expect(r).toEqual({ appUserId: o.id, epoch: 1 });
    expect(await attemptPin(t().pool, o.id, '2580', at(2))).toMatchObject({ ok: true });
    expect(
      (await storeError(resetOwner(t().db, SECRET, code, { ownerId: o.id, pin: '2580' }, at(2))))
        .code,
    ).toBe('expired');

    const again = await issueOwnerReset(t().pool, SECRET, NOW);
    const crew = await person('driver');
    expect(
      (
        await storeError(
          resetOwner(t().db, SECRET, again.code, { ownerId: crew.id, pin: '2580' }, at(1)),
        )
      ).code,
    ).toBe('not_found');
    // The failed attempt rolled back: the code still works for an owner.
    expect(await ownerResetValid(t().pool, SECRET, again.code, at(1))).toBe(true);
  });
});
