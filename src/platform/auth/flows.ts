/**
 * Sign-in flows for server actions (they set or clear cookies, so only server actions and route
 * handlers may call them). Each returns a FlowResult instead of throwing for anything a person
 * can cause (wrong PIN, used code); the caller redirects on success.
 *
 *  - signInOperator:  the PIN pad on an enrolled SHARED device (wall, cab/truck iPad);
 *  - signInPerson:    name + PIN on someone's own browser (PERSON_SIGN_IN_MIN_ROLE and up);
 *  - enrollBrowser:   a one-time enrollment code makes this browser a device (or a person's phone);
 *  - setupOwnerFlow / resetOwnerFlow: the first-run owner link and `pnpm auth:reset-owner`;
 *  - signOutOperator ("switch user") and signOutBrowser.
 */
import { cookies } from 'next/headers';
import { getConfig } from '../../config';
import { getDb, getPool } from '../../db/client';
import { isOwnerSetupCode, looksLikeResetCode, normalizeEnrollCode } from './codes';
import { clearOperator, setOperator } from './operator';
import { isWellFormedPin } from './pin';
import { homePathFor, PERSON_SIGN_IN_MIN_ROLE } from './policy';
import { getAuthProvider } from './provider';
import { resolveBrowserAuth } from './resolve';
import {
  AuthStoreError,
  attemptPin,
  getPerson,
  pinAttemptMessage,
  redeemEnrollment,
  resetOwner,
  setupOwner,
} from './store';
import { PIN_RULES, roleAtLeast } from './types';

export type FlowResult = { ok: true; home: string } | { ok: false; message: string };

const failed = (message: string): FlowResult => ({ ok: false, message });
const BAD_PIN = `A PIN is ${PIN_RULES.minLength} to ${PIN_RULES.maxLength} digits.`;

async function context() {
  const cfg = getConfig();
  return {
    cfg,
    jar: await cookies(),
    provider: getAuthProvider(cfg),
    now: new Date(),
  };
}

/** AuthStoreError -> its message; anything else is logged and becomes a generic message. */
function explain(e: unknown, what: string): FlowResult {
  if (e instanceof AuthStoreError) return failed(e.message);
  console.error(`[auth] ${what} failed:`, (e as Error).message);
  return failed(`${what} failed on the server; try again.`);
}

/** The PIN pad on a shared device: put `appUserId` on this device as its operator. */
export async function signInOperator(appUserId: string, pin: string): Promise<FlowResult> {
  try {
    const { cfg, jar, provider, now } = await context();
    const auth = await resolveBrowserAuth({
      provider,
      secret: cfg.SESSION_SECRET,
      cookies: jar,
      ex: getPool(),
      now,
      touch: false,
    });
    if (!auth.sharedDevice) {
      return failed('This screen is not an enrolled shared device: enroll it first.');
    }
    if (!isWellFormedPin(pin)) return failed(BAD_PIN);
    const a = await attemptPin(getPool(), appUserId, pin, now);
    if (!a.ok) return failed(pinAttemptMessage(a, now));
    await setOperator(
      cfg.SESSION_SECRET,
      cfg.cookieSecure,
      jar,
      { appUserId, epoch: a.user.sessionEpoch, deviceId: auth.sharedDevice.id },
      now,
    );
    return { ok: true, home: homePathFor(auth.sharedDevice.kind) };
  } catch (e) {
    return explain(e, 'Sign-in');
  }
}

/** "Switch user": the shared device goes back to its own session. */
export async function signOutOperator(): Promise<void> {
  clearOperator(await cookies());
}

/** Name + PIN on a person's own browser (managers and the owner). */
export async function signInPerson(appUserId: string, pin: string): Promise<FlowResult> {
  try {
    const { jar, provider, now } = await context();
    if (!isWellFormedPin(pin)) return failed(BAD_PIN);
    // Refuse people who may not sign in this way before counting a try against them.
    const person = await getPerson(getPool(), appUserId);
    if (!person?.active || !roleAtLeast(person.role, PERSON_SIGN_IN_MIN_ROLE)) {
      return failed(
        'Only managers and the owner sign in with a PIN on their own browser. Crew: use the PIN pad on the wall or a cab iPad, or ask a manager to enroll your phone.',
      );
    }
    const a = await attemptPin(getPool(), appUserId, pin, now);
    if (!a.ok) return failed(pinAttemptMessage(a, now));
    await provider.signInPerson(jar, appUserId, a.user.sessionEpoch, null);
    return { ok: true, home: '/board' };
  } catch (e) {
    return explain(e, 'Sign-in');
  }
}

/** Sign this browser out completely (person or device; the device must be enrolled again). */
export async function signOutBrowser(): Promise<void> {
  const { jar, provider } = await context();
  await provider.signOut(jar);
}

/** Use an enrollment code on this browser. */
export async function enrollBrowser(rawCode: unknown): Promise<FlowResult> {
  const code = normalizeEnrollCode(rawCode);
  if (!code)
    return failed('That is not an enrollment code (10 letters and digits, like K7QD2-M9XPA).');
  try {
    const { cfg, jar, provider, now } = await context();
    const { device, identity } = await redeemEnrollment(getDb(), cfg.SESSION_SECRET, code, now);
    if (identity.kind === 'device') {
      await provider.signInDevice(jar, identity.deviceId, identity.epoch);
    } else {
      await provider.signInPerson(jar, identity.appUserId, identity.epoch, identity.deviceId);
    }
    return { ok: true, home: homePathFor(device.kind) };
  } catch (e) {
    return explain(e, 'Enrollment');
  }
}

/** First run: the owner setup link (works only while no owner exists). */
export async function setupOwnerFlow(
  code: unknown,
  name: unknown,
  pin: string,
): Promise<FlowResult> {
  try {
    const { cfg, jar, provider, now } = await context();
    if (!isOwnerSetupCode(cfg.SESSION_SECRET, code)) {
      return failed('This setup link is not valid: use the one `pnpm dev` printed on the PC.');
    }
    const owner = await setupOwner(getDb(), { name, pin }, now);
    await provider.signInPerson(jar, owner.appUserId, owner.epoch, null);
    return { ok: true, home: '/admin/people' };
  } catch (e) {
    return explain(e, 'Owner setup');
  }
}

/** Recovery: a reset code from `pnpm auth:reset-owner` sets an owner's PIN and signs them in. */
export async function resetOwnerFlow(
  code: unknown,
  ownerId: string,
  pin: string,
): Promise<FlowResult> {
  if (!looksLikeResetCode(code)) return failed('This reset link is not valid.');
  try {
    const { cfg, jar, provider, now } = await context();
    const owner = await resetOwner(getDb(), cfg.SESSION_SECRET, code, { ownerId, pin }, now);
    await provider.signInPerson(jar, owner.appUserId, owner.epoch, null);
    return { ok: true, home: '/admin/people' };
  } catch (e) {
    return explain(e, 'Owner reset');
  }
}
