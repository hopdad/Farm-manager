/**
 * From a verified credential plus the rows it names to the request's Session (pure; ./store.ts
 * loads the rows, ./server.ts calls it). Everything that can revoke access is checked here:
 *
 *  - device identity: the device exists, is enrolled, not revoked, and the credential's epoch is
 *    not below farm.devices.session_epoch (re-enrolling or revoking bumps it);
 *  - person identity: the person is active and the epoch is not below
 *    farm.app_users.session_epoch ("sign out everywhere"); when it names a phone, that phone is
 *    still enrolled, not revoked, still belongs to that person, and the credential's phone
 *    epoch is not below farm.devices.session_epoch (a new code redeemed on a replacement
 *    phone, or a revoke, ends the old browser's session);
 *  - operator layer (shared devices only): bound to this device, the person is active, still
 *    has a PIN, and the epoch holds. A bad operator layer falls back to the device session.
 *
 * The role always comes from the row, never from the cookie: demoting someone takes effect on
 * their next request.
 */
import type { DeviceKind, DeviceRole } from '../../domain/farm';
import { isSharedKind } from './policy';
import type { OperatorClaims } from './tokens';
import type { AuthIdentity, Role, Session } from './types';

export interface DeviceRecord {
  id: string;
  kind: DeviceKind;
  name: string;
  role: DeviceRole;
  appUserId: string | null;
  sessionEpoch: number;
  enrolledAt: Date | null;
  revokedAt: Date | null;
  lastSeenAt: Date | null;
}

export interface UserRecord {
  id: string;
  partyId: string;
  displayName: string;
  role: Role;
  active: boolean;
  sessionEpoch: number;
  hasPin: boolean;
}

/** Is the device usable for a credential issued at `epoch`? */
export function deviceAccepts(device: DeviceRecord | null, epoch: number | null): boolean {
  if (!device || device.revokedAt || !device.enrolledAt) return false;
  return epoch === null || epoch >= device.sessionEpoch;
}

/** Is the person usable for a credential issued at `epoch`? */
export function userAccepts(user: UserRecord | null, epoch: number): user is UserRecord {
  return !!user && user.active && epoch >= user.sessionEpoch;
}

export interface SessionInputs {
  identity: AuthIdentity;
  /** The identity's device (device identity) or phone (person identity with deviceId). */
  device: DeviceRecord | null;
  /** The identity's person (person identity). */
  user: UserRecord | null;
  /** A verified operator layer and its person, when the cookie is present. */
  operator: { claims: OperatorClaims; user: UserRecord | null } | null;
}

/** The Session, or null when the credential no longer stands. */
export function buildSession({ identity, device, user, operator }: SessionInputs): Session | null {
  if (identity.kind === 'device') {
    if (!device || device.id !== identity.deviceId) return null;
    if (!deviceAccepts(device, identity.epoch)) return null;
    const op = operatorOn(device, operator);
    if (op) {
      return {
        kind: 'device',
        deviceId: device.id,
        appUserId: op.id,
        partyId: op.partyId,
        role: op.role,
        displayName: `${op.displayName} (${device.name})`,
        deviceKind: device.kind,
        provisional: false,
      };
    }
    return {
      kind: 'device',
      deviceId: device.id,
      appUserId: null,
      partyId: null,
      role: device.role,
      displayName: device.name,
      deviceKind: device.kind,
      provisional: false,
    };
  }

  if (!user || user.id !== identity.appUserId || !userAccepts(user, identity.epoch)) return null;
  if (identity.deviceId) {
    if (!device || device.id !== identity.deviceId) return null;
    if (identity.deviceEpoch === null || !deviceAccepts(device, identity.deviceEpoch)) return null;
    if (device.appUserId !== user.id) return null;
  }
  return {
    kind: 'person',
    deviceId: identity.deviceId,
    appUserId: user.id,
    partyId: user.partyId,
    role: user.role,
    displayName: user.displayName,
    deviceKind: identity.deviceId ? (device?.kind ?? null) : null,
    provisional: false,
  };
}

/** The operator signed in on this shared device, if the layer still stands. */
export function operatorOn(
  device: DeviceRecord,
  operator: SessionInputs['operator'],
): UserRecord | null {
  if (!operator || !isSharedKind(device.kind)) return null;
  if (operator.claims.deviceId !== device.id) return null;
  const u = operator.user;
  if (!u || u.id !== operator.claims.appUserId) return null;
  if (!userAccepts(u, operator.claims.epoch) || !u.hasPin) return null;
  return u;
}
