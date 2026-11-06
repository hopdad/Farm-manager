/**
 * The request-link section's actions against the real database, as the sessions that press them:
 * below manager is refused (nothing made); a manager makes a link (the token comes back once, in
 * the link and its QR code, with the PC's LAN address when the page was opened on localhost; only
 * the hash is stored) and revokes it; a non-customer gets no link. (Next's revalidatePath, the
 * request headers and the app pool are swapped for the test's.)
 */
import { afterAll, describe, expect, test, vi } from 'vitest';
import { getConfig } from '@/config';
import { makeSession, runWithSession } from '@/platform/auth/testing';
import type { Role } from '@/platform/auth/types';
import { setupTestDb } from '@/test/db';

const t = setupTestDb(import.meta.url);
let host = 'farm-pc.local:3000';
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ host }) }));
vi.mock('@/db/client', async (orig) => ({
  ...(await orig<typeof import('@/db/client')>()),
  getPool: () => t().pool,
}));
const { createRequestLinkAction, revokeRequestLinkAction } = await import('./actions');
const { requestLinkHash, resolveRequestLink } = await import('@/db/queries/request-links');

afterAll(() => vi.restoreAllMocks());

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const as = (role: Role) => makeSession({ role, displayName: `Test ${role}` });

async function party(roles: string[]): Promise<string> {
  const r = await t().pool.query<{ id: string }>(
    `insert into farm.parties (kind, display_name, roles) values ('org', 'Halvorsen Bros. Farms', $1)
     returning id`,
    [roles],
  );
  return r.rows[0]?.id as string;
}

const count = async (partyId: string) =>
  Number(
    (
      await t().pool.query('select count(*) from farm.job_request_links where party_id = $1', [
        partyId,
      ])
    ).rows[0].count,
  );

describe('request link actions', () => {
  test('below manager: refused on the server, no link made', async () => {
    const p = await party(['customer']);
    for (const role of ['viewer', 'driver', 'operator'] as const) {
      const r = await runWithSession(as(role), () =>
        createRequestLinkAction(null, form({ partyId: p })),
      );
      expect(r, role).toMatchObject({
        ok: false,
        message: 'Request links need a manager or the owner.',
      });
      expect(r.made).toBeUndefined();
    }
    expect(
      await runWithSession(null, () => createRequestLinkAction(null, form({ partyId: p }))),
    ).toMatchObject({ ok: false, message: 'Sign in first.' });
    expect(await count(p)).toBe(0);
  });

  test('a manager makes a link (shown once) and revokes it', async () => {
    const p = await party(['customer']);
    const r = await runWithSession(as('manager'), () =>
      createRequestLinkAction(null, form({ partyId: p, label: 'Gail' })),
    );
    expect(r).toMatchObject({ ok: true, message: 'Link made: copy it now, it is shown only once' });
    const made = r.made;
    if (!made) throw new Error('no link');
    const m = /^http:\/\/farm-pc\.local:3000\/r\/([A-Za-z0-9_-]{22})$/.exec(made.url);
    expect(m, made.url).not.toBeNull();
    const token = m?.[1] as string;
    expect(made).toMatchObject({ label: 'Gail', localUrl: null, lanUrls: [] });
    expect(made.qr.size).toBeGreaterThan(20);
    const row = await t().pool.query(
      'select token_hash, label from farm.job_request_links where id = $1',
      [made.linkId],
    );
    expect(row.rows[0]).toEqual({
      token_hash: requestLinkHash(getConfig().SESSION_SECRET, token),
      label: 'Gail',
    });
    expect(await resolveRequestLink(t().pool, getConfig().SESSION_SECRET, token)).not.toBeNull();

    const revoked = await runWithSession(as('manager'), () =>
      revokeRequestLinkAction(null, form({ partyId: p, linkId: made.linkId })),
    );
    expect(revoked).toMatchObject({ ok: true, message: 'Link revoked: it no longer opens' });
    expect(await resolveRequestLink(t().pool, getConfig().SESSION_SECRET, token)).toBeNull();
    expect(
      await runWithSession(as('manager'), () =>
        revokeRequestLinkAction(null, form({ partyId: p, linkId: made.linkId })),
      ),
    ).toMatchObject({ ok: true, message: 'That link was already revoked' });
    expect(
      await runWithSession(as('driver'), () =>
        revokeRequestLinkAction(null, form({ partyId: p, linkId: made.linkId })),
      ),
    ).toMatchObject({ ok: false });
  });

  test('on localhost the link uses a LAN address (a phone cannot open localhost)', async () => {
    host = 'localhost:3000';
    const p = await party(['customer']);
    const r = await runWithSession(as('owner'), () =>
      createRequestLinkAction(null, form({ partyId: p })),
    );
    host = 'farm-pc.local:3000';
    expect(r.ok).toBe(true);
    expect(r.made?.localUrl ?? r.made?.url).toMatch(/^http:\/\/localhost:3000\/r\//);
  });

  test('a party that is not a customer gets no link; an unknown one neither', async () => {
    const landlord = await party(['landlord']);
    expect(
      await runWithSession(as('manager'), () =>
        createRequestLinkAction(null, form({ partyId: landlord })),
      ),
    ).toMatchObject({
      ok: false,
      message: 'Request links are for customers: give them the customer role.',
    });
    expect(
      await runWithSession(as('manager'), () =>
        createRequestLinkAction(null, form({ partyId: crypto.randomUUID() })),
      ),
    ).toMatchObject({ ok: false, message: 'That customer no longer exists.' });
    expect(
      await runWithSession(as('manager'), () =>
        revokeRequestLinkAction(null, form({ partyId: 'x', linkId: 'y' })),
      ),
    ).toMatchObject({ ok: false, message: 'That link no longer exists.' });
  });
});
