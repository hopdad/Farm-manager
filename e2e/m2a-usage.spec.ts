/**
 * Usage events and the Phase 2 gate report (slice 2a, decision 2a-11; docs/contracts-2a.md
 * §7.6, §7.7; done-when §11.4), against the stack `pnpm test:e2e` starts:
 *
 *  - the board's heartbeat: a person on /m gets a `page_view` (the page) and a
 *    `board_heartbeat` (UsageHeartbeat, mounted by the board) for '/m'; the viewer kiosk (a
 *    device session, no one signed in) posts and records nothing;
 *  - /admin/usage drives the gate line with two THROWAWAY CREW of source 'app' (real crew as
 *    far as the gate knows; created here, removed afterwards with their usage rows): today's row
 *    counts them as active crew and passes (Sundays: "not counted"), while the e2e manager, a
 *    test person, is on the separate "demo and test people" line and never counted;
 *  - a viewer can't open the report.
 * Wall project only (one browser is enough).
 */
import { randomBytes } from 'node:crypto';
import { type BrowserContext, expect, test } from '@playwright/test';
import { farmDate } from '../src/domain/farm';
import { deterministicId } from '../src/domain/ids';
import { PHASE2_MIN_DAILY_CREW } from '../src/domain/work-jobs';
import { weekdayOf } from '../src/platform/usage/report';
import { USAGE_URL } from '../src/ui/work/contract';
import { applyIdentity, e2ePool, signInAs } from './support/auth';

/** The throwaway crew's names start with this (a crashed run's are removed on the next). */
const PREFIX = 'E2E usage crew';
const run = randomBytes(4).toString('hex');
const crew = [
  { key: `${run}-a`, name: `${PREFIX} ${run} Ann`, role: 'driver' },
  { key: `${run}-b`, name: `${PREFIX} ${run} Bo`, role: 'operator' },
].map((c) => ({
  ...c,
  partyId: deterministicId('app', `e2e-usage-party:${c.key}`),
  userId: deterministicId('app', `e2e-usage-user:${c.key}`),
}));

test.describe.configure({ mode: 'serial' });

async function removeThrowawayCrew(like: string) {
  const db = e2ePool();
  const users = `select u.id from farm.app_users u join farm.parties p on p.id = u.party_id
                  where p.source = 'app' and p.display_name like $1`;
  await db.query(
    `delete from app.usage_events where app_user_id in (${users})
        or split_part(actor_key, ':', 2) in (select id::text from (${users}) x)`,
    [like],
  );
  await db.query(`delete from farm.app_users where id in (${users})`, [like]);
  await db.query(`delete from farm.parties where source = 'app' and display_name like $1`, [like]);
}

test.beforeAll(async ({ browser: _browser }, info) => {
  if (info.project.name !== 'wall') return;
  // A crashed earlier run's crew never counts toward a real day.
  await removeThrowawayCrew(`${PREFIX} %`);
  const db = e2ePool();
  for (const c of crew) {
    await db.query(
      `insert into farm.parties (id, kind, display_name, roles, source)
       values ($1, 'person', $2, '{crew}', 'app')`,
      [c.partyId, c.name],
    );
    await db.query(
      `insert into farm.app_users (id, party_id, role, source) values ($1, $2, $3, 'app')`,
      [c.userId, c.partyId, c.role],
    );
  }
});

test.afterAll(async ({ browser: _browser }, info) => {
  if (info.project.name !== 'wall') return;
  await removeThrowawayCrew(`${PREFIX} ${run} %`);
});

test.beforeEach(async ({ page: _page }, info) => {
  test.skip(info.project.name !== 'wall', 'one browser is enough');
});

async function asCrew(context: BrowserContext, userId: string) {
  await applyIdentity(context, {
    kind: 'person',
    appUserId: userId,
    epoch: 0,
    deviceId: null,
    deviceEpoch: null,
  });
}

const eventsOf = async (userId: string) =>
  (
    await e2ePool().query<{ kind: string; route: string }>(
      `select kind, route from app.usage_events where app_user_id = $1 order by kind, route`,
      [userId],
    )
  ).rows;

test('a person on /m: the page view and the heartbeat; the viewer kiosk records nothing', async ({
  browser,
  page,
}) => {
  test.setTimeout(90_000);
  const [ann] = crew;
  if (!ann) throw new Error('no crew');
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    await asCrew(ctx, ann.userId);
    const phone = await ctx.newPage();
    await phone.goto('/m');
    await expect
      .poll(async () => (await eventsOf(ann.userId)).map((e) => `${e.kind} ${e.route}`), {
        timeout: 30_000,
      })
      .toEqual(['board_heartbeat /m', 'page_view /m']);
  } finally {
    await ctx.close();
  }
  // The suite's default context is the e2e viewer kiosk: a device session with no person.
  const res = await page.request.post(USAGE_URL, { data: { route: '/board' } });
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ recorded: false });
});

test('the gate line: two throwaway crew make today pass; test people are on their own line', async ({
  browser,
  page,
}) => {
  test.setTimeout(90_000);
  const today = farmDate(new Date());
  // The second crew member posts a heartbeat the way the board does.
  const [, bo] = crew;
  if (!bo) throw new Error('no crew');
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    await asCrew(ctx, bo.userId);
    const p = await ctx.newPage();
    const res = await p.request.post(USAGE_URL, { data: { route: '/board' } });
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ recorded: true });
  } finally {
    await ctx.close();
  }
  // The e2e manager (a test person) has board time today too.
  await signInAs(page.context(), 'manager');
  const mine = await page.request.post(USAGE_URL, { data: { route: '/board' } });
  expect(mine.status()).toBe(200);

  await page.goto('/admin/usage');
  await expect(page.getByTestId('usage-report')).toBeVisible();
  const day = page.locator(`[data-testid="usage-day"][data-farm-day="${today}"]`);
  await expect(day).toHaveCount(1);
  const active = Number(await day.getAttribute('data-crew'));
  expect(active).toBeGreaterThanOrEqual(PHASE2_MIN_DAILY_CREW);
  for (const c of crew) await expect(day.getByTestId('usage-crew')).toContainText(c.name);
  await expect(day.getByTestId('usage-crew')).not.toContainText('E2E Manager');
  await expect(day).toHaveAttribute('data-gate', weekdayOf(today) === 0 ? 'skip' : 'pass');
  await expect(page.getByTestId('usage-gate')).toHaveAttribute(
    'data-today',
    weekdayOf(today) === 0 ? 'skip' : 'pass',
  );
  await expect(day.getByTestId('usage-board-time')).toContainText(`${crew[1]?.name}'s browser`);
  const demo = page.locator(`[data-testid="usage-demo-people"][data-farm-day="${today}"]`);
  await expect(demo).toContainText('demo and test people (not counted)');
  await expect(demo).toContainText('E2E Manager');
  // The other days of the window are listed too, newest first.
  await expect(page.getByTestId('usage-day')).toHaveCount(30);
  await expect(page.getByTestId('usage-day').first()).toHaveAttribute('data-farm-day', today);
});

test('without them today has fewer active crew; a viewer cannot open the report', async ({
  browser,
  page,
}) => {
  const today = farmDate(new Date());
  await removeThrowawayCrew(`${PREFIX} ${run} %`);
  await signInAs(page.context(), 'manager');
  await page.goto('/admin/usage');
  const day = page.locator(`[data-testid="usage-day"][data-farm-day="${today}"]`);
  for (const c of crew) await expect(day.getByTestId('usage-crew')).not.toContainText(c.name);

  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  await signInAs(ctx, 'viewer');
  const p = await ctx.newPage();
  await p.goto('/admin/usage');
  await expect(p.getByTestId('no-access')).toBeVisible();
  await expect(p.getByTestId('usage-report')).toHaveCount(0);
  await ctx.close();
});
