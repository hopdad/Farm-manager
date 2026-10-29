import { describe, expect, test } from 'vitest';
import { unlockResponse } from '../../app/admin/_lib/unlock';
import { ADMIN_COOKIE, adminCookie, adminKey, adminUnlockUrl, isAdminKey } from './admin-key';

const SECRET = 's'.repeat(40);
const dev = { SESSION_SECRET: SECRET, isProduction: false, cookieSecure: false };

describe('admin key', () => {
  test('stable per SESSION_SECRET, different for another secret, URL-safe', () => {
    expect(adminKey(SECRET)).toBe(adminKey(SECRET));
    expect(adminKey(SECRET)).not.toBe(adminKey('t'.repeat(40)));
    expect(adminKey(SECRET)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('only the exact key unlocks, and never in production', () => {
    const key = adminKey(SECRET);
    expect(isAdminKey(dev, key)).toBe(true);
    expect(isAdminKey(dev, `${key}x`)).toBe(false);
    expect(isAdminKey(dev, key.slice(0, -1))).toBe(false);
    expect(isAdminKey(dev, '')).toBe(false);
    expect(isAdminKey(dev, null)).toBe(false);
    expect(isAdminKey({ ...dev, isProduction: true }, key)).toBe(false);
  });

  test('cookie: HttpOnly, SameSite=Strict, Path=/; Secure follows PUBLIC_URL', () => {
    const c = adminCookie('k', false);
    expect(c).toMatch(new RegExp(`^${ADMIN_COOKIE}=k; Path=/; HttpOnly; SameSite=Strict`));
    expect(c).not.toContain('Secure');
    expect(adminCookie('k', true)).toMatch(/; Secure$/);
  });

  test('the unlock link', () => {
    const url = new URL(adminUnlockUrl('http://localhost:3000', SECRET));
    expect(`${url.origin}${url.pathname}`).toBe('http://localhost:3000/admin/unlock');
    expect(url.searchParams.get('key')).toBe(adminKey(SECRET));
  });
});

describe('/admin/unlock', () => {
  test('the right key sets the cookie and links on (200, never 3xx)', async () => {
    const res = unlockResponse(dev, adminUnlockUrl('http://localhost:3000', SECRET));
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBe(adminCookie(adminKey(SECRET), false));
    expect(await res.text()).toContain('href="/admin/connectors"');
  });

  test('a wrong or missing key: 403, no cookie', () => {
    for (const url of ['http://pc:3000/admin/unlock?key=nope', 'http://pc:3000/admin/unlock']) {
      const res = unlockResponse(dev, url);
      expect(res.status).toBe(403);
      expect(res.headers.get('set-cookie')).toBeNull();
    }
  });

  test('production: 404 even with the key', () => {
    const res = unlockResponse(
      { ...dev, isProduction: true },
      adminUnlockUrl('https://farm.example', SECRET),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});
