/**
 * The emitted cron.sql is valid SQL that schedules, updates and unschedules jobs, and its
 * commands build the right request. pg_cron/pg_net/Vault exist only in the `postgres` database
 * (never touched by tests), so this runs against stand-ins with the same signatures:
 * cron.schedule(name, schedule, command) upserting cron.job by name, cron.unschedule(jobid),
 * net.http_post(url, headers, body, timeout_milliseconds) and vault.decrypted_secrets.
 */
import { beforeAll, describe, expect, test } from 'vitest';
import { validateRegistry } from '../src/jobs/schedule';
import type { JobRegistry } from '../src/jobs/types';
import { setupTestDb } from '../src/test/db';
import { emitCronSql } from './jobs-emit-cron';

const t = setupTestDb(import.meta.url);
const run = async () => ({ items: 0 });

beforeAll(async () => {
  await t().admin.query(`
    create schema cron;
    create table cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text);
    create function cron.schedule(job_name text, schedule text, command text) returns bigint
    language sql as $$
      insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
      on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
      returning jobid
    $$;
    create function cron.unschedule(job_id bigint) returns boolean
    language sql as $$ delete from cron.job where jobid = job_id returning true $$;

    create schema net;
    create table net.requests (url text, headers jsonb, body jsonb, timeout_milliseconds int);
    create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}',
                                  headers jsonb default '{}', timeout_milliseconds int default 2000)
    returns bigint language sql as $$
      insert into net.requests values (url, headers, body, timeout_milliseconds) returning 1::bigint
    $$;

    create schema vault;
    create table vault.secrets_store (name text primary key, secret text);
    create view vault.decrypted_secrets as select name, secret as decrypted_secret from vault.secrets_store;
    insert into vault.secrets_store values
      ('farm_jobs_base_url', 'http://host.docker.internal:3000'),
      ('farm_jobs_secret', 'test-secret-value');
    -- someone else's job that must survive
    insert into cron.job (jobname, schedule, command) values ('vacuum', '0 3 * * *', 'vacuum');
  `);
});

async function jobs() {
  const r = await t().admin.query(
    'select jobname, schedule, command from cron.job order by jobname',
  );
  return r.rows as { jobname: string; schedule: string; command: string }[];
}

describe('cron.sql', () => {
  test('schedules each app job; re-applying updates; removed jobs are unscheduled', async () => {
    const v1: JobRegistry = {
      'fleet.trucks': { every: '30 seconds', run },
      'weather.nws': { cron: '*/30 * * * *', run },
      'gis.derived': { cron: '40 8 * * *', host: 'pc', run },
    };
    await t().admin.query(emitCronSql(validateRegistry(v1)));
    await t().admin.query(emitCronSql(validateRegistry(v1))); // idempotent
    expect((await jobs()).map((j) => [j.jobname, j.schedule])).toEqual([
      ['fleet.trucks', '30 seconds'],
      ['vacuum', '0 3 * * *'],
      ['weather.nws', '*/30 * * * *'],
    ]);

    const v2: JobRegistry = { 'fleet.trucks': { every: '5 seconds', run } };
    await t().admin.query(emitCronSql(validateRegistry(v2)));
    expect((await jobs()).map((j) => [j.jobname, j.schedule])).toEqual([
      ['fleet.trucks', '5 seconds'],
      ['vacuum', '0 3 * * *'],
    ]);
  });

  test("a job's command posts to <base>/api/jobs/<name> with the bearer secret and a 5 s timeout", async () => {
    const [trucks] = (await jobs()).filter((j) => j.jobname === 'fleet.trucks');
    await t().admin.query(trucks?.command ?? 'select 1/0');
    const r = await t().admin.query(
      'select url, headers, body, timeout_milliseconds from net.requests',
    );
    expect(r.rows).toEqual([
      {
        url: 'http://host.docker.internal:3000/api/jobs/fleet.trucks',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-secret-value' },
        body: {},
        timeout_milliseconds: 5000,
      },
    ]);
  });
});
