/**
 * /admin/products (slice 2a, decision 2a-12; docs/contracts-2a.md §7.6): list, add, edit and
 * retire the seed, chemicals, fertilizer and fuel jobs name. Manager or owner (ROLE_FOR.admin),
 * checked first here and in every action (./actions.ts); anyone else gets the refusal page. A
 * product on a job can't be deleted (retire it: the jobs keep it, the job form stops offering
 * it); one nothing names can be.
 *
 * Owned by job-forms (queries in src/db/queries/products.ts).
 */
import { getPool } from '@/db/client';
import { listProducts, type ProductRow } from '@/db/queries/products';
import { PRODUCT_KIND_LABELS, PRODUCT_UNIT_LABELS } from '@/domain/work-jobs';
import { requireRole } from '@/platform/auth/server';
import { AuthError, ROLE_FOR } from '@/platform/auth/types';
import { ActionForm, NoticeProvider, SubmitButton } from '../_components/controls';
import css from '../admin.module.css';
import { NoAccess } from '../fields/_components/NoAccess';
import fd from '../fields/field-data.module.css';
import { ProductFields } from './_components/ProductFields';
import {
  createProductAction,
  deleteProductAction,
  restoreProductAction,
  retireProductAction,
  updateProductAction,
} from './actions';
import own from './products.module.css';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Products · Farm Ops' };

function jobsText(p: ProductRow): string {
  if (p.jobCount === 0) return 'none';
  const open = p.openJobCount > 0 ? ` (${p.openJobCount} open)` : '';
  return `${p.jobCount}${open}`;
}

function ProductRowView({ p }: { p: ProductRow }) {
  const demo = p.source === 'demo';
  return (
    <tr data-testid="product-row" data-product-id={p.id} data-active={p.active ? 'true' : 'false'}>
      <td>
        <strong data-testid="product-name">{p.name}</strong>
        {p.restrictedUse && (
          <span className={`${css.badge} ${css.warn} ${own.badge}`} data-testid="product-rup">
            restricted use
          </span>
        )}
        {p.epaRegNo && <div className={css.muted}>EPA {p.epaRegNo}</div>}
        {demo && <div className={css.muted}>demo product</div>}
      </td>
      <td>{PRODUCT_KIND_LABELS[p.kind]}</td>
      <td>{PRODUCT_UNIT_LABELS[p.unit]}</td>
      <td data-testid="product-jobs">{jobsText(p)}</td>
      <td>
        <span
          className={`${css.badge} ${p.active ? css.ok : css.idle}`}
          data-testid="product-status"
        >
          {p.active ? 'active' : 'retired'}
        </span>
      </td>
      <td>
        <div className={own.actions}>
          <details className={own.edit}>
            <summary className={css.button} data-testid="product-edit">
              Edit
            </summary>
            <ActionForm action={updateProductAction} className={`${fd.form} ${own.editForm}`}>
              <input type="hidden" name="id" value={p.id} />
              <input type="hidden" name="version" value={p.version} />
              <ProductFields product={p} prefix="product-edit" />
              {demo && (
                <p className={css.muted}>
                  A demo product: the demo seed writes its name, kind, unit and EPA number back.
                </p>
              )}
              <SubmitButton className={`${css.button} ${css.primary}`} testId="product-edit-save">
                Save
              </SubmitButton>
            </ActionForm>
          </details>
          <ActionForm action={p.active ? retireProductAction : restoreProductAction}>
            <input type="hidden" name="id" value={p.id} />
            <SubmitButton
              className={css.button}
              testId={p.active ? 'product-retire' : 'product-restore'}
            >
              {p.active ? 'Retire' : 'Bring back'}
            </SubmitButton>
          </ActionForm>
          {p.jobCount === 0 && (
            <ActionForm action={deleteProductAction}>
              <input type="hidden" name="id" value={p.id} />
              <input type="hidden" name="name" value={p.name} />
              <SubmitButton className={`${css.button} ${css.danger}`} testId="product-delete">
                Delete
              </SubmitButton>
            </ActionForm>
          )}
        </div>
      </td>
    </tr>
  );
}

export default async function ProductsAdminPage() {
  try {
    await requireRole(ROLE_FOR.admin);
  } catch (e) {
    if (e instanceof AuthError) return <NoAccess status={e.status} required={ROLE_FOR.admin} />;
    throw e;
  }
  const products = await listProducts(getPool());
  const active = products.filter((p) => p.active).length;

  return (
    <NoticeProvider>
      <div className={css.pageHead}>
        <h1>Products</h1>
        <span className={css.muted} data-testid="products-count">
          {active} active · {products.length - active} retired
        </span>
      </div>
      <section className={css.card} data-testid="product-new">
        <h2>Add a product</h2>
        <ActionForm action={createProductAction} className={fd.form}>
          <ProductFields prefix="product-new" />
          <SubmitButton className={`${css.button} ${css.primary}`} testId="product-new-save">
            Add product
          </SubmitButton>
        </ActionForm>
        <p className={css.muted}>
          Jobs name these with a rate and who supplies them (the job form). Retire a product you no
          longer use: the jobs that name it keep it.
        </p>
      </section>
      <section className={css.card}>
        <h2>All products</h2>
        {products.length === 0 && <p className={css.muted}>No products yet.</p>}
        <div className={css.tableWrap}>
          <table className={css.table} data-testid="products-table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Kind</th>
                <th>Bought in</th>
                <th>On jobs</th>
                <th>Status</th>
                <th>Change</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <ProductRowView key={p.id} p={p} />
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </NoticeProvider>
  );
}
