/**
 * Authorization and action plumbing for the field-data admin pages (/admin/fields,
 * /admin/parties) and the History tab's actions (docs/contracts-m1.md §2 "Authorization").
 *
 *  - Pages: `pageAccess(ROLE_FOR.admin)` FIRST; a refusal renders <NoAccess /> (401: sign in,
 *    403: needs a manager). Never assertAdmin/adminUnlocked (contracts §2).
 *  - Actions: `runAction(min, fn)` checks the session on the server before anything else and
 *    turns refusals into an ActionResult (actions never throw to the client).
 */

import { FieldDataError } from '@/db/queries/boundaries-sql';
import { getSession, requireRole } from '@/platform/auth/server';
import { AuthError, type Role, type Session } from '@/platform/auth/types';
import { type ActionResult, actionResult } from '../../action-result';

export type PageAccess =
  | { ok: true; session: Session }
  | { ok: false; status: 401 | 403; required: Role };

export async function pageAccess(min: Role): Promise<PageAccess> {
  try {
    return { ok: true, session: await requireRole(min) };
  } catch (e) {
    if (e instanceof AuthError) return { ok: false, status: e.status, required: min };
    throw e;
  }
}

/** The session (null when signed out), for pages that only adapt their controls. */
export async function sessionOrNull(): Promise<Session | null> {
  return getSession();
}

export const actorOf = (s: Session) => ({ appUserId: s.appUserId, displayName: s.displayName });

/** An ActionResult that may carry data back (previews, history). */
export interface DataResult<T> extends ActionResult {
  data?: T;
}

/** Messages people can act on (everything else is logged and summarized). */
export function refusalMessage(e: unknown): string | null {
  if (e instanceof AuthError) {
    return e.status === 401
      ? 'Sign in first.'
      : `This needs the ${e.required ?? 'manager'} role (or above).`;
  }
  if (e instanceof FieldDataError) return e.message;
  return null;
}

export async function runAction<T = undefined>(
  min: Role,
  fn: (session: Session) => Promise<{ message: string; data?: T; ok?: boolean }>,
): Promise<DataResult<T>> {
  try {
    const session = await requireRole(min);
    const out = await fn(session);
    return { ...actionResult(out.ok ?? true, out.message), data: out.data };
  } catch (e) {
    const known = refusalMessage(e);
    if (known) return actionResult(false, known);
    console.error('[field-data] action failed:', e);
    return actionResult(false, `Something went wrong: ${(e as Error).message}`);
  }
}

/** A text field of a form ('' when missing). */
export const formText = (form: FormData, name: string): string => {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
};
