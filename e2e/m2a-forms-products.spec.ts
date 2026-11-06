/**
 * Slice 2a job-forms: /admin/products (decision 2a-12; docs/contracts-2a.md §7.6, §11.3). A
 * driver gets the refusal page; a manager adds a product (with its EPA number and the
 * restricted-use mark), edits it, retires it, brings it back and deletes it; a product that is on
 * a job has no Delete (retire it: the job keeps it). Products are app-wide, so the spec runs on
 * the wall project only; its rows are named "E2E Product <tag>" and removed afterwards, with the
 * spec's own job (source 'e2e').
 */
import { randomBytes } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import type { Pool } from 'pg';
import { getConfig } from '../src/config';
import { createPool } from '../src/db/client';
import { E2E_SOURCE, signInAs } from './support/auth';

const tag = randomBytes(3).toString('hex');
const NAME = `E2E Product ${tag}`;
let pool: Pool;

test.beforeAll(async () => {
  pool = createPool({ connectionString: getConfig().DATABASE_URL, max: 2 });
});

test.afterAll(async () => {
  await pool.query(
    `delete from farm.jobs where source = $1 and source_id like 'e2e:m2a-forms-products:%'`,
    [E2E_SOURCE],
  );
  await pool.query(`delete from farm.products where name like 'E2E Product %'`);
  await pool.end();
});

test.beforeEach(() => {
  test.skip(test.info().project.name !== 'wall', 'products are app-wide: one project is enough');
});

const row = (page: Page, name: string) =>
  page
    .getByTestId('product-row')
    .filter({ has: page.getByTestId('product-name').getByText(name, { exact: true }) });

const notice = (page: Page) => page.getByTestId('admin-notice');

test('a driver gets the refusal page', async ({ context, page }) => {
  await signInAs(context, 'driver');
  await page.goto('/admin/products');
  await expect(page.getByTestId('no-access')).toHaveAttribute('data-status', '403');
  await expect(page.getByTestId('products-table')).toHaveCount(0);
});

test('a manager adds, edits, retires, brings back and deletes a product', async ({
  context,
  page,
}) => {
  await signInAs(context, 'manager');
  await page.goto('/admin/products');
  await expect(page.getByTestId('products-table')).toBeVisible();
  // The demo seed's products are listed.
  await expect(row(page, 'Glyphosate 5.5 (demo)')).toHaveCount(1);
  await expect(
    row(page, 'Atrazine 4L (demo, restricted use)').getByTestId('product-rup'),
  ).toBeVisible();

  const add = page.getByTestId('product-new');
  await add.getByTestId('product-new-name').fill(NAME);
  await add.getByTestId('product-new-kind').selectOption('chemical');
  await add.getByTestId('product-new-unit').selectOption('gal');
  await add.getByTestId('product-new-epa').fill('524-475');
  await add.getByTestId('product-new-restricted').check();
  await add.getByTestId('product-new-save').click();
  await expect(notice(page)).toHaveText(`Added ${NAME}`);
  const r = row(page, NAME);
  await expect(r).toHaveAttribute('data-active', 'true');
  await expect(r).toContainText('EPA 524-475');
  await expect(r.getByTestId('product-rup')).toBeVisible();
  await expect(r.getByTestId('product-jobs')).toHaveText('none');

  await r.getByTestId('product-edit').click();
  await r.getByTestId('product-edit-name').fill(`${NAME} edited`);
  await r.getByTestId('product-edit-unit').selectOption('qt');
  await r.getByTestId('product-edit-restricted').uncheck();
  await r.getByTestId('product-edit-save').click();
  await expect(notice(page)).toHaveText(`Saved ${NAME} edited`);
  const e = row(page, `${NAME} edited`);
  await expect(e).toContainText('qt');
  await expect(e.getByTestId('product-rup')).toHaveCount(0);

  await e.getByTestId('product-retire').click();
  await expect(notice(page)).toContainText(`Retired ${NAME} edited`);
  await expect(e).toHaveAttribute('data-active', 'false');
  await expect(e.getByTestId('product-status')).toHaveText('retired');
  await e.getByTestId('product-restore').click();
  await expect(e).toHaveAttribute('data-active', 'true');

  await e.getByTestId('product-delete').click();
  await expect(notice(page)).toHaveText(`Deleted ${NAME} edited`);
  await expect(row(page, `${NAME} edited`)).toHaveCount(0);
});

test('a product on a job can only be retired, and the job keeps it', async ({ context, page }) => {
  const name = `${NAME} on a job`;
  const p = await pool.query<{ id: string }>(
    `insert into farm.products (kind, name, unit) values ('fertilizer', $1, 'gal') returning id`,
    [name],
  );
  const j = await pool.query<{ id: string }>(
    `insert into farm.jobs (kind, business_line, status, source, source_id)
     values ('fertilize', 'spraying', 'planned', $1, $2) returning id`,
    [E2E_SOURCE, `e2e:m2a-forms-products:${tag}`],
  );
  await pool.query('insert into farm.job_products (job_id, product_id) values ($1, $2)', [
    j.rows[0]?.id,
    p.rows[0]?.id,
  ]);
  await signInAs(context, 'manager');
  await page.goto('/admin/products');
  const r = row(page, name);
  await expect(r.getByTestId('product-jobs')).toHaveText('1 (1 open)');
  await expect(r.getByTestId('product-delete')).toHaveCount(0);
  await r.getByTestId('product-retire').click();
  await expect(r).toHaveAttribute('data-active', 'false');
  const kept = await pool.query('select 1 from farm.job_products where product_id = $1', [
    p.rows[0]?.id,
  ]);
  expect(kept.rowCount).toBe(1);
});
