/** What a field-data admin page shows to someone whose session may not open it. */
import Link from 'next/link';
import type { Role } from '@/platform/auth/types';
import adminCss from '../../admin.module.css';

export function NoAccess({ status, required }: { status: 401 | 403; required: Role }) {
  return (
    <main className={adminCss.banner} data-testid="no-access" data-status={status}>
      <h1>{status === 401 ? 'Sign in first' : `This page needs a ${required}`}</h1>
      <p>
        {status === 401 ? (
          <>
            <Link href="/login">Sign in</Link> with a manager or owner account.
          </>
        ) : (
          <>
            You are signed in, but editing fields, boundaries and contacts needs the {required} role
            or above. Ask the owner to change your role on /admin/people.
          </>
        )}
      </p>
    </main>
  );
}
