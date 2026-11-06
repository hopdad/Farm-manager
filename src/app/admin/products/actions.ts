'use server';
/**
 * /admin/products' server actions (job-forms, decision 2a-12): add, edit, retire, bring back and
 * delete products. requireRole(ROLE_FOR.admin) FIRST in each (manager and above; anyone else is
 * refused on the server and nothing changes), then the query; an ActionResult, never a throw to
 * the client. A product on a job is never deleted: the answer says to retire it.
 */
import { revalidatePath } from 'next/cache';
import { getPool } from '@/db/client';
import {
  deleteProduct,
  createProduct as insertProduct,
  type ProductWriteResult,
  setProductActive,
  updateProduct,
  validateProduct,
} from '@/db/queries/products';
import { isUuid } from '@/domain/ids';
import { requireRole } from '@/platform/auth/server';
import { isAuthError, ROLE_FOR } from '@/platform/auth/types';
import { type ActionResult, actionResult } from '../action-result';

const PATH = '/admin/products';

const text = (form: FormData, name: string): string => {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
};

async function run(fn: () => Promise<ActionResult>): Promise<ActionResult> {
  try {
    await requireRole(ROLE_FOR.admin);
  } catch (e) {
    if (isAuthError(e)) {
      return actionResult(
        false,
        e.status === 401 ? 'Sign in first.' : 'Changing products needs a manager or the owner.',
      );
    }
    throw e;
  }
  try {
    const r = await fn();
    if (r.ok) revalidatePath(PATH);
    return r;
  } catch (e) {
    console.error('[admin/products]', (e as Error).message);
    return actionResult(false, 'That failed on the server; try again.');
  }
}

function productFrom(form: FormData) {
  return validateProduct({
    kind: text(form, 'kind'),
    name: text(form, 'name'),
    epaRegNo: text(form, 'epaRegNo'),
    restrictedUse: form.get('restrictedUse') === 'on' || form.get('restrictedUse') === 'true',
    unit: text(form, 'unit'),
  });
}

const capital = (s: string) => (s ? `${s[0]?.toUpperCase()}${s.slice(1)}` : s);

function written(r: ProductWriteResult, ok: (name: string) => string): ActionResult {
  switch (r.status) {
    case 'saved':
      return actionResult(true, ok(r.product.name));
    case 'not_found':
      return actionResult(false, 'That product no longer exists.');
    case 'conflict':
      return actionResult(
        false,
        `Someone changed ${r.product.name} since this page loaded: reload and try again.`,
      );
  }
}

export async function createProductAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  return run(async () => {
    const v = productFrom(form);
    if (!v.ok) return actionResult(false, `${capital(v.error)}.`);
    const p = await insertProduct(getPool(), v.value);
    return actionResult(true, `Added ${p.name}`);
  });
}

export async function updateProductAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  return run(async () => {
    const id = text(form, 'id');
    if (!isUuid(id)) return actionResult(false, 'That product no longer exists.');
    const v = productFrom(form);
    if (!v.ok) return actionResult(false, `${capital(v.error)}.`);
    const r = await updateProduct(getPool(), id, v.value, text(form, 'version') || null);
    return written(r, (name) => `Saved ${name}`);
  });
}

export async function retireProductAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  return run(async () => {
    const id = text(form, 'id');
    if (!isUuid(id)) return actionResult(false, 'That product no longer exists.');
    const r = await setProductActive(getPool(), id, false);
    return written(r, (name) => `Retired ${name}: jobs keep it; new jobs can't pick it`);
  });
}

export async function restoreProductAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  return run(async () => {
    const id = text(form, 'id');
    if (!isUuid(id)) return actionResult(false, 'That product no longer exists.');
    const r = await setProductActive(getPool(), id, true);
    return written(r, (name) => `${name} is back on the job form`);
  });
}

export async function deleteProductAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  return run(async () => {
    const id = text(form, 'id');
    if (!isUuid(id)) return actionResult(false, 'That product no longer exists.');
    const name = text(form, 'name') || 'The product';
    const r = await deleteProduct(getPool(), id);
    switch (r.status) {
      case 'deleted':
        return actionResult(true, `Deleted ${name}`);
      case 'not_found':
        return actionResult(false, 'That product no longer exists.');
      case 'in_use':
        return actionResult(
          false,
          `${name} is on ${r.jobCount} job${r.jobCount === 1 ? '' : 's'}: retire it instead (the jobs keep it).`,
        );
    }
  });
}
