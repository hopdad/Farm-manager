/**
 * LocalAuth: the `local` AuthProvider (plan §1 "Auth"; docs/contracts-m1.md §4). The base
 * credential is one signed httpOnly cookie (`farm_auth`, ./tokens.ts) holding an AuthIdentity:
 * an enrolled device, or a person (optionally on the phone enrolled for them). `Secure` follows
 * PUBLIC_URL (`cfg.cookieSecure`), SameSite=Lax, so sign-in works over http://<lan-ip> under
 * `pnpm pilot`.
 *
 * The provider only proves identity; whether the device or person still stands (revoked,
 * switched off, epoch bumped) is checked against the database by ./session.ts on every
 * request. The Supabase provider (MD) implements the same interface and passes the same
 * contract suite (./provider-contract.ts).
 */
import { AUTH_COOKIE, OPERATOR_COOKIE, SESSION_TTL_SECONDS, sessionCookieOptions } from './cookies';
import { signIdentity, verifyIdentity } from './tokens';
import type { AuthIdentity, AuthProvider, CookieJar } from './types';

export interface LocalAuthOptions {
  /** SESSION_SECRET. */
  secret: string;
  /** cfg.cookieSecure (PUBLIC_URL is https). */
  secure: boolean;
  /** Clock (tests). */
  now?: () => Date;
}

export function createLocalAuth(opts: LocalAuthOptions): AuthProvider {
  const now = opts.now ?? (() => new Date());
  async function issue(cookies: CookieJar, identity: AuthIdentity): Promise<void> {
    const ttl =
      identity.kind === 'device' ? SESSION_TTL_SECONDS.device : SESSION_TTL_SECONDS.person;
    const token = await signIdentity(opts.secret, identity, now(), ttl);
    cookies.set(AUTH_COOKIE, token, sessionCookieOptions(opts.secure, ttl));
    // A new base identity never inherits an operator layer from before.
    cookies.delete(OPERATOR_COOKIE);
  }
  return {
    kind: 'local',
    async identify(cookies) {
      const v = await verifyIdentity(opts.secret, cookies.get(AUTH_COOKIE)?.value, now());
      return v?.identity ?? null;
    },
    signInDevice(cookies, deviceId, epoch) {
      return issue(cookies, { kind: 'device', deviceId, epoch });
    },
    signInPerson(cookies, appUserId, epoch, deviceId) {
      return issue(cookies, { kind: 'person', appUserId, epoch, deviceId });
    },
    async signOut(cookies) {
      cookies.delete(AUTH_COOKIE);
      cookies.delete(OPERATOR_COOKIE);
    },
  };
}
