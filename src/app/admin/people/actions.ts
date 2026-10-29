'use server';
/**
 * Server actions behind /admin/people. Every action calls requireRole FIRST (managers:
 * ROLE_FOR.managePeople), then the store re-checks, in one transaction with the row locked,
 * what this actor may do to this person (src/platform/auth/policy.ts: managers manage crew,
 * only the owner manages managers and owners, nobody demotes or switches off themselves, the
 * farm keeps an active owner). They return an ActionResult and never throw to the client.
 */
import { revalidatePath } from 'next/cache';
import { getDb, getPool } from '@/db/client';
import { deactivateDemoPeople } from '@/platform/auth/demo';
import { requireRole } from '@/platform/auth/server';
import {
  AuthStoreError,
  createPerson,
  setPersonPin,
  signOutEverywhere,
  unlockPerson,
  updatePerson,
} from '@/platform/auth/store';
import { isAuthError, isRole, ROLE_FOR, type Role, type Session } from '@/platform/auth/types';
import { type ActionResult, actionResult as result } from '../action-result';

const PATH = '/admin/people';

const field = (form: FormData, name: string): string => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

/** requireRole(min), then `fn`; refusals and store errors become a failed ActionResult. */
async function attempt(min: Role, fn: (s: Session) => Promise<string>): Promise<ActionResult> {
  let session: Session;
  try {
    session = await requireRole(min);
  } catch (e) {
    if (isAuthError(e)) {
      return result(
        false,
        e.status === 401 ? 'Sign in first.' : `This needs the ${e.required} role or above.`,
      );
    }
    throw e;
  }
  try {
    const message = await fn(session);
    revalidatePath(PATH);
    return result(true, message);
  } catch (e) {
    if (e instanceof AuthStoreError) return result(false, e.message);
    console.error('[admin/people]', (e as Error).message);
    return result(false, 'That failed on the server; try again.');
  }
}

function roleFrom(form: FormData): Role {
  const role = field(form, 'role');
  if (!isRole(role)) throw new AuthStoreError('invalid', 'pick a role');
  return role;
}

/** Add a person (new, or an existing person party without a sign-in), optionally with a PIN. */
export async function addPersonAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  return attempt(ROLE_FOR.managePeople, async (s) => {
    const partyId = field(form, 'partyId') || null;
    const p = await createPerson(getDb(), s, {
      role: roleFrom(form),
      partyId,
      name: partyId ? null : field(form, 'name'),
      pin: field(form, 'pin') || null,
    });
    return `${p.displayName} added as ${p.role}${p.hasPin ? ' with a PIN' : ' (set a PIN to let them sign in)'}`;
  });
}

export async function setRoleAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  return attempt(ROLE_FOR.managePeople, async (s) => {
    const p = await updatePerson(getDb(), s, field(form, 'id'), { role: roleFrom(form) });
    return `${p.displayName} is now ${p.role}`;
  });
}

export async function setActiveAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  return attempt(ROLE_FOR.managePeople, async (s) => {
    const active = field(form, 'active') === 'true';
    const p = await updatePerson(getDb(), s, field(form, 'id'), { active });
    return active
      ? `${p.displayName} can sign in again`
      : `${p.displayName} is switched off and signed out`;
  });
}

export async function setPinAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  return attempt(ROLE_FOR.managePeople, async (s) => {
    await setPersonPin(getDb(), s, field(form, 'id'), field(form, 'pin'));
    return 'PIN saved (any lockout cleared)';
  });
}

export async function unlockAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  return attempt(ROLE_FOR.managePeople, async (s) => {
    await unlockPerson(getDb(), s, field(form, 'id'));
    return 'Unlocked: they can try their PIN again';
  });
}

export async function signOutEverywhereAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  return attempt(ROLE_FOR.managePeople, async (s) => {
    await signOutEverywhere(getDb(), s, field(form, 'id'));
    return 'Signed out on every browser, phone and shared screen';
  });
}

/** Switch every demo person off (their PINs are printed on the PC; owner only: one is a manager). */
export async function deactivateDemoAction(_prev: ActionResult | null): Promise<ActionResult> {
  return attempt(ROLE_FOR.manageManagers, async () => {
    const n = await deactivateDemoPeople(getPool());
    return `${n} demo ${n === 1 ? 'person' : 'people'} switched off`;
  });
}
