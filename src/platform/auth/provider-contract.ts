/**
 * The AuthProvider adapter contract (plan §7 "Adapter contracts": auth): what every provider
 * must do, run against LocalAuth now (./local.test.ts) and the Supabase provider at MD. Test
 * code only (it imports vitest); the cookie jar fake lives here too.
 */
import { describe, expect, test } from 'vitest';
import { AUTH_COOKIE, OPERATOR_COOKIE } from './cookies';
import type { AuthProvider, CookieJar } from './types';

type SetOptions = Parameters<CookieJar['set']>[2];

/** A Map-backed CookieJar that also remembers the options of each Set-Cookie. */
export class MemoryJar implements CookieJar {
  readonly values = new Map<string, string>();
  readonly options = new Map<string, SetOptions>();
  get(name: string) {
    const value = this.values.get(name);
    return value === undefined ? undefined : { value };
  }
  set(name: string, value: string, options: SetOptions) {
    this.values.set(name, value);
    this.options.set(name, options);
  }
  delete(name: string) {
    this.values.delete(name);
    this.options.delete(name);
  }
}

/**
 * Change one character in the middle of a token. (Not the last one: base64url's last character
 * carries padding bits, so changing it can decode to the same bytes.)
 */
export function flipMiddle(token: string): string {
  const i = Math.floor(token.length / 2);
  const c = token[i] === 'A' ? 'B' : 'A';
  return `${token.slice(0, i)}${c}${token.slice(i + 1)}`;
}

const DEVICE = '0b9cfe4e-7b0e-4bb4-9a4e-6c1f7a0d2a11';
const PERSON = '6a1d2f8c-3e4b-4c5d-8e9f-0a1b2c3d4e5f';

export function authProviderContract(name: string, makeProvider: () => AuthProvider): void {
  describe(`AuthProvider contract: ${name}`, () => {
    test('no credential: identify is null', async () => {
      expect(await makeProvider().identify(new MemoryJar())).toBeNull();
    });

    test('a device signed in is identified as that device and epoch', async () => {
      const p = makeProvider();
      const jar = new MemoryJar();
      await p.signInDevice(jar, DEVICE, 3);
      expect(await p.identify(jar)).toEqual({ kind: 'device', deviceId: DEVICE, epoch: 3 });
    });

    test('a person signed in is identified, with or without their phone', async () => {
      const p = makeProvider();
      const jar = new MemoryJar();
      await p.signInPerson(jar, PERSON, 0, null, null);
      expect(await p.identify(jar)).toEqual({
        kind: 'person',
        appUserId: PERSON,
        epoch: 0,
        deviceId: null,
        deviceEpoch: null,
      });
      await p.signInPerson(jar, PERSON, 2, DEVICE, 5);
      expect(await p.identify(jar)).toEqual({
        kind: 'person',
        appUserId: PERSON,
        epoch: 2,
        deviceId: DEVICE,
        deviceEpoch: 5,
      });
    });

    test('signing in replaces the previous identity and drops any operator layer', async () => {
      const p = makeProvider();
      const jar = new MemoryJar();
      await p.signInDevice(jar, DEVICE, 0);
      jar.set(OPERATOR_COOKIE, 'x', { httpOnly: true, secure: false, sameSite: 'lax', path: '/' });
      await p.signInPerson(jar, PERSON, 1, null, null);
      expect((await p.identify(jar))?.kind).toBe('person');
      expect(jar.get(OPERATOR_COOKIE)).toBeUndefined();
    });

    test('sign out removes the credential and the operator layer', async () => {
      const p = makeProvider();
      const jar = new MemoryJar();
      await p.signInDevice(jar, DEVICE, 0);
      jar.set(OPERATOR_COOKIE, 'x', { httpOnly: true, secure: false, sameSite: 'lax', path: '/' });
      await p.signOut(jar);
      expect(await p.identify(jar)).toBeNull();
      expect(jar.get(OPERATOR_COOKIE)).toBeUndefined();
    });

    test('a tampered credential is no credential (never throws)', async () => {
      const p = makeProvider();
      const jar = new MemoryJar();
      await p.signInDevice(jar, DEVICE, 0);
      const v = jar.get(AUTH_COOKIE)?.value ?? '';
      for (const bad of [`${v}x`, flipMiddle(v), 'garbage', '']) {
        jar.values.set(AUTH_COOKIE, bad);
        expect(await p.identify(jar)).toBeNull();
      }
    });
  });
}
