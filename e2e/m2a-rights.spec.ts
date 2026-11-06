/**
 * The data-rights gate's admin side (slice 2a, D17, decision 2a-10; docs/contracts-2a.md §4.4,
 * §7.5, §7.6; done-when §11.4), against the sim stack `pnpm test:e2e` starts (or an app already
 * on PUBLIC_URL):
 *
 *  - /admin/connectors: every Deere org fleet.deere listed has its data-rights state: the home
 *    org "your own org", Halvorsen's org "agreement on file" (the demo seed's agreement),
 *    Juniper Hill's "no agreement: blocked in live" (sim reports, never enforces);
 *  - an org with no customer party offers "link to customer", which writes the
 *    ('deere', 'party', org, org) link (an org row of the spec's own, removed afterwards);
 *  - /admin/parties/<id> of a throwaway customer: record an agreement with its signed document
 *    (the two-step storage grant: the browser PUTs the PDF itself), open the document through
 *    its signed link, revoke it; a viewer can't open the page;
 * Wall project only (one browser is enough). Every row the spec writes names its own throwaway
 * party (source 'e2e', a `tmp:` key: pruneE2eLeftovers removes it after a crash too).
 */
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { getConfig } from '../src/config';
import { deterministicId } from '../src/domain/ids';
import { SIM_DEERE_HOME_ORG } from '../src/sim/types';
import { E2E_SOURCE, e2ePool, signInAs } from './support/auth';

const run = randomBytes(4).toString('hex');
const KEY = `tmp:rights-${run}`;
const CUSTOMER = deterministicId(E2E_SOURCE, `party:${KEY}`);
const CUSTOMER_NAME = `E2E Rights Customer ${run}`;
const ORG = `org-e2e-${run}`;

// One worker, in order: the tests share the spec's throwaway customer.
test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name !== 'wall', 'one browser is enough');
  await signInAs(page.context(), 'manager');
});

test.beforeAll(async ({ browser: _browser }, info) => {
  if (info.project.name !== 'wall') return;
  await e2ePool().query(
    `insert into farm.parties (id, kind, display_name, roles, source, source_id)
     values ($1, 'org', $2, '{customer}', $3, $4) on conflict (id) do nothing`,
    [CUSTOMER, CUSTOMER_NAME, E2E_SOURCE, KEY],
  );
});

test.afterAll(async ({ browser: _browser }, info) => {
  if (info.project.name !== 'wall') return;
  const db = e2ePool();
  await db.query(
    `delete from ingest.external_refs where source = 'deere' and kind = 'party' and external_id = $1`,
    [ORG],
  );
  await db.query(`delete from ingest.connector_orgs where org_external_id = $1`, [ORG]);
  await db.query('delete from farm.data_rights_agreements where party_id = $1', [CUSTOMER]);
  await db.query('delete from farm.parties where id = $1', [CUSTOMER]);
  const cfg = getConfig();
  await rm(path.resolve(cfg.projectDir, cfg.STORAGE_DIR, 'uploads', 'agreements', CUSTOMER), {
    recursive: true,
    force: true,
  });
});

async function reloadUntil(page: Page, check: () => Promise<boolean>, timeout = 60_000) {
  await expect
    .poll(
      async () => {
        await page.reload();
        return check();
      },
      { timeout, intervals: [1_000, 2_000, 3_000, 5_000] },
    )
    .toBe(true);
}

const rights = (page: Page, org: string) =>
  page.locator(`[data-testid="deere-org-rights"][data-org="${org}"]`);

test('connectors: each Deere org shows its data-rights state (sim reports, never enforces)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/admin/connectors');
  // fleet.deere lists the orgs every 15 s in the demo.
  await reloadUntil(page, async () => (await rights(page, 'org-customer-2').count()) > 0);
  const table = page.getByTestId('deere-orgs');
  await expect(table.locator('th', { hasText: 'Data rights' })).toBeVisible();
  await expect(rights(page, SIM_DEERE_HOME_ORG)).toHaveAttribute('data-state', 'home');
  await expect(rights(page, 'org-customer-1')).toHaveAttribute('data-state', 'agreed');
  await expect(rights(page, 'org-customer-1')).toContainText('agreement on file');
  await expect(rights(page, 'org-customer-1')).toContainText('Halvorsen Bros. Farms');
  await expect(rights(page, 'org-customer-2')).toHaveAttribute('data-state', 'reported');
  await expect(rights(page, 'org-customer-2')).toContainText('no agreement: blocked in live');
  await expect(rights(page, 'org-customer-2')).toContainText('Juniper Hill Farms LLC');
  // Both demo orgs are linked by the seed: nothing to link.
  await expect(rights(page, 'org-customer-2').getByTestId('deere-org-link')).toHaveCount(0);
  // The party link opens the customer's page with its agreements.
  await rights(page, 'org-customer-1').getByTestId('deere-org-party').click();
  await expect(page.getByTestId('party-title')).toHaveText('Halvorsen Bros. Farms');
  const card = page.getByTestId('party-agreements');
  await expect(card).toHaveAttribute('data-in-force', 'true');
  await expect(card.getByTestId('agreement-orgs')).toContainText('org-customer-1');
  await expect(card.getByTestId('agreement-row').first()).toHaveAttribute('data-state', 'in_force');
});

test('connectors: "link to customer" for an org with no party yet', async ({ page }) => {
  test.setTimeout(90_000);
  const db = e2ePool();
  // An org row of the spec's own. fleet.deere drops rows its next listing doesn't have (every
  // 15 s), so put it back until the page shows it; the link itself doesn't need the row.
  const seed = () =>
    db.query(
      `insert into ingest.connector_orgs (source, mode, org_external_id, name, status)
       values ('deere', 'sim', $1, 'E2E unlinked org', 'connected')
       on conflict (source, mode, org_external_id) do update set last_seen_at = now()`,
      [ORG],
    );
  await expect(async () => {
    await seed();
    await page.goto('/admin/connectors');
    await expect(rights(page, ORG)).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  const cell = rights(page, ORG);
  await expect(cell).toHaveAttribute('data-state', 'reported');
  await cell.getByTestId('deere-org-link-party').selectOption(CUSTOMER);
  await cell.getByTestId('deere-org-link-save').click();
  await expect(page.getByTestId('admin-notice')).toHaveText(
    `Deere org ${ORG} linked to ${CUSTOMER_NAME}: record their agreement on their page`,
  );
  const ref = await db.query(
    `select entity_id::text as id from ingest.external_refs
      where source = 'deere' and kind = 'party' and external_id = $1 and source_org = $1`,
    [ORG],
  );
  expect(ref.rows[0]?.id).toBe(CUSTOMER);
  // The customer's page names the org now.
  await page.goto(`/admin/parties/${CUSTOMER}`);
  await expect(page.getByTestId('agreement-orgs')).toContainText(ORG);
});

test('a customer page: record an agreement with its signed document, open it, revoke it', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto(`/admin/parties/${CUSTOMER}`);
  const card = page.getByTestId('party-agreements');
  await expect(card).toHaveAttribute('data-in-force', 'false');
  await expect(card).toContainText('No agreement on file.');

  const form = card.getByTestId('agreement-new');
  await form.getByTestId('agreement-signed-on').fill('2026-10-01');
  await form.getByTestId('agreement-use-billing').check();
  await form.getByTestId('agreement-use-agronomy').check();
  await form.getByTestId('agreement-notes').fill('Signed at the shop; paper copy in the binder.');
  const pdf = Buffer.from(`%PDF-1.4\n% e2e agreement ${run}\n%%EOF\n`);
  await form.getByTestId('agreement-document').setInputFiles({
    name: 'signed agreement.pdf',
    mimeType: 'application/pdf',
    buffer: pdf,
  });
  await form.getByTestId('agreement-save').click();
  await expect(page.getByTestId('admin-notice')).toHaveText(
    'Agreement signed 2026-10-01 recorded with its document',
  );
  const row = card.getByTestId('agreement-row');
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-state', 'in_force');
  await expect(row).toContainText('signed 2026-10-01');
  await expect(row).toContainText('Billing, Agronomy');
  await expect(row).toContainText('recorded by E2E Manager');
  await expect(card).toHaveAttribute('data-in-force', 'true');

  const db = await e2ePool().query<{ document_key: string; permitted_uses: string[] }>(
    'select document_key, permitted_uses from farm.data_rights_agreements where party_id = $1',
    [CUSTOMER],
  );
  expect(db.rows[0]?.document_key).toMatch(
    new RegExp(`^agreements/${CUSTOMER}/[0-9a-f-]{36}\\.pdf$`),
  );
  expect(db.rows[0]?.permitted_uses).toEqual(['billing', 'agronomy']);

  // The document opens through its signed link (private bucket: unsigned is a 404).
  const href = (await row.getByTestId('agreement-document-link').getAttribute('href')) as string;
  const doc = await page.request.get(href);
  expect(doc.status()).toBe(200);
  expect(doc.headers()['content-type']).toContain('application/pdf');
  expect(Buffer.from(await doc.body()).equals(pdf)).toBe(true);
  expect((await page.request.get(href.split('?')[0] as string)).status()).toBe(404);

  // Revoke (today by default).
  await row.getByTestId('agreement-revoke').click();
  await expect(page.getByTestId('admin-notice')).toContainText('Agreement revoked as of');
  await expect(card.getByTestId('agreement-row')).toHaveAttribute('data-state', 'revoked');
  await expect(card).toHaveAttribute('data-in-force', 'false');
  await expect(card.getByTestId('agreement-revoke')).toHaveCount(0);
});

test('a viewer cannot open a customer page or its agreements', async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  await signInAs(ctx, 'viewer');
  const p = await ctx.newPage();
  await p.goto(`/admin/parties/${CUSTOMER}`);
  await expect(p.getByTestId('no-access')).toBeVisible();
  await expect(p.getByTestId('party-agreements')).toHaveCount(0);
  await ctx.close();
});
