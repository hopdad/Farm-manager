/** What /admin/* pages show until /admin/unlock set the admin cookie (src/platform/auth/admin-key.ts). */
import css from '../admin.module.css';

export function Locked() {
  return (
    <main className={css.banner} data-testid="admin-locked">
      <h1>Admin is locked</h1>
      <p>
        Open the <strong>Admin</strong> link that <code>pnpm dev</code> (or <code>pnpm pilot</code>)
        printed on the PC, in this browser. Sign-in arrives with slice 1a; until then only someone
        at the PC can use the admin pages.
      </p>
    </main>
  );
}
