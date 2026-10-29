/**
 * Realtime across browser contexts (plan §7: "realtime across two browser contexts under
 * next start"). Two isolated contexts open /admin/realtime; a test event sent from one
 * (server action -> app.publish -> pg_notify -> LISTEN -> SSE) reaches both within 2 s with the
 * same per-topic seq; dropping the server's LISTEN connection makes both resync and keep
 * receiving. UI only, so it also runs against a remote E2E_BASE_URL.
 */
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';

async function twoMonitors(
  browser: Browser,
): Promise<{ contexts: BrowserContext[]; pages: Page[] }> {
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const pages = await Promise.all(contexts.map((c) => c.newPage()));
  await Promise.all(
    pages.map(async (p) => {
      await p.goto('/admin/realtime?topics=admin');
      await expect(p.getByTestId('rt-state')).toHaveAttribute('data-state', 'ready', {
        timeout: 20_000,
      });
    }),
  );
  return { contexts, pages };
}

/** Send a test event from `from`; returns its marker as RealtimeMonitor shows it. */
async function sendTestEvent(from: Page): Promise<string> {
  const marker = await from.getByTestId('test-marker').inputValue();
  await from.getByTestId('send-test-event').click();
  return `test:${marker}`;
}

const eventFor = (p: Page, marker: string) =>
  p.locator(`[data-testid="rt-event"][data-marker="${marker}"]`);

test('two browser contexts receive the same publish within 2 s', async ({ browser }) => {
  const { contexts, pages } = await twoMonitors(browser);
  try {
    const [a, b] = pages as [Page, Page];
    const sent = Date.now();
    const marker = await sendTestEvent(a);
    await Promise.all(
      [a, b].map((p) => expect(eventFor(p, marker)).toBeVisible({ timeout: 2_000 })),
    );
    expect(Date.now() - sent).toBeLessThan(2_000);
    const seqs = await Promise.all([a, b].map((p) => eventFor(p, marker).getAttribute('data-seq')));
    expect(Number(seqs[0])).toBeGreaterThan(0);
    expect(seqs[1]).toBe(seqs[0]);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

test('both contexts resync when the server LISTEN connection drops, then keep receiving', async ({
  browser,
}, info) => {
  test.skip(info.project.name !== 'wall', 'drops the shared LISTEN connection: run it once');
  const { contexts, pages } = await twoMonitors(browser);
  try {
    const [a, b] = pages as [Page, Page];
    const resyncs = (p: Page) => p.getByTestId('rt-resyncs').textContent().then(Number);
    const before = await Promise.all([a, b].map(resyncs));
    await a.getByTestId('drop-listen').click();
    await expect(a.getByTestId('admin-notice')).toContainText('LISTEN connection dropped');
    await Promise.all(
      [a, b].map((p, i) =>
        expect.poll(() => resyncs(p), { timeout: 10_000 }).toBeGreaterThan(before[i] ?? 0),
      ),
    );
    const marker = await sendTestEvent(b);
    await Promise.all(
      [a, b].map((p) => expect(eventFor(p, marker)).toBeVisible({ timeout: 2_000 })),
    );
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
