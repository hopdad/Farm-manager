'use server';
/**
 * Server actions behind /login and the board's session chip. They never throw to the client:
 * a refusal comes back as a LoginState message; success redirects (to `next` when it is a safe
 * same-origin path, else the device's home: /board for the wall, /m for iPads and phones).
 *
 * Authorization: signing in is the one thing a browser does without a session; what it may do
 * is decided by the flows (src/platform/auth/flows.ts): the operator PIN pad only works on an
 * enrolled shared device, the personal sign-in only for PERSON_SIGN_IN_MIN_ROLE and up, every
 * attempt counts toward the lockout.
 */
import { redirect } from 'next/navigation';
import {
  signInOperator,
  signInPerson,
  signOutBrowser,
  signOutOperator,
} from '@/platform/auth/flows';
import { homePathFor, safeNextPath } from '@/platform/auth/policy';
import { getBrowserAuth } from '@/platform/auth/server';
import type { Role } from '@/platform/auth/types';

export interface LoginState {
  ok: false;
  message: string;
  /** Distinguishes two identical messages (so the UI re-announces them). */
  at: number;
}

const field = (form: FormData, name: string): string => {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
};

const refused = (message: string): LoginState => ({ ok: false, message, at: Date.now() });

/** The PIN pad on a shared device (wall, cab/truck iPad). */
export async function operatorSignInAction(
  _prev: LoginState | null,
  form: FormData,
): Promise<LoginState> {
  const r = await signInOperator(field(form, 'appUserId'), field(form, 'pin'));
  if (!r.ok) return refused(r.message);
  redirect(safeNextPath(field(form, 'next')) ?? r.home);
}

/** Name + PIN on a manager's or the owner's own browser. */
export async function personSignInAction(
  _prev: LoginState | null,
  form: FormData,
): Promise<LoginState> {
  const r = await signInPerson(field(form, 'appUserId'), field(form, 'pin'));
  if (!r.ok) return refused(r.message);
  redirect(safeNextPath(field(form, 'next')) ?? r.home);
}

/**
 * "Switch user": the operator leaves and the shared device goes back to its own screen (the
 * wall to the board, an iPad to /m), not to the PIN pad: the next person taps the name chip.
 */
export async function switchUserAction(): Promise<void> {
  const auth = await getBrowserAuth();
  await signOutOperator();
  redirect(homePathFor(auth.sharedDevice?.kind));
}

/** Sign this browser out (a device must then be enrolled again). */
export async function signOutAction(): Promise<void> {
  await signOutBrowser();
  redirect('/login');
}

export interface WhoAmI {
  displayName: string;
  role: Role;
  /** An operator layer can be switched on this browser. */
  shared: boolean;
  operatorSignedIn: boolean;
  adminKey: boolean;
}

/** For the board's session chip (a client component): who this browser is signed in as. */
export async function whoAmIAction(): Promise<WhoAmI | null> {
  const auth = await getBrowserAuth();
  if (!auth.session) return null;
  return {
    displayName: auth.session.displayName,
    role: auth.session.role,
    shared: !!auth.sharedDevice,
    operatorSignedIn: auth.operatorSignedIn,
    adminKey: auth.adminKey,
  };
}
