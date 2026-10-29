/** Page guards: signed out goes to /login (coming back afterwards), too low a role is refused. */
import { describe, expect, test } from 'vitest';
import { loginPathFor, pageSession, requirePageSession } from './page';
import { makeSession, runWithSession } from './testing';

async function redirectOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    // next/navigation's redirect() throws an error whose digest carries the location.
    const digest = String((e as { digest?: string }).digest ?? '');
    if (!digest.startsWith('NEXT_REDIRECT')) throw e;
    return digest.split(';')[2] ?? null;
  }
}

describe('page guards', () => {
  test('signed out: redirect to /login with the page as next', async () => {
    expect(await redirectOf(() => runWithSession(null, () => requirePageSession('/board')))).toBe(
      '/login?next=%2Fboard',
    );
    expect(
      await redirectOf(() => runWithSession(null, () => pageSession('manager', '/admin/people'))),
    ).toBe('/login?next=%2Fadmin%2Fpeople');
    expect(loginPathFor('/')).toBe('/login');
  });

  test('a role too low is refused without a redirect; enough passes', async () => {
    const viewer = makeSession({ role: 'viewer', kind: 'device' });
    expect(await runWithSession(viewer, () => pageSession('manager', '/admin/people'))).toEqual({
      ok: false,
      required: 'manager',
      session: viewer,
    });
    const owner = makeSession({ role: 'owner' });
    expect(await runWithSession(owner, () => pageSession('manager', '/admin/people'))).toEqual({
      ok: true,
      session: owner,
    });
  });
});
