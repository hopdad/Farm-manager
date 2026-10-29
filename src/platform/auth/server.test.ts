/**
 * The server helpers' contract through the test seam (no cookies involved): getSession returns
 * the override, requireRole throws typed AuthErrors, authErrorResponse maps them to 401/403.
 */
import { describe, expect, test } from 'vitest';
import { authErrorResponse, getSession, requireRole } from './server';
import { makeSession, runWithSession, sessionOverride } from './testing';
import { AuthError } from './types';

describe('getSession / requireRole', () => {
  test('return the active session', async () => {
    const s = makeSession({ role: 'operator', displayName: 'Dana', appUserId: 'u1' });
    await runWithSession(s, async () => {
      expect(await getSession()).toBe(s);
      expect(await requireRole('driver')).toBe(s);
      await expect(requireRole('manager')).rejects.toMatchObject({ status: 403 });
    });
  });

  test('signed out: getSession is null and requireRole is 401', async () => {
    await runWithSession(null, async () => {
      expect(await getSession()).toBeNull();
      await expect(requireRole('viewer')).rejects.toMatchObject({ status: 401 });
    });
  });

  test('the override only exists inside runWithSession', async () => {
    expect(sessionOverride()).toBeUndefined();
    await runWithSession(makeSession(), async () => {
      await Promise.resolve();
      expect(sessionOverride()?.displayName).toBe('Test user');
    });
    expect(sessionOverride()).toBeUndefined();
  });
});

describe('authErrorResponse', () => {
  test('maps AuthError to a no-store JSON 401/403', async () => {
    const r401 = authErrorResponse(new AuthError(401));
    expect(r401?.status).toBe(401);
    expect(r401?.headers.get('cache-control')).toBe('no-store');
    expect(await r401?.json()).toMatchObject({ status: 401, required: null });
    const r403 = authErrorResponse(new AuthError(403, undefined, 'manager'));
    expect(r403?.status).toBe(403);
    expect(await r403?.json()).toMatchObject({ status: 403, required: 'manager' });
  });

  test('anything else is not its business', () => {
    expect(authErrorResponse(new Error('db down'))).toBeNull();
    expect(authErrorResponse('nope')).toBeNull();
  });
});
