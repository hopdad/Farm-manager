/**
 * runSyncStep against the real functions (contracts §8): skips, landing + cursor in one
 * transaction, sha256 dedupe, paging, failure rules (poll error with Retry-After, lost lease,
 * per-event failures → dead after 5, afterRun on failure, afterRun throwing), deadlines.
 */
import { sql } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { claimDue, ensureStream } from '../db/leases';
import { setupTestDb } from '../test/db';
import { vendorFetch } from './http';
import { runSyncStep } from './sync-step';
import { testJobContext } from './testkit';
import {
  type PollResult,
  type RawItem,
  SyncStepError,
  type SyncStepResult,
  type SyncStepSpec,
  syncStepJobResult,
} from './types';

const t = setupTestDb(import.meta.url);

interface Raw {
  n: number;
  fail?: boolean;
}

let streamNo = 0;
/** A spec on a fresh stream with a scripted poll; upserts write into a scratch table. */
function spec(
  pages: (PollResult<RawItem<Raw>> | Error)[],
  extra: Partial<SyncStepSpec<Raw, Raw>> = {},
): SyncStepSpec<Raw, Raw> & { polls: (string | null)[]; after: SyncStepResult[] } {
  const polls: (string | null)[] = [];
  const after: SyncStepResult[] = [];
  return {
    source: 'samsara',
    stream: `test-${++streamNo}`,
    mode: 'sim',
    polls,
    after,
    async poll(cursor) {
      polls.push(cursor);
      const p = pages.shift();
      if (!p) return { items: [], cursor: cursor ?? '' };
      if (p instanceof Error) throw p;
      return p;
    },
    map(raw) {
      if (raw.fail) throw new Error(`cannot map ${raw.n}`);
      return [raw];
    },
    async upsert(tx, item) {
      await tx.execute(sql`insert into scratch (n) values (${item.n})`);
    },
    async afterRun(result) {
      after.push(result);
    },
    ...extra,
  };
}

const items = (...ns: number[]): RawItem<Raw>[] =>
  ns.map((n) => ({ externalId: `e${n}`, payload: { n } }));

async function scratch(): Promise<number[]> {
  const r = await t().pool.query<{ n: number }>('select n from scratch order by n');
  return r.rows.map((x) => x.n);
}

async function state(stream: string) {
  const r = await t().pool.query(
    `select cursor, mode, last_ok_at is not null as ok_at, last_error,
            extract(epoch from (next_run_at - now()))::int as next_in, lease_token
       from ingest.sync_state where source = 'samsara' and stream = $1`,
    [stream],
  );
  return r.rows[0];
}

describe('runSyncStep', () => {
  test('setup: a scratch table farm_app can write', async () => {
    await t().admin.query('create table public.scratch (n int not null)');
    await t().admin.query('grant select, insert, delete on public.scratch to farm_app');
  });

  test("mode 'off' claims nothing and never polls", async () => {
    const s = spec([{ items: items(1), cursor: 'c1' }], { mode: 'off' });
    const r = await runSyncStep(s, testJobContext(t()));
    expect(r).toEqual({
      claimed: false,
      ok: true,
      skipped: 'off',
      landed: 0,
      processed: 0,
      dead: 0,
      cursor: null,
    });
    expect(s.polls).toEqual([]);
    expect(s.after).toEqual([]);
    expect(syncStepJobResult(r)).toEqual({ items: 0, note: 'off' });
    expect((await state(s.stream)).mode).toBe('off');
  });

  test('a stream lease held elsewhere is skipped', async () => {
    const s = spec([{ items: items(1), cursor: 'c1' }]);
    await ensureStream(t().pool, 'samsara', s.stream, 'sim');
    expect(await claimDue(t().pool, 'samsara', s.stream, 90)).not.toBeNull();
    const r = await runSyncStep(s, testJobContext(t()));
    expect(r).toMatchObject({ claimed: false, ok: true, skipped: 'lease held elsewhere' });
    expect(syncStepJobResult(r)).toEqual({ items: 0, note: 'lease held elsewhere' });
    expect(s.polls).toEqual([]);
  });

  test('lands, advances the cursor, processes, releases, then afterRun; duplicates dedupe', async () => {
    await t().pool.query('delete from scratch');
    const s = spec([
      { items: items(1, 2, 3), cursor: 'c1' },
      { items: items(2, 3, 4), cursor: 'c2' },
    ]);
    const ctx = testJobContext(t());
    const r1 = await runSyncStep(s, ctx);
    expect(r1).toEqual({ claimed: true, ok: true, landed: 3, processed: 3, dead: 0, cursor: 'c1' });
    expect(s.after).toEqual([r1]);
    const st = await state(s.stream);
    expect(st).toMatchObject({ cursor: 'c1', ok_at: true, lease_token: null });

    const r2 = await runSyncStep(s, ctx);
    expect(s.polls).toEqual([null, 'c1']);
    expect(r2).toMatchObject({ ok: true, landed: 1, processed: 1, cursor: 'c2' });
    expect(await scratch()).toEqual([1, 2, 3, 4]);
    const raw = await t().pool.query(
      `select count(*)::int as n, count(*) filter (where status = 'processed')::int as done
         from ingest.raw_events where stream = $1`,
      [s.stream],
    );
    expect(raw.rows[0]).toEqual({ n: 4, done: 4 });
    expect(syncStepJobResult(r2)).toEqual({ items: 1 });
  });

  test('keeps polling while the vendor says hasMore', async () => {
    const s = spec([
      { items: items(10), cursor: 'p1', hasMore: true },
      { items: items(11), cursor: 'p2', hasMore: true },
      { items: items(12), cursor: 'p3', hasMore: false },
      { items: items(13), cursor: 'p4' },
    ]);
    const r = await runSyncStep(s, testJobContext(t()));
    expect(s.polls).toEqual([null, 'p1', 'p2']);
    expect(r).toMatchObject({ ok: true, landed: 3, processed: 3, cursor: 'p3' });
  });

  test('a poll error with Retry-After releases with backoff; afterRun still runs; never throws', async () => {
    const err = Object.assign(new Error('samsara /feed: HTTP 429 (Rate limit exceeded)'), {
      retryAfterSeconds: 30,
    });
    const s = spec([{ items: items(20), cursor: 'k1' }, err]);
    const ctx = testJobContext(t());
    await runSyncStep(s, ctx);
    const r = await runSyncStep(s, ctx);
    expect(r).toEqual({
      claimed: true,
      ok: false,
      error: 'samsara /feed: HTTP 429 (Rate limit exceeded)',
      landed: 0,
      processed: 0,
      dead: 0,
      cursor: 'k1',
    });
    expect(s.after.at(-1)).toEqual(r);
    const st = await state(s.stream);
    expect(st.last_error).toBe('samsara /feed: HTTP 429 (Rate limit exceeded)');
    expect(st.next_in).toBeGreaterThan(25);
    expect(st.next_in).toBeLessThanOrEqual(30);
    expect(st.cursor).toBe('k1');
    // Not due yet: the next run is skipped.
    expect((await runSyncStep(s, ctx)).skipped).toBe('lease held elsewhere');
    expect(() => syncStepJobResult(r)).toThrow(SyncStepError);
  });

  test('a poll error without Retry-After is due again at the next tick', async () => {
    const s = spec([
      new Error('samsara /feed: unreachable (ECONNREFUSED)'),
      { items: items(30), cursor: 'z' },
    ]);
    const ctx = testJobContext(t());
    const r = await runSyncStep(s, ctx);
    expect(r).toMatchObject({
      claimed: true,
      ok: false,
      error: 'samsara /feed: unreachable (ECONNREFUSED)',
    });
    expect((await state(s.stream)).next_in).toBeNull();
    expect(await runSyncStep(s, ctx)).toMatchObject({ ok: true, landed: 1, cursor: 'z' });
  });

  test('a lost lease rolls the page back and stops', async () => {
    const s = spec([]);
    s.poll = async () => {
      // Someone else takes the stream over mid-run.
      await t().admin.query(
        `update ingest.sync_state set lease_token = gen_random_uuid() where source = 'samsara' and stream = $1`,
        [s.stream],
      );
      return { items: items(40, 41), cursor: 'stolen' };
    };
    const r = await runSyncStep(s, testJobContext(t()));
    expect(r).toMatchObject({
      claimed: true,
      ok: false,
      error: 'lease lost',
      landed: 0,
      processed: 0,
    });
    const raw = await t().pool.query(
      'select count(*)::int as n from ingest.raw_events where stream = $1',
      [s.stream],
    );
    expect(raw.rows[0].n).toBe(0);
    expect((await state(s.stream)).cursor).toBeNull();
  });

  test('one bad event is not a step failure: attempts count up, dead after 5', async () => {
    await t().pool.query('delete from scratch');
    const s = spec([
      {
        items: [...items(50), { externalId: 'bad', payload: { n: 51, fail: true } }],
        cursor: 'b1',
      },
    ]);
    const ctx = testJobContext(t());
    const results: SyncStepResult[] = [];
    for (let i = 0; i < 5; i++) results.push(await runSyncStep(s, ctx));
    expect(results.map((r) => [r.ok, r.processed, r.dead])).toEqual([
      [true, 1, 0],
      [true, 0, 0],
      [true, 0, 0],
      [true, 0, 0],
      [true, 0, 1],
    ]);
    expect(syncStepJobResult(results[4] as SyncStepResult)).toEqual({
      items: 0,
      note: '1 dead-lettered',
    });
    const bad = await t().pool.query(
      `select status, attempts, last_error from ingest.raw_events where stream = $1 and external_id = 'bad'`,
      [s.stream],
    );
    expect(bad.rows[0]).toEqual({ status: 'dead', attempts: 5, last_error: 'cannot map 51' });
    expect(await scratch()).toEqual([50]);
  });

  test('an upsert that fails half way leaves nothing behind (its savepoint rolls back)', async () => {
    await t().pool.query('delete from scratch');
    const s = spec([{ items: items(60), cursor: 'u1' }], {
      async upsert(tx, item) {
        await tx.execute(sql`insert into scratch (n) values (${item.n})`);
        throw new Error('constraint went wrong');
      },
    });
    const r = await runSyncStep(s, testJobContext(t()));
    expect(r).toMatchObject({ ok: true, landed: 1, processed: 0 });
    expect(await scratch()).toEqual([]);
  });

  test('past the deadline it lands but leaves processing for the next run', async () => {
    const base = Date.now();
    let offset = 0;
    const s = spec([]);
    s.poll = async () => {
      offset = 120_000; // the poll took us past the deadline
      return { items: items(70, 71), cursor: 'd1' };
    };
    const ctx = testJobContext(t(), { now: () => new Date(base + offset) });
    const r = await runSyncStep(s, ctx);
    expect(r).toMatchObject({ ok: true, landed: 2, processed: 0 });
    s.poll = async (cursor) => ({ items: [], cursor: cursor ?? '' });
    const r2 = await runSyncStep(s, testJobContext(t()));
    expect(r2).toMatchObject({ ok: true, landed: 0, processed: 2 });
  });

  test('afterRun throwing turns the result into a failure', async () => {
    const s = spec([{ items: items(80), cursor: 'a1' }], {
      async afterRun() {
        throw new Error('publish failed');
      },
    });
    const ctx = testJobContext(t());
    const r = await runSyncStep(s, ctx);
    expect(r).toMatchObject({
      claimed: true,
      ok: false,
      error: 'afterRun: publish failed',
      processed: 1,
    });
    expect(ctx.log.lines.some((l) => l.level === 'error' && l.msg === 'sync afterRun failed')).toBe(
      true,
    );
    // The stream itself was released OK.
    expect((await state(s.stream)).ok_at).toBe(true);
  });

  test('a page is applied in series time order (external_id), not in uuid order', async () => {
    // One catch-up page: a vehicle's stats from 05:46 to 05:49, delivered newest first. Every row
    // of the page shares fetched_at, and ids are random, so only external_id orders them.
    const order: string[] = [];
    const minutes = [49, 48, 47, 46];
    const s = spec(
      [
        {
          items: minutes.map((m) => ({
            externalId: `281474976831855:fuelPercents:2026-10-29T05:${m}:00.000Z`,
            payload: { n: m },
          })),
          cursor: 'f1',
        },
      ],
      {
        async upsert(_tx, item) {
          order.push(`05:${item.n}`);
        },
      },
    );
    const r = await runSyncStep(s, testJobContext(t()));
    expect(r).toMatchObject({ ok: true, landed: 4, processed: 4 });
    expect(order).toEqual(['05:46', '05:47', '05:48', '05:49']);
  });
});

describe('runSyncStep: call counting and minIntervalSeconds (1f decision 4)', () => {
  /** A poll that makes `n` vendor calls (statuses in order) through vendorFetch. */
  function callingPoll(statuses: number[], cursor = 'k1') {
    return async (): Promise<PollResult<RawItem<Raw>>> => {
      for (const s of statuses) {
        await vendorFetch(
          'http://vendor.test/feed?after=x',
          {},
          {
            vendor: 'samsara',
            maxRetries: 0,
            fetch: async () => Response.json({}, { status: s }),
            now: () => new Date('2026-10-31T12:00:00Z'),
          },
        ).catch(() => {});
      }
      return { items: [], cursor };
    };
  }

  async function counts(stream: string) {
    const r = await t().pool.query(
      `select mode, to_char(day, 'YYYY-MM-DD') as day, calls, errors, rate_limited
         from ingest.api_calls_daily where source = 'samsara' and stream = $1 order by mode`,
      [stream],
    );
    return r.rows;
  }

  async function extra(stream: string) {
    const r = await t().pool.query(
      `select extra from ingest.sync_state where source = 'samsara' and stream = $1`,
      [stream],
    );
    return r.rows[0]?.extra;
  }

  test("every attempt of a run counts under the vendor, the step's stream and mode", async () => {
    const s = spec([], { poll: callingPoll([200, 503, 429, 200]) });
    const r = await runSyncStep(s, testJobContext(t()));
    expect(r.ok).toBe(true);
    expect(await counts(s.stream)).toEqual([
      { mode: 'sim', day: '2026-10-31', calls: 4, errors: 1, rate_limited: 1 },
    ]);
    expect(await extra(s.stream)).toMatchObject({ callsPerRun: 4, callsPerRunMode: 'sim' });

    // A second run adds to the day's row and to the mean.
    await runSyncStep({ ...s, poll: callingPoll([200, 200]) }, testJobContext(t()));
    expect((await counts(s.stream))[0]).toMatchObject({ calls: 6 });
    expect(await extra(s.stream)).toMatchObject({ callsPerRun: 3, callsRecent: [4, 2] });
  });

  test('a failed run counts its calls but leaves calls per run alone; off counts nothing', async () => {
    const failing = spec([], {
      async poll() {
        await callingPoll([200, 200])();
        throw new Error('vendor broke mid-run');
      },
    });
    const r = await runSyncStep(failing, testJobContext(t()));
    expect(r).toMatchObject({ claimed: true, ok: false });
    expect((await counts(failing.stream))[0]).toMatchObject({ calls: 2 });
    expect((await extra(failing.stream))?.callsPerRun).toBeUndefined();

    const off = spec([], { mode: 'off', poll: callingPoll([200]) });
    await runSyncStep(off, testJobContext(t()));
    expect(await counts(off.stream)).toEqual([]);
  });

  test('calls of other modes go to their own rows (a sim day never counts as sandbox)', async () => {
    const s = spec([], { mode: 'sandbox', poll: callingPoll([200]) });
    await runSyncStep(s, testJobContext(t()));
    await t().pool.query(`select app.ensure_stream('samsara', $1, 'sim')`, [s.stream]);
    await runSyncStep({ ...s, mode: 'sim' }, testJobContext(t()));
    expect((await counts(s.stream)).map((x) => [x.mode, x.calls])).toEqual([
      ['sandbox', 1],
      ['sim', 1],
    ]);
    // The measurement starts over in the new mode.
    expect(await extra(s.stream)).toMatchObject({ callsPerRunMode: 'sim', callsRecent: [1] });
  });

  test('minIntervalSeconds: next_run_at = run start + the minimum (the later of it and Retry-After)', async () => {
    const nextIn = async (stream: string) =>
      (
        await t().pool.query(
          `select extract(epoch from (next_run_at - now()))::int as s from ingest.sync_state
            where source = 'samsara' and stream = $1`,
          [stream],
        )
      ).rows[0].s as number | null;

    const paced = spec([{ items: items(1), cursor: 'p1' }], { minIntervalSeconds: 300 });
    await runSyncStep(paced, testJobContext(t()));
    const a = await nextIn(paced.stream);
    expect(a).toBeGreaterThan(290);
    expect(a).toBeLessThanOrEqual(300);
    // Not due yet: the next firing is skipped.
    expect(await runSyncStep(paced, testJobContext(t()))).toMatchObject({ claimed: false });

    // A longer Retry-After wins over the minimum; a shorter one doesn't.
    const limited = spec([Object.assign(new Error('429'), { retryAfterSeconds: 900 })], {
      minIntervalSeconds: 300,
    });
    await runSyncStep(limited, testJobContext(t()));
    expect(await nextIn(limited.stream)).toBeGreaterThan(890);
    const short = spec([Object.assign(new Error('429'), { retryAfterSeconds: 5 })], {
      minIntervalSeconds: 300,
    });
    await runSyncStep(short, testJobContext(t()));
    expect(await nextIn(short.stream)).toBeGreaterThan(290);

    // Unset, null or 0: no minimum (due again at the next firing).
    for (const min of [undefined, null, 0]) {
      const free = spec([{ items: items(2), cursor: 'f1' }], { minIntervalSeconds: min });
      await runSyncStep(free, testJobContext(t()));
      expect(await nextIn(free.stream)).toBeNull();
    }
  });
});
