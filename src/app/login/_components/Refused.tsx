/**
 * What a page shows a session whose role is too low (403 semantics, nothing private rendered):
 * who is signed in, what the page needs, and the way to sign in as someone else.
 */
import Link from 'next/link';
import type { Role, Session } from '@/platform/auth/types';
import css from '../login.module.css';

export function Refused({
  required,
  session,
  what,
  path,
}: {
  required: Role;
  session: Session;
  what: string;
  /** The refused page (sign-in comes back to it). */
  path: string;
}) {
  return (
    <main className={css.page} data-testid="auth-refused" data-required={required}>
      <h1 className={css.title}>
        {what} needs a {required} or above
      </h1>
      <p className={css.lead}>
        This browser is signed in as {session.displayName} ({session.role}).{' '}
        {session.kind === 'device'
          ? 'On a shared screen, a manager signs in with their PIN first.'
          : 'Ask the owner if you need more access.'}
      </p>
      <div className={css.row}>
        <Link
          className={`${css.button} ${css.primary}`}
          href={`/login?next=${encodeURIComponent(path)}`}
        >
          Sign in as someone else
        </Link>
        <Link className={css.button} href="/board">
          Board
        </Link>
      </div>
    </main>
  );
}
