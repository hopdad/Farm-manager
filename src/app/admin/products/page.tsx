/**
 * /admin/products (slice 2a, decision 2a-12; docs/contracts-2a.md §7.6): list, add, edit and
 * retire the seed, chemicals, fertilizer and fuel jobs name. Manager or owner (ROLE_FOR.admin),
 * checked first here and in every action.
 *
 * FOUNDATION STUB, owned by the job-forms builder (queries in src/db/queries/products.ts).
 */
import { requireRole } from '@/platform/auth/server';
import { AuthError, ROLE_FOR } from '@/platform/auth/types';
import css from '../admin.module.css';
import { NoAccess } from '../fields/_components/NoAccess';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Products · Farm Ops' };

export default async function ProductsAdminPage() {
  try {
    await requireRole(ROLE_FOR.admin);
  } catch (e) {
    if (e instanceof AuthError) return <NoAccess status={e.status} required={ROLE_FOR.admin} />;
    throw e;
  }
  return (
    <>
      <div className={css.pageHead}>
        <h1>Products</h1>
      </div>
      <section className={css.card} data-testid="products-stub">
        <p className={css.muted}>The product list arrives with slice 2a.</p>
      </section>
    </>
  );
}
