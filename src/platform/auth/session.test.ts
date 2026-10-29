/** From credential + rows to the Session: every way access is revoked, and the operator layer. */
import { describe, expect, test } from 'vitest';
import { buildSession, type DeviceRecord, type UserRecord } from './session';

const WALL = '0b9cfe4e-7b0e-4bb4-9a4e-6c1f7a0d2a11';
const PHONE = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const DANA = '6a1d2f8c-3e4b-4c5d-8e9f-0a1b2c3d4e5f';
const EVE = '7b2e3f9d-4f5c-4d6e-9fa0-1b2c3d4e5f60';

const wall: DeviceRecord = {
  id: WALL,
  kind: 'wall',
  name: 'Shop wall',
  role: 'viewer',
  appUserId: null,
  sessionEpoch: 2,
  enrolledAt: new Date('2026-11-16T12:00:00Z'),
  revokedAt: null,
  lastSeenAt: null,
};
const dana: UserRecord = {
  id: DANA,
  partyId: 'f0f0f0f0-0000-4000-8000-000000000001',
  displayName: 'Dana Pike',
  role: 'operator',
  active: true,
  sessionEpoch: 1,
  hasPin: true,
};
const phone: DeviceRecord = {
  ...wall,
  id: PHONE,
  kind: 'phone',
  name: "Dana's phone",
  appUserId: DANA,
};

describe('device identity', () => {
  const identity = { kind: 'device' as const, deviceId: WALL, epoch: 2 };

  test('an enrolled device is a device session with its own role', () => {
    expect(buildSession({ identity, device: wall, user: null, operator: null })).toEqual({
      kind: 'device',
      deviceId: WALL,
      appUserId: null,
      partyId: null,
      role: 'viewer',
      displayName: 'Shop wall',
      deviceKind: 'wall',
      provisional: false,
    });
  });

  test('revoked, not enrolled, re-enrolled elsewhere (epoch) or missing: no session', () => {
    const cases: [DeviceRecord | null, number][] = [
      [{ ...wall, revokedAt: new Date() }, 2],
      [{ ...wall, enrolledAt: null }, 2],
      [{ ...wall, sessionEpoch: 3 }, 2],
      [null, 2],
      [{ ...wall, id: PHONE }, 2],
    ];
    for (const [device, epoch] of cases) {
      expect(
        buildSession({ identity: { ...identity, epoch }, device, user: null, operator: null }),
      ).toBeNull();
    }
  });

  test('an operator on a shared device: their role and name, on that device', () => {
    const s = buildSession({
      identity,
      device: wall,
      user: null,
      operator: { claims: { appUserId: DANA, epoch: 1, deviceId: WALL }, user: dana },
    });
    expect(s).toMatchObject({
      kind: 'device',
      deviceId: WALL,
      appUserId: DANA,
      partyId: dana.partyId,
      role: 'operator',
      displayName: 'Dana Pike (Shop wall)',
    });
  });

  test('a bad operator layer falls back to the bare device session', () => {
    const claims = { appUserId: DANA, epoch: 1, deviceId: WALL };
    const bad: [typeof claims, UserRecord | null, DeviceRecord][] = [
      [{ ...claims, deviceId: PHONE }, dana, wall], // made on another device
      [claims, { ...dana, active: false }, wall], // switched off
      [claims, { ...dana, sessionEpoch: 2 }, wall], // signed out everywhere
      [claims, { ...dana, hasPin: false }, wall], // PIN removed
      [claims, null, wall], // person gone
      [{ ...claims, appUserId: EVE }, dana, wall], // row is someone else
      [claims, dana, { ...wall, kind: 'phone' }], // not a shared device
    ];
    for (const [c, user, device] of bad) {
      const s = buildSession({ identity, device, user: null, operator: { claims: c, user } });
      expect(s?.appUserId ?? null).toBeNull();
      expect(s?.role ?? 'viewer').toBe('viewer');
    }
  });
});

describe('person identity', () => {
  test('a person on their own browser', () => {
    const s = buildSession({
      identity: { kind: 'person', appUserId: DANA, epoch: 1, deviceId: null, deviceEpoch: null },
      device: null,
      user: dana,
      operator: null,
    });
    expect(s).toEqual({
      kind: 'person',
      deviceId: null,
      appUserId: DANA,
      partyId: dana.partyId,
      role: 'operator',
      displayName: 'Dana Pike',
      deviceKind: null,
      provisional: false,
    });
  });

  test('the role comes from the row (a demotion takes effect at once)', () => {
    const s = buildSession({
      identity: { kind: 'person', appUserId: DANA, epoch: 1, deviceId: null, deviceEpoch: null },
      device: null,
      user: { ...dana, role: 'viewer' },
      operator: null,
    });
    expect(s?.role).toBe('viewer');
  });

  test('switched off or signed out everywhere: no session', () => {
    for (const user of [{ ...dana, active: false }, { ...dana, sessionEpoch: 2 }, null]) {
      expect(
        buildSession({
          identity: {
            kind: 'person',
            appUserId: DANA,
            epoch: 1,
            deviceId: null,
            deviceEpoch: null,
          },
          device: null,
          user,
          operator: null,
        }),
      ).toBeNull();
    }
  });

  test('on their enrolled phone: the phone must stand and still be theirs', () => {
    const identity = {
      kind: 'person' as const,
      appUserId: DANA,
      epoch: 1,
      deviceId: PHONE,
      deviceEpoch: 2,
    };
    expect(buildSession({ identity, device: phone, user: dana, operator: null })).toMatchObject({
      kind: 'person',
      deviceId: PHONE,
      deviceKind: 'phone',
    });
    for (const device of [
      { ...phone, revokedAt: new Date() },
      { ...phone, appUserId: EVE },
      { ...phone, appUserId: null },
      // The phone got a new enrollment code, redeemed on a replacement phone.
      { ...phone, sessionEpoch: 3 },
      null,
    ]) {
      expect(buildSession({ identity, device, user: dana, operator: null })).toBeNull();
    }
    // A phone credential that lost its phone epoch never stands.
    expect(
      buildSession({
        identity: { ...identity, deviceEpoch: null },
        device: phone,
        user: dana,
        operator: null,
      }),
    ).toBeNull();
  });
});
