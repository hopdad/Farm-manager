/**
 * The jobs publish triggers (db/pending/jobs-api.sql; decision 2a-8, docs/contracts-2a.md §6)
 * against a real database with a LISTEN app_events client, as the SSE hub runs it: a write is
 * heard within 1 s with the `jobs` seq going up; old and new field ids; machines and people
 * from assignment rows; a rolled-back write and a statement that changes nothing are silent;
 * 500 jobs in one INSERT are ONE invalidate; an upsert sends at most two messages and a job
 * delete at most three (one per table), never one per row; data:import's GUC silences them;
 * nine triggers, one per event per table, one shared function.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { JOBS_TRIGGER_MAX_PAYLOAD_BYTES } from '../../domain/work-jobs';
import { LOCAL_NOTIFY_CHANNEL, type NotifyMessage } from '../../platform/realtime/types';
import { setupTestDb } from '../../test/db';
import {
  insertTestAssignment,
  insertTestField,
  insertTestJob,
  insertTestMachine,
  insertTestPerson,
  insertTestProduct,
} from './work-jobs-testkit';

const t = setupTestDb(import.meta.url);
let listener: pg.Client;
let received: { at: number; msg: NotifyMessage }[] = [];

beforeAll(async () => {
  listener = new pg.Client({ connectionString: t().appUrl });
  await listener.connect();
  listener.on('notification', (n) => {
    if (n.channel !== LOCAL_NOTIFY_CHANNEL || !n.payload) return;
    const msg = JSON.parse(n.payload) as NotifyMessage;
    if (msg.topic === 'jobs') received.push({ at: Date.now(), msg });
  });
  await listener.query(`listen ${LOCAL_NOTIFY_CHANNEL}`);
});
afterAll(async () => {
  await listener?.end();
});

beforeEach(async () => {
  await settle();
  received = [];
});

/** Let in-flight notifications arrive. */
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

function waitForJobs(n: number, ms = 1000): Promise<NotifyMessage[]> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (received.length >= n) return resolve(received.map((r) => r.msg));
      if (Date.now() - started > ms) {
        return reject(new Error(`${received.length} of ${n} jobs messages within ${ms} ms`));
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

/** Wait a moment more and return everything heard (to assert nothing extra came). */
async function allHeard(): Promise<NotifyMessage[]> {
  await settle(250);
  return received.map((r) => r.msg);
}

const sorted = (xs: string[]) => [...xs].sort();

describe('the nine triggers', () => {
  test('one per event per table, statement level, after, all calling app.publish_jobs_changes', async () => {
    const r = await t().admin.query<{
      tbl: string;
      name: string;
      fn: string;
      events: string;
      level: string;
      timing: string;
    }>(
      `select c.relname as tbl, t.tgname as name, p.proname as fn,
              e.event_manipulation as events, e.action_orientation as level,
              e.action_timing as timing
         from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'farm'
         join pg_proc p on p.oid = t.tgfoid
         join information_schema.triggers e
           on e.trigger_name = t.tgname and e.event_object_table = c.relname
        where c.relname in ('jobs', 'job_assignments', 'job_products') and not t.tgisinternal
        order by 1, 2`,
    );
    expect(r.rows).toHaveLength(9);
    for (const row of r.rows) {
      expect(row).toMatchObject({
        fn: 'publish_jobs_changes',
        level: 'STATEMENT',
        timing: 'AFTER',
      });
    }
    const byTable = (tbl: string) =>
      r.rows
        .filter((x) => x.tbl === tbl)
        .map((x) => x.events)
        .sort();
    for (const tbl of ['jobs', 'job_assignments', 'job_products']) {
      expect(byTable(tbl)).toEqual(['DELETE', 'INSERT', 'UPDATE']);
    }
  });

  test('the functions are SECURITY INVOKER with a pinned search_path; farm_app may run them', async () => {
    const r = await t().admin.query<{ name: string; definer: boolean; config: string[] | null }>(
      `select p.proname as name, p.prosecdef as definer, p.proconfig as config
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'app'
        where p.proname like 'publish_jobs_%' order by 1`,
    );
    expect(r.rows.map((x) => x.name)).toEqual([
      'publish_jobs_changes',
      'publish_jobs_payload',
      'publish_jobs_updated',
    ]);
    for (const row of r.rows) {
      expect(row.definer).toBe(false);
      expect(row.config).toEqual(['search_path=pg_catalog, pg_temp']);
    }
    const priv = await t().pool.query<{ ok: boolean }>(
      `select has_function_privilege('app.publish_jobs_updated(uuid[], uuid[], uuid[], uuid[])',
                                     'execute') as ok`,
    );
    expect(priv.rows[0]?.ok).toBe(true);
    const pub = await t().admin.query<{ ok: boolean }>(
      `select has_function_privilege('public',
                                     'app.publish_jobs_updated(uuid[], uuid[], uuid[], uuid[])',
                                     'execute') as ok`,
    );
    expect(pub.rows[0]?.ok).toBe(false);
  });
});

describe('jobs/updated', () => {
  test('a job write is heard within 1 s with the jobs seq going up', async () => {
    const { pool } = t();
    const sent = Date.now();
    const jobId = await insertTestJob(pool);
    const [first] = await waitForJobs(1);
    expect(Date.now() - sent).toBeLessThan(1000);
    expect(first).toMatchObject({
      topic: 'jobs',
      event: 'updated',
      payload: { jobIds: [jobId], fieldIds: [], machineIds: [], partyIds: [] },
    });
    const seq1 = Number(first?.payload.seq);
    expect(seq1).toBeGreaterThanOrEqual(1);

    await pool.query(`update farm.jobs set notes = 'x', version = version + 1 where id = $1`, [
      jobId,
    ]);
    const msgs = await waitForJobs(2);
    expect(msgs[1]).toMatchObject({ event: 'updated', payload: { jobIds: [jobId] } });
    expect(Number(msgs[1]?.payload.seq)).toBe(seq1 + 1);
    const seq = await pool.query<{ seq: string }>(
      `select seq::text from app.topic_seq where topic = 'jobs'`,
    );
    expect(Number(seq.rows[0]?.seq)).toBe(seq1 + 1);
  });

  test('a job moved to another field names the old and the new field', async () => {
    const { pool, db } = t();
    const a = await insertTestField(db, { lng: -84.3, lat: 41.6 });
    const b = await insertTestField(db, { lng: -84.31, lat: 41.6 });
    const jobId = await insertTestJob(pool, { fieldId: a.fieldId });
    await waitForJobs(1);
    received = [];
    await pool.query('update farm.jobs set field_id = $2 where id = $1', [jobId, b.fieldId]);
    const [msg] = await waitForJobs(1);
    expect(msg?.payload).toMatchObject({
      jobIds: [jobId],
      fieldIds: sorted([a.fieldId, b.fieldId]),
      machineIds: [],
      partyIds: [],
    });
    received = [];
    await pool.query('update farm.jobs set field_id = null where id = $1', [jobId]);
    const [cleared] = await waitForJobs(1);
    expect(cleared?.payload).toMatchObject({ jobIds: [jobId], fieldIds: [b.fieldId] });
  });

  test("assignment rows name their machines and people (old and new) and their job's field", async () => {
    const { pool, db } = t();
    const f = await insertTestField(db, { lng: -84.32, lat: 41.6 });
    const jobId = await insertTestJob(pool, { fieldId: f.fieldId });
    const m1 = await insertTestMachine(pool);
    const m2 = await insertTestMachine(pool);
    const { partyId } = await insertTestPerson(pool, 'Trigger Person');
    await settle();
    received = [];

    const aid = await insertTestAssignment(pool, jobId, { machineId: m1 });
    const [ins] = await waitForJobs(1);
    expect(ins?.payload).toMatchObject({
      jobIds: [jobId],
      fieldIds: [f.fieldId],
      machineIds: [m1],
      partyIds: [],
    });

    received = [];
    await pool.query(
      'update farm.job_assignments set machine_id = $2, party_id = $3 where id = $1',
      [aid, m2, partyId],
    );
    const [upd] = await waitForJobs(1);
    expect(upd?.payload).toMatchObject({
      jobIds: [jobId],
      fieldIds: [f.fieldId],
      machineIds: sorted([m1, m2]),
      partyIds: [partyId],
    });

    received = [];
    await pool.query('delete from farm.job_assignments where id = $1', [aid]);
    const [del] = await waitForJobs(1);
    expect(del?.payload).toMatchObject({ jobIds: [jobId], machineIds: [m2], partyIds: [partyId] });
  });

  test('product rows name their job and its field, no machines or people', async () => {
    const { pool, db } = t();
    const f = await insertTestField(db, { lng: -84.33, lat: 41.6 });
    const jobId = await insertTestJob(pool, { fieldId: f.fieldId });
    const productId = await insertTestProduct(pool);
    await settle();
    received = [];
    await pool.query(
      `insert into farm.job_products (job_id, product_id, rate, unit) values ($1, $2, 1, 'pt_ac')`,
      [jobId, productId],
    );
    const [msg] = await waitForJobs(1);
    expect(msg?.payload).toMatchObject({
      jobIds: [jobId],
      fieldIds: [f.fieldId],
      machineIds: [],
      partyIds: [],
    });
  });

  test('a multi-row statement sends one message with every id once', async () => {
    const { pool } = t();
    const ids = [await insertTestJob(pool), await insertTestJob(pool), await insertTestJob(pool)];
    await settle();
    received = [];
    await pool.query(`update farm.jobs set priority = 2 where id = any($1::uuid[])`, [ids]);
    await waitForJobs(1);
    const heard = await allHeard();
    expect(heard).toHaveLength(1);
    expect(heard[0]?.payload.jobIds).toEqual(sorted(ids));
  });

  test('a rolled-back write sends nothing', async () => {
    const c = await t().pool.connect();
    try {
      await c.query('begin');
      await insertTestJob(c);
      await c.query('rollback');
    } finally {
      c.release();
    }
    expect(await allHeard()).toEqual([]);
  });

  test('a statement that changes no row sends nothing', async () => {
    const { pool } = t();
    await pool.query(`update farm.jobs set priority = 1 where false`);
    await pool.query(`delete from farm.job_assignments where false`);
    await pool.query(`delete from farm.job_products where false`);
    await pool.query(
      `insert into farm.jobs (kind, business_line) select 'spray', 'spraying' where false`,
    );
    expect(await allHeard()).toEqual([]);
  });

  test('a write inside a transaction is delivered on commit, not before', async () => {
    const c = await t().pool.connect();
    try {
      await c.query('begin');
      const id = await insertTestJob(c);
      await settle(200);
      expect(received).toEqual([]);
      await c.query('commit');
      const [msg] = await waitForJobs(1);
      expect(msg?.payload.jobIds).toEqual([id]);
    } finally {
      c.release();
    }
  });
});

describe('never one message per row', () => {
  test('500 jobs in one INSERT are ONE jobs/invalidate (too large), nothing else', async () => {
    const { pool } = t();
    await pool.query(
      `insert into farm.jobs (kind, business_line, source, source_id)
       select 'haul', 'trucking', 'test', 'bulk:' || g from generate_series(1, 500) g`,
    );
    await waitForJobs(1);
    const heard = await allHeard();
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({
      topic: 'jobs',
      event: 'invalidate',
      payload: { event: 'updated', reason: 'too_large' },
    });
    await pool.query(`delete from farm.jobs where source = 'test' and source_id like 'bulk:%'`);
  });

  test('100 jobs in one INSERT still fit: one jobs/updated with all 100 ids', async () => {
    const { pool } = t();
    await pool.query(
      `insert into farm.jobs (kind, business_line, source, source_id)
       select 'haul', 'trucking', 'test', 'hundred:' || g from generate_series(1, 100) g`,
    );
    await waitForJobs(1);
    const heard = await allHeard();
    expect(heard).toHaveLength(1);
    expect(heard[0]?.event).toBe('updated');
    expect(heard[0]?.payload.jobIds).toHaveLength(100);
  });

  test('an upsert sends at most two: its insert rows and its update rows, one message each', async () => {
    const { pool } = t();
    const existing = await insertTestJob(pool, { source: 'upsert' });
    const src = await pool.query<{ source_id: string }>(
      'select source_id from farm.jobs where id = $1',
      [existing],
    );
    await settle();
    received = [];
    const r = await pool.query<{ id: string; inserted: boolean }>(
      `insert into farm.jobs (kind, business_line, source, source_id)
       values ('spray', 'spraying', 'upsert', $1), ('spray', 'spraying', 'upsert', 'new-1'),
              ('spray', 'spraying', 'upsert', 'new-2')
       on conflict (source, source_id) do update set priority = 1
       returning id::text, (xmax = 0) as inserted`,
      [src.rows[0]?.source_id],
    );
    await waitForJobs(2);
    const heard = await allHeard();
    expect(heard).toHaveLength(2);
    const inserted = r.rows.filter((x) => x.inserted).map((x) => x.id);
    expect(
      heard.map((m) => m.payload.jobIds).sort((a, b) => String(a).localeCompare(String(b))),
    ).toEqual([sorted(inserted), [existing]].sort((a, b) => String(a).localeCompare(String(b))));
  });

  test('a job delete sends at most three (jobs, assignments, products), never one per row', async () => {
    const { pool, db } = t();
    const f = await insertTestField(db, { lng: -84.34, lat: 41.6 });
    const jobs = [
      await insertTestJob(pool, { fieldId: f.fieldId }),
      await insertTestJob(pool, { fieldId: f.fieldId }),
    ];
    for (const j of jobs) {
      await insertTestAssignment(pool, j, { machineId: await insertTestMachine(pool) });
      await insertTestAssignment(pool, j, { machineId: await insertTestMachine(pool) });
      for (let i = 0; i < 3; i++) {
        await pool.query(`insert into farm.job_products (job_id, product_id) values ($1, $2)`, [
          j,
          await insertTestProduct(pool),
        ]);
      }
    }
    await settle();
    received = [];
    await pool.query('delete from farm.jobs where id = any($1::uuid[])', [jobs]);
    await waitForJobs(3);
    const heard = await allHeard();
    expect(heard).toHaveLength(3);
    for (const m of heard) {
      expect(m.event).toBe('updated');
      expect(m.payload.jobIds).toEqual(sorted(jobs));
    }
    // The jobs message names the field the cards left; the children's can't (their jobs are gone).
    expect(heard.some((m) => (m.payload.fieldIds as string[]).includes(f.fieldId))).toBe(true);
    expect(heard.filter((m) => (m.payload.machineIds as string[]).length === 4)).toHaveLength(1);
  });
});

describe('the 7,000-byte limit (JOBS_TRIGGER_MAX_PAYLOAD_BYTES)', () => {
  test('the largest payload under the limit is sent; the next id over it is an invalidate', async () => {
    const { pool } = t();
    expect(JOBS_TRIGGER_MAX_PAYLOAD_BYTES).toBe(7_000);
    const size = async (jobIds: string[]) => {
      const r = await pool.query<{ n: number }>(
        `select octet_length(app.publish_jobs_payload($1::uuid[], '{}', '{}', '{}')::text)::int as n`,
        [jobIds],
      );
      return r.rows[0]?.n ?? 0;
    };
    const ids = (
      await pool.query<{ id: string }>(
        `select gen_random_uuid()::text as id from generate_series(1, 300)`,
      )
    ).rows.map((x) => x.id);
    // Each id adds 40 bytes of jsonb text ('"<uuid>", '), so the line falls between two lists.
    let n = 1;
    while ((await size(ids.slice(0, n + 1))) <= JOBS_TRIGGER_MAX_PAYLOAD_BYTES) n++;
    const fits = ids.slice(0, n);
    const over = ids.slice(0, n + 1);
    const [fitSize, overSize] = [await size(fits), await size(over)];
    expect(fitSize).toBeLessThanOrEqual(JOBS_TRIGGER_MAX_PAYLOAD_BYTES);
    expect(fitSize).toBeGreaterThan(JOBS_TRIGGER_MAX_PAYLOAD_BYTES - 41);
    expect(overSize).toBeGreaterThan(JOBS_TRIGGER_MAX_PAYLOAD_BYTES);

    await pool.query(`select app.publish_jobs_updated($1::uuid[], '{}', '{}', '{}')`, [fits]);
    await pool.query(`select app.publish_jobs_updated($1::uuid[], '{}', '{}', '{}')`, [over]);
    await waitForJobs(2);
    const heard = await allHeard();
    expect(heard.map((m) => m.event)).toEqual(['updated', 'invalidate']);
    expect(heard[0]?.payload.jobIds).toHaveLength(n);
    expect(heard[1]?.payload).toMatchObject({ event: 'updated', reason: 'too_large' });
  });

  test('the payload builder sorts, deduplicates and drops nulls', async () => {
    const { pool } = t();
    const a = '00000000-0000-4000-8000-00000000000a';
    const b = '00000000-0000-4000-8000-00000000000b';
    const r = await pool.query<{ p: unknown }>(
      `select app.publish_jobs_payload(array[$2, $1, $2, null]::uuid[], array[null]::uuid[],
                                       null, array[$1]::uuid[]) as p`,
      [a, b],
    );
    expect(r.rows[0]?.p).toEqual({ jobIds: [a, b], fieldIds: [], machineIds: [], partyIds: [a] });
  });
});

describe("data:import's GUC", () => {
  test('app.jobs_publish = off silences every trigger for that transaction only', async () => {
    const { pool } = t();
    const c = await pool.connect();
    let quiet: string;
    try {
      await c.query('begin');
      await c.query(`select set_config('app.jobs_publish', 'off', true)`);
      quiet = await insertTestJob(c);
      await insertTestAssignment(c, quiet, { machineId: await insertTestMachine(c) });
      await c.query(`insert into farm.job_products (job_id, product_id) values ($1, $2)`, [
        quiet,
        await insertTestProduct(c),
      ]);
      await c.query('update farm.jobs set priority = 1 where id = $1', [quiet]);
      await c.query('delete from farm.jobs where id = $1', [quiet]);
      await c.query('commit');
    } finally {
      c.release();
    }
    expect(await allHeard()).toEqual([]);
    // The next transaction (same pooled connections) publishes again.
    const loud = await insertTestJob(pool);
    const [msg] = await waitForJobs(1);
    expect(msg?.payload.jobIds).toEqual([loud]);
  });
});
