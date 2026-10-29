/** Cookie signing (jose HS256): round trips, tampering, expiry, audiences, secrets. */
import { decodeJwt, decodeProtectedHeader, SignJWT } from 'jose';
import { describe, expect, test } from 'vitest';
import { sessionCookieOptions } from './cookies';
import { flipMiddle } from './provider-contract';
import { sessionKey, signIdentity, signOperator, verifyIdentity, verifyOperator } from './tokens';

const SECRET = 'tokens-test-secret-0123456789abcdef-xyz';
const NOW = new Date('2026-11-16T13:00:00Z');
const A = '0b9cfe4e-7b0e-4bb4-9a4e-6c1f7a0d2a11';
const B = '6a1d2f8c-3e4b-4c5d-8e9f-0a1b2c3d4e5f';
const later = (s: number) => new Date(NOW.getTime() + s * 1000);

describe('identity tokens', () => {
  test('device and person identities round-trip', async () => {
    const d = await signIdentity(SECRET, { kind: 'device', deviceId: A, epoch: 4 }, NOW, 3600);
    expect((await verifyIdentity(SECRET, d, NOW))?.identity).toEqual({
      kind: 'device',
      deviceId: A,
      epoch: 4,
    });
    const p = await signIdentity(
      SECRET,
      { kind: 'person', appUserId: B, epoch: 0, deviceId: A, deviceEpoch: 3 },
      NOW,
      3600,
    );
    const v = await verifyIdentity(SECRET, p, NOW);
    expect(v?.identity).toEqual({
      kind: 'person',
      appUserId: B,
      epoch: 0,
      deviceId: A,
      deviceEpoch: 3,
    });
    expect(v?.times.exp).toBe(Math.floor(NOW.getTime() / 1000) + 3600);
  });

  test("a phone credential without the phone's epoch (issued before it existed) is refused", async () => {
    const old = await new SignJWT({ k: 'p', ep: 0, dev: A })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('farm-ops')
      .setAudience('farm:identity')
      .setSubject(B)
      .setIssuedAt(Math.floor(NOW.getTime() / 1000))
      .setExpirationTime(Math.floor(NOW.getTime() / 1000) + 60)
      .sign(sessionKey(SECRET));
    expect(await verifyIdentity(SECRET, old, NOW)).toBeNull();
  });

  test('carries only ids and an epoch (no names, no roles), HS256', async () => {
    const t = await signIdentity(
      SECRET,
      { kind: 'person', appUserId: B, epoch: 1, deviceId: null, deviceEpoch: null },
      NOW,
      60,
    );
    expect(decodeProtectedHeader(t).alg).toBe('HS256');
    const claims = decodeJwt(t);
    expect(Object.keys(claims).sort()).toEqual(['aud', 'ep', 'exp', 'iat', 'iss', 'k', 'sub']);
  });

  test('expired, tampered, foreign or garbage tokens verify to null', async () => {
    const t = await signIdentity(SECRET, { kind: 'device', deviceId: A, epoch: 0 }, NOW, 60);
    expect(await verifyIdentity(SECRET, t, later(59))).not.toBeNull();
    expect(await verifyIdentity(SECRET, t, later(61))).toBeNull();
    const [h, p, s] = t.split('.') as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ ...decodeJwt(t), ep: 99 })).toString('base64url');
    expect(await verifyIdentity(SECRET, `${h}.${forged}.${s}`, NOW)).toBeNull();
    expect(await verifyIdentity(SECRET, `${h}.${p}.${flipMiddle(s)}`, NOW)).toBeNull();
    expect(await verifyIdentity('another-secret-0123456789abcdef-xyz!', t, NOW)).toBeNull();
    for (const junk of [undefined, null, '', 'a.b.c', 'x'.repeat(5000)]) {
      expect(await verifyIdentity(SECRET, junk, NOW)).toBeNull();
    }
  });

  test('alg=none and a non-uuid subject are refused', async () => {
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(
      JSON.stringify({
        k: 'd',
        ep: 0,
        sub: A,
        aud: 'farm:identity',
        iss: 'farm-ops',
        iat: 1,
        exp: 9e9,
      }),
    ).toString('base64url')}.`;
    expect(await verifyIdentity(SECRET, none, NOW)).toBeNull();
    const notUuid = await new SignJWT({ k: 'd', ep: 0 })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('farm-ops')
      .setAudience('farm:identity')
      .setSubject("1' or '1'='1")
      .setIssuedAt(NOW)
      .setExpirationTime(later(60))
      .sign(sessionKey(SECRET));
    expect(await verifyIdentity(SECRET, notUuid, NOW)).toBeNull();
  });
});

describe('operator tokens', () => {
  test('round-trip, bound to the device', async () => {
    const t = await signOperator(SECRET, { appUserId: B, epoch: 2, deviceId: A }, NOW, 600);
    expect((await verifyOperator(SECRET, t, NOW))?.operator).toEqual({
      appUserId: B,
      epoch: 2,
      deviceId: A,
    });
    expect(await verifyOperator(SECRET, t, later(601))).toBeNull();
  });

  test('an operator token is not an identity and vice versa (audiences)', async () => {
    const op = await signOperator(SECRET, { appUserId: B, epoch: 0, deviceId: A }, NOW, 600);
    const id = await signIdentity(SECRET, { kind: 'device', deviceId: A, epoch: 0 }, NOW, 600);
    expect(await verifyIdentity(SECRET, op, NOW)).toBeNull();
    expect(await verifyOperator(SECRET, id, NOW)).toBeNull();
  });

  test('the session key is derived (not the secret itself) and stable', () => {
    expect(Buffer.from(sessionKey(SECRET)).equals(Buffer.from(sessionKey(SECRET)))).toBe(true);
    expect(Buffer.from(sessionKey(SECRET)).toString('utf8')).not.toContain(SECRET.slice(0, 8));
    expect(sessionKey(SECRET)).toHaveLength(32);
  });
});

describe('cookie options', () => {
  test('clamped to the 400-day browser cap', () => {
    expect(sessionCookieOptions(false, 10 ** 9).maxAge).toBe(400 * 24 * 3600);
    expect(sessionCookieOptions(true, 60)).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60,
    });
  });
});
