/**
 * POST /api/v1/usage, the board's heartbeat (decision 2a-11; docs/contracts-2a.md §5.2, §7.7;
 * done-when §11.4 "nothing recorded for a session with no person"), run as the sessions it
 * serves against a real database: 401 signed out; every role with a person records one
 * `board_heartbeat` per 5-minute bucket (`recorded: false` for the rest of the bucket); a
 * device session with no one signed in records nothing (`recorded: false`); the request checks
 * (cross-site 403, 415, 413, bad JSON 400, a route or field the contract refuses 400); a
 * database failure is a 503; every answer is JSON and no-store.
 */
import { beforeAll, describe, expect, test, vi } from 'vitest';
import type { Executor } from '@/db/exec';
import { deterministicId } from '@/domain/ids';
import { makeSession, runWithSession } from '@/platform/auth/testing';
import { ROLES, type Session } from '@/platform/auth/types';
import { setupTestDb } from '@/test/db';
import { usageHeartbeatResponseSchema } from '@/ui/work/contract';
import { handleUsageHeartbeat, USAGE_BODY_MAX_BYTES } from './handler';

const t = setupTestDb(import.meta.url);
const id = (k: string) => deterministicId('test', k);
const WALL = id('device:wall');
const userOf = (role: string) => id(`user:${role}`);

function request(
  body: unknown,
  headers: Record<string, string> = { 'content-type': 'application/json' },
): Request {
  return new Request('http://localhost:3124/api/v1/usage', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function post(
  session: Session | null,
  body: unknown = { route: '/board' },
  opts: { headers?: Record<string, string>; ex?: Executor; now?: Date } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await runWithSession(session, () =>
    handleUsageHeartbeat(
      request(body, opts.headers),
      opts.ex ?? t().pool,
      () => opts.now ?? new Date('2026-11-06T15:01:00Z'),
    ),
  );
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('content-type')).toContain('application/json');
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const heartbeats = async () =>
  (
    await t().pool.query<{ actor_key: string; route: string; farm_day: string }>(
      `select actor_key, route, farm_day::text as farm_day from app.usage_events
        where kind = 'board_heartbeat' order by at, actor_key`,
    )
  ).rows;

const person = (role: (typeof ROLES)[number], deviceId: string | null = null) =>
  makeSession({ role, appUserId: userOf(role), partyId: id(`party:${role}`), deviceId });

beforeAll(async () => {
  for (const role of ROLES) {
    await t().pool.query(
      `insert into farm.parties (id, kind, display_name, roles) values ($1::uuid, 'person', $2, '{crew}')`,
      [id(`party:${role}`), `Test ${role}`],
    );
    await t().pool.query(
      'insert into farm.app_users (id, party_id, role) values ($1::uuid, $2::uuid, $3)',
      [userOf(role), id(`party:${role}`), role],
    );
  }
  await t().pool.query(
    `insert into farm.devices (id, kind, name, role) values ($1::uuid, 'wall', 'Shop wall', 'viewer')`,
    [WALL],
  );
});

describe('POST /api/v1/usage', () => {
  test('signed out: 401, nothing recorded', async () => {
    const r = await post(null);
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ status: 401 });
    expect(await heartbeats()).toEqual([]);
  });

  test('a wall with no one signed in (a device session): recorded false, nothing written', async () => {
    const wall = makeSession({ kind: 'device', role: 'viewer', deviceId: WALL, appUserId: null });
    const r = await post(wall);
    expect(r).toEqual({ status: 200, body: { recorded: false } });
    expect(usageHeartbeatResponseSchema.parse(r.body)).toEqual({ recorded: false });
    expect(await heartbeats()).toEqual([]);
  });

  test.each(ROLES)('%s with a person: one beat per bucket', async (role) => {
    const s = person(role, role === 'operator' ? WALL : null);
    expect(await post(s, { route: '/m' })).toEqual({ status: 200, body: { recorded: true } });
    expect(await post(s, { route: '/m' }, { now: new Date('2026-11-06T15:04:59Z') })).toEqual({
      status: 200,
      body: { recorded: false },
    });
    expect(await post(s, { route: '/m' }, { now: new Date('2026-11-06T15:05:00Z') })).toEqual({
      status: 200,
      body: { recorded: true },
    });
    const mine = (await heartbeats()).filter((h) => h.actor_key.endsWith(userOf(role)));
    expect(mine).toHaveLength(2);
    expect(mine[0]).toMatchObject({
      route: '/m',
      farm_day: '2026-11-06',
      actor_key: `${role === 'operator' ? WALL : '-'}:${userOf(role)}`,
    });
  });

  describe('request checks (as a signed-in driver)', () => {
    const s = () => person('driver');

    test('cross-site: 403', async () => {
      const r = await post(s(), undefined, {
        headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      });
      expect(r).toEqual({ status: 403, body: { error: 'cross-site request refused' } });
    });

    test('same origin passes', async () => {
      const r = await post(s(), undefined, {
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost:3124',
          host: 'localhost:3124',
        },
        now: new Date('2026-11-06T16:00:00Z'),
      });
      expect(r.status).toBe(200);
    });

    test('not JSON: 415; too large: 413; bad JSON: 400', async () => {
      expect(
        (await post(s(), 'route=/board', { headers: { 'content-type': 'text/plain' } })).status,
      ).toBe(415);
      expect((await post(s(), 'x'.repeat(USAGE_BODY_MAX_BYTES + 1))).status).toBe(413);
      expect((await post(s(), '{route:')).status).toBe(400);
    });

    test.each([[{ route: '/admin' }], [{ route: '/board', extra: 1 }], [{}], [['/board']]])(
      'a body the contract refuses: 400 (%j)',
      async (body) => {
        const r = await post(s(), body);
        expect(r.status).toBe(400);
        expect(typeof r.body.error).toBe('string');
      },
    );
  });

  test('a database failure: 503, logged', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing: Executor = { query: (() => Promise.reject(new Error('db down'))) as never };
    const r = await post(person('manager'), undefined, { ex: failing });
    expect(r.status).toBe(503);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
