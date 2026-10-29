/**
 * Sessions in e2e (docs/contracts-m1.md §2 "E2E sessions", §4). Every M1 spec gets its session
 * from `signInAs`, before its first navigation, and never calls `unlockAdmin` itself (only M0's
 * specs do):
 *
 *   await signInAs(context, 'driver');                 // the role the action needs (ROLE_FOR)
 *   await signInAs(context);                           // 'viewer': reads
 *   await signInAs(phone, 'viewer', 'http://<lan-ip>:3000'); // a context on another host
 *
 * Real sessions (LocalAuth, src/platform/auth): the cookie is signed with this checkout's
 * SESSION_SECRET for rows in the app's database (DATABASE_URL), so it also works against an
 * E2E_BASE_URL that shares both (like unlockAdmin). The principals are e2e rows (source 'e2e',
 * deterministic ids), created or repaired on first use:
 *  - 'viewer': the "E2E viewer kiosk", an enrolled wall device with the viewer role (the same
 *    session e2e/global-setup.ts puts in every context's storageState for the suite's host);
 *  - 'driver' and up: a person session for "E2E <Role>" (a person on their own browser).
 * Cookies belong to one host: a context that opens the app on another origin than the suite's
 * baseURL (the M0 demo's phone on the LAN address) passes that origin.
 *
 * The helpers below the line are for the auth specs: throwaway people and devices (source 'e2e',
 * source_id 'tmp:…', removed by the next run's global setup), cookies for them, the LAN origin.
 */
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import type { BrowserContext } from '@playwright/test';
import pg from 'pg';
import { getConfig, getE2eSettings } from '../../src/config';
import type { DeviceKind, DeviceRole } from '../../src/domain/farm';
import { deterministicId } from '../../src/domain/ids';
import { AUTH_COOKIE, OPERATOR_COOKIE, SESSION_TTL_SECONDS } from '../../src/platform/auth/cookies';
import { demoPin } from '../../src/platform/auth/demo';
import { hashPin } from '../../src/platform/auth/pin';
import { signIdentity } from '../../src/platform/auth/tokens';
import type { AuthIdentity, Role } from '../../src/platform/auth/types';

export const E2E_SOURCE = 'e2e';
export const VIEWER_KIOSK_ID = deterministicId(E2E_SOURCE, 'device:viewer-kiosk');
export const VIEWER_KIOSK_NAME = 'E2E viewer kiosk';

const ROLE_NAMES: Record<Exclude<Role, 'viewer'>, string> = {
  driver: 'E2E Driver',
  operator: 'E2E Operator',
  manager: 'E2E Manager',
  owner: 'E2E Owner',
};

export const e2eUserId = (role: Role): string => deterministicId(E2E_SOURCE, `user:${role}`);
/** The e2e people's PIN (per install, like the demo PINs). */
export const e2ePin = (role: Role): string => demoPin(getConfig().SESSION_SECRET, `e2e-${role}`);
export const e2eName = (role: Exclude<Role, 'viewer'>): string => ROLE_NAMES[role];

let pool: pg.Pool | null = null;
/** One small pool per process, as farm_app (what the app runs as); never keeps a worker alive. */
export function e2ePool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: getConfig().DATABASE_URL,
      max: 2,
      allowExitOnIdle: true,
      application_name: 'farm-e2e',
    });
    pool.on('error', () => {});
  }
  return pool;
}

export async function closeE2ePool(): Promise<void> {
  const p = pool;
  pool = null;
  await p?.end();
}

// ---------------------------------------------------------------------------------------------
// Principals
// ---------------------------------------------------------------------------------------------

async function ensurePerson(
  db: pg.Pool,
  input: { id: string; partyId: string; sourceId: string; name: string; role: Role; pin: string },
): Promise<number> {
  await db.query(
    `insert into farm.parties (id, kind, display_name, roles, source, source_id)
     values ($1, 'person', $2, '{crew}', $3, $4)
     on conflict (id) do update set display_name = excluded.display_name`,
    [input.partyId, input.name, E2E_SOURCE, input.sourceId],
  );
  const r = await db.query<{ session_epoch: number }>(
    `insert into farm.app_users (id, party_id, role, pin_hash, pin_set_at, source, source_id)
     values ($1, $2, $3, $4, now(), $5, $6)
     on conflict (id) do update set role = excluded.role, active = true, failed_pins = 0,
       locked_until = null, pin_hash = coalesce(farm.app_users.pin_hash, excluded.pin_hash)
     returning session_epoch`,
    [input.id, input.partyId, input.role, await hashPin(input.pin), E2E_SOURCE, input.sourceId],
  );
  return r.rows[0]?.session_epoch ?? 0;
}

/** The viewer kiosk: enrolled, not revoked, a viewer wall. Returns its session epoch. */
async function ensureViewerKiosk(db: pg.Pool): Promise<number> {
  const r = await db.query<{ session_epoch: number }>(
    `insert into farm.devices (id, kind, name, role, enrolled_at, source, source_id)
     values ($1, 'wall', $2, 'viewer', now(), $3, 'device:viewer-kiosk')
     on conflict (id) do update set kind = 'wall', role = 'viewer', revoked_at = null,
       enrolled_at = coalesce(farm.devices.enrolled_at, now())
     returning session_epoch`,
    [VIEWER_KIOSK_ID, VIEWER_KIOSK_NAME, E2E_SOURCE],
  );
  return r.rows[0]?.session_epoch ?? 0;
}

const identities = new Map<Role, Promise<AuthIdentity>>();

/** The identity `signInAs(role)` signs (created or repaired on first use in this worker). */
export function e2eIdentity(role: Role): Promise<AuthIdentity> {
  let p = identities.get(role);
  if (!p) {
    p = (async (): Promise<AuthIdentity> => {
      if (role === 'viewer') {
        const epoch = await ensureViewerKiosk(e2ePool());
        return { kind: 'device', deviceId: VIEWER_KIOSK_ID, epoch };
      }
      const id = e2eUserId(role);
      const epoch = await ensurePerson(e2ePool(), {
        id,
        partyId: deterministicId(E2E_SOURCE, `party:${role}`),
        sourceId: `user:${role}`,
        name: ROLE_NAMES[role],
        role,
        pin: e2ePin(role),
      });
      return { kind: 'person', appUserId: id, epoch, deviceId: null, deviceEpoch: null };
    })();
    p.catch(() => identities.delete(role));
    identities.set(role, p);
  }
  return p;
}

/** A signed `farm_auth` value for an identity (what the app would set after a sign-in). */
export function identityCookie(identity: AuthIdentity): Promise<string> {
  const ttl = identity.kind === 'device' ? SESSION_TTL_SECONDS.device : SESSION_TTL_SECONDS.person;
  return signIdentity(getConfig().SESSION_SECRET, identity, new Date(), ttl);
}

/** Put `identity` on `context` for `baseURL`'s host (and drop any operator layer). */
export async function applyIdentity(
  context: BrowserContext,
  identity: AuthIdentity,
  baseURL: string = getE2eSettings().baseURL,
): Promise<void> {
  await context.clearCookies({ name: OPERATOR_COOKIE });
  await context.addCookies([
    {
      name: AUTH_COOKIE,
      value: await identityCookie(identity),
      url: baseURL,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
}

export async function signInAs(
  context: BrowserContext,
  role: Role = 'viewer',
  baseURL: string = getE2eSettings().baseURL,
): Promise<void> {
  await applyIdentity(context, await e2eIdentity(role), baseURL);
}

// ---------------------------------------------------------------------------------------------
// Throwaway people and devices for the auth specs
// ---------------------------------------------------------------------------------------------

const tmpKey = () => `tmp:${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;

export interface TmpPerson {
  id: string;
  name: string;
  pin: string;
  role: Role;
}

/** A person with a PIN, unique to this test (e.g. for a lockout). */
export async function createTmpPerson(role: Role, label: string, pin = '4071'): Promise<TmpPerson> {
  const key = tmpKey();
  const name = `E2E ${label} ${key.slice(-4)}`;
  const id = deterministicId(E2E_SOURCE, `user:${key}`);
  await ensurePerson(e2ePool(), {
    id,
    partyId: deterministicId(E2E_SOURCE, `party:${key}`),
    sourceId: key,
    name,
    role,
    pin,
  });
  return { id, name, pin, role };
}

/** An enrolled device, unique to this test, and its identity. */
export async function createTmpDevice(
  kind: DeviceKind,
  role: DeviceRole,
  label: string,
): Promise<{ id: string; name: string; identity: AuthIdentity }> {
  const key = tmpKey();
  const id = deterministicId(E2E_SOURCE, `device:${key}`);
  const name = `E2E ${label} ${key.slice(-4)}`;
  await e2ePool().query(
    `insert into farm.devices (id, kind, name, role, enrolled_at, source, source_id)
     values ($1, $2, $3, $4, now(), $5, $6)`,
    [id, kind, name, role, E2E_SOURCE, key],
  );
  return { id, name, identity: { kind: 'device', deviceId: id, epoch: 0 } };
}

/**
 * Remove what earlier runs left: throwaway e2e people and devices, and devices the specs added
 * through /admin/devices (named 'E2E …'). The fixed principals stay.
 */
export async function pruneE2eLeftovers(db: pg.Pool = e2ePool()): Promise<void> {
  await db.query(
    `delete from farm.devices
      where (source = $1 and source_id like 'tmp:%') or (source = 'app' and name like 'E2E %')`,
    [E2E_SOURCE],
  );
  await db.query(`delete from farm.app_users where source = $1 and source_id like 'tmp:%'`, [
    E2E_SOURCE,
  ]);
  await db.query(
    `delete from farm.parties p where p.source = $1 and p.source_id like 'tmp:%'
        and not exists (select 1 from farm.app_users u where u.party_id = p.id)`,
    [E2E_SOURCE],
  );
}

/**
 * After a run: the e2e people are switched off and the e2e devices revoked, so nothing the
 * suite created can sign in between runs (on Derrick's PC the suite runs against his dev
 * database); throwaway rows are removed. The next run's signInAs / global setup turn the fixed
 * principals back on.
 */
export async function retireE2ePrincipals(db: pg.Pool = e2ePool()): Promise<void> {
  await pruneE2eLeftovers(db);
  await db.query(`update farm.app_users set active = false where source = $1 and active`, [
    E2E_SOURCE,
  ]);
  await db.query(
    `update farm.devices set revoked_at = now() where source = $1 and revoked_at is null`,
    [E2E_SOURCE],
  );
}

/**
 * The app's origin on this machine's LAN address (what a phone on the shop Wi-Fi opens), or
 * null when the machine has none. Prefers an address listed in DEV_ORIGINS.
 */
export function lanOrigin(baseURL: string = getE2eSettings().baseURL): string | null {
  const mine = Object.values(networkInterfaces())
    .flatMap((a) => a ?? [])
    .filter((a) => a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
  const ip = mine.find((a) => getConfig().DEV_ORIGINS.includes(a)) ?? mine[0];
  if (!ip) return null;
  const u = new URL(baseURL);
  return `${u.protocol}//${ip}${u.port ? `:${u.port}` : ''}`;
}
