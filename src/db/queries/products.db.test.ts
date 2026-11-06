/**
 * Products against a real database (decision 2a-12): the list order and job counts, add, edit
 * with the version (a stale edit changes nothing), retire and bring back, and delete only what no
 * job names (a product on a job answers in_use and stays; the job keeps it).
 */
import { describe, expect, test } from 'vitest';
import { setupTestDb } from '../../test/db';
import {
  createProduct,
  deleteProduct,
  getProduct,
  listProducts,
  type ProductInput,
  setProductActive,
  updateProduct,
  validateProduct,
} from './products';

const t = setupTestDb(import.meta.url);

const input = (over: Partial<ProductInput> = {}): ProductInput => ({
  kind: 'chemical',
  name: `Herbicide ${Math.random().toString(16).slice(2, 8)}`,
  epaRegNo: '524-475',
  restrictedUse: false,
  unit: 'gal',
  ...over,
});

async function jobWith(productId: string, status = 'planned'): Promise<string> {
  const j = await t().pool.query<{ id: string }>(
    `insert into farm.jobs (kind, business_line, status) values ('spray', 'spraying', $1) returning id`,
    [status],
  );
  const id = j.rows[0]?.id as string;
  await t().pool.query(
    `insert into farm.job_products (job_id, product_id, rate, unit) values ($1, $2, 32, 'floz_ac')`,
    [id, productId],
  );
  return id;
}

describe('validateProduct', () => {
  test('trims, empties to null, and says the first problem', () => {
    expect(
      validateProduct({ kind: 'seed', name: '  Corn 108  ', epaRegNo: '  ', unit: 'kseed' }),
    ).toEqual({
      ok: true,
      value: {
        kind: 'seed',
        name: 'Corn 108',
        epaRegNo: null,
        restrictedUse: false,
        unit: 'kseed',
      },
    });
    expect(validateProduct({ kind: 'seed', name: '   ', unit: 'bag' })).toEqual({
      ok: false,
      error: 'give the product a name',
    });
    expect(validateProduct({ kind: 'paint', name: 'x', unit: 'gal' })).toMatchObject({ ok: false });
    expect(validateProduct({ kind: 'fuel', name: 'x'.repeat(121), unit: 'gal' })).toMatchObject({
      ok: false,
    });
    expect(validateProduct({ kind: 'fuel', name: 'Diesel', unit: 'barrel' })).toMatchObject({
      ok: false,
      error: 'pick the unit it is bought in',
    });
  });
});

describe('products', () => {
  test('add, then list: active first by kind and name, with job counts', async () => {
    const seed = await createProduct(
      t().pool,
      input({ kind: 'seed', name: 'Beans 2.8', unit: 'unit', epaRegNo: null }),
    );
    const chem = await createProduct(t().pool, input({ name: 'Atrazine', restrictedUse: true }));
    const old = await createProduct(t().pool, input({ name: 'Aaa retired' }));
    await setProductActive(t().pool, old.id, false);
    await jobWith(chem.id);
    await jobWith(chem.id, 'done');
    expect(seed).toMatchObject({ kind: 'seed', source: 'app', active: true, jobCount: 0 });
    const rows = (await listProducts(t().pool)).filter((p) =>
      [seed.id, chem.id, old.id].includes(p.id),
    );
    expect(rows.map((p) => p.id)).toEqual([seed.id, chem.id, old.id]);
    expect(rows[1]).toMatchObject({ restrictedUse: true, jobCount: 2, openJobCount: 1 });
    expect(rows[2]?.active).toBe(false);
  });

  test('edit with the version the page showed; a stale one changes nothing', async () => {
    const p = await createProduct(t().pool, input({ name: 'Glyphosate' }));
    const saved = await updateProduct(
      t().pool,
      p.id,
      input({ name: 'Glyphosate 5.5', unit: 'qt' }),
      p.version,
    );
    expect(saved).toMatchObject({
      status: 'saved',
      product: { name: 'Glyphosate 5.5', unit: 'qt' },
    });
    if (saved.status !== 'saved') throw new Error('not saved');
    expect(saved.product.version).not.toBe(p.version);
    const stale = await updateProduct(t().pool, p.id, input({ name: 'Mine' }), p.version);
    expect(stale).toMatchObject({ status: 'conflict', product: { name: 'Glyphosate 5.5' } });
    expect((await getProduct(t().pool, p.id))?.name).toBe('Glyphosate 5.5');
    expect(await updateProduct(t().pool, crypto.randomUUID(), input(), null)).toEqual({
      status: 'not_found',
    });
    // The name rule holds in the database too.
    await expect(
      t().pool.query(`update farm.products set name = '  ' where id = $1`, [p.id]),
    ).rejects.toThrow(/products_name_check/);
  });

  test('retire and bring back (idempotent); a job keeps a retired product', async () => {
    const p = await createProduct(t().pool, input());
    const job = await jobWith(p.id);
    expect(await setProductActive(t().pool, p.id, false)).toMatchObject({
      status: 'saved',
      product: { active: false },
    });
    expect(await setProductActive(t().pool, p.id, false)).toMatchObject({ status: 'saved' });
    const kept = await t().pool.query('select 1 from farm.job_products where job_id = $1', [job]);
    expect(kept.rowCount).toBe(1);
    expect(await setProductActive(t().pool, p.id, true)).toMatchObject({
      product: { active: true },
    });
    expect(await setProductActive(t().pool, crypto.randomUUID(), true)).toEqual({
      status: 'not_found',
    });
  });

  test('delete only what no job names', async () => {
    const free = await createProduct(t().pool, input());
    expect(await deleteProduct(t().pool, free.id)).toEqual({ status: 'deleted' });
    expect(await getProduct(t().pool, free.id)).toBeNull();
    expect(await deleteProduct(t().pool, free.id)).toEqual({ status: 'not_found' });
    const used = await createProduct(t().pool, input());
    await jobWith(used.id, 'cancelled');
    expect(await deleteProduct(t().pool, used.id)).toEqual({ status: 'in_use', jobCount: 1 });
    expect(await getProduct(t().pool, used.id)).not.toBeNull();
  });
});
