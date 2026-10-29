/**
 * Auth contract (plan §1 "Auth", 1a; docs/contracts-m1.md §4). Owned by the contracts stage;
 * the auth builder implements it in src/platform/auth/** (everything but this file).
 *
 * Two layers, the same in both environments:
 *  1. The PROVIDER proves the base identity of a request: an enrolled DEVICE (wall, cab or
 *     truck iPad, phone) or a PERSON (a manager or owner on their own browser). Locally that is
 *     `LocalAuth` (a signed httpOnly cookie, jose; `Secure` follows PUBLIC_URL); at MD it is
 *     Supabase Auth (`@supabase/ssr`, `getClaims()` in proxy.ts). AUTH_PROVIDER picks one.
 *     The provider returns ONLY ids (`AuthIdentity`): nothing outside src/platform/** ever sees
 *     a provider user id (plan §1 seam rule).
 *  2. The OPERATOR layer (shared devices only: wall, cab/truck iPads, D8): the person at the
 *     screen picks their name and enters a PIN, checked against farm.app_users.pin_hash with
 *     failed_pins / locked_until lockout. Same code with either provider.
 *
 * Every server-side read of private data and EVERY mutation (route handler or server action)
 * calls `requireRole(min)` (or `getSession()` when anonymous access is allowed), never trusts
 * anything the browser says about who it is, and never reads cookies itself.
 */
import { APP_ROLES, type AppRole, type DeviceKind } from '../../domain/farm';

// ---------------------------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------------------------

/** Roles, LOWEST FIRST: viewer < driver < operator < manager < owner (D8 defaults). */
export const ROLES = APP_ROLES;
export type Role = AppRole;

/** Position of a role in ROLES (0 = viewer). */
export function roleRank(role: Role): number {
  return ROLES.indexOf(role);
}

/** Does `role` meet the minimum `min`? (`roleAtLeast('manager', 'operator')` is true.) */
export function roleAtLeast(role: Role, min: Role): boolean {
  return roleRank(role) >= roleRank(min);
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/**
 * What each role may do in M1 (the auth builder enforces; others call requireRole with these).
 *  - viewer:   see the board, fields, fleet, weather (private layers included)
 *  - driver:   + mark a machine down/up, enter a soil temperature reading
 *  - operator: same as driver in M1 (field crew; spray-related actions arrive in M2)
 *  - manager:  + edit field notes, parties, fields, boundaries of non-Deere fields, tile lines,
 *              spray thresholds; admin pages; enroll devices; manage people below owner
 *  - owner:    + manage managers and owners
 */
export const ROLE_FOR = {
  viewPrivate: 'viewer',
  markMachineDown: 'driver',
  enterSoilTemp: 'driver',
  editFieldNotes: 'manager',
  editFieldData: 'manager',
  editTileLines: 'manager',
  editSprayThresholds: 'manager',
  admin: 'manager',
  manageDevices: 'manager',
  managePeople: 'manager',
  manageManagers: 'owner',
} as const satisfies Record<string, Role>;

// ---------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------

/**
 * Who is making this request, resolved on the server from the provider identity, the
 * operator layer and the database (farm.devices / farm.app_users / farm.parties).
 *
 *  - kind 'person': a person signed in on their own browser or phone. appUserId and partyId
 *    are set; deviceId is set when the browser is an enrolled personal phone.
 *  - kind 'device': an enrolled shared device. deviceId is set; appUserId/partyId are set
 *    while an operator is signed in on it with their PIN (role = the operator's role), else
 *    null (role = farm.devices.role).
 *
 * `role` is the EFFECTIVE role for authorization. `displayName` is what the UI shows
 * ("Shop wall", "Dana (Cab 2)", "Derrick").
 */
export interface Session {
  kind: 'device' | 'person';
  deviceId: string | null;
  appUserId: string | null;
  partyId: string | null;
  role: Role;
  displayName: string;
  /** The device's kind when deviceId is set (UI: PIN pad on shared kinds). */
  deviceKind: DeviceKind | null;
  /**
   * True for the stand-in session the placeholder implementation returns before the auth
   * builder's code lands (an anonymous viewer, or the admin-key holder). Real sessions: false.
   */
  provisional: boolean;
}

/** The anonymous viewer the placeholder `getSession()` returns (until 1a's sign-in lands). */
export const ANONYMOUS_VIEWER: Readonly<Session> = Object.freeze({
  kind: 'device',
  deviceId: null,
  appUserId: null,
  partyId: null,
  role: 'viewer',
  displayName: 'Anonymous viewer',
  deviceKind: null,
  provisional: true,
});

/**
 * Thrown by `requireRole` (and by anything that refuses on authorization grounds).
 *  - 401: nobody is signed in (or the session expired / was revoked): sign in or enroll.
 *  - 403: signed in, but the role is below `required`.
 * Route handlers turn it into a response with `authErrorResponse` (server.ts); server actions
 * catch it and return an error result (actions never throw to the client).
 */
export class AuthError extends Error {
  readonly status: 401 | 403;
  /** The minimum role that was required (403), if any. */
  readonly required: Role | null;
  constructor(status: 401 | 403, message?: string, required: Role | null = null) {
    super(
      message ??
        (status === 401
          ? 'sign in required'
          : `this needs the ${required ?? 'a higher'} role or above`),
    );
    this.name = 'AuthError';
    this.status = status;
    this.required = required;
  }
}

export function isAuthError(e: unknown): e is AuthError {
  return e instanceof AuthError;
}

/**
 * The server helpers (src/platform/auth/server.ts; auth builder; keep these exact signatures):
 *  - getSession(): the request's Session, or null when nobody is signed in. Reads the request's
 *    cookies through next/headers, so it works in server components, route handlers and server
 *    actions. Cached per request. Never throws for a bad or expired credential (null instead).
 *  - requireRole(min): the Session when its role is at least `min`; otherwise throws
 *    AuthError(401) (no session) or AuthError(403) (role too low).
 */
export type GetSession = () => Promise<Session | null>;
export type RequireRole = (min: Role) => Promise<Session>;

/**
 * Pure core of requireRole (unit-testable; server.ts uses it): the session if it qualifies,
 * else the AuthError to throw.
 */
export function checkRole(session: Session | null, min: Role): Session {
  if (!session) throw new AuthError(401);
  if (!roleAtLeast(session.role, min)) throw new AuthError(403, undefined, min);
  return session;
}

// ---------------------------------------------------------------------------------------------
// The provider adapter (LocalAuth now, Supabase at MD)
// ---------------------------------------------------------------------------------------------

export type AuthProviderKind = 'local' | 'supabase';

/**
 * The base identity a provider proves. Ids are OUR ids (farm.devices.id / farm.app_users.id);
 * the Supabase adapter maps its auth user id to them through `auth_user_id` columns inside
 * src/platform/**. `epoch` is the farm.devices / farm.app_users `session_epoch` the credential
 * was issued under: a credential whose epoch is below the row's current one is revoked.
 * A person on their enrolled phone carries BOTH epochs: the person's (`epoch`, "sign out
 * everywhere") and the phone's (`deviceEpoch`, bumped by revoke or by a new enrollment code
 * redeemed on a replacement phone). `deviceEpoch` is set exactly when `deviceId` is.
 */
export type AuthIdentity =
  | { kind: 'device'; deviceId: string; epoch: number }
  | {
      kind: 'person';
      appUserId: string;
      epoch: number;
      deviceId: string | null;
      deviceEpoch: number | null;
    };

/** Minimal cookie access (Next's `cookies()` satisfies it; tests pass a Map-backed fake). */
export interface CookieJar {
  get(name: string): { value: string } | undefined;
  set(
    name: string,
    value: string,
    options: {
      httpOnly: boolean;
      secure: boolean;
      sameSite: 'lax' | 'strict';
      path: string;
      maxAge?: number;
    },
  ): void;
  delete(name: string): void;
}

/**
 * One provider. Implementations: src/platform/auth/local.ts (1a), supabase.ts (MD). Both are
 * exercised by the same adapter contract suite (plan §7 "Adapter contracts").
 */
export interface AuthProvider {
  readonly kind: AuthProviderKind;
  /** The verified base identity of the request, or null (none, invalid, expired). Never throws for bad input. */
  identify(cookies: CookieJar): Promise<AuthIdentity | null>;
  /** Issue the base credential for an enrolled device (after a valid enrollment code / magic link). */
  signInDevice(cookies: CookieJar, deviceId: string, epoch: number): Promise<void>;
  /**
   * Issue the base credential for a person who proved who they are (local: PIN or manager
   * sign-in; MD: email OTP). On their enrolled phone, `deviceId` and that phone's
   * `session_epoch` (`deviceEpoch`); elsewhere both null.
   */
  signInPerson(
    cookies: CookieJar,
    appUserId: string,
    epoch: number,
    deviceId: string | null,
    deviceEpoch: number | null,
  ): Promise<void>;
  /** Remove the base credential (and with it any operator layer). */
  signOut(cookies: CookieJar): Promise<void>;
}

/** Operator PIN rules (D8): shared devices only. The auth builder may tune, not loosen. */
export const PIN_RULES = Object.freeze({
  /** Digits only, this many. */
  minLength: 4,
  maxLength: 8,
  /** Failed attempts before the user is locked out. */
  maxFailures: 5,
  /** Lockout length. */
  lockoutMinutes: 15,
  /** An operator layer on a shared device ends after this much inactivity. */
  operatorIdleMinutes: 12 * 60,
});
