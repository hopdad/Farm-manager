/**
 * Signed session tokens for LocalAuth (jose, HS256), pure apart from the clock you pass in.
 *
 *  - Identity token (cookie `farm_auth`): the provider's base credential, an `AuthIdentity`
 *    (a device, or a person optionally on their enrolled phone) plus the row's
 *    `session_epoch` at issue time (`ep`); a person on their phone also carries the phone's
 *    epoch (`dep`), so a new enrollment code for that phone signs the old browser out.
 *    Audience `farm:identity`.
 *  - Operator token (cookie `farm_op`): the operator layer on one shared device: the person who
 *    entered their PIN there, bound to that device id, with the person's epoch. Audience
 *    `farm:operator`, short idle lifetime (PIN_RULES.operatorIdleMinutes).
 *
 * The signing key is derived from SESSION_SECRET with HKDF (its own label), so it never equals
 * the admin key or the storage URL signatures that also derive from the secret. Tokens carry
 * only our ids (never names or roles): the role always comes from the database at use time, and
 * an epoch below the row's current one means revoked (docs/contracts-m1.md §4).
 */
import { hkdfSync } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { isUuid } from '../../domain/ids';
import type { AuthIdentity } from './types';

const ISSUER = 'farm-ops';
const AUD_IDENTITY = 'farm:identity';
const AUD_OPERATOR = 'farm:operator';
const ALG = 'HS256';

const keys = new Map<string, Uint8Array>();

/** The HS256 key for `secret` (HKDF-SHA256, label 'farm-ops local session v1'). */
export function sessionKey(secret: string): Uint8Array {
  let key = keys.get(secret);
  if (!key) {
    key = new Uint8Array(hkdfSync('sha256', secret, 'farm-ops', 'local session v1', 32));
    keys.set(secret, key);
  }
  return key;
}

export interface TokenTimes {
  /** Issued at (seconds). */
  iat: number;
  /** Expires at (seconds). */
  exp: number;
}

export interface OperatorClaims {
  appUserId: string;
  /** farm.app_users.session_epoch when the PIN was entered. */
  epoch: number;
  /** The shared device the PIN was entered on. */
  deviceId: string;
}

const seconds = (d: Date) => Math.floor(d.getTime() / 1000);
const isEpoch = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

async function sign(
  secret: string,
  audience: string,
  subject: string,
  claims: Record<string, unknown>,
  now: Date,
  ttlSeconds: number,
): Promise<string> {
  const iat = seconds(now);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: ALG, typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt(iat)
    .setExpirationTime(iat + Math.max(1, Math.floor(ttlSeconds)))
    .sign(sessionKey(secret));
}

async function verify(
  secret: string,
  audience: string,
  token: string | undefined | null,
  now: Date,
): Promise<(Record<string, unknown> & TokenTimes & { sub: string }) | null> {
  if (!token || token.length > 4096) return null;
  try {
    const { payload } = await jwtVerify(token, sessionKey(secret), {
      algorithms: [ALG],
      issuer: ISSUER,
      audience,
      currentDate: now,
      requiredClaims: ['sub', 'iat', 'exp'],
    });
    if (!isUuid(payload.sub)) return null;
    return payload as Record<string, unknown> & TokenTimes & { sub: string };
  } catch {
    return null; // bad signature, expired, malformed: all just "no credential"
  }
}

/** Sign the base credential. */
export function signIdentity(
  secret: string,
  identity: AuthIdentity,
  now: Date,
  ttlSeconds: number,
): Promise<string> {
  if (identity.kind === 'device') {
    return sign(
      secret,
      AUD_IDENTITY,
      identity.deviceId,
      { k: 'd', ep: identity.epoch },
      now,
      ttlSeconds,
    );
  }
  return sign(
    secret,
    AUD_IDENTITY,
    identity.appUserId,
    {
      k: 'p',
      ep: identity.epoch,
      ...(identity.deviceId ? { dev: identity.deviceId, dep: identity.deviceEpoch } : {}),
    },
    now,
    ttlSeconds,
  );
}

/** The identity inside a valid, unexpired token, or null. Never throws. */
export async function verifyIdentity(
  secret: string,
  token: string | undefined | null,
  now: Date,
): Promise<{ identity: AuthIdentity; times: TokenTimes } | null> {
  const p = await verify(secret, AUD_IDENTITY, token, now);
  if (!p || !isEpoch(p.ep)) return null;
  const times = { iat: p.iat, exp: p.exp };
  if (p.k === 'd') return { identity: { kind: 'device', deviceId: p.sub, epoch: p.ep }, times };
  if (p.k === 'p') {
    if (p.dev === undefined) {
      return {
        identity: {
          kind: 'person',
          appUserId: p.sub,
          epoch: p.ep,
          deviceId: null,
          deviceEpoch: null,
        },
        times,
      };
    }
    // A phone credential without the phone's epoch (issued before `dep` existed) is refused:
    // it could outlive a re-enrollment of that phone.
    if (!isUuid(p.dev) || !isEpoch(p.dep)) return null;
    return {
      identity: {
        kind: 'person',
        appUserId: p.sub,
        epoch: p.ep,
        deviceId: p.dev,
        deviceEpoch: p.dep,
      },
      times,
    };
  }
  return null;
}

/** Sign the operator layer for one shared device. */
export function signOperator(
  secret: string,
  op: OperatorClaims,
  now: Date,
  ttlSeconds: number,
): Promise<string> {
  return sign(
    secret,
    AUD_OPERATOR,
    op.appUserId,
    { ep: op.epoch, dev: op.deviceId },
    now,
    ttlSeconds,
  );
}

/** The operator claims inside a valid, unexpired token, or null. Never throws. */
export async function verifyOperator(
  secret: string,
  token: string | undefined | null,
  now: Date,
): Promise<{ operator: OperatorClaims; times: TokenTimes } | null> {
  const p = await verify(secret, AUD_OPERATOR, token, now);
  if (!p || !isEpoch(p.ep) || !isUuid(p.dev)) return null;
  return {
    operator: { appUserId: p.sub, epoch: p.ep, deviceId: p.dev },
    times: { iat: p.iat, exp: p.exp },
  };
}
