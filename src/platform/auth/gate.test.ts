/** The proxy's decisions: who is sent to /login, what never is, and the sliding lifetimes. */
import { describe, expect, test } from 'vitest';
import { proxy, config as proxyConfig } from '../../proxy';
import { OPERATOR_REFRESH_AFTER_SECONDS, SESSION_REFRESH_AFTER_SECONDS } from './cookies';
import { decideGate, type GateInput, isPublicPath, loginRedirect } from './gate';
import { OPERATOR_TTL_SECONDS } from './operator';
import { signIdentity, signOperator, verifyIdentity, verifyOperator } from './tokens';

const SECRET = 'gate-test-secret-0123456789abcdef-xyz';
const NOW = new Date('2026-11-16T13:00:00Z');
const DEV = '0b9cfe4e-7b0e-4bb4-9a4e-6c1f7a0d2a11';
const USER = '6a1d2f8c-3e4b-4c5d-8e9f-0a1b2c3d4e5f';
const ago = (s: number) => new Date(NOW.getTime() - s * 1000);

const input = (over: Partial<GateInput> = {}): GateInput => ({
  secret: SECRET,
  method: 'GET',
  pathname: '/board',
  search: '',
  authCookie: undefined,
  operatorCookie: undefined,
  adminKey: false,
  now: NOW,
  ...over,
});

describe('who is sent to /login', () => {
  test('a page with no identity redirects, carrying where it was going', async () => {
    expect(await decideGate(input())).toEqual({
      action: 'redirect',
      location: '/login?next=%2Fboard',
    });
    expect(await decideGate(input({ pathname: '/', search: '' }))).toEqual({
      action: 'redirect',
      location: '/login',
    });
    expect(loginRedirect('/admin/people', '?x=1&_rsc=abc')).toBe(
      '/login?next=%2Fadmin%2Fpeople%3Fx%3D1',
    );
  });

  test('public pages, the admin cookie and POSTs never redirect', async () => {
    for (const pathname of ['/login', '/login/setup', '/enroll', '/admin/unlock']) {
      expect(isPublicPath(pathname)).toBe(true);
      expect((await decideGate(input({ pathname }))).action).toBe('next');
    }
    expect(isPublicPath('/loginx')).toBe(false);
    expect((await decideGate(input({ adminKey: true }))).action).toBe('next');
    expect((await decideGate(input({ method: 'POST' }))).action).toBe('next');
  });

  test('a valid credential passes; a forged or expired one does not', async () => {
    const good = await signIdentity(SECRET, { kind: 'device', deviceId: DEV, epoch: 0 }, NOW, 600);
    expect(await decideGate(input({ authCookie: good }))).toEqual({ action: 'next', refresh: {} });
    expect((await decideGate(input({ authCookie: `${good}x` }))).action).toBe('redirect');
    const old = await signIdentity(
      SECRET,
      { kind: 'device', deviceId: DEV, epoch: 0 },
      ago(700),
      600,
    );
    expect((await decideGate(input({ authCookie: old }))).action).toBe('redirect');
  });
});

describe('sliding lifetimes', () => {
  test('the base credential is re-issued once a day, same identity', async () => {
    const t = await signIdentity(
      SECRET,
      { kind: 'person', appUserId: USER, epoch: 3, deviceId: null, deviceEpoch: null },
      ago(SESSION_REFRESH_AFTER_SECONDS + 1),
      30 * 24 * 3600,
    );
    const d = await decideGate(input({ authCookie: t }));
    if (d.action !== 'next' || !d.refresh.auth) throw new Error('expected a refresh');
    const fresh = await verifyIdentity(SECRET, d.refresh.auth.value, NOW);
    expect(fresh?.identity).toEqual({
      kind: 'person',
      appUserId: USER,
      epoch: 3,
      deviceId: null,
      deviceEpoch: null,
    });
    expect(fresh?.times.iat).toBe(Math.floor(NOW.getTime() / 1000));
  });

  test('the operator layer slides every 10 minutes, only on its own device', async () => {
    const base = await signIdentity(SECRET, { kind: 'device', deviceId: DEV, epoch: 0 }, NOW, 3600);
    const op = await signOperator(
      SECRET,
      { appUserId: USER, epoch: 0, deviceId: DEV },
      ago(OPERATOR_REFRESH_AFTER_SECONDS + 1),
      OPERATOR_TTL_SECONDS,
    );
    const d = await decideGate(input({ authCookie: base, operatorCookie: op }));
    if (d.action !== 'next' || !d.refresh.operator) throw new Error('expected a refresh');
    expect(d.refresh.operator.maxAge).toBe(OPERATOR_TTL_SECONDS);
    expect((await verifyOperator(SECRET, d.refresh.operator.value, NOW))?.operator.appUserId).toBe(
      USER,
    );

    const fresh = await signOperator(SECRET, { appUserId: USER, epoch: 0, deviceId: DEV }, NOW, 60);
    expect(await decideGate(input({ authCookie: base, operatorCookie: fresh }))).toEqual({
      action: 'next',
      refresh: {},
    });
    const elsewhere = await signOperator(
      SECRET,
      { appUserId: USER, epoch: 0, deviceId: USER },
      ago(OPERATOR_REFRESH_AFTER_SECONDS + 1),
      OPERATOR_TTL_SECONDS,
    );
    expect(await decideGate(input({ authCookie: base, operatorCookie: elsewhere }))).toEqual({
      action: 'next',
      refresh: {},
    });
  });
});

describe('src/proxy.ts', () => {
  const matcher = new RegExp(`^${proxyConfig.matcher[0] as string}$`);

  test('its matcher never covers /api/**, /_next/** or files', () => {
    for (const path of [
      '/api/tiles/fields/10/271/376',
      '/api/jobs/fleet.trucks',
      '/api/webhooks/samsara',
      '/api/oauth/deere',
      '/api/realtime',
      '/api/fleet',
      '/api/health',
      '/api/storage/tiles/basemap.json',
      '/api',
      '/_next/static/chunks/app.js',
      '/favicon.ico',
      '/sw.js',
    ]) {
      expect(matcher.test(path), path).toBe(false);
    }
    for (const path of ['/', '/board', '/m', '/admin/people', '/login', '/enroll', '/apiary']) {
      expect(matcher.test(path), path).toBe(true);
    }
  });

  test('is a function Next can call', () => {
    expect(typeof proxy).toBe('function');
  });
});
