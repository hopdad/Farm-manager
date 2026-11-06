/**
 * Customer request links against a real database (decision 2a-9; docs/contracts-2a.md §5.5): the
 * token (128 bits, shown once, stored only as an HMAC), make / list / revoke, what the public page
 * may see, and the POST: a `requested` web_form job with the link's party, at most 20 a link a
 * farm day (the 21st refused, a new farm day starts over, parallel posts can't pass the cap
 * together), last_used_at, a revoked or unknown token refused alike, the field rules for one of
 * the customer's fields.
 */
import { describe, expect, test } from 'vitest';
import { REQUEST_LINK_MAX_PER_DAY } from '../../domain/work-jobs';
import { setupTestDb } from '../../test/db';
import { ADRIAN_QUARTER_SECTION, insertField } from '../../test/fixtures';
import {
  createRequestLink,
  type LinkRequestInput,
  linkRequestSchema,
  listRequestLinks,
  looksLikeRequestToken,
  newRequestToken,
  REQUEST_TOKEN_LENGTH,
  requestDatesProblem,
  requestLinkHash,
  requestNotes,
  resolveRequestLink,
  revokeRequestLink,
  submitLinkRequest,
} from './request-links';

const t = setupTestDb(import.meta.url);
const SECRET = 'test-secret-for-request-links-0123456789';
// Fri Nov 6 2026, 10:00 in Detroit (EST).
const NOW = new Date('2026-11-06T15:00:00Z');

async function party(
  name: string,
  opts: { kind?: 'org' | 'person'; roles?: string[]; orgId?: string | null } = {},
): Promise<string> {
  const r = await t().pool.query<{ id: string }>(
    `insert into farm.parties (kind, display_name, roles, org_id) values ($1, $2, $3, $4) returning id`,
    [opts.kind ?? 'org', name, opts.roles ?? ['customer'], opts.orgId ?? null],
  );
  return r.rows[0]?.id as string;
}

async function link(partyId: string, label: string | null = null) {
  const r = await createRequestLink(t().pool, SECRET, { partyId, label, createdBy: null });
  if (r.status !== 'created') throw new Error(r.status);
  return r;
}

const ask = (over: Partial<LinkRequestInput> = {}): LinkRequestInput => ({
  kind: 'spray',
  fieldId: null,
  where: 'the 80 north of the elevator',
  from: null,
  by: null,
  notes: '',
  name: 'Gail Pressler',
  phone: '(517) 555-0100',
  ...over,
});

const job = async (id: string) =>
  (
    await t().pool.query(
      `select kind, business_line, status, customer_party_id, field_id, crop_year,
              planned_acres::float8 as planned_acres, planned_acres_by_hand, priority, sort_key,
              notes, request_channel, requested_by_party_id, requester_name, requester_phone,
              request_link_id, source, lower(planned_window) as wfrom, upper(planned_window) as wto,
              created_at
         from farm.jobs where id = $1`,
      [id],
    )
  ).rows[0];

describe('tokens', () => {
  test('128 random bits, base64url, 22 characters; only an HMAC is stored', async () => {
    const a = newRequestToken();
    expect(a).toHaveLength(REQUEST_TOKEN_LENGTH);
    expect(REQUEST_TOKEN_LENGTH).toBe(22);
    expect(looksLikeRequestToken(a)).toBe(true);
    expect(newRequestToken()).not.toBe(a);
    for (const bad of [null, '', 'short', `${a}x`, `${a.slice(0, 21)}!`]) {
      expect(looksLikeRequestToken(bad), String(bad)).toBe(false);
    }
    expect(requestLinkHash(SECRET, a)).toMatch(/^[0-9a-f]{64}$/);
    expect(requestLinkHash(SECRET, a)).toBe(requestLinkHash(SECRET, a));
    expect(requestLinkHash(`${SECRET}2`, a)).not.toBe(requestLinkHash(SECRET, a));

    const p = await party('Token Farms');
    const made = await link(p);
    const row = await t().pool.query('select * from farm.job_request_links where id = $1', [
      made.id,
    ]);
    expect(row.rows[0].token_hash).toBe(requestLinkHash(SECRET, made.token));
    expect(JSON.stringify(row.rows[0])).not.toContain(made.token);
  });
});

describe('links', () => {
  test('only customers get links; labels are tidied', async () => {
    expect(
      await createRequestLink(t().pool, SECRET, {
        partyId: crypto.randomUUID(),
        label: null,
        createdBy: null,
      }),
    ).toEqual({ status: 'not_found' });
    const landlord = await party('Ivan Abernath', { kind: 'person', roles: ['landlord'] });
    expect(
      await createRequestLink(t().pool, SECRET, {
        partyId: landlord,
        label: null,
        createdBy: null,
      }),
    ).toEqual({ status: 'not_customer' });
    const p = await party('Label Farms');
    await link(p, "  for   Gail's  phone ");
    const [row] = await listRequestLinks(t().pool, p, NOW);
    expect(row).toMatchObject({
      partyId: p,
      label: "for Gail's phone",
      revokedAt: null,
      lastUsedAt: null,
      requestsToday: 0,
      requestsTotal: 0,
      createdByName: null,
    });
  });

  test('revoke: once, for its own party only; the page refuses it after', async () => {
    const p = await party('Revoke Farms');
    const other = await party('Other Farms');
    const made = await link(p);
    expect(await resolveRequestLink(t().pool, SECRET, made.token)).toMatchObject({
      id: made.id,
      partyId: p,
      partyName: 'Revoke Farms',
    });
    expect(await revokeRequestLink(t().pool, { id: made.id, partyId: other }, NOW)).toBe(
      'not_found',
    );
    expect(await revokeRequestLink(t().pool, { id: made.id, partyId: p }, NOW)).toBe('revoked');
    expect(await revokeRequestLink(t().pool, { id: made.id, partyId: p }, NOW)).toBe(
      'already_revoked',
    );
    expect(await resolveRequestLink(t().pool, SECRET, made.token)).toBeNull();
    expect((await listRequestLinks(t().pool, p, NOW))[0]?.revokedAt).toBe(NOW.toISOString());
    expect(await submitLinkRequest(t().pool, SECRET, made.token, ask(), NOW)).toEqual({
      status: 'refused',
    });
  });

  test('unknown and malformed tokens are refused like a revoked one', async () => {
    expect(await resolveRequestLink(t().pool, SECRET, newRequestToken())).toBeNull();
    expect(await resolveRequestLink(t().pool, SECRET, '../../etc')).toBeNull();
    expect(await submitLinkRequest(t().pool, SECRET, newRequestToken(), ask(), NOW)).toEqual({
      status: 'refused',
    });
    expect(await submitLinkRequest(t().pool, SECRET, 42, ask(), NOW)).toEqual({
      status: 'refused',
    });
    // The right token under another secret is no link at all.
    const made = await link(await party('Secret Farms'));
    expect(await resolveRequestLink(t().pool, `${SECRET}x`, made.token)).toBeNull();
  });

  test("the page shows the customer's own fields (an org's, and a person's org's)", async () => {
    const org = await party('Juniper Hill Farms LLC');
    const gail = await party('Gail Pressler', { kind: 'person', orgId: org });
    const theirs = await insertField(t().db, {
      name: 'Juniper North',
      geom: ADRIAN_QUARTER_SECTION,
    });
    await t().pool.query('update farm.farms set client_party_id = $2 where id = $1', [
      theirs.farmId,
      org,
    ]);
    await insertField(t().db, { name: 'Ours', geom: ADRIAN_QUARTER_SECTION });
    const viaPerson = await link(gail);
    const r = await resolveRequestLink(t().pool, SECRET, viaPerson.token);
    expect(r?.fields.map((f) => f.name)).toEqual(['Juniper North']);
    expect(r?.fields[0]?.acres).toBeCloseTo(160, 0);
  });
});

describe('a request through a link', () => {
  test('becomes a requested web_form job; last_used_at moves; the list counts it', async () => {
    const org = await party('Halvorsen Bros. Farms');
    const made = await link(org);
    const r = await submitLinkRequest(
      t().pool,
      SECRET,
      made.token,
      ask({ kind: 'haul', from: '2026-11-09', by: '2026-11-10', notes: 'Bring two trucks.' }),
      NOW,
    );
    if (r.status !== 'created') throw new Error(r.status);
    const j = await job(r.jobId);
    expect(j).toMatchObject({
      kind: 'haul',
      business_line: 'trucking',
      status: 'requested',
      customer_party_id: org,
      field_id: null,
      crop_year: null,
      planned_acres: null,
      priority: 3,
      sort_key: 10,
      notes: 'Where: the 80 north of the elevator\n\nBring two trucks.',
      request_channel: 'web_form',
      requested_by_party_id: org,
      requester_name: 'Gail Pressler',
      requester_phone: '(517) 555-0100',
      request_link_id: made.id,
      source: 'app',
    });
    // Whole farm days: Nov 9 00:00 to Nov 11 00:00, Detroit (EST).
    expect((j.wfrom as Date).toISOString()).toBe('2026-11-09T05:00:00.000Z');
    expect((j.wto as Date).toISOString()).toBe('2026-11-11T05:00:00.000Z');
    expect((j.created_at as Date).toISOString()).toBe(NOW.toISOString());
    const [row] = await listRequestLinks(t().pool, org, NOW);
    expect(row).toMatchObject({
      lastUsedAt: NOW.toISOString(),
      requestsToday: 1,
      requestsTotal: 1,
    });
    // The next one goes to the end of the lane's priority.
    const r2 = await submitLinkRequest(t().pool, SECRET, made.token, ask({ kind: 'haul' }), NOW);
    if (r2.status !== 'created') throw new Error(r2.status);
    expect((await job(r2.jobId)).sort_key).toBe(20);
  });

  test("a person's link: the customer is their organization, the requester the person", async () => {
    const org = await party('Juniper Hill Farms LLC 2');
    const gail = await party('Gail Pressler 2', { kind: 'person', orgId: org });
    const made = await link(gail);
    const r = await submitLinkRequest(t().pool, SECRET, made.token, ask(), NOW);
    if (r.status !== 'created') throw new Error(r.status);
    expect(await job(r.jobId)).toMatchObject({
      customer_party_id: org,
      requested_by_party_id: gail,
    });
  });

  test("one of the customer's fields brings the field rules; someone else's is refused", async () => {
    const org = await party('Field Rules Farms');
    const theirs = await insertField(t().db, { name: 'Theirs 160', geom: ADRIAN_QUARTER_SECTION });
    await t().pool.query('update farm.farms set client_party_id = $2 where id = $1', [
      theirs.farmId,
      org,
    ]);
    const ours = await insertField(t().db, { name: 'Ours 160', geom: ADRIAN_QUARTER_SECTION });
    const made = await link(org);
    const r = await submitLinkRequest(
      t().pool,
      SECRET,
      made.token,
      ask({ fieldId: theirs.fieldId, where: '' }),
      NOW,
    );
    if (r.status !== 'created') throw new Error(r.status);
    const j = await job(r.jobId);
    expect(j).toMatchObject({
      field_id: theirs.fieldId,
      crop_year: 2026,
      planned_acres_by_hand: false,
    });
    expect(j.planned_acres).toBeCloseTo(160, 0);
    expect(j.notes).toBeNull();
    expect(
      await submitLinkRequest(t().pool, SECRET, made.token, ask({ fieldId: ours.fieldId }), NOW),
    ).toEqual({ status: 'bad_field' });
  });

  test('at most 20 a farm day: the 21st is refused, the next farm day starts over', async () => {
    const org = await party('Busy Farms');
    const made = await link(org);
    // 19 earlier today (from 00:05 Detroit), and one late last night that doesn't count.
    await t().pool.query(
      `insert into farm.jobs (kind, business_line, status, request_link_id, request_channel, created_at)
       select 'spray', 'spraying', 'requested', $1, 'web_form', $2::timestamptz + make_interval(mins => g)
         from generate_series(1, 19) g`,
      [made.id, '2026-11-06T05:04:00Z'],
    );
    await t().pool.query(
      `insert into farm.jobs (kind, business_line, status, request_link_id, request_channel, created_at)
       values ('spray', 'spraying', 'requested', $1, 'web_form', '2026-11-06T04:59:00Z')`,
      [made.id],
    );
    expect((await listRequestLinks(t().pool, org, NOW))[0]?.requestsToday).toBe(19);
    expect((await submitLinkRequest(t().pool, SECRET, made.token, ask(), NOW)).status).toBe(
      'created',
    );
    expect(await submitLinkRequest(t().pool, SECRET, made.token, ask(), NOW)).toEqual({
      status: 'limit',
    });
    const used = await t().pool.query(
      'select last_used_at from farm.job_request_links where id = $1',
      [made.id],
    );
    expect((used.rows[0].last_used_at as Date).toISOString()).toBe(NOW.toISOString());
    // 00:01 on Saturday in Detroit (05:01 UTC): a new farm day.
    const tomorrow = new Date('2026-11-07T05:01:00Z');
    expect((await submitLinkRequest(t().pool, SECRET, made.token, ask(), tomorrow)).status).toBe(
      'created',
    );
    expect(REQUEST_LINK_MAX_PER_DAY).toBe(20);
  });

  test('parallel posts never pass the cap together', async () => {
    const made = await link(await party('Parallel Farms'));
    const results = await Promise.all(
      Array.from({ length: 25 }, () => submitLinkRequest(t().pool, SECRET, made.token, ask(), NOW)),
    );
    const count = (s: string) => results.filter((r) => r.status === s).length;
    expect(count('created')).toBe(20);
    expect(count('limit')).toBe(5);
  });
});

describe('the public form', () => {
  const base = {
    kind: 'spray',
    fieldId: '',
    where: 'north 80',
    from: '',
    by: '',
    notes: '',
    name: 'Gail',
    phone: '517 555 0100',
  };

  test('blank inputs are absent; a field or a place is needed; dates in order', () => {
    expect(linkRequestSchema.parse(base)).toMatchObject({ fieldId: null, from: null, by: null });
    expect(linkRequestSchema.safeParse({ ...base, where: ' ' }).success).toBe(false);
    expect(
      linkRequestSchema.safeParse({ ...base, from: '2026-11-10', by: '2026-11-09' }).success,
    ).toBe(false);
    expect(linkRequestSchema.safeParse({ ...base, phone: 'call me' }).success).toBe(false);
    expect(linkRequestSchema.safeParse({ ...base, kind: 'repair' }).success).toBe(false);
    expect(linkRequestSchema.safeParse({ ...base, name: '' }).success).toBe(false);
    expect(linkRequestSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });

  test('dates a person can mean, and the notes', () => {
    expect(requestDatesProblem({ from: '2026-11-05', by: null }, NOW)).toBeNull();
    expect(requestDatesProblem({ from: '2026-11-04', by: null }, NOW)).toMatch(/from today/);
    expect(requestDatesProblem({ from: null, by: '2028-01-01' }, NOW)).toMatch(/next year/);
    expect(requestNotes({ where: '', notes: '' })).toBeNull();
    expect(requestNotes({ where: 'x', notes: 'y' })).toBe('Where: x\n\ny');
  });
});
