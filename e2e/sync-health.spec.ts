/**
 * Sync health on /admin/connectors (slice 1f, docs/contracts-1f.md §11.4), against the sim stack
 * `pnpm test:e2e` starts (or an app already on PUBLIC_URL):
 *
 *  - a manager sees vendor calls today per source and mode (the jobs' own counts), "limit
 *    unknown" for the Deere budget, the Runs column, the Deere connection (connected by itself in
 *    sim, its scopes), the home org, every connection with its mode key, mode and capability
 *    matrix, and the doc-derived list with each entry's basis;
 *  - the stand-in's knob makes a customer org need approval: fleet.deere skips it (the page shows
 *    "needs approval" with an "Approve in Deere Connections" link back to /admin/connectors) while
 *    the Deere locations stream keeps syncing; approving it reconnects it;
 *  - after a (simulated) Deere sign-in the callback page lists that org with the same link;
 *  - dead letters: the total, requeue and discard; a viewer or driver gets 403 from the server;
 *  - with the deprecated CONNECTOR_ELD / ELD_VENDOR set (start the app so: the test process reads
 *    the same env), the warning shows.
 * Wall project only (one browser is enough).
 */
import { expect, type Page, test } from '@playwright/test';
import { getConfig } from '../src/config';
import { SIM_DEERE_HOME_ORG } from '../src/sim/types';
import { e2ePool, signInAs } from './support/auth';

const BLOCKED = 'org-customer-1';
const DEAD_STREAM = 'e2e-dead';

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name !== 'wall', 'one browser is enough');
  await signInAs(page.context(), 'manager');
});

async function reloadUntil(page: Page, check: () => Promise<boolean>, timeout = 60_000) {
  await expect
    .poll(
      async () => {
        await page.reload();
        return check();
      },
      { timeout, intervals: [2_000, 3_000, 5_000] },
    )
    .toBe(true);
}

test('a manager sees calls, the budget, the Deere connection, connections and doc-derived items', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/admin/connectors');
  await expect(page.getByTestId('calls-card')).toBeVisible();
  // fleet.deere runs every 15 s in the demo; its calls land under deere / sim.
  await reloadUntil(page, async () => (await page.getByTestId('calls-deere-sim').count()) > 0);
  const deere = page.getByTestId('calls-deere-sim');
  await expect(deere.getByTestId('calls-today')).toHaveText(/^[1-9][\d,]*/);
  await expect(page.getByTestId('calls-samsara-sim')).toBeVisible();
  await expect(page.getByTestId('deere-budget')).toContainText('limit unknown');
  await expect(
    page.getByTestId('jobs').locator('th', { hasText: 'Runs 1 h / 24 h' }),
  ).toBeVisible();

  await expect(page.getByTestId('deere-oauth-status')).toContainText('connected');
  await expect(page.getByTestId('deere-scopes')).toContainText('ag2');
  await expect(page.getByTestId('deere-scope-warning')).toHaveCount(0);
  await expect(page.getByTestId('deere-home-org')).toContainText(SIM_DEERE_HOME_ORG);
  await expect(page.getByTestId('deere-home-org')).toContainText('simulated home org');

  const matrix = page.getByTestId('capability-matrix');
  for (const c of ['deere', 'samsara', 'motive', 'geotab', 'aemp', 'cnh', 'terminal']) {
    await expect(matrix.getByTestId(`connection-${c}`)).toBeVisible();
    await expect(page.getByTestId(`connector-mode-${c}`)).toContainText(
      /sim|replay|sandbox|live|off/,
    );
  }
  await expect(page.getByTestId('connector-mode-deere')).toContainText('CONNECTOR_DEERE');
  await expect(matrix.locator('[data-testid^="provider-aemp_"]').first()).toBeVisible();

  const doc = page.getByTestId('doc-derived');
  await expect(doc.getByTestId('doc-basis').filter({ hasText: 'spec' }).first()).toBeVisible();
  await expect(doc.getByTestId('doc-basis').filter({ hasText: 'doc' }).first()).toBeVisible();
});

test("an org that needs approval is skipped and shown with Deere Connections' link; the others keep syncing", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto('/admin/connectors');
  const knob = page.getByTestId(`sim-org-${BLOCKED}-needs-approval`);
  await expect(knob).toBeVisible();
  try {
    await knob.click();
    await expect(page.getByTestId('admin-notice')).toContainText(`${BLOCKED}: needs approval`);
    const row = page.getByTestId(`deere-org-${BLOCKED}`);
    await reloadUntil(
      page,
      async () => (await row.getAttribute('data-status').catch(() => null)) === 'needs_approval',
      90_000,
    );
    await expect(row).toContainText('needs approval');
    const href = await row.getByTestId('approve-link').getAttribute('href');
    const link = new URL(href as string);
    expect(link.host).toBe('connections.deere.com');
    expect(link.searchParams.get('redirect_uri')).toBe(
      `${getConfig().PUBLIC_URL.replace(/\/+$/, '')}/admin/connectors`,
    );
    // The home org stays connected and the locations stream keeps succeeding.
    await expect(page.getByTestId(`deere-org-${SIM_DEERE_HOME_ORG}`)).toHaveAttribute(
      'data-status',
      'connected',
    );
    const db = e2ePool();
    const st = await db.query(
      `select last_error, last_ok_at > now() - interval '2 minutes' as fresh
         from ingest.sync_state where source = 'deere' and stream = 'locations'`,
    );
    expect(st.rows[0]).toMatchObject({ fresh: true });

    // The sign-in callback lists the org that needs approval, with the same link.
    await page.goto('/api/oauth/deere');
    await page.getByRole('button', { name: 'Allow' }).click();
    await expect(page.getByRole('heading', { name: 'Connected to John Deere' })).toBeVisible();
    const waiting = page.getByTestId('orgs-need-approval');
    await expect(waiting.locator(`li[data-org="${BLOCKED}"]`)).toBeVisible();
    const approve = waiting.locator(`li[data-org="${BLOCKED}"] a.approve`);
    await expect(approve).toHaveText('Approve in Deere Connections');
    expect(
      new URL((await approve.getAttribute('href')) as string).searchParams.get('redirect_uri'),
    ).toBe(link.searchParams.get('redirect_uri'));
  } finally {
    await page.goto('/admin/connectors');
    await page.getByTestId(`sim-org-${BLOCKED}-connect`).click();
    await expect(page.getByTestId('admin-notice')).toContainText(`${BLOCKED}: connected`);
  }
  const row = page.getByTestId(`deere-org-${BLOCKED}`);
  await reloadUntil(
    page,
    async () => (await row.getAttribute('data-status').catch(() => null)) === 'connected',
    90_000,
  );
});

test('dead letters: the total, requeue and discard; a viewer or driver gets 403', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  const db = e2ePool();
  const sha = () =>
    Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const insert = async (externalId: string) =>
    (
      await db.query<{ id: string }>(
        `insert into ingest.raw_events (source, stream, external_id, payload, sha256, status, attempts, last_error)
         values ('samsara', $1, $2, '{}', $3, 'dead', 5, 'e2e: no machine for this vehicle')
         returning id::text`,
        [DEAD_STREAM, externalId, sha()],
      )
    ).rows[0]?.id as string;
  try {
    const a = await insert('e2e-a');
    const b = await insert('e2e-b');
    await page.goto('/admin/connectors');
    await expect(page.getByTestId('dead-total')).toHaveText(/^[1-9]\d*$/);
    const total = Number(await page.getByTestId('dead-total').textContent());
    expect(total).toBeGreaterThanOrEqual(2);

    await page.getByTestId(`dead-${a}`).getByTestId('dead-requeue').click();
    await expect(page.getByTestId('admin-notice')).toContainText('1 dead-lettered event requeued');
    await page.getByTestId(`dead-${b}`).getByTestId('dead-discard').click();
    await expect(page.getByTestId('admin-notice')).toContainText('1 dead-lettered event discarded');
    await page.reload();
    await expect(page.getByTestId(`dead-${a}`)).toHaveCount(0);
    await expect(page.getByTestId(`dead-${b}`)).toHaveCount(0);
    const rows = await db.query(
      `select external_id, status, attempts, last_error from ingest.raw_events where stream = $1 order by 1`,
      [DEAD_STREAM],
    );
    expect(rows.rows.map((r) => [r.external_id, r.status])).toEqual([
      ['e2e-a', 'pending'],
      ['e2e-b', 'processed'],
    ]);
    expect(rows.rows[1].last_error).toMatch(/^discarded on \/admin\/connectors by E2E Manager/);

    // The server refuses anyone below manager, whatever the page shows.
    const c = await insert('e2e-c');
    for (const role of ['viewer', 'driver'] as const) {
      const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
      await signInAs(ctx, role);
      const p = await ctx.newPage();
      const res = await p.request.post('/admin/connectors/dead-letters', {
        data: { action: 'discard', ids: [c] },
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status(), role).toBe(403);
      await ctx.close();
    }
    const manager = await page.request.post('/admin/connectors/dead-letters', {
      data: { action: 'requeue', ids: [c] },
      headers: { 'content-type': 'application/json' },
    });
    expect(manager.status()).toBe(200);
    expect(await manager.json()).toEqual({ ok: true, action: 'requeue', count: 1 });
  } finally {
    await db.query('delete from ingest.raw_events where stream = $1', [DEAD_STREAM]);
  }
});

test('the deprecated CONNECTOR_ELD / ELD_VENDOR warning shows while they are set', async ({
  page,
}) => {
  const notes = getConfig().connectorAliasNotes;
  test.skip(
    notes.length === 0,
    'start the app (and this test) with CONNECTOR_ELD=sim (or ELD_VENDOR=…) set to see the warning',
  );
  await page.goto('/admin/connectors');
  const warning = page.getByTestId('connector-alias-warning');
  await expect(warning.first()).toBeVisible();
  await expect(warning.first()).toContainText('deprecated');
  for (const n of notes)
    await expect(page.getByTestId('connections-card')).toContainText(n.message);
});
