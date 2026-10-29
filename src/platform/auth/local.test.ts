/**
 * LocalAuth: the provider contract, plus what is specific to the local cookie: its flags
 * (httpOnly, SameSite=Lax, Secure from PUBLIC_URL), the secret, expiry.
 */
import { describe, expect, test } from 'vitest';
import { parseConfig } from '../../config';
import { AUTH_COOKIE, SESSION_TTL_SECONDS } from './cookies';
import { createLocalAuth } from './local';
import { getAuthProvider } from './provider';
import { authProviderContract, MemoryJar } from './provider-contract';

const SECRET = 'local-auth-test-secret-0123456789abcdef';
const DEVICE = '0b9cfe4e-7b0e-4bb4-9a4e-6c1f7a0d2a11';

authProviderContract('LocalAuth', () => createLocalAuth({ secret: SECRET, secure: false }));

describe('LocalAuth cookie', () => {
  test('httpOnly, SameSite=Lax, Path=/, long-lived; Secure only when told', async () => {
    for (const secure of [false, true]) {
      const jar = new MemoryJar();
      await createLocalAuth({ secret: SECRET, secure }).signInDevice(jar, DEVICE, 0);
      expect(jar.options.get(AUTH_COOKIE)).toEqual({
        httpOnly: true,
        secure,
        sameSite: 'lax',
        path: '/',
        maxAge: SESSION_TTL_SECONDS.device,
      });
    }
  });

  test('Secure follows PUBLIC_URL, never NODE_ENV (pilot is a production build over http)', () => {
    const env = {
      DATABASE_URL: 'postgres://u:p@127.0.0.1:15432/db',
      JOBS_SECRET: 'j'.repeat(32),
      SESSION_SECRET: SECRET,
    };
    const http = parseConfig({ ...env, PUBLIC_URL: 'http://192.168.1.50:3000' });
    const https = parseConfig({ ...env, PUBLIC_URL: 'https://farm.example' });
    expect(http.cookieSecure).toBe(false);
    expect(https.cookieSecure).toBe(true);
  });

  test('another install (other SESSION_SECRET) cannot read the cookie', async () => {
    const jar = new MemoryJar();
    await createLocalAuth({ secret: SECRET, secure: false }).signInDevice(jar, DEVICE, 0);
    const other = createLocalAuth({ secret: 'another-secret-0123456789abcdef-xyz', secure: false });
    expect(await other.identify(jar)).toBeNull();
  });

  test('a person credential expires after its lifetime', async () => {
    let now = new Date('2026-11-01T12:00:00Z');
    const p = createLocalAuth({ secret: SECRET, secure: false, now: () => now });
    const jar = new MemoryJar();
    await p.signInPerson(jar, DEVICE, 0, null);
    now = new Date(now.getTime() + (SESSION_TTL_SECONDS.person - 60) * 1000);
    expect(await p.identify(jar)).not.toBeNull();
    now = new Date(now.getTime() + 120_000);
    expect(await p.identify(jar)).toBeNull();
  });
});

describe('getAuthProvider', () => {
  test('local is LocalAuth, supabase is refused until MD', () => {
    expect(
      getAuthProvider({ AUTH_PROVIDER: 'local', SESSION_SECRET: SECRET, cookieSecure: false }).kind,
    ).toBe('local');
    expect(() =>
      getAuthProvider({ AUTH_PROVIDER: 'supabase', SESSION_SECRET: SECRET, cookieSecure: false }),
    ).toThrow(/MD/);
  });
});
