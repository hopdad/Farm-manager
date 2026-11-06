/**
 * /admin/usage (slice 2a, decision 2a-11; docs/contracts-2a.md §7.6): the Phase 2 gate report
 * from app.usage_events: the last USAGE_REPORT_DAYS farm days with daily active crew (names),
 * board time per device, job actions, morning-mode runs ("starts in 2b"), and the gate line
 * ("crew used the board every day": at least PHASE2_MIN_DAILY_CREW active crew, Sundays not
 * counted). Manager or owner (ROLE_FOR.admin).
 *
 * FOUNDATION STUB, owned by the rights-usage builder (queries in src/db/queries/usage*.ts).
 */
import { requireRole } from '@/platform/auth/server';
import { AuthError, ROLE_FOR } from '@/platform/auth/types';
import css from '../admin.module.css';
import { NoAccess } from '../fields/_components/NoAccess';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Usage · Farm Ops' };

export default async function UsageAdminPage() {
  try {
    await requireRole(ROLE_FOR.admin);
  } catch (e) {
    if (e instanceof AuthError) return <NoAccess status={e.status} required={ROLE_FOR.admin} />;
    throw e;
  }
  return (
    <>
      <div className={css.pageHead}>
        <h1>Usage</h1>
      </div>
      <section className={css.card} data-testid="usage-stub">
        <p className={css.muted}>The usage report (the Phase 2 gate) arrives with slice 2a.</p>
      </section>
    </>
  );
}
