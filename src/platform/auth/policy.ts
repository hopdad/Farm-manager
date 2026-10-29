/**
 * Who may do what to whom (pure; the server actions call these after requireRole, and the
 * database transaction re-checks what depends on other rows, e.g. "the last owner").
 *
 * D8 defaults (docs/contracts-m1.md §14), easy to change here:
 *  - people below manager (viewer, driver, operator) are managed by managers and owners
 *    (ROLE_FOR.managePeople); managers and owners only by owners (ROLE_FOR.manageManagers);
 *  - nobody changes their own role or switches themselves off (no self-lockout);
 *  - a person signs in with name + PIN on their own browser only from PERSON_SIGN_IN_MIN_ROLE up
 *    (managers and the owner); crew use a shared device's PIN pad or a phone a manager enrolled;
 *  - a device on its own is at most an operator (DEVICE_ROLES; a CHECK in the database);
 *  - a personal phone enrolled for someone signs in as that person, so binding a phone to a
 *    manager or owner needs the right to manage that person.
 */
import {
  DEVICE_KINDS,
  type DeviceKind,
  type DeviceRole,
  SHARED_DEVICE_KINDS,
} from '../../domain/farm';
import { ROLE_FOR, type Role, roleAtLeast, type Session } from './types';

/** Lowest role that may sign in with name + PIN on a browser that isn't a shared device. */
export const PERSON_SIGN_IN_MIN_ROLE: Role = 'manager';

export type Verdict = { ok: true } | { ok: false; reason: string };
const OK: Verdict = { ok: true };
const no = (reason: string): Verdict => ({ ok: false, reason });

/** The minimum role an actor needs to manage someone who has (or will get) `role`. */
export function roleNeededToManage(role: Role): Role {
  return roleAtLeast(role, 'manager') ? ROLE_FOR.manageManagers : ROLE_FOR.managePeople;
}

/**
 * May `actor` create someone with `role`, or change `target` (current role, and the new role if
 * it changes)? `self` = the target is the actor.
 */
export function canManagePerson(
  actor: Session,
  target: { id: string | null; role: Role },
  change: { role?: Role; active?: boolean } = {},
): Verdict {
  if (!roleAtLeast(actor.role, ROLE_FOR.managePeople)) {
    return no(`managing people needs the ${ROLE_FOR.managePeople} role`);
  }
  const self = target.id !== null && target.id === actor.appUserId;
  if (self && change.role !== undefined && change.role !== target.role) {
    return no('you cannot change your own role (ask the owner)');
  }
  if (self && change.active === false) return no('you cannot switch yourself off');
  for (const r of [target.role, change.role]) {
    if (r === undefined) continue;
    const need = roleNeededToManage(r);
    if (!roleAtLeast(actor.role, need)) {
      return no(`only the ${need} can manage ${r === 'owner' ? 'owners' : 'managers'}`);
    }
  }
  return OK;
}

/** May `actor` set this person's PIN? Their own PIN always; anyone else's as for managing. */
export function canSetPin(actor: Session, target: { id: string; role: Role }): Verdict {
  if (target.id === actor.appUserId && actor.kind === 'person') return OK;
  return canManagePerson(actor, target);
}

export function isSharedKind(kind: DeviceKind | null | undefined): boolean {
  return !!kind && (SHARED_DEVICE_KINDS as readonly string[]).includes(kind);
}

export function isDeviceKind(value: unknown): value is DeviceKind {
  return typeof value === 'string' && (DEVICE_KINDS as readonly string[]).includes(value);
}

/** What a new device of each kind may do on its own (before an operator signs in). */
export const DEFAULT_DEVICE_ROLE: Record<DeviceKind, DeviceRole> = {
  wall: 'viewer',
  cab_ipad: 'operator',
  truck_ipad: 'driver',
  phone: 'viewer',
};

export const DEVICE_KIND_LABELS: Record<DeviceKind, string> = {
  wall: 'Wall display',
  cab_ipad: 'Cab iPad',
  truck_ipad: 'Truck iPad',
  phone: 'Phone (personal)',
};

/** Where an enrolled device lands: the wall on /board, everything else on /m. */
export function homePathFor(kind: DeviceKind | null | undefined): '/board' | '/m' {
  return kind === 'wall' ? '/board' : '/m';
}

/**
 * The `next` parameter of /login, made safe: a same-origin path only (no `//host`, no
 * backslashes, no scheme), else null.
 */
export function safeNextPath(next: unknown): string | null {
  if (typeof next !== 'string' || next.length > 512) return null;
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return null;
  if ([...next].some((ch) => ch.charCodeAt(0) < 0x20 || ch === '\u007f')) return null;
  if (next === '/login' || next.startsWith('/login?') || next.startsWith('/login/')) return null;
  try {
    const u = new URL(next, 'http://x.invalid');
    if (u.origin !== 'http://x.invalid') return null;
    return `${u.pathname}${u.search}`;
  } catch {
    return null;
  }
}
