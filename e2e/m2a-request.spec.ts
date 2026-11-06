/**
 * Slice 2a job-forms: the customer request link (decision 2a-9; docs/contracts-2a.md §5.5,
 * §11.3), end to end with no session on the customer's side:
 *
 *  - a manager makes a link on /admin/parties/<id> (shown once: gone after a reload), sees it
 *    "never used";
 *  - a browser with no cookies at all opens /r/<token> (no redirect to /login), asks for a spray
 *    job on one of the customer's fields; a requested web_form job lands in the database for the
 *    link's party, and the link shows it was used;
 *  - the 21st request of the farm day is refused;
 *  - revoked, the link opens the same "doesn't work any more" page as an unknown token.
 *
 * Wall project only (the page is the same on a phone; the form is phone-first anyway). The spec's
 * customer is a throwaway e2e party ('tmp:'), with a field of its own far from the map's specs;
 * its jobs, links, field and party are removed afterwards (and by pruneE2eLeftovers if it
 * crashes).
 */
import { randomBytes } from 'node:crypto';
import { type Browser, expect, type Page, test } from '@playwright/test';
import type { Pool } from 'pg';
import { getConfig, getE2eSettings } from '../src/config';
import { createDb, createPool } from '../src/db/client';
import { REQUEST_LINK_MAX_PER_DAY } from '../src/domain/work-jobs';
import { insertField, squareMultiPolygon } from '../src/test/fixtures';
import { E2E_SOURCE, signInAs } from './support/auth';

test.describe.configure({ mode: 'serial' });

const BASE_URL = getE2eSettings().baseURL;
const tag = randomBytes(3).toString('hex');
const CUSTOMER = `E2E Request Farms ${tag}`;
const FIELD = `E2E Request North ${tag}`;

let pool: Pool;
let partyId: string;
let field: { fieldId: string; farmId: string };
let token: string;
let linkId: string;

test.beforeAll(async () => {
  pool = createPool({ connectionString: getConfig().DATABASE_URL, max: 2 });
  if (test.info().project.name !== 'wall') return;
  const p = await pool.query<{ id: string }>(
    `insert into farm.parties (kind, display_name, roles, source, source_id)
     values ('org', $1, '{customer}', $2, $3) returning id`,
    [CUSTOMER, E2E_SOURCE, `tmp:request-${tag}`],
  );
  partyId = p.rows[0]?.id as string;
  field = await insertField(createDb(pool), {
    name: FIELD,
    geom: squareMultiPolygon(-84.3, 41.6, 300),
    tenure: 'custom',
  });
  await pool.query('update farm.farms set client_party_id = $2 where id = $1', [
    field.farmId,
    partyId,
  ]);
});

test.afterAll(async () => {
  if (partyId) {
    await pool.query('delete from farm.jobs where requested_by_party_id = $1', [partyId]);
    await pool.query('delete from farm.job_request_links where party_id = $1', [partyId]);
  }
  if (field) {
    await pool.query('delete from farm.fields where id = $1', [field.fieldId]);
    await pool.query('delete from farm.farms where id = $1', [field.farmId]);
  }
  if (partyId) await pool.query('delete from farm.parties where id = $1', [partyId]);
  await pool?.end();
});

test.beforeEach(() => {
  test.skip(test.info().project.name !== 'wall', 'one project: the page is the same on a phone');
});

/** A browser with no cookies at all (not even the suite's viewer kiosk). */
async function anonymous(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    baseURL: BASE_URL,
  });
  return ctx.newPage();
}

async function fillRequest(page: Page, opts: { field?: boolean } = {}): Promise<void> {
  const form = page.getByTestId('request-form');
  await form.getByTestId('request-kind').selectOption('spray');
  if (opts.field) await form.getByTestId('request-field').selectOption(field.fieldId);
  else await form.getByTestId('request-where').fill('the 40 behind the church');
  await form.getByTestId('request-notes').fill('Burndown before wheat, please.');
  await form.getByTestId('request-name').fill('Gail Pressler');
  await form.getByTestId('request-phone').fill('(517) 555-0100');
}

test('a manager makes a link; it is shown once', async ({ context, page }) => {
  await signInAs(context, 'manager');
  await page.goto(`/admin/parties/${partyId}`);
  const section = page.getByTestId('party-request-links');
  await expect(section).toBeVisible();
  await expect(section).toContainText('only opens on the farm');
  await section.getByTestId('request-link-label').fill('for Gail');
  await section.getByTestId('request-link-new').click();
  const made = section.getByTestId('request-link-made');
  await expect(made).toBeVisible();
  await expect(made.getByTestId('request-link-qr')).toBeVisible();
  const url = (await made.getByTestId('request-link-url').getAttribute('href')) ?? '';
  const m = /\/r\/([A-Za-z0-9_-]{22})$/.exec(url);
  expect(m, url).not.toBeNull();
  token = m?.[1] as string;
  const linkRow = section.getByTestId('request-link-row');
  await expect(linkRow).toHaveCount(1);
  await expect(linkRow).toHaveAttribute('data-state', 'active');
  await expect(linkRow.getByTestId('request-link-used')).toContainText('Never used');
  linkId = (await linkRow.getAttribute('data-link-id')) as string;
  // Only the hash is stored, so a reload can't show the link again.
  await page.reload();
  await expect(page.getByTestId('party-request-links')).toBeVisible();
  await expect(page.getByTestId('request-link-made')).toHaveCount(0);
  await expect(page.getByTestId('party-request-links')).not.toContainText(token);
});

test('with no session, the customer asks for work: a requested job lands on the board', async ({
  browser,
  context,
  page,
}) => {
  const anon = await anonymous(browser);
  await anon.goto(`/r/${token}`);
  expect(new URL(anon.url()).pathname).toBe(`/r/${token}`);
  await expect(anon.getByTestId('request-page')).toContainText(CUSTOMER);
  await fillRequest(anon, { field: true });
  await anon.getByTestId('request-submit').click();
  await expect(anon.getByTestId('request-done')).toBeVisible();

  const jobs = await pool.query(
    `select status, request_channel, requested_by_party_id, request_link_id, field_id, kind,
            requester_name, requester_phone, source
       from farm.jobs where request_link_id = $1`,
    [linkId],
  );
  expect(jobs.rows).toEqual([
    {
      status: 'requested',
      request_channel: 'web_form',
      requested_by_party_id: partyId,
      request_link_id: linkId,
      field_id: field.fieldId,
      kind: 'spray',
      requester_name: 'Gail Pressler',
      requester_phone: '(517) 555-0100',
      source: 'app',
    },
  ]);
  await anon.context().close();

  await signInAs(context, 'manager');
  await page.goto(`/admin/parties/${partyId}`);
  await expect(page.getByTestId('request-link-used')).toContainText(
    /Last used .* ago · 1 today, 1 in all/,
  );
});

test('the 21st request of the farm day is refused', async ({ browser }) => {
  // 19 more today (one came through the form above): 20 in all.
  await pool.query(
    `insert into farm.jobs (kind, business_line, status, request_link_id, request_channel,
                            requested_by_party_id)
     select 'spray', 'spraying', 'requested', $1, 'web_form', $2 from generate_series(1, $3::int)`,
    [linkId, partyId, REQUEST_LINK_MAX_PER_DAY - 1],
  );
  const anon = await anonymous(browser);
  await anon.goto(`/r/${token}`);
  await fillRequest(anon);
  await anon.getByTestId('request-submit').click();
  await expect(anon.getByTestId('request-refused')).toHaveAttribute('data-reason', 'limit');
  const n = await pool.query(
    'select count(*)::int as n from farm.jobs where request_link_id = $1',
    [linkId],
  );
  expect(n.rows[0].n).toBe(REQUEST_LINK_MAX_PER_DAY);
  await anon.context().close();
});

test('revoked, the link opens the same refusal as an unknown token', async ({
  browser,
  context,
  page,
}) => {
  await signInAs(context, 'manager');
  await page.goto(`/admin/parties/${partyId}`);
  await page.getByTestId('request-link-revoke').click();
  await expect(page.getByTestId('admin-notice')).toHaveText('Link revoked: it no longer opens');
  await expect(page.getByTestId('request-link-row')).toHaveAttribute('data-state', 'revoked');

  const anon = await anonymous(browser);
  await anon.goto(`/r/${token}`);
  await expect(anon.getByTestId('request-refused')).toHaveAttribute('data-reason', 'unknown');
  await expect(anon.getByTestId('request-form')).toHaveCount(0);
  await anon.goto(`/r/${'A'.repeat(22)}`);
  await expect(anon.getByTestId('request-refused')).toHaveAttribute('data-reason', 'unknown');
  await anon.goto('/r/not-a-token');
  await expect(anon.getByTestId('request-refused')).toHaveAttribute('data-reason', 'unknown');
  await anon.context().close();
});
