/**
 * app.usage_events against a real database (decision 2a-11; docs/contracts-2a.md §7.6, §7.7;
 * done-when §11.4): the writer's row and its 5-minute bucket dedupe, the farm day around
 * midnight and the DST change, a person or device that doesn't exist (or is deleted later)
 * never breaks a write nor the bucket key, the report's rows (who, board time per device,
 * counts) into the gate line, and usage.prune (400 farm days, in batches, up to the deadline).
 */
import { beforeAll, describe, expect, test } from 'vitest';
import { testJobContext } from '../../connectors/testkit';
import { deterministicId } from '../../domain/ids';
import { USAGE_RETENTION_DAYS } from '../../domain/work-jobs';
import { runUsagePrune } from '../../jobs/usage-prune';
import { recordUsage, writeUsage } from '../../platform/usage/record';
import { addFarmDays, buildUsageReport } from '../../platform/usage/report';
import { setupTestDb } from '../../test/db';
import { loadUsageReportRows, pruneUsageEvents } from './usage';

const t = setupTestDb(import.meta.url);
const id = (k: string) => deterministicId('test', k);

const U = {
  rita: id('user:rita'),
  mo: id('user:mo'),
  owner: id('user:owner'),
  amy: id('user:amy-demo'),
  e2e: id('user:e2e'),
  gone: id('user:gone'),
};
const WALL = id('device:wall');
const CAB = id('device:cab');

async function person(user: string, name: string, role: string, source = 'app') {
  const party = deterministicId('test', `party:${user}`);
  await t().pool.query(
    `insert into farm.parties (id, kind, display_name, roles, source, source_id)
     values ($1::uuid, 'person', $2, '{crew}', $3, $4)`,
    [party, name, source, `party:${user}`],
  );
  await t().pool.query(
    `insert into farm.app_users (id, party_id, role, source, source_id)
     values ($1::uuid, $2::uuid, $3, $4, $5)`,
    [user, party, role, source, `user:${user}`],
  );
}

async function device(did: string, name: string, kind: string) {
  await t().pool.query(
    `insert into farm.devices (id, kind, name, role, source, source_id)
     values ($1::uuid, $2, $3, 'viewer', 'test', $1::text)`,
    [did, kind, name],
  );
}

const rows = async (where = 'true', params: unknown[] = []) =>
  (
    await t().pool.query<{
      farm_day: string;
      kind: string;
      route: string;
      app_user_id: string | null;
      device_id: string | null;
      actor_key: string;
      bucket_at: Date;
    }>(
      `select farm_day::text as farm_day, kind, route, app_user_id::text as app_user_id,
              device_id::text as device_id, actor_key, bucket_at
         from app.usage_events where ${where} order by at, kind, route`,
      params,
    )
  ).rows;

beforeAll(async () => {
  await person(U.rita, 'Rita Real', 'driver');
  await person(U.mo, 'Mo Manager', 'manager');
  await person(U.owner, 'Derrick', 'owner');
  await person(U.amy, 'Amy Kovach', 'manager', 'demo');
  await person(U.e2e, 'E2E Operator', 'operator', 'e2e');
  await person(U.gone, 'Gone Soon', 'operator');
  await device(WALL, 'Shop wall', 'wall');
  await device(CAB, 'Cab 2', 'cab_ipad');
});

describe('the writer', () => {
  test('one row per actor, kind and route per 5-minute bucket', async () => {
    const at = (iso: string) => ({ now: new Date(iso), ex: t().pool });
    const input = {
      kind: 'board_heartbeat' as const,
      route: '/board',
      appUserId: U.rita,
      deviceId: WALL,
    };
    expect(await writeUsage(input, at('2026-11-02T15:00:10Z'))).toBe(true);
    expect(await writeUsage(input, at('2026-11-02T15:04:59Z'))).toBe(false);
    expect(await writeUsage(input, at('2026-11-02T15:05:00Z'))).toBe(true);
    // Another route, kind, person or device is another row in the same bucket.
    expect(await writeUsage({ ...input, route: '/m' }, at('2026-11-02T15:06:00Z'))).toBe(true);
    expect(await writeUsage({ ...input, kind: 'page_view' }, at('2026-11-02T15:06:00Z'))).toBe(
      true,
    );
    expect(await writeUsage({ ...input, appUserId: U.mo }, at('2026-11-02T15:06:00Z'))).toBe(true);
    expect(await writeUsage({ ...input, deviceId: null }, at('2026-11-02T15:06:00Z'))).toBe(true);
    const mine = await rows("farm_day = '2026-11-02'");
    expect(mine).toHaveLength(6);
    expect(mine[0]).toMatchObject({
      farm_day: '2026-11-02',
      kind: 'board_heartbeat',
      route: '/board',
      app_user_id: U.rita,
      device_id: WALL,
      actor_key: `${WALL}:${U.rita}`,
      bucket_at: new Date('2026-11-02T15:00:00Z'),
    });
  });

  test("the farm day is Michigan's, across midnight and the fall-back night", async () => {
    const input = { kind: 'page_view' as const, route: '/m', appUserId: U.mo, deviceId: CAB };
    for (const iso of [
      '2026-11-01T03:59:00Z', // Oct 31, 11:59 PM EDT
      '2026-11-01T05:30:00Z', // Nov 1, 1:30 AM EDT
      '2026-11-01T06:30:00Z', // Nov 1, 1:30 AM EST (the hour again)
      '2026-11-02T04:59:00Z', // Nov 1, 11:59 PM EST
    ]) {
      await recordUsage(input, { ex: t().pool, now: new Date(iso) });
    }
    const days = await rows('app_user_id = $1 and route = $2', [U.mo, '/m']);
    expect(days.map((r) => r.farm_day)).toEqual([
      '2026-10-31',
      '2026-11-01',
      '2026-11-01',
      '2026-11-01',
    ]);
  });

  test('an unknown person or device writes null ids; a later delete keeps the bucket key', async () => {
    const ghost = id('user:never-existed');
    expect(
      await writeUsage(
        { kind: 'job_action', route: '/api/v1/jobs', appUserId: ghost, deviceId: id('device:x') },
        { ex: t().pool, now: new Date('2026-10-20T12:00:00Z') },
      ),
    ).toBe(true);
    const [g] = await rows("farm_day = '2026-10-20'");
    expect(g).toMatchObject({
      app_user_id: null,
      device_id: null,
      actor_key: `${id('device:x')}:${ghost}`,
    });

    const input = {
      kind: 'pin_sign_in' as const,
      route: '/board',
      appUserId: U.gone,
      deviceId: WALL,
    };
    const now = new Date('2026-10-21T12:00:00Z');
    expect(await writeUsage(input, { ex: t().pool, now })).toBe(true);
    await t().pool.query('delete from farm.app_users where id = $1', [U.gone]);
    const [kept] = await rows("farm_day = '2026-10-21'");
    expect(kept).toMatchObject({ app_user_id: null, actor_key: `${WALL}:${U.gone}` });
    // The same actor in the same bucket after the delete: still one row.
    expect(await writeUsage(input, { ex: t().pool, now })).toBe(false);
    expect(await rows("farm_day = '2026-10-21'")).toHaveLength(1);
  });

  test('inside a transaction it is part of it (rolled back with it)', async () => {
    const client = await t().pool.connect();
    try {
      await client.query('begin');
      await recordUsage(
        { kind: 'job_action', route: '/api/v1/jobs/[id]', appUserId: U.rita, deviceId: null },
        { ex: client, now: new Date('2026-10-22T12:00:00Z') },
      );
      expect(
        (await client.query("select 1 from app.usage_events where farm_day = '2026-10-22'"))
          .rowCount,
      ).toBe(1);
      await client.query('rollback');
    } finally {
      client.release();
    }
    expect(await rows("farm_day = '2026-10-22'")).toHaveLength(0);
  });
});

describe('the report', () => {
  const day = '2026-11-05'; // a Thursday
  const at = (hhmm: string) => new Date(`${day}T${hhmm}:00-05:00`);

  beforeAll(async () => {
    const beat = (appUserId: string, deviceId: string | null, hhmm: string) =>
      recordUsage(
        { kind: 'board_heartbeat', route: deviceId === CAB ? '/m' : '/board', appUserId, deviceId },
        { ex: t().pool, now: at(hhmm) },
      );
    // The wall: Rita's beats every 4 minutes from 7:00 (7:00 and 7:04 share a bucket: four
    // rows), then Mo on the same wall at 7:21 and 7:25 (two more): six buckets, 30 minutes.
    for (const hhmm of ['07:00', '07:04', '07:08', '07:12', '07:16'])
      await beat(U.rita, WALL, hhmm);
    for (const hhmm of ['07:21', '07:25']) await beat(U.mo, WALL, hhmm);
    // Mo on his own browser (no device): one bucket.
    await beat(U.mo, null, '12:00');
    // The demo manager and an e2e person on the cab iPad: board time, but never crew.
    await beat(U.amy, CAB, '09:00');
    await recordUsage(
      { kind: 'pin_sign_in', route: '/m', appUserId: U.e2e, deviceId: CAB },
      { ex: t().pool, now: at('09:01') },
    );
    // The owner opens the board: active, not crew.
    await recordUsage(
      { kind: 'page_view', route: '/board', appUserId: U.owner, deviceId: null },
      { ex: t().pool, now: at('08:00') },
    );
    for (const hhmm of ['10:00', '10:01', '10:10']) {
      await recordUsage(
        {
          kind: 'job_action',
          route: '/api/v1/jobs/[id]/status',
          appUserId: U.rita,
          deviceId: WALL,
        },
        { ex: t().pool, now: at(hhmm) },
      );
    }
  });

  test('rows: people with their marks, board time per device, counts per kind', async () => {
    const r = await loadUsageReportRows(t().pool, day, day);
    expect(r.people.map((p) => [p.name, p.role, p.demoOrTest])).toEqual([
      ['Amy Kovach', 'manager', true],
      ['Derrick', 'owner', false],
      ['E2E Operator', 'operator', true],
      ['Mo Manager', 'manager', false],
      ['Rita Real', 'driver', false],
    ]);
    expect(
      r.boardTime
        .map((b) => [b.deviceName ?? b.personName, b.deviceKey === '-', b.buckets])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ['Cab 2', false, 1],
      ['Mo Manager', true, 1],
      ['Shop wall', false, 6],
    ]);
    expect(Object.fromEntries(r.counts.map((c) => [c.kind, c.events]))).toEqual({
      board_heartbeat: 8,
      job_action: 2,
      page_view: 1,
      pin_sign_in: 1,
    });
  });

  test('into the gate line: two real crew pass; the owner and demo/test people never count', async () => {
    const today = '2026-11-06';
    const r = buildUsageReport(
      await loadUsageReportRows(t().pool, addFarmDays(today, -29), today),
      today,
    );
    const d = r.days.find((x) => x.farmDay === day);
    expect(d?.crew.map((p) => p.name)).toEqual(['Mo Manager', 'Rita Real']);
    expect(d?.demoAndTest.map((p) => p.name)).toEqual(['Amy Kovach', 'E2E Operator']);
    expect(d?.notCrew.map((p) => p.name)).toEqual(['Derrick']);
    expect(d?.gate).toBe('pass');
    expect(d?.boardTime).toEqual([
      { label: 'Shop wall', minutes: 30 },
      { label: 'Cab 2', minutes: 5 },
      { label: "Mo Manager's browser", minutes: 5 },
    ]);
    expect(d?.counts.job_action).toBe(2);
    // The fall-back Sunday is skipped whatever happened on it.
    expect(r.days.find((x) => x.farmDay === '2026-11-01')?.gate).toBe('skip');
  });
});

describe('retention (usage.prune)', () => {
  const now = new Date('2027-06-15T12:00:00Z');
  const cutoff = addFarmDays('2027-06-15', -USAGE_RETENTION_DAYS); // 2026-05-11

  beforeAll(async () => {
    const values: string[] = [];
    // Five rows on each of the days just before and on/after the cutoff.
    for (const [offset, n] of [
      [-2, 5],
      [-1, 5],
      [0, 5],
      [1, 5],
    ] as const) {
      for (let i = 0; i < n; i++) {
        const fd = addFarmDays(cutoff, offset);
        const ts = `${fd}T1${i}:00:00Z`;
        values.push(`('${ts}', '${fd}', 'page_view', '/prune/${i}', '-:-', '${ts}')`);
      }
    }
    await t().admin.query(
      `insert into app.usage_events (at, farm_day, kind, route, actor_key, bucket_at)
       values ${values.join(', ')}`,
    );
  });

  const left = async () =>
    (
      await t().pool.query<{ farm_day: string; n: number }>(
        `select farm_day::text as farm_day, count(*)::int as n from app.usage_events
          where route like '/prune/%' group by farm_day order by farm_day`,
      )
    ).rows;

  test('the deadline stops it before it starts', async () => {
    const r = await pruneUsageEvents(t().pool, cutoff, new Date(0));
    expect(r).toEqual({ deleted: 0, complete: false, batches: 0 });
  });

  test("the runner's abort (a shutdown) stops it too, rows left for the next run", async () => {
    const ac = new AbortController();
    ac.abort();
    const ctx = testJobContext(t(), { name: 'usage.prune', now: () => now, signal: ac.signal });
    const result = await runUsagePrune(ctx, { batch: 3 });
    expect(result.items).toBe(0);
    expect(result.note).toContain('the rest tomorrow');
    expect((await left()).reduce((n, r) => n + r.n, 0)).toBe(20);
  });

  test(`deletes the rows of farm days before ${USAGE_RETENTION_DAYS} days ago, in batches`, async () => {
    const ctx = testJobContext(t(), { name: 'usage.prune', now: () => now });
    const before = (await rows()).length;
    const result = await runUsagePrune(ctx, { batch: 3 });
    expect(result.items).toBe(10);
    expect(result.note).toContain(`before ${cutoff}`);
    expect(await left()).toEqual([
      { farm_day: cutoff, n: 5 },
      { farm_day: addFarmDays(cutoff, 1), n: 5 },
    ]);
    // Everything else in this file is newer and stays.
    expect((await rows()).length).toBe(before - 10);
    expect(ctx.log.lines.some((l) => l.msg === 'usage.prune' && l.data?.batches === 4)).toBe(true);
    // A second run finds nothing.
    expect((await runUsagePrune(ctx)).items).toBe(0);
  });
});
