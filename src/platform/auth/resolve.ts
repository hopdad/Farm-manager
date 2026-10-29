/**
 * One browser's auth state from its cookies (no next/headers here, so DB tests drive it with a
 * fake cookie jar): the provider's identity, the operator layer, the rows they name, and the
 * resulting Session. ./server.ts (getSession) and the /login page use it.
 */
import type { Executor } from '../../db/exec';
import { readOperator } from './operator';
import { isSharedKind } from './policy';
import { buildSession, type DeviceRecord, deviceAccepts } from './session';
import { LAST_SEEN_EVERY_MS, loadSessionRows, touchDevice } from './store';
import type { AuthIdentity, AuthProvider, CookieJar, Session } from './types';

export interface BrowserAuth {
  /** The request's session (null: signed out, or the credential no longer stands). */
  session: Session | null;
  /** The verified credential, even when it no longer stands. */
  identity: AuthIdentity | null;
  /** A credential is present and verifies but was revoked, re-enrolled elsewhere or switched off. */
  stale: boolean;
  /** This browser is an enrolled SHARED device that stands (the PIN pad's device). */
  sharedDevice: DeviceRecord | null;
  /** An operator is signed in on that shared device. */
  operatorSignedIn: boolean;
}

export interface ResolveOptions {
  provider: AuthProvider;
  secret: string;
  cookies: Pick<CookieJar, 'get'>;
  ex: Executor;
  now: Date;
  /** Write farm.devices.last_seen_at (throttled). Default true. */
  touch?: boolean;
}

const SIGNED_OUT: BrowserAuth = Object.freeze({
  session: null,
  identity: null,
  stale: false,
  sharedDevice: null,
  operatorSignedIn: false,
});

export async function resolveBrowserAuth(opts: ResolveOptions): Promise<BrowserAuth> {
  const identity = await opts.provider.identify(opts.cookies as CookieJar);
  if (!identity) return SIGNED_OUT;
  const op =
    identity.kind === 'device' ? await readOperator(opts.secret, opts.cookies, opts.now) : null;
  const rows = await loadSessionRows(opts.ex, {
    deviceId: identity.deviceId,
    userId: identity.kind === 'person' ? identity.appUserId : null,
    operatorUserId: op?.operator.appUserId ?? null,
  });
  const session = buildSession({
    identity,
    device: rows.device,
    user: rows.user,
    operator: op ? { claims: op.operator, user: rows.operatorUser } : null,
  });
  if (
    session &&
    rows.device &&
    opts.touch !== false &&
    (!rows.device.lastSeenAt ||
      opts.now.getTime() - rows.device.lastSeenAt.getTime() > LAST_SEEN_EVERY_MS)
  ) {
    await touchDevice(opts.ex, rows.device.id, opts.now);
  }
  const shared =
    session &&
    identity.kind === 'device' &&
    rows.device &&
    isSharedKind(rows.device.kind) &&
    deviceAccepts(rows.device, identity.epoch)
      ? rows.device
      : null;
  return {
    session,
    identity,
    stale: !session,
    sharedDevice: shared,
    operatorSignedIn: !!session && session.kind === 'device' && session.appUserId !== null,
  };
}
