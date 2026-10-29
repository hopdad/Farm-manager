/** What M0's admin pages show to anyone below a manager (src/app/admin/_lib/guard.ts). */
import css from '../admin.module.css';

export function Locked() {
  return (
    <main className={css.banner} data-testid="admin-locked">
      <h1>Admin is locked</h1>
      <p>
        The admin pages need a manager. <a href="/login">Sign in as a manager</a> (name and PIN),
        or, on the PC, open the <strong>Admin</strong> link that <code>pnpm dev</code> (or{' '}
        <code>pnpm pilot</code>) printed, in this browser.
      </p>
    </main>
  );
}
