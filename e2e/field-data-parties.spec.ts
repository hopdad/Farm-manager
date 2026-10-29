/**
 * /admin/parties (plan 1c): a manager adds a landlord with the form, links a field to them,
 * edits them, imports contacts from a CSV (preview, then apply) and deletes one nobody points
 * at; a viewer is refused. Writes to the app's database; removes what it made afterwards.
 */
import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Pool } from 'pg';
import { getConfig } from '../src/config';
import { createPool } from '../src/db/client';
import { signInAs } from './support/auth';

const run = randomBytes(3).toString('hex');
let pool: Pool;

test.beforeAll(() => {
  pool = createPool({ connectionString: getConfig().DATABASE_URL, max: 2 });
});

test.afterAll(async () => {
  const like = `%e2e ${run}%`;
  await pool.query(
    `update farm.fields set landlord_party_id = null
      where landlord_party_id in (select id from farm.parties where display_name like $1)`,
    [like],
  );
  await pool.query(`update farm.parties set org_id = null where display_name like $1`, [like]);
  await pool.query(`delete from farm.parties where display_name like $1`, [like]);
  await pool.end();
});

test('a viewer cannot open the parties page', async ({ page }, info) => {
  test.skip(info.project.name !== 'wall', 'one browser is enough');
  await signInAs(page.context(), 'viewer');
  await page.goto('/admin/parties');
  await expect(page.getByTestId('no-access')).toBeVisible();
  await expect(page.getByTestId('party-new-save')).toHaveCount(0);
});

test('add a landlord, link a field, edit, import a CSV, delete', async ({ page }, info) => {
  test.skip(
    info.project.name !== 'wall',
    'one browser is enough (the forms are the same on phones)',
  );
  await signInAs(page.context(), 'manager');
  await page.goto('/admin/parties');

  // The form.
  const name = `Faye Tillman e2e ${run}`;
  const form = page.getByTestId('party-new');
  await form.getByTestId('party-new-name').fill(name);
  await form.getByTestId('party-new-phone').fill('517-555-0100');
  await form.getByTestId('party-new-role-landlord').check();
  await form.getByTestId('party-new-save').click();
  await expect(page.getByTestId('admin-notice')).toHaveText(`Added ${name}`);
  const row = page.getByTestId('parties-table').locator(`tr[data-party="${name}"]`);
  await expect(row).toContainText('landlord');
  await expect(row).toContainText('517-555-0100');

  // Link a field: its panel shows the landlord.
  await row.getByRole('link', { name }).click();
  await expect(page.getByTestId('party-title')).toHaveText(name);
  const fieldSelect = page.getByTestId('landlord-add-field');
  // A field with no landlord yet (so unlinking puts it back as it was).
  const firstField = await fieldSelect
    .locator('option:not([disabled])', { hasNotText: '· now' })
    .first()
    .getAttribute('value');
  expect(firstField).toBeTruthy();
  await fieldSelect.selectOption(firstField as string);
  await page.getByTestId('landlord-add').click();
  await expect(page.getByTestId('landlord-field')).toHaveCount(1);
  const linked = await pool.query('select landlord_party_id from farm.fields where id = $1', [
    firstField,
  ]);
  const partyId = linked.rows[0]?.landlord_party_id as string;
  expect(partyId).toBeTruthy();

  // Edit.
  await page.getByTestId('party-edit-phone').fill('517-555-0199');
  await page.getByTestId('party-edit-save').click();
  await expect(page.getByTestId('admin-notice')).toHaveText(`Saved ${name}`);
  await expect(page.getByTestId('party-edit-phone')).toHaveValue('517-555-0199');

  // Delete is refused while linked.
  await page.getByTestId('party-delete').click();
  await expect(page.getByTestId('admin-notice')).toContainText('still linked: landlord of 1 field');

  // CSV import: preview shows what would happen, apply writes it.
  await page.goto('/admin/parties');
  const csv = [
    'display_name,kind,roles,phone,email,address,notes,org',
    `River Bend e2e ${run},org,landlord,517-555-0140,,,,`,
    `Joan Albrecht e2e ${run},person,landlord;customer,,joan@example.com,,,River Bend e2e ${run}`,
  ].join('\n');
  const panel = page.getByTestId('party-import');
  await panel.getByTestId('party-import-file').setInputFiles({
    name: 'contacts.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  });
  await panel.getByTestId('party-import-preview').click();
  await expect(panel.getByTestId('party-import-result')).toContainText('Preview: 2 new');
  await expect(panel.locator('tr[data-tone="insert"]')).toHaveCount(2);
  await panel.getByTestId('party-import-apply').click();
  await expect(panel.getByTestId('party-import-result')).toContainText('Done:');
  const joan = page
    .getByTestId('parties-table')
    .locator(`tr[data-party="Joan Albrecht e2e ${run}"]`);
  await expect(joan).toContainText(`River Bend e2e ${run}`);
  await expect(joan).toContainText('landlord, customer');

  // A broken file is refused with its line numbers, nothing written.
  await panel.getByTestId('party-import-file').setInputFiles({
    name: 'bad.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(`display_name,roles\nNobody e2e ${run},tenant\n`),
  });
  await panel.getByTestId('party-import-preview').click();
  await expect(panel.getByTestId('party-import-result')).toContainText(
    'line 2: unknown role(s): tenant',
  );
  await expect(panel.getByTestId('party-import-apply')).toHaveCount(0);

  // Unlink, then delete.
  await page.goto(`/admin/parties/${partyId}`);
  await page.getByTestId('landlord-field').getByRole('button', { name: 'Unlink' }).click();
  await expect(page.getByTestId('landlord-field')).toHaveCount(0);
  await page.getByTestId('party-delete').click();
  await expect(page).toHaveURL(/\/admin\/parties$/);
  await expect(page.getByTestId('parties-table').locator(`tr[data-party="${name}"]`)).toHaveCount(
    0,
  );
});
