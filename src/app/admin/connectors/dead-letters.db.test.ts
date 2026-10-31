/**
 * Dead letters on /admin/connectors (1f): requeue (pending, attempts reset) and discard (kept as
 * processed with the reason), by id or all of a stream, only 'dead' rows touched; and the POST
 * /admin/connectors/dead-letters handler: a manager only (a viewer, driver or operator gets 403,
 * signed out 401), same-origin JSON only.
 */
import { beforeEach, describe, expect, test } from 'vitest';
import { makeSession, runWithSession } from '@/platform/auth/testing';
import type { Role } from '@/platform/auth/types';
import { setupTestDb } from '@/test/db';
import { deadCounts, discardDead, requeueDead } from './dead-letters';
import { handleDeadLetters } from './dead-letters/handler';

const t = setupTestDb(import.meta.url);
const sha = (n: number) => n.toString(16).padStart(64, '0');
let ids: string[] = [];

beforeEach(async () => {
  await t().admin.query('delete from ingest.raw_events');
  const r = await t().admin.query<{ id: string }>(
    `insert into ingest.raw_events (source, stream, external_id, payload, sha256, status, attempts, last_error)
     values ('samsara', 'positions', 'v1', '{}', $1, 'dead', 5, 'no machine for v1'),
            ('samsara', 'positions', 'v2', '{}', $2, 'dead', 5, 'bad payload'),
            ('deere', 'locations', 'm1', '{}', $3, 'dead', 5, 'boom'),
            ('deere', 'locations', 'm2', '{}', $4, 'pending', 2, 'retrying')
     returning id::text`,
    [sha(1), sha(2), sha(3), sha(4)],
  );
  ids = r.rows.map((x) => x.id);
});

async function row(id: string) {
  return (
    await t().pool.query(
      'select status, attempts, last_error, processed_at is not null as done from ingest.raw_events where id = $1',
      [id],
    )
  ).rows[0];
}

describe('requeue and discard', () => {
  test('counts per stream and the total', async () => {
    expect(await deadCounts(t().pool)).toEqual({
      total: 3,
      byStream: [
        { source: 'deere', stream: 'locations', count: 1 },
        { source: 'samsara', stream: 'positions', count: 2 },
      ],
    });
  });

  test('requeue one: pending with attempts reset; a pending row is never touched', async () => {
    expect(await requeueDead(t().pool, { ids: [ids[0] as string, ids[3] as string] })).toBe(1);
    expect(await row(ids[0] as string)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(await row(ids[3] as string)).toMatchObject({ status: 'pending', attempts: 2 });
    expect((await deadCounts(t().pool)).total).toBe(2);
  });

  test('discard all of one stream: processed, the reason kept with the old error', async () => {
    expect(
      await discardDead(t().pool, { all: true, source: 'samsara', stream: 'positions' }, 'Amy'),
    ).toBe(2);
    expect(await row(ids[0] as string)).toMatchObject({
      status: 'processed',
      done: true,
      last_error: 'discarded on /admin/connectors by Amy: no machine for v1',
    });
    expect(await row(ids[2] as string)).toMatchObject({ status: 'dead' });
    expect(await requeueDead(t().pool, { all: true })).toBe(1);
    expect((await deadCounts(t().pool)).total).toBe(0);
  });
});

describe('POST /admin/connectors/dead-letters', () => {
  const req = (
    body: unknown,
    headers: Record<string, string> = { 'content-type': 'application/json' },
  ) =>
    new Request('http://localhost:3114/admin/connectors/dead-letters', {
      method: 'POST',
      headers: { host: 'localhost:3114', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const call = async (role: Role | null, body: unknown, headers?: Record<string, string>) => {
    const session = role ? makeSession({ role, displayName: `Test ${role}` }) : null;
    const res = await runWithSession(session, () =>
      handleDeadLetters(req(body, headers), t().pool),
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  test('a viewer, driver or operator gets 403; signed out 401; nothing changes', async () => {
    for (const role of ['viewer', 'driver', 'operator'] as const) {
      expect((await call(role, { action: 'discard', all: true })).status).toBe(403);
    }
    expect((await call(null, { action: 'discard', all: true })).status).toBe(401);
    expect((await deadCounts(t().pool)).total).toBe(3);
  });

  test('a manager requeues and discards; bad requests are refused', async () => {
    expect(await call('manager', { action: 'requeue', ids: [ids[2]] })).toEqual({
      status: 200,
      body: { ok: true, action: 'requeue', count: 1 },
    });
    expect(await call('owner', { action: 'discard', all: true })).toEqual({
      status: 200,
      body: { ok: true, action: 'discard', count: 2 },
    });
    expect((await row(ids[0] as string)).last_error).toMatch(
      /^discarded on \/admin\/connectors by Test owner/,
    );
    expect((await call('manager', { action: 'explode', all: true })).status).toBe(400);
    expect((await call('manager', { action: 'requeue', ids: ['not-a-uuid'] })).status).toBe(400);
    expect((await call('manager', '{not json')).status).toBe(400);
    expect(
      (await call('manager', { action: 'requeue', all: true }, { 'content-type': 'text/plain' }))
        .status,
    ).toBe(415);
    expect(
      (
        await call(
          'manager',
          { action: 'requeue', all: true },
          { 'content-type': 'application/json', origin: 'https://evil.example' },
        )
      ).status,
    ).toBe(403);
  });
});
