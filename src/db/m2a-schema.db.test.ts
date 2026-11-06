/**
 * The 2a migration (db/migrations/0008_m2a_job_board.sql) as the app sees it, running as
 * farm_app: the new tables round-trip through Drizzle, and the constraints and on-delete rules
 * the four 2a builders rely on hold (docs/contracts-2a.md §3).
 */
import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import {
  BUSINESS_LINES,
  JOB_KINDS,
  JOB_STATUSES,
  PERMITTED_USES,
  USAGE_KINDS,
} from '../domain/work-jobs';
import { setupTestDb } from '../test/db';
import { insertField } from '../test/fixtures';
import {
  appUsers,
  dataRightsAgreements,
  devices,
  jobAssignments,
  jobProducts,
  jobRequestLinks,
  jobs,
  machines,
  parties,
  products,
  usageEvents,
} from './schema';

const t = setupTestDb(import.meta.url);

/** The Postgres error code of a rejected statement (23505 unique, 23514 check, 23503 FK). */
async function pgCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } };
    return err.code ?? err.cause?.code;
  }
}

async function party(name: string, kind: 'person' | 'org' = 'person'): Promise<string> {
  const [p] = await t()
    .db.insert(parties)
    .values({ kind, displayName: name, roles: kind === 'person' ? ['crew'] : ['customer'] })
    .returning({ id: parties.id });
  if (!p) throw new Error('insert failed');
  return p.id;
}

async function machine(unitNo: string): Promise<string> {
  const [m] = await t()
    .db.insert(machines)
    .values({ kind: 'sprayer', unitNo })
    .returning({ id: machines.id });
  if (!m) throw new Error('insert failed');
  return m.id;
}

async function job(values: Partial<typeof jobs.$inferInsert> = {}): Promise<string> {
  const [j] = await t()
    .db.insert(jobs)
    .values({ kind: 'spray', businessLine: 'spraying', ...values })
    .returning({ id: jobs.id });
  if (!j) throw new Error('insert failed');
  return j.id;
}

async function product(name = 'Glyphosate (test)'): Promise<string> {
  const [p] = await t()
    .db.insert(products)
    .values({ kind: 'chemical', name, unit: 'gal' })
    .returning({ id: products.id });
  if (!p) throw new Error('insert failed');
  return p.id;
}

describe('farm.jobs', () => {
  test('a job round-trips with its window, defaults and version', async () => {
    const { fieldId } = await insertField(t().db);
    const customer = await party('Test Customer', 'org');
    const from = new Date('2026-11-06T12:00:00Z');
    const to = new Date('2026-11-06T22:00:00Z');
    const id = await job({
      fieldId,
      customerPartyId: customer,
      plannedWindow: { from, to },
      plannedAcres: 78.5,
      cropYear: 2026,
      requestChannel: 'phone',
      requesterName: 'Gail',
    });
    const [row] = await t().db.select().from(jobs).where(eq(jobs.id, id));
    expect(row).toMatchObject({
      status: 'planned',
      version: 1,
      priority: 3,
      sortKey: 0,
      plannedAcresByHand: false,
      plannedAcres: 78.5,
      source: 'app',
      plannedWindow: { from, to },
    });
  });

  test('CHECKs take exactly the TS lists, and the limits', async () => {
    for (const kind of JOB_KINDS) await job({ kind });
    for (const businessLine of BUSINESS_LINES) await job({ businessLine });
    for (const status of JOB_STATUSES) await job({ status });
    const bad = [
      `insert into farm.jobs (kind, business_line) values ('mow', 'grain')`,
      `insert into farm.jobs (kind, business_line) values ('spray', 'retail')`,
      `insert into farm.jobs (kind, business_line, status) values ('spray', 'grain', 'started')`,
      `insert into farm.jobs (kind, business_line, priority) values ('spray', 'grain', 0)`,
      `insert into farm.jobs (kind, business_line, version) values ('spray', 'grain', 0)`,
      `insert into farm.jobs (kind, business_line, planned_unit) values ('spray', 'grain', 'acres')`,
      `insert into farm.jobs (kind, business_line, request_channel) values ('spray', 'grain', 'sms')`,
      `insert into farm.jobs (kind, business_line, planned_acres) values ('spray', 'grain', -1)`,
      `insert into farm.jobs (kind, business_line, crop_year) values ('spray', 'grain', 1900)`,
      `insert into farm.jobs (kind, business_line, title) values ('spray', 'grain', repeat('x', 81))`,
      `insert into farm.jobs (kind, business_line, planned_window)
         values ('spray', 'grain', tstzrange(now(), now(), '[)'))`,
    ];
    for (const s of bad) expect(await pgCode(t().pool.query(s)), s).toBe('23514');
  });

  test('a deleted field leaves the job without one; a customer with jobs cannot be deleted', async () => {
    const { fieldId } = await insertField(t().db);
    const customer = await party('Kept Customer', 'org');
    const id = await job({ fieldId, customerPartyId: customer, requestedByPartyId: customer });
    await t().admin.query('delete from farm.field_boundaries where field_id = $1', [fieldId]);
    await t().admin.query('delete from farm.fields where id = $1', [fieldId]);
    const [row] = await t().db.select().from(jobs).where(eq(jobs.id, id));
    expect(row?.fieldId).toBeNull();
    expect(await pgCode(t().pool.query('delete from farm.parties where id = $1', [customer]))).toBe(
      '23503',
    );
  });
});

describe('farm.job_assignments', () => {
  test('a row needs a person or a machine; each appears once per job; the job cascades', async () => {
    const id = await job();
    const dale = await party('Dale (test)');
    const sp2 = await machine('SP2-test');
    await t()
      .db.insert(jobAssignments)
      .values({ jobId: id, machineId: sp2, partyId: dale, role: 'operator' });
    expect(
      await pgCode(t().pool.query('insert into farm.job_assignments (job_id) values ($1)', [id])),
    ).toBe('23514');
    expect(
      await pgCode(
        t().pool.query('insert into farm.job_assignments (job_id, party_id) values ($1, $2)', [
          id,
          dale,
        ]),
      ),
    ).toBe('23505');
    expect(
      await pgCode(
        t().pool.query('insert into farm.job_assignments (job_id, machine_id) values ($1, $2)', [
          id,
          sp2,
        ]),
      ),
    ).toBe('23505');
    // The same person and machine on another job: allowed (flagged, never blocked: 2a-4).
    await t()
      .db.insert(jobAssignments)
      .values({ jobId: await job(), machineId: sp2, partyId: dale });
    // A machine or person on a job can't be deleted; deleting the job removes its rows.
    expect(await pgCode(t().admin.query('delete from farm.machines where id = $1', [sp2]))).toBe(
      '23503',
    );
    await t().pool.query('delete from farm.jobs where id = $1', [id]);
    const left = await t().db.select().from(jobAssignments).where(eq(jobAssignments.jobId, id));
    expect(left).toEqual([]);
  });

  test('job_id has a plain index (the snapshot and the cascade cannot use the partial ones)', async () => {
    const r = await t().pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where schemaname = 'farm' and indexname = 'job_assignments_job_id_idx'`,
    );
    expect(r.rows[0]?.indexdef).toMatch(/btree \(job_id\)$/);
  });
});

describe('farm.products and farm.job_products', () => {
  test('a product on a job is restricted; units and supplied_by are checked', async () => {
    const id = await job();
    const p = await product();
    await t().db.insert(jobProducts).values({ jobId: id, productId: p, rate: 32, unit: 'floz_ac' });
    const [row] = await t().db.select().from(products).where(eq(products.id, p));
    expect(row).toMatchObject({ active: true, restrictedUse: false, labelRules: {} });
    expect(await pgCode(t().pool.query('delete from farm.products where id = $1', [p]))).toBe(
      '23503',
    );
    expect(
      await pgCode(
        t().pool.query(`insert into farm.job_products (job_id, product_id) values ($1, $2)`, [
          id,
          p,
        ]),
      ),
    ).toBe('23505');
    for (const s of [
      `insert into farm.products (kind, name, unit) values ('seed', '  ', 'bag')`,
      `insert into farm.products (kind, name, unit) values ('herbicide', 'x', 'gal')`,
      `insert into farm.products (kind, name, unit) values ('fuel', 'x', 'liter')`,
      `insert into farm.products (kind, name, unit, label_rules) values ('fuel', 'x', 'gal', '[]')`,
    ]) {
      expect(await pgCode(t().pool.query(s)), s).toBe('23514');
    }
    expect(
      await pgCode(
        t().pool.query(
          `insert into farm.job_products (job_id, product_id, unit) values ($1, $2, 'l_ac')`,
          [await job(), p],
        ),
      ),
    ).toBe('23514');
  });
});

describe('farm.data_rights_agreements', () => {
  test('permitted uses are a subset of the list; revoked on or after signed', async () => {
    const org = await party('Signed Customer', 'org');
    await t()
      .db.insert(dataRightsAgreements)
      .values({ partyId: org, signedOn: '2026-10-01', permittedUses: [...PERMITTED_USES] });
    for (const s of [
      `insert into farm.data_rights_agreements (party_id, signed_on, permitted_uses)
         values ('${org}', '2026-10-01', '{resale}')`,
      `insert into farm.data_rights_agreements (party_id, signed_on, revoked_on)
         values ('${org}', '2026-10-01', '2026-09-30')`,
    ]) {
      expect(await pgCode(t().pool.query(s)), s).toBe('23514');
    }
    expect(await pgCode(t().pool.query('delete from farm.parties where id = $1', [org]))).toBe(
      '23503',
    );
  });
});

describe('farm.job_request_links', () => {
  test('one row per token hash; a link that made jobs can be deleted, the jobs stay', async () => {
    const org = await party('Linked Customer', 'org');
    const [link] = await t()
      .db.insert(jobRequestLinks)
      .values({ partyId: org, tokenHash: 'h1' })
      .returning({ id: jobRequestLinks.id });
    expect(
      await pgCode(
        t().pool.query(
          `insert into farm.job_request_links (party_id, token_hash) values ($1, 'h1')`,
          [org],
        ),
      ),
    ).toBe('23505');
    const id = await job({
      status: 'requested',
      requestChannel: 'web_form',
      requestLinkId: link?.id,
    });
    await t().pool.query('delete from farm.job_request_links where id = $1', [link?.id]);
    const [row] = await t().db.select().from(jobs).where(eq(jobs.id, id));
    expect(row?.requestLinkId).toBeNull();
  });
});

describe('app.usage_events', () => {
  test('one row per actor, kind, route and bucket; deleting the person or device never collides', async () => {
    const personParty = await party('Usage Person');
    const [user] = await t()
      .db.insert(appUsers)
      .values({ partyId: personParty, role: 'operator' })
      .returning({ id: appUsers.id });
    const [device] = await t()
      .db.insert(devices)
      .values({ kind: 'wall', name: 'Usage wall' })
      .returning({ id: devices.id });
    if (!user || !device) throw new Error('fixture');
    const bucketAt = new Date('2026-11-06T14:05:00Z');
    const at = new Date('2026-11-06T14:07:12Z');
    const insert = (kind: string, appUserId: string | null) =>
      t().pool.query(
        `insert into app.usage_events (at, farm_day, kind, route, app_user_id, device_id, actor_key, bucket_at)
         values ($1, '2026-11-06', $2, '/board', $3, $4, $5, $6)
         on conflict (actor_key, kind, route, bucket_at) do nothing`,
        [at, kind, appUserId, device.id, `${device.id}:${appUserId ?? '-'}`, bucketAt],
      );
    for (const kind of USAGE_KINDS) expect((await insert(kind, user.id)).rowCount).toBe(1);
    expect((await insert('board_heartbeat', user.id)).rowCount).toBe(0);
    expect((await insert('board_heartbeat', null)).rowCount).toBe(1);
    expect(await pgCode(insert('lunch', null))).toBe('23514');
    // Both actors gone: the rows stay, unlinked, without tripping the bucket key.
    await t().pool.query('delete from farm.app_users where id = $1', [user.id]);
    await t().pool.query('delete from farm.devices where id = $1', [device.id]);
    const rows = await t().db.select().from(usageEvents);
    expect(rows.length).toBe(USAGE_KINDS.length + 1);
    expect(rows.every((r) => r.appUserId === null && r.deviceId === null)).toBe(true);
    expect(
      await pgCode(
        t().pool.query(
          `insert into app.usage_events (farm_day, kind, actor_key, bucket_at)
           values ('2026-11-06', 'page_view', 'someone', now())`,
        ),
      ),
    ).toBe('23514');
  });
});
