/**
 * The /r/<token> POST (a server action with no session) against the real database: a good request
 * becomes a requested job; a revoked or unknown token is refused; the form's problems come back
 * in words with the input to fix; the bot trap makes nothing; the 21st request of a farm day is
 * refused. (The app pool is swapped for the test's.)
 */
import { afterAll, describe, expect, test, vi } from 'vitest';
import { getConfig } from '@/config';
import { runWithSession } from '@/platform/auth/testing';
import { setupTestDb } from '@/test/db';

const t = setupTestDb(import.meta.url);
vi.mock('@/db/client', async (orig) => ({
  ...(await orig<typeof import('@/db/client')>()),
  getPool: () => t().pool,
}));
const { submitRequestAction } = await import('./actions');
const { createRequestLink, revokeRequestLink } = await import('@/db/queries/request-links');

afterAll(() => vi.restoreAllMocks());

const secret = () => getConfig().SESSION_SECRET;

async function newLink(): Promise<{ id: string; token: string; partyId: string }> {
  const p = await t().pool.query<{ id: string }>(
    `insert into farm.parties (kind, display_name, roles) values ('org', 'Juniper Hill Farms LLC', '{customer}')
     returning id`,
  );
  const partyId = p.rows[0]?.id as string;
  const r = await createRequestLink(t().pool, secret(), { partyId, label: null, createdBy: null });
  if (r.status !== 'created') throw new Error(r.status);
  return { id: r.id, token: r.token, partyId };
}

const form = (token: string, over: Record<string, string> = {}) => {
  const f = new FormData();
  const fields = {
    token,
    kind: 'spray',
    fieldId: '',
    where: 'the 80 by the church',
    from: '',
    by: '',
    notes: 'Burndown',
    name: 'Gail Pressler',
    phone: '(517) 555-0100',
    website: '',
    ...over,
  };
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

const jobsOf = async (linkId: string) =>
  (
    await t().pool.query(
      'select status, request_channel from farm.jobs where request_link_id = $1',
      [linkId],
    )
  ).rows;

describe('/r/<token> POST', () => {
  test('a good request becomes a requested job, with no session at all', async () => {
    const l = await newLink();
    const r = await runWithSession(null, () => submitRequestAction(null, form(l.token)));
    expect(r.status).toBe('done');
    expect(await jobsOf(l.id)).toEqual([{ status: 'requested', request_channel: 'web_form' }]);
  });

  test('the form says what to fix, and nothing is made', async () => {
    const l = await newLink();
    expect(await submitRequestAction(null, form(l.token, { name: '' }))).toMatchObject({
      status: 'invalid',
      message: 'Tell us your name.',
      field: 'name',
    });
    expect(await submitRequestAction(null, form(l.token, { where: '' }))).toMatchObject({
      status: 'invalid',
      field: 'where',
    });
    expect(await submitRequestAction(null, form(l.token, { from: '2001-01-01' }))).toMatchObject({
      status: 'invalid',
      message: 'Pick a day from today on.',
    });
    expect(
      await submitRequestAction(null, form(l.token, { fieldId: crypto.randomUUID() })),
    ).toMatchObject({ status: 'invalid', field: 'fieldId' });
    expect(await jobsOf(l.id)).toEqual([]);
  });

  test('the bot trap thanks the bot and makes nothing', async () => {
    const l = await newLink();
    expect(
      (await submitRequestAction(null, form(l.token, { website: 'http://spam' }))).status,
    ).toBe('done');
    expect(await jobsOf(l.id)).toEqual([]);
  });

  test('revoked and unknown tokens are refused alike', async () => {
    const l = await newLink();
    await revokeRequestLink(t().pool, { id: l.id, partyId: l.partyId }, new Date());
    expect((await submitRequestAction(null, form(l.token))).status).toBe('refused');
    expect((await submitRequestAction(null, form('A'.repeat(22)))).status).toBe('refused');
    expect((await submitRequestAction(null, form('nope'))).status).toBe('refused');
    expect(await jobsOf(l.id)).toEqual([]);
  });

  test('the 21st request of a farm day is refused', async () => {
    const l = await newLink();
    await t().pool.query(
      `insert into farm.jobs (kind, business_line, status, request_link_id, request_channel)
       select 'spray', 'spraying', 'requested', $1, 'web_form' from generate_series(1, 20)`,
      [l.id],
    );
    expect((await submitRequestAction(null, form(l.token))).status).toBe('limit');
    expect(await jobsOf(l.id)).toHaveLength(20);
  });
});
