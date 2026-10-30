/**
 * The admin notice and the pressed button (src/app/admin/_components/controls.tsx,
 * action-failure.ts), on /admin/realtime's "Send a test event" (a harmless action):
 *  - a press before hydration is replayed once the page is live: the answer shows, the button
 *    frees up;
 * and when the call rejects instead of answering (the action never runs):
 *  - a page from an older build: the action POST reaches the real server with an action id no
 *    build has, which it answers as it does for a stale page (409, x-nextjs-action-not-found);
 *    the notice says to reload, not to try again, and its Reload button loads a fresh page;
 *  - a server failure: the real server cannot decode the request and answers with the error
 *    (500, the rejection with its digest): reload to see what was saved, not "Try again";
 *  - no connection at all: the server could not be reached, try again.
 * Changes nothing shared: both projects run it.
 */
import { expect, type Page, type Route, test } from '@playwright/test';
import { unlockAdmin } from './support/admin';

/** The shape of a real action id (42 hex characters), in no build's manifest. */
const UNKNOWN_ACTION_ID = `7f${'0'.repeat(40)}`;

/** /admin/realtime, hydrated (its monitor only connects once React runs), with `onAction`. */
async function openWith(page: Page, onAction: (route: Route) => Promise<void>): Promise<void> {
  await unlockAdmin(page.context());
  await page.route('**/admin/realtime**', async (route) => {
    if (route.request().headers()['next-action']) await onAction(route);
    else await route.continue();
  });
  await page.goto('/admin/realtime?topics=admin');
  await expect(page.getByTestId('rt-state')).toHaveAttribute('data-state', 'ready', {
    timeout: 20_000,
  });
}

const actionPost = (page: Page) =>
  page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().includes('/admin/realtime'),
  );

test('a page older than the server says to reload, and Reload loads a fresh one', async ({
  page,
}) => {
  await openWith(page, (route) =>
    route.continue({
      headers: { ...route.request().headers(), 'next-action': UNKNOWN_ACTION_ID },
    }),
  );
  const answer = actionPost(page);
  const button = page.getByTestId('send-test-event');
  await button.click();
  const res = await answer;
  // What Next's action handler sends for an id it does not know (server/app-render/
  // action-handler.js, handleUnrecognizedAction): the client turns it into
  // UnrecognizedActionError.
  expect(res.status()).toBe(409);
  expect(res.headers()['x-nextjs-action-not-found']).toBe('1');

  const notice = page.getByTestId('admin-notice');
  await expect(notice).toContainText('This page is out of date');
  await expect(notice).toContainText('Reload the page');
  await expect(notice).not.toContainText('could not be reached');
  await expect(button).toBeEnabled();
  await expect(button).toHaveAttribute('aria-busy', 'false');

  const reload = page.getByTestId('admin-notice-reload');
  await Promise.all([page.waitForEvent('load'), reload.click()]);
  await expect(page.getByTestId('rt-state')).toHaveAttribute('data-state', 'ready', {
    timeout: 20_000,
  });
  await expect(notice).toHaveText('');
  await expect(reload).toHaveCount(0);
});

test('a server failure says to reload and see what was saved, not to try again', async ({
  page,
}) => {
  // The real action id with a body the server cannot decode: Next answers with the error.
  await openWith(page, (route) => route.continue({ postData: 'not a multipart body' }));
  const answer = actionPost(page);
  const button = page.getByTestId('send-test-event');
  await button.click();
  expect((await answer).status()).toBe(500);

  const notice = page.getByTestId('admin-notice');
  // The digest is the server log's name for the error (production hides its message).
  await expect(notice).toContainText(
    /The server could not finish that \(error \w+ in the server log\)/,
  );
  await expect(notice).toContainText('Reload the page to see what was saved');
  await expect(notice).not.toContainText('Try again');
  await expect(page.getByTestId('admin-notice-reload')).toBeVisible();
  await expect(button).toBeEnabled();
});

test('no connection says the server could not be reached: try again', async ({ page }) => {
  await openWith(page, (route) => route.abort('internetdisconnected'));
  const button = page.getByTestId('send-test-event');
  await button.click();

  const notice = page.getByTestId('admin-notice');
  await expect(notice).toContainText('The server could not be reached');
  await expect(notice).toContainText('Try again');
  await expect(page.getByTestId('admin-notice-reload')).toHaveCount(0);
  await expect(button).toBeEnabled();
});

test('a press before hydration is replayed: the answer shows and the button frees up', async ({
  page,
}) => {
  await unlockAdmin(page.context());
  // Hold the page's JavaScript (not its CSS: that would hold the first paint too).
  const js = '**/_next/static/chunks/*.js';
  let release: () => void = () => {};
  const released = new Promise<void>((r) => {
    release = r;
  });
  const holdJs = async (route: Route) => {
    await released;
    await route.continue().catch(() => {});
  };
  let actionsSent = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.headers()['next-action']) actionsSent++;
  });
  await page.route(js, holdJs);
  try {
    await page.goto('/admin/realtime?topics=admin', { waitUntil: 'domcontentloaded' });
    const button = page.getByTestId('send-test-event');
    await button.click(); // the server-rendered button: React's inline script queues the submit
    await expect(page.getByTestId('rt-state')).not.toHaveAttribute('data-state', 'ready');
    expect(actionsSent, 'nothing is sent before React runs').toBe(0);
    release();
    await expect(page.getByTestId('admin-notice')).toContainText('test event sent', {
      timeout: 20_000,
    });
    expect(actionsSent).toBe(1);
    await expect(button).toBeEnabled();
    await expect(button).toHaveAttribute('aria-busy', 'false');
  } finally {
    release();
    await page.unroute(js, holdJs);
  }
});
