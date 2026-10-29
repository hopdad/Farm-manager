/**
 * The routes pg_cron, the clock, vendors and map tiles call never answer 3xx (contracts §5, plan
 * §1 "A contract test checks these never answer 3xx"), with or without a trailing slash: pg_net
 * and the clock don't follow redirects, and Next would 308 a trailing slash without
 * `skipTrailingSlashRedirect`. Request-only; runs once (wall project).
 */
import { expect, test } from '@playwright/test';

const CASES: { method: 'GET' | 'POST'; path: string }[] = [
  { method: 'POST', path: '/api/jobs/fleet.trucks' },
  { method: 'GET', path: '/api/realtime' },
  { method: 'GET', path: '/api/tiles/fields/10/271/376' },
  { method: 'POST', path: '/api/webhooks/samsara' },
  { method: 'GET', path: '/api/oauth/deere' },
  { method: 'GET', path: '/api/fleet' },
  { method: 'GET', path: '/api/health' },
];

test('excluded API routes never redirect, with or without a trailing slash', async ({
  baseURL,
}, info) => {
  test.skip(info.project.name !== 'wall', 'request-only: run once');
  for (const c of CASES) {
    for (const path of [c.path, `${c.path}/`]) {
      const ac = new AbortController();
      // Headers only: /api/realtime streams forever.
      const res = await fetch(`${baseURL}${path}`, {
        method: c.method,
        redirect: 'manual',
        signal: ac.signal,
        headers: { 'content-type': 'application/json' },
        body: c.method === 'POST' ? '{}' : undefined,
      });
      ac.abort();
      expect(res.status >= 300 && res.status < 400, `${c.method} ${path} -> ${res.status}`).toBe(
        false,
      );
      expect(res.status, `${c.method} ${path}`).not.toBe(404);
    }
  }
});
