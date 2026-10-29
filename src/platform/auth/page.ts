/**
 * Guards for server-component PAGES (route handlers and server actions use requireRole):
 *
 *   const gate = await pageSession(ROLE_FOR.managePeople, '/admin/people');
 *   if (!gate.ok) return <Refused required={gate.required} session={gate.session} />;
 *
 *  - signed out (or a revoked device): redirect to /login?next=<path> (the proxy only catches
 *    browsers with no credential at all; a revoked one still verifies there);
 *  - role too low: { ok: false } so the page can say who is signed in and what it needs (403
 *    semantics without an error page; nothing private is rendered).
 *
 * `/board` and `/m` call `requirePageSession(path)` (integrator: one line each) so a revoked
 * wall lands on the enrollment screen instead of an empty map.
 */
import { redirect } from 'next/navigation';
import { getSession } from './server';
import { type Role, roleAtLeast, type Session } from './types';

export type PageGate =
  | { ok: true; session: Session }
  | { ok: false; required: Role; session: Session };

export function loginPathFor(path: string): string {
  return path === '/' ? '/login' : `/login?next=${encodeURIComponent(path)}`;
}

/** Any session, or off to /login. */
export async function requirePageSession(path: string): Promise<Session> {
  const session = await getSession();
  if (!session) redirect(loginPathFor(path));
  return session;
}

/** A session with at least `min`, a refusal to render, or off to /login. */
export async function pageSession(min: Role, path: string): Promise<PageGate> {
  const session = await requirePageSession(path);
  if (!roleAtLeast(session.role, min)) return { ok: false, required: min, session };
  return { ok: true, session };
}
