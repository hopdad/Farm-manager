import { expect, test } from '@playwright/test';

// Request-only smoke test; needs a running app at baseURL (E2E_BASE_URL).
test('GET /api/health reports the database', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.ok()).toBe(true);
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, db: true });
});
