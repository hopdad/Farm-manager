/**
 * LocalAuth's database side (farm.app_users, farm.devices, farm.parties, app.settings), as
 * farm_app. The provider-agnostic parts (operator PIN with lockout, devices, people, owner
 * setup) are the same code at MD; only how a device or person proves itself changes.
 *
 * Mutations that depend on other rows run in one transaction with the rows locked, and re-check
 * authorization there (./policy.ts) with the actor's Session, so two managers clicking at once
 * can't, say, demote the last owner. Times come in as `now` (tests move the clock).
 */

import type { Db, DbTx } from '../../db/client';
import { type Executor, exec, toDate } from '../../db/exec';
import type { DeviceKind, DeviceRole } from '../../domain/farm';
import { DEVICE_ROLES } from '../../domain/farm';
import { isUuid } from '../../domain/ids';
import {
  ENROLL_CODE_TTL_MINUTES,
  hashCode,
  newEnrollCode,
  newOwnerResetCode,
  OWNER_RESET_TTL_MINUTES,
} from './codes';
import { burn, hashPin, pinProblem, verifyPin } from './pin';
import { canManagePerson, canSetPin, isDeviceKind } from './policy';
import type { DeviceRecord, UserRecord } from './session';
import { type AuthIdentity, isRole, PIN_RULES, type Role, type Session } from './types';

/** A refusal or conflict the UI shows as is. */
export class AuthStoreError extends Error {
  readonly code: 'not_found' | 'forbidden' | 'conflict' | 'invalid' | 'expired';
  constructor(code: AuthStoreError['code'], message: string) {
    super(message);
    this.name = 'AuthStoreError';
    this.code = code;
  }
}

const fail = (code: AuthStoreError['code'], message: string): never => {
  throw new AuthStoreError(code, message);
};

const ROLE_ORDER_SQL = `array_position(array['owner','manager','operator','driver','viewer']::text[], u.role)`;
const minutes = (n: number) => n * 60_000;
const num = (v: unknown) => Number(v ?? 0);

// ---------------------------------------------------------------------------------------------
// Session rows
// ---------------------------------------------------------------------------------------------

interface SessionRow {
  d_id: string | null;
  d_kind: DeviceKind | null;
  d_name: string | null;
  d_role: DeviceRole | null;
  d_app_user_id: string | null;
  d_epoch: number | null;
  d_enrolled_at: unknown;
  d_revoked_at: unknown;
  d_last_seen_at: unknown;
  u_id: string | null;
  u_party_id: string | null;
  u_name: string | null;
  u_role: Role | null;
  u_active: boolean | null;
  u_epoch: number | null;
  u_has_pin: boolean | null;
  o_id: string | null;
  o_party_id: string | null;
  o_name: string | null;
  o_role: Role | null;
  o_active: boolean | null;
  o_epoch: number | null;
  o_has_pin: boolean | null;
}

function userOf(r: SessionRow, p: 'u' | 'o'): UserRecord | null {
  const id = r[`${p}_id`];
  if (!id) return null;
  return {
    id,
    partyId: r[`${p}_party_id`] as string,
    displayName: r[`${p}_name`] as string,
    role: r[`${p}_role`] as Role,
    active: !!r[`${p}_active`],
    sessionEpoch: num(r[`${p}_epoch`]),
    hasPin: !!r[`${p}_has_pin`],
  };
}

/** The device and people a credential (and its operator layer) names: one round trip. */
export async function loadSessionRows(
  ex: Executor,
  ids: { deviceId: string | null; userId: string | null; operatorUserId: string | null },
): Promise<{
  device: DeviceRecord | null;
  user: UserRecord | null;
  operatorUser: UserRecord | null;
}> {
  const clean = (v: string | null) => (v && isUuid(v) ? v : null);
  const r = await exec<SessionRow>(
    ex,
    `select d.id::text as d_id, d.kind as d_kind, d.name as d_name, d.role as d_role,
            d.app_user_id::text as d_app_user_id, d.session_epoch as d_epoch,
            d.enrolled_at as d_enrolled_at, d.revoked_at as d_revoked_at,
            d.last_seen_at as d_last_seen_at,
            u.id::text as u_id, u.party_id::text as u_party_id, up.display_name as u_name,
            u.role as u_role, u.active as u_active, u.session_epoch as u_epoch,
            (u.pin_hash is not null) as u_has_pin,
            o.id::text as o_id, o.party_id::text as o_party_id, op.display_name as o_name,
            o.role as o_role, o.active as o_active, o.session_epoch as o_epoch,
            (o.pin_hash is not null) as o_has_pin
       from (select 1) as one
       left join farm.devices d on d.id = $1::uuid
       left join farm.app_users u on u.id = $2::uuid
       left join farm.parties up on up.id = u.party_id
       left join farm.app_users o on o.id = $3::uuid
       left join farm.parties op on op.id = o.party_id`,
    [clean(ids.deviceId), clean(ids.userId), clean(ids.operatorUserId)],
  );
  const row = r.rows[0] as SessionRow;
  const device: DeviceRecord | null = row.d_id
    ? {
        id: row.d_id,
        kind: row.d_kind as DeviceKind,
        name: row.d_name as string,
        role: row.d_role as DeviceRole,
        appUserId: row.d_app_user_id,
        sessionEpoch: num(row.d_epoch),
        enrolledAt: toDate(row.d_enrolled_at),
        revokedAt: toDate(row.d_revoked_at),
        lastSeenAt: toDate(row.d_last_seen_at),
      }
    : null;
  return { device, user: userOf(row, 'u'), operatorUser: userOf(row, 'o') };
}

/** How often a device's last_seen_at is written (it is read on nearly every request). */
export const LAST_SEEN_EVERY_MS = minutes(5);

/** Record that a device was used (at most every LAST_SEEN_EVERY_MS). */
export async function touchDevice(ex: Executor, deviceId: string, now: Date): Promise<void> {
  await exec(
    ex,
    `update farm.devices set last_seen_at = $2
      where id = $1::uuid and (last_seen_at is null or last_seen_at < $3)`,
    [deviceId, now, new Date(now.getTime() - LAST_SEEN_EVERY_MS)],
  );
}

// ---------------------------------------------------------------------------------------------
// Operator PIN with lockout
// ---------------------------------------------------------------------------------------------

export type PinAttempt =
  | { ok: true; user: { id: string; role: Role; sessionEpoch: number } }
  | {
      ok: false;
      reason: 'unknown' | 'no_pin' | 'locked' | 'wrong';
      /** Set when locked (now or by this attempt). */
      lockedUntil: Date | null;
      /** Tries left before the lockout (wrong). */
      triesLeft: number | null;
    };

/** The longest lockout: repeated lockouts double up to a day. */
export const LOCKOUT_MAX_MINUTES = 24 * 60;

/**
 * How long the lockout after `failures` consecutive wrong PINs lasts (0 = not locked): every
 * PIN_RULES.maxFailures-th failure locks, for PIN_RULES.lockoutMinutes the first time and twice
 * as long each time after (15, 30, 60 min, ... up to a day), so guessing a 4-digit PIN by trying
 * them all takes years, while someone who mistypes waits 15 minutes. A right PIN or a manager's
 * Unlock resets the count.
 */
export function lockoutMinutesAfter(failures: number): number {
  if (failures <= 0 || failures % PIN_RULES.maxFailures !== 0) return 0;
  const n = failures / PIN_RULES.maxFailures;
  return Math.min(LOCKOUT_MAX_MINUTES, PIN_RULES.lockoutMinutes * 2 ** (n - 1));
}

/**
 * Check `pin` for a person. The attempt is COUNTED BEFORE the PIN is checked (one UPDATE that
 * also refuses a locked row), so parallel guesses can never get more than
 * PIN_RULES.maxFailures tries per lockout; a right PIN then clears the count. The count is not
 * cleared when a lockout ends, so the next lockout is longer (lockoutMinutesAfter).
 */
export async function attemptPin(
  ex: Executor,
  appUserId: string,
  pin: string,
  now: Date,
): Promise<PinAttempt> {
  if (!isUuid(appUserId)) {
    await burn();
    return { ok: false, reason: 'unknown', lockedUntil: null, triesLeft: null };
  }
  const reserved = await exec<{
    pin_hash: string;
    failed_pins: number;
    locked_until: unknown;
    session_epoch: number;
    role: Role;
  }>(
    ex,
    `update farm.app_users u set
        failed_pins = u.failed_pins + 1,
        locked_until = case
          when (u.failed_pins + 1) % $3::int = 0
            then $2::timestamptz + make_interval(mins => least($5::float8,
                   $4::int * power(2, (u.failed_pins + 1) / $3::int - 1))::int)
          else null end
      where u.id = $1::uuid and u.active and u.pin_hash is not null
        and (u.locked_until is null or u.locked_until <= $2::timestamptz)
      returning u.pin_hash, u.failed_pins, u.locked_until, u.session_epoch, u.role`,
    [appUserId, now, PIN_RULES.maxFailures, PIN_RULES.lockoutMinutes, LOCKOUT_MAX_MINUTES],
  );
  const row = reserved.rows[0];
  if (!row) {
    const r = await exec<{ active: boolean; has_pin: boolean; locked_until: unknown }>(
      ex,
      `select active, (pin_hash is not null) as has_pin, locked_until
         from farm.app_users where id = $1::uuid`,
      [appUserId],
    );
    const u = r.rows[0];
    const lockedUntil = toDate(u?.locked_until);
    if (u?.active && u.has_pin && lockedUntil && lockedUntil > now) {
      return { ok: false, reason: 'locked', lockedUntil, triesLeft: 0 };
    }
    await burn();
    return {
      ok: false,
      reason: u?.active ? 'no_pin' : 'unknown',
      lockedUntil: null,
      triesLeft: null,
    };
  }
  if (await verifyPin(pin, row.pin_hash)) {
    await exec(
      ex,
      `update farm.app_users set failed_pins = 0, locked_until = null, last_sign_in_at = $2
        where id = $1::uuid`,
      [appUserId, now],
    );
    return {
      ok: true,
      user: { id: appUserId, role: row.role, sessionEpoch: num(row.session_epoch) },
    };
  }
  const lockedUntil = toDate(row.locked_until);
  return lockedUntil
    ? { ok: false, reason: 'locked', lockedUntil, triesLeft: 0 }
    : {
        ok: false,
        reason: 'wrong',
        lockedUntil: null,
        triesLeft: PIN_RULES.maxFailures - (num(row.failed_pins) % PIN_RULES.maxFailures),
      };
}

/** The sentence a PIN pad shows for a failed attempt. */
export function pinAttemptMessage(a: Exclude<PinAttempt, { ok: true }>, now: Date): string {
  switch (a.reason) {
    case 'locked': {
      const mins = a.lockedUntil
        ? Math.max(1, Math.ceil((a.lockedUntil.getTime() - now.getTime()) / 60_000))
        : PIN_RULES.lockoutMinutes;
      return `Too many wrong PINs: locked for ${mins} minute${mins === 1 ? '' : 's'}. Ask a manager to unlock you sooner.`;
    }
    case 'wrong':
      return `Wrong PIN. ${a.triesLeft} ${a.triesLeft === 1 ? 'try' : 'tries'} left before a lockout.`;
    case 'no_pin':
      return 'No PIN is set for this person yet: ask a manager to set one.';
    default:
      return 'That person cannot sign in here.';
  }
}

// ---------------------------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------------------------

export interface PersonRow {
  id: string;
  partyId: string;
  displayName: string;
  role: Role;
  active: boolean;
  hasPin: boolean;
  pinSetAt: Date | null;
  failedPins: number;
  lockedUntil: Date | null;
  lastSignInAt: Date | null;
  source: string;
}

interface RawPerson {
  id: string;
  party_id: string;
  display_name: string;
  role: Role;
  active: boolean;
  has_pin: boolean;
  pin_set_at: unknown;
  failed_pins: number;
  locked_until: unknown;
  last_sign_in_at: unknown;
  source: string;
}

const PERSON_SELECT = `
  select u.id::text as id, u.party_id::text as party_id, p.display_name, u.role, u.active,
         (u.pin_hash is not null) as has_pin, u.pin_set_at, u.failed_pins, u.locked_until,
         u.last_sign_in_at, u.source
    from farm.app_users u join farm.parties p on p.id = u.party_id`;

const toPerson = (r: RawPerson): PersonRow => ({
  id: r.id,
  partyId: r.party_id,
  displayName: r.display_name,
  role: r.role,
  active: r.active,
  hasPin: r.has_pin,
  pinSetAt: toDate(r.pin_set_at),
  failedPins: num(r.failed_pins),
  lockedUntil: toDate(r.locked_until),
  lastSignInAt: toDate(r.last_sign_in_at),
  source: r.source,
});

/** Everyone who can (or could) sign in: active first, then by role (owner first), then name. */
export async function listPeople(ex: Executor): Promise<PersonRow[]> {
  const r = await exec<RawPerson>(
    ex,
    `${PERSON_SELECT} order by u.active desc, ${ROLE_ORDER_SQL}, lower(p.display_name), u.id`,
  );
  return r.rows.map(toPerson);
}

export async function getPerson(ex: Executor, id: string): Promise<PersonRow | null> {
  if (!isUuid(id)) return null;
  const r = await exec<RawPerson>(ex, `${PERSON_SELECT} where u.id = $1::uuid`, [id]);
  return r.rows[0] ? toPerson(r.rows[0]) : null;
}

export interface PickablePerson {
  id: string;
  displayName: string;
  role: Role;
  lockedUntil: Date | null;
}

/**
 * The names a PIN pad offers: active people with a PIN, from `minRole` up (shared devices: all;
 * a personal browser's sign-in: PERSON_SIGN_IN_MIN_ROLE).
 */
export async function listPickablePeople(ex: Executor, minRole: Role): Promise<PickablePerson[]> {
  const roles = ['viewer', 'driver', 'operator', 'manager', 'owner'];
  const allowed = roles.slice(roles.indexOf(minRole));
  const r = await exec<{ id: string; display_name: string; role: Role; locked_until: unknown }>(
    ex,
    `select u.id::text as id, p.display_name, u.role, u.locked_until
       from farm.app_users u join farm.parties p on p.id = u.party_id
      where u.active and u.pin_hash is not null and u.role = any($1::text[])
      order by lower(p.display_name), u.id`,
    [allowed],
  );
  return r.rows.map((x) => ({
    id: x.id,
    displayName: x.display_name,
    role: x.role,
    lockedUntil: toDate(x.locked_until),
  }));
}

/** People (party kind 'person') with no sign-in yet: crew first. */
export async function listPeopleWithoutSignIn(
  ex: Executor,
): Promise<{ partyId: string; displayName: string; crew: boolean }[]> {
  const r = await exec<{ id: string; display_name: string; crew: boolean }>(
    ex,
    `select p.id::text as id, p.display_name, ('crew' = any(p.roles)) as crew
       from farm.parties p
      where p.kind = 'person'
        and not exists (select 1 from farm.app_users u where u.party_id = p.id)
      order by ('crew' = any(p.roles)) desc, lower(p.display_name)
      limit 500`,
  );
  return r.rows.map((x) => ({ partyId: x.id, displayName: x.display_name, crew: x.crew }));
}

const cleanName = (name: unknown): string => {
  const s = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
  if (s.length < 2 || s.length > 80) fail('invalid', 'a name is 2 to 80 characters');
  return s;
};

/**
 * Give someone a sign-in: an existing person party (`partyId`, e.g. a crew member the demo
 * seed or the parties admin made) or a new one (`name`). Optional first PIN.
 */
export async function createPerson(
  db: Db,
  actor: Session,
  input: { role: Role; partyId?: string | null; name?: string | null; pin?: string | null },
): Promise<PersonRow> {
  if (!isRole(input.role)) fail('invalid', 'unknown role');
  const verdict = canManagePerson(actor, { id: null, role: input.role });
  if (!verdict.ok) fail('forbidden', verdict.reason);
  if (input.pin) {
    const problem = pinProblem(input.pin);
    if (problem) fail('invalid', problem);
  }
  const pinHash = input.pin ? await hashPin(input.pin) : null;
  const id = await db.transaction(async (tx: DbTx) => {
    let partyId: string;
    if (input.partyId) {
      if (!isUuid(input.partyId)) fail('invalid', 'unknown person');
      const p = await exec<{ kind: string }>(
        tx,
        'select kind from farm.parties where id = $1::uuid for update',
        [input.partyId],
      );
      if (p.rows[0]?.kind !== 'person') fail('invalid', 'pick a person (not an organization)');
      const taken = await exec(tx, 'select 1 from farm.app_users where party_id = $1::uuid', [
        input.partyId,
      ]);
      if (taken.rowCount) fail('conflict', 'that person already has a sign-in');
      partyId = input.partyId;
    } else {
      const name = cleanName(input.name);
      const p = await exec<{ id: string }>(
        tx,
        `insert into farm.parties (kind, display_name, roles, source)
         values ('person', $1, $2::text[], 'app') returning id::text as id`,
        [name, input.role === 'owner' ? ['owner'] : ['crew']],
      );
      partyId = (p.rows[0] as { id: string }).id;
    }
    const u = await exec<{ id: string }>(
      tx,
      `insert into farm.app_users (party_id, role, pin_hash, pin_set_at, source)
       values ($1::uuid, $2, $3, case when $3::text is null then null else now() end, 'app')
       returning id::text as id`,
      [partyId, input.role, pinHash],
    );
    return (u.rows[0] as { id: string }).id;
  });
  return (await getPerson(db, id)) as PersonRow;
}

async function lockPerson(
  tx: DbTx,
  id: string,
): Promise<{ id: string; role: Role; active: boolean }> {
  if (!isUuid(id)) fail('not_found', 'no such person');
  const r = await exec<{ id: string; role: Role; active: boolean }>(
    tx,
    'select id::text as id, role, active from farm.app_users where id = $1::uuid for update',
    [id],
  );
  return r.rows[0] ?? fail('not_found', 'no such person');
}

/** Refuse leaving the farm without an active owner. */
async function assertAnotherOwner(tx: DbTx, exceptId: string): Promise<void> {
  // Lock every owner row so two concurrent demotions can't each see the other.
  const r = await exec<{ id: string }>(
    tx,
    `select id::text as id from farm.app_users
      where role = 'owner' and active and id <> $1::uuid for update`,
    [exceptId],
  );
  if (!r.rowCount) fail('conflict', 'the farm must keep at least one active owner');
}

/** Change someone's role and/or switch them on or off. */
export async function updatePerson(
  db: Db,
  actor: Session,
  id: string,
  change: { role?: Role; active?: boolean },
): Promise<PersonRow> {
  if (change.role !== undefined && !isRole(change.role)) fail('invalid', 'unknown role');
  await db.transaction(async (tx: DbTx) => {
    const target = await lockPerson(tx, id);
    const verdict = canManagePerson(actor, target, change);
    if (!verdict.ok) fail('forbidden', verdict.reason);
    const losesOwner =
      target.role === 'owner' &&
      target.active &&
      ((change.role !== undefined && change.role !== 'owner') || change.active === false);
    if (losesOwner) await assertAnotherOwner(tx, id);
    await exec(
      tx,
      `update farm.app_users set
          role = coalesce($2, role),
          active = coalesce($3, active),
          -- switching someone off ends their sessions now (and for good if switched back on)
          session_epoch = session_epoch + case when $3::boolean is false and active then 1 else 0 end,
          updated_at = now()
        where id = $1::uuid`,
      [id, change.role ?? null, change.active ?? null],
    );
  });
  return (await getPerson(db, id)) as PersonRow;
}

/** Set (or replace) someone's PIN; clears any lockout. */
export async function setPersonPin(db: Db, actor: Session, id: string, pin: string): Promise<void> {
  const problem = pinProblem(pin);
  if (problem) fail('invalid', problem);
  const pinHash = await hashPin(pin);
  await db.transaction(async (tx: DbTx) => {
    const target = await lockPerson(tx, id);
    const verdict = canSetPin(actor, target);
    if (!verdict.ok) fail('forbidden', verdict.reason);
    await exec(
      tx,
      `update farm.app_users set pin_hash = $2, pin_set_at = now(), failed_pins = 0,
              locked_until = null, updated_at = now()
        where id = $1::uuid`,
      [id, pinHash],
    );
  });
}

/** Clear a lockout early. */
export async function unlockPerson(db: Db, actor: Session, id: string): Promise<void> {
  await db.transaction(async (tx: DbTx) => {
    const target = await lockPerson(tx, id);
    const verdict = canManagePerson(actor, target);
    if (!verdict.ok) fail('forbidden', verdict.reason);
    await exec(
      tx,
      'update farm.app_users set failed_pins = 0, locked_until = null where id = $1::uuid',
      [id],
    );
  });
}

/** End every session of a person (their browsers, phones and operator layers). */
export async function signOutEverywhere(db: Db, actor: Session, id: string): Promise<void> {
  await db.transaction(async (tx: DbTx) => {
    const target = await lockPerson(tx, id);
    if (target.id !== actor.appUserId) {
      const verdict = canManagePerson(actor, target);
      if (!verdict.ok) fail('forbidden', verdict.reason);
    }
    await exec(
      tx,
      `update farm.app_users set session_epoch = session_epoch + 1, updated_at = now()
        where id = $1::uuid`,
      [id],
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Devices and enrollment
// ---------------------------------------------------------------------------------------------

export interface DeviceRow {
  id: string;
  kind: DeviceKind;
  name: string;
  role: DeviceRole;
  appUserId: string | null;
  personName: string | null;
  enrolledAt: Date | null;
  enrollExpiresAt: Date | null;
  codePending: boolean;
  revokedAt: Date | null;
  lastSeenAt: Date | null;
  createdAt: Date;
  source: string;
}

interface RawDevice {
  id: string;
  kind: DeviceKind;
  name: string;
  role: DeviceRole;
  app_user_id: string | null;
  person_name: string | null;
  enrolled_at: unknown;
  enroll_expires_at: unknown;
  code_pending: boolean;
  revoked_at: unknown;
  last_seen_at: unknown;
  created_at: unknown;
  source: string;
}

const DEVICE_SELECT = `
  select d.id::text as id, d.kind, d.name, d.role, d.app_user_id::text as app_user_id,
         p.display_name as person_name, d.enrolled_at, d.enroll_expires_at,
         (d.enroll_code_hash is not null) as code_pending, d.revoked_at, d.last_seen_at,
         d.created_at, d.source
    from farm.devices d
    left join farm.app_users u on u.id = d.app_user_id
    left join farm.parties p on p.id = u.party_id`;

const toDevice = (r: RawDevice): DeviceRow => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  role: r.role,
  appUserId: r.app_user_id,
  personName: r.person_name,
  enrolledAt: toDate(r.enrolled_at),
  enrollExpiresAt: toDate(r.enroll_expires_at),
  codePending: r.code_pending,
  revokedAt: toDate(r.revoked_at),
  lastSeenAt: toDate(r.last_seen_at),
  createdAt: toDate(r.created_at) as Date,
  source: r.source,
});

/** Every device: in use first, then by kind and name. */
export async function listDevices(ex: Executor): Promise<DeviceRow[]> {
  const r = await exec<RawDevice>(
    ex,
    `${DEVICE_SELECT} order by (d.revoked_at is null) desc, d.kind, lower(d.name), d.id`,
  );
  return r.rows.map(toDevice);
}

export async function getDevice(ex: Executor, id: string): Promise<DeviceRow | null> {
  if (!isUuid(id)) return null;
  const r = await exec<RawDevice>(ex, `${DEVICE_SELECT} where d.id = $1::uuid`, [id]);
  return r.rows[0] ? toDevice(r.rows[0]) : null;
}

export interface IssuedCode {
  device: DeviceRow;
  /** The one-time code, unformatted (shown once; only its hash is stored). */
  code: string;
  expiresAt: Date;
}

/** A phone bound to someone signs in as them: the actor must be allowed to manage them. */
async function assertMayBindPhone(tx: DbTx, actor: Session, appUserId: string): Promise<void> {
  const target = await lockPerson(tx, appUserId);
  if (!target.active) fail('invalid', 'that person is switched off');
  const verdict = canManagePerson(actor, target);
  if (!verdict.ok) fail('forbidden', verdict.reason);
}

/** Add a device and issue its first enrollment code. */
export async function createDevice(
  db: Db,
  actor: Session,
  secret: string,
  input: { name: unknown; kind: unknown; role?: unknown; appUserId?: string | null },
  now: Date,
): Promise<IssuedCode> {
  const name = cleanName(input.name);
  if (!isDeviceKind(input.kind)) fail('invalid', 'unknown device kind');
  const kind = input.kind as DeviceKind;
  const role = (input.role ?? 'viewer') as DeviceRole;
  if (!(DEVICE_ROLES as readonly string[]).includes(role)) {
    fail('invalid', 'a device on its own is at most an operator');
  }
  const appUserId = kind === 'phone' && input.appUserId ? input.appUserId : null;
  const code = newEnrollCode();
  const expiresAt = new Date(now.getTime() + minutes(ENROLL_CODE_TTL_MINUTES));
  const id = await db.transaction(async (tx: DbTx) => {
    if (appUserId) await assertMayBindPhone(tx, actor, appUserId);
    const r = await exec<{ id: string }>(
      tx,
      `insert into farm.devices (kind, name, role, app_user_id, enroll_code_hash, enroll_expires_at,
                                 created_by, source)
       values ($1, $2, $3, $4::uuid, $5, $6, $7::uuid, 'app')
       returning id::text as id`,
      [
        kind,
        name,
        kind === 'phone' ? 'viewer' : role,
        appUserId,
        hashCode(secret, 'enroll', code),
        expiresAt,
        actor.appUserId,
      ],
    );
    return (r.rows[0] as { id: string }).id;
  });
  return { device: (await getDevice(db, id)) as DeviceRow, code, expiresAt };
}

/** A new enrollment code for a device (moving it to another browser, or the old one expired). */
export async function issueEnrollCode(
  db: Db,
  actor: Session,
  secret: string,
  deviceId: string,
  now: Date,
): Promise<IssuedCode> {
  if (!isUuid(deviceId)) fail('not_found', 'no such device');
  const code = newEnrollCode();
  const expiresAt = new Date(now.getTime() + minutes(ENROLL_CODE_TTL_MINUTES));
  await db.transaction(async (tx: DbTx) => {
    const d = await exec<{ app_user_id: string | null; revoked_at: unknown }>(
      tx,
      'select app_user_id::text as app_user_id, revoked_at from farm.devices where id = $1::uuid for update',
      [deviceId],
    );
    const row = d.rows[0] ?? fail('not_found', 'no such device');
    if (row.revoked_at) fail('conflict', 'this device was revoked: add it again as a new device');
    if (row.app_user_id) await assertMayBindPhone(tx, actor, row.app_user_id);
    await exec(
      tx,
      `update farm.devices set enroll_code_hash = $2, enroll_expires_at = $3, updated_at = now()
        where id = $1::uuid`,
      [deviceId, hashCode(secret, 'enroll', code), expiresAt],
    );
  });
  return { device: (await getDevice(db, deviceId)) as DeviceRow, code, expiresAt };
}

/** Rename a device or change what it may do on its own. */
export async function updateDevice(
  db: Db,
  deviceId: string,
  change: { name?: unknown; role?: unknown },
): Promise<DeviceRow> {
  if (!isUuid(deviceId)) fail('not_found', 'no such device');
  const name = change.name === undefined ? null : cleanName(change.name);
  const role = change.role === undefined ? null : (change.role as DeviceRole);
  if (role !== null && !(DEVICE_ROLES as readonly string[]).includes(role)) {
    fail('invalid', 'a device on its own is at most an operator');
  }
  const r = await exec(
    db,
    `update farm.devices set name = coalesce($2, name),
            role = case when kind = 'phone' then role else coalesce($3, role) end,
            updated_at = now()
      where id = $1::uuid`,
    [deviceId, name, role],
  );
  if (!r.rowCount) fail('not_found', 'no such device');
  return (await getDevice(db, deviceId)) as DeviceRow;
}

/** Revoke a device: every cookie it holds stops working on its next request. */
export async function revokeDevice(db: Db, deviceId: string, now: Date): Promise<boolean> {
  if (!isUuid(deviceId)) return false;
  const r = await exec(
    db,
    `update farm.devices set revoked_at = $2, enroll_code_hash = null, enroll_expires_at = null,
            session_epoch = session_epoch + 1, updated_at = $2
      where id = $1::uuid and revoked_at is null`,
    [deviceId, now],
  );
  return r.rowCount > 0;
}

export type EnrollPreview =
  | { status: 'ok'; device: DeviceRow }
  | { status: 'expired' | 'unknown' | 'revoked' };

/** What a code would enroll, without using it (the /enroll confirmation page). */
export async function previewEnrollment(
  ex: Executor,
  secret: string,
  code: string,
  now: Date,
): Promise<EnrollPreview> {
  const r = await exec<RawDevice>(ex, `${DEVICE_SELECT} where d.enroll_code_hash = $1`, [
    hashCode(secret, 'enroll', code),
  ]);
  const row = r.rows[0];
  if (!row) return { status: 'unknown' };
  const device = toDevice(row);
  if (device.revokedAt) return { status: 'revoked' };
  if (!device.enrollExpiresAt || device.enrollExpiresAt <= now) return { status: 'expired' };
  return { status: 'ok', device };
}

/**
 * Use a code: the device is enrolled (again) for this browser, and the identity to sign in with
 * comes back. One UPDATE consumes the code, so it works exactly once; bumping session_epoch
 * signs out whichever browser held the device before.
 */
export async function redeemEnrollment(
  db: Db,
  secret: string,
  code: string,
  now: Date,
): Promise<{ device: DeviceRow; identity: AuthIdentity }> {
  const identity = await db.transaction(async (tx: DbTx): Promise<AuthIdentity> => {
    const r = await exec<{ id: string; app_user_id: string | null; session_epoch: number }>(
      tx,
      `update farm.devices d set enroll_code_hash = null, enroll_expires_at = null,
              enrolled_at = $2, session_epoch = d.session_epoch + 1, last_seen_at = $2,
              updated_at = $2
        where d.enroll_code_hash = $1 and d.enroll_expires_at > $2 and d.revoked_at is null
        returning d.id::text as id, d.app_user_id::text as app_user_id, d.session_epoch`,
      [hashCode(secret, 'enroll', code), now],
    );
    const d = r.rows[0] ?? fail('expired', 'this code was already used or has expired');
    if (!d.app_user_id) return { kind: 'device', deviceId: d.id, epoch: num(d.session_epoch) };
    const u = await exec<{ session_epoch: number; active: boolean }>(
      tx,
      'select session_epoch, active from farm.app_users where id = $1::uuid',
      [d.app_user_id],
    );
    const user = u.rows[0];
    if (!user?.active) fail('invalid', 'the person this phone belongs to is switched off');
    return {
      kind: 'person',
      appUserId: d.app_user_id,
      epoch: num(user?.session_epoch),
      deviceId: d.id,
      // The bump above signs out whichever browser held this phone before.
      deviceEpoch: num(d.session_epoch),
    };
  });
  const deviceId = identity.kind === 'device' ? identity.deviceId : (identity.deviceId as string);
  return { device: (await getDevice(db, deviceId)) as DeviceRow, identity };
}

// ---------------------------------------------------------------------------------------------
// The owner: first-run setup and recovery
// ---------------------------------------------------------------------------------------------

/**
 * Has the farm's owner been set up in the app? Owners from the demo seed or the e2e suite
 * (source 'demo' / 'e2e') don't count: they must not swallow Derrick's first-run link.
 */
export async function realOwnerExists(ex: Executor): Promise<boolean> {
  const r = await exec<{ exists: boolean }>(
    ex,
    `select exists (select 1 from farm.app_users
                     where role = 'owner' and active and pin_hash is not null and source = 'app')
            as exists`,
  );
  return !!r.rows[0]?.exists;
}

/** First run: create the owner (a person party + an owner sign-in with a PIN). */
export async function setupOwner(
  db: Db,
  input: { name: unknown; pin: string },
  now: Date,
): Promise<{ appUserId: string; epoch: number }> {
  const name = cleanName(input.name);
  const problem = pinProblem(input.pin);
  if (problem) fail('invalid', problem);
  const pinHash = await hashPin(input.pin);
  return db.transaction(async (tx: DbTx) => {
    // One setup at a time (two browsers submitting the form at once).
    await exec(tx, `select pg_advisory_xact_lock(hashtext('farm-ops:owner-setup'))`);
    if (await realOwnerExists(tx)) {
      fail(
        'conflict',
        'the owner is already set up: sign in at /login (recovery: pnpm auth:reset-owner)',
      );
    }
    const p = await exec<{ id: string }>(
      tx,
      `insert into farm.parties (kind, display_name, roles, source)
       values ('person', $1, array['owner']::text[], 'app') returning id::text as id`,
      [name],
    );
    const u = await exec<{ id: string; session_epoch: number }>(
      tx,
      `insert into farm.app_users (party_id, role, pin_hash, pin_set_at, last_sign_in_at, source)
       values ($1::uuid, 'owner', $2, $3, $3, 'app')
       returning id::text as id, session_epoch`,
      [(p.rows[0] as { id: string }).id, pinHash, now],
    );
    const row = u.rows[0] as { id: string; session_epoch: number };
    return { appUserId: row.id, epoch: num(row.session_epoch) };
  });
}

export const OWNER_RESET_KEY = 'auth.owner_reset';

/** `pnpm auth:reset-owner`: a one-time code (OWNER_RESET_TTL_MINUTES) to set an owner's PIN. */
export async function issueOwnerReset(
  ex: Executor,
  secret: string,
  now: Date,
): Promise<{ code: string; expiresAt: Date }> {
  const code = newOwnerResetCode();
  const expiresAt = new Date(now.getTime() + minutes(OWNER_RESET_TTL_MINUTES));
  await exec(
    ex,
    `insert into app.settings (key, value, updated_at) values ($1, $2::jsonb, $3)
     on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    [
      OWNER_RESET_KEY,
      JSON.stringify({
        codeHash: hashCode(secret, 'owner-reset', code),
        expiresAt: expiresAt.toISOString(),
      }),
      now,
    ],
  );
  return { code, expiresAt };
}

/** Is `code` the current, unexpired reset code? (Doesn't use it.) */
export async function ownerResetValid(
  ex: Executor,
  secret: string,
  code: string,
  now: Date,
): Promise<boolean> {
  const r = await exec(
    ex,
    `select 1 from app.settings
      where key = $1 and value->>'codeHash' = $2 and (value->>'expiresAt')::timestamptz > $3`,
    [OWNER_RESET_KEY, hashCode(secret, 'owner-reset', code), now],
  );
  return r.rowCount > 0;
}

/** Owners, for the reset form (switched-off ones too: recovery may need to switch one back on). */
export async function listOwners(ex: Executor): Promise<{ id: string; displayName: string }[]> {
  const r = await exec<{ id: string; display_name: string }>(
    ex,
    `select u.id::text as id, p.display_name
       from farm.app_users u join farm.parties p on p.id = u.party_id
      where u.role = 'owner'
      order by u.active desc, (u.source = 'app') desc, lower(p.display_name)`,
  );
  return r.rows.map((x) => ({ id: x.id, displayName: x.display_name }));
}

/**
 * Use a reset code: the owner gets a new PIN, is switched on and unlocked, and every older
 * session of theirs ends. The code works once.
 */
export async function resetOwner(
  db: Db,
  secret: string,
  code: string,
  input: { ownerId: string; pin: string },
  now: Date,
): Promise<{ appUserId: string; epoch: number }> {
  const problem = pinProblem(input.pin);
  if (problem) fail('invalid', problem);
  if (!isUuid(input.ownerId)) fail('invalid', 'pick an owner');
  const pinHash = await hashPin(input.pin);
  return db.transaction(async (tx: DbTx) => {
    const used = await exec(
      tx,
      `delete from app.settings
        where key = $1 and value->>'codeHash' = $2 and (value->>'expiresAt')::timestamptz > $3`,
      [OWNER_RESET_KEY, hashCode(secret, 'owner-reset', code), now],
    );
    if (!used.rowCount) fail('expired', 'this reset link was already used or has expired');
    const u = await exec<{ session_epoch: number }>(
      tx,
      `update farm.app_users set pin_hash = $2, pin_set_at = $3, failed_pins = 0,
              locked_until = null, active = true, session_epoch = session_epoch + 1,
              last_sign_in_at = $3, updated_at = $3
        where id = $1::uuid and role = 'owner'
        returning session_epoch`,
      [input.ownerId, pinHash, now],
    );
    const row = u.rows[0] ?? fail('not_found', 'no such owner');
    return { appUserId: input.ownerId, epoch: num(row.session_epoch) };
  });
}
