/**
 * Customer request links (decision 2a-9, the stretch web form; docs/contracts-2a.md §5.5): a
 * manager makes a revocable link `/r/<token>` for one customer party on /admin/parties/<id>; the
 * customer opens it with no sign-in and asks for work; each request becomes a `requested` job on
 * the board for a manager to accept.
 *
 *  - The token is REQUEST_LINK_TOKEN_BYTES (16, 128 bits) of randomness, base64url (22
 *    characters), shown ONCE when the link is made. Only its HMAC-SHA256 under SESSION_SECRET
 *    (purpose 'job-request-link', next to the auth codes' purposes) is stored, so a copy of the
 *    database alone can't be turned back into working links.
 *  - A revoked link and an unknown token are refused the same way (the page can't tell anyone
 *    which links exist).
 *  - At most REQUEST_LINK_MAX_PER_DAY (20) requests per link per farm day (America/Detroit),
 *    counted from farm.jobs.request_link_id + created_at; the 21st is refused. The count and the
 *    insert run in one transaction under a lock on the link row, so parallel posts can't pass the
 *    cap together.
 *  - A request is inserted here directly (source 'app', status 'requested', channel 'web_form',
 *    requested_by_party_id = the link's party, request_link_id, last_used_at touched). The jobs
 *    triggers publish it (jobs/updated, decision 2a-8); nothing here publishes. Lock order (§4.7):
 *    the link row first, then the one job statement (the insert, which takes the `jobs` topic
 *    row through its trigger) last; a deadlock (40P01) retries the whole transaction once.
 *  - With a field (one of the customer's own fields, offered on the form), the field rules of a
 *    new job apply (decisions 2a-5, 2a-6): planned acres from the current boundary, crop year
 *    from the field's growing year (D23), else the calendar year.
 *  - The job's customer is the link's party, or, for a person whose organization is a customer
 *    (Gail Pressler of Juniper Hill), that organization.
 *
 * Until the app is online (MD) the link only works on the farm's own network (LAN-only).
 */
import { createHmac, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { cropSeasonsToSync, currentCropYear } from '../../domain/crops';
import { FARM_TIME_ZONE, farmDate } from '../../domain/farm';
import { isUuid } from '../../domain/ids';
import {
  DEFAULT_BUSINESS_LINE,
  JOB_DEFAULT_PRIORITY,
  type JobKind,
  MAX_JOB_NOTES_CHARS,
  MAX_REQUESTER_NAME_CHARS,
  MAX_REQUESTER_PHONE_CHARS,
  OPEN_JOB_STATUSES,
  REQUEST_LINK_MAX_PER_DAY,
  REQUEST_LINK_TOKEN_BYTES,
} from '../../domain/work-jobs';
import { type Executor, exec } from '../exec';
import { fieldGrowingYear } from './operations';

// ---------------------------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------------------------

/** base64url of REQUEST_LINK_TOKEN_BYTES bytes: 22 characters, no padding. */
export const REQUEST_TOKEN_LENGTH = Math.ceil((REQUEST_LINK_TOKEN_BYTES * 8) / 6);
const TOKEN_RE = new RegExp(`^[A-Za-z0-9_-]{${REQUEST_TOKEN_LENGTH}}$`);

/** A new random link token (128 bits, base64url). */
export function newRequestToken(): string {
  return randomBytes(REQUEST_LINK_TOKEN_BYTES).toString('base64url');
}

/** Only strings that could be one of our tokens reach the database. */
export function looksLikeRequestToken(v: unknown): v is string {
  return typeof v === 'string' && TOKEN_RE.test(v);
}

/** The stored form of a token: hex HMAC-SHA256 under SESSION_SECRET, purpose 'job-request-link'. */
export function requestLinkHash(secret: string, token: string): string {
  return createHmac('sha256', secret)
    .update(`farm-ops job-request-link token\n${token}`)
    .digest('hex');
}

/** The page a link opens. */
export const requestLinkPath = (token: string) => `/r/${token}`;

// ---------------------------------------------------------------------------------------------
// Links (the admin side)
// ---------------------------------------------------------------------------------------------

export const MAX_REQUEST_LINK_LABEL_CHARS = 80;

export interface RequestLinkRow {
  id: string;
  partyId: string;
  label: string | null;
  createdAt: string;
  createdByName: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  /** Requests this farm day (the cap is REQUEST_LINK_MAX_PER_DAY). */
  requestsToday: number;
  requestsTotal: number;
}

/** `$n` -> the start of the farm day (America/Detroit) of that instant, as timestamptz SQL. */
const farmDayStart = (param: string) =>
  `((${param}::timestamptz at time zone '${FARM_TIME_ZONE}')::date::timestamp at time zone '${FARM_TIME_ZONE}')`;
const farmDayEnd = (param: string) =>
  `(((${param}::timestamptz at time zone '${FARM_TIME_ZONE}')::date + 1)::timestamp at time zone '${FARM_TIME_ZONE}')`;

/** A party's links, newest first, with their use. */
export async function listRequestLinks(
  ex: Executor,
  partyId: string,
  now: Date,
): Promise<RequestLinkRow[]> {
  if (!isUuid(partyId)) return [];
  const r = await exec<{
    id: string;
    party_id: string;
    label: string | null;
    created_at: Date;
    created_by_name: string | null;
    revoked_at: Date | null;
    last_used_at: Date | null;
    requests_today: number;
    requests_total: number;
  }>(
    ex,
    `select l.id, l.party_id, l.label, l.created_at, cp.display_name as created_by_name,
            l.revoked_at, l.last_used_at,
            (select count(*)::int from farm.jobs j
              where j.request_link_id = l.id
                and j.created_at >= ${farmDayStart('$2')} and j.created_at < ${farmDayEnd('$2')})
              as requests_today,
            (select count(*)::int from farm.jobs j where j.request_link_id = l.id) as requests_total
       from farm.job_request_links l
       left join farm.app_users u on u.id = l.created_by
       left join farm.parties cp on cp.id = u.party_id
      where l.party_id = $1::uuid
      order by l.revoked_at is not null, l.created_at desc, l.id`,
    [partyId, now.toISOString()],
  );
  return r.rows.map((x) => ({
    id: x.id,
    partyId: x.party_id,
    label: x.label,
    createdAt: x.created_at.toISOString(),
    createdByName: x.created_by_name,
    revokedAt: x.revoked_at?.toISOString() ?? null,
    lastUsedAt: x.last_used_at?.toISOString() ?? null,
    requestsToday: x.requests_today,
    requestsTotal: x.requests_total,
  }));
}

export type CreateRequestLinkResult =
  /** `token` is shown once: only its hash is stored. */
  | { status: 'created'; id: string; token: string }
  | { status: 'not_found' }
  /** Links are for customers (role customer) only. */
  | { status: 'not_customer' };

export async function createRequestLink(
  ex: Executor,
  secret: string,
  input: { partyId: string; label: string | null; createdBy: string | null },
  opts: { token?: string } = {},
): Promise<CreateRequestLinkResult> {
  if (!isUuid(input.partyId)) return { status: 'not_found' };
  const party = await exec<{ customer: boolean }>(
    ex,
    `select 'customer' = any (roles) as customer from farm.parties where id = $1::uuid`,
    [input.partyId],
  );
  const p = party.rows[0];
  if (!p) return { status: 'not_found' };
  if (!p.customer) return { status: 'not_customer' };
  const token = opts.token ?? newRequestToken();
  const label = input.label?.replace(/\s+/g, ' ').trim().slice(0, MAX_REQUEST_LINK_LABEL_CHARS);
  const r = await exec<{ id: string }>(
    ex,
    `insert into farm.job_request_links (party_id, token_hash, label, created_by)
     values ($1::uuid, $2, $3, $4::uuid) returning id`,
    [input.partyId, requestLinkHash(secret, token), label || null, input.createdBy],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('the request link was not saved');
  return { status: 'created', id, token };
}

export type RevokeRequestLinkResult = 'revoked' | 'already_revoked' | 'not_found';

/** End a link (its jobs stay; the page refuses it from now on). */
export async function revokeRequestLink(
  ex: Executor,
  input: { id: string; partyId: string },
  now: Date,
): Promise<RevokeRequestLinkResult> {
  if (!isUuid(input.id) || !isUuid(input.partyId)) return 'not_found';
  const r = await exec<{ was: Date | null }>(
    ex,
    `update farm.job_request_links l set revoked_at = coalesce(l.revoked_at, $3::timestamptz)
       from farm.job_request_links old
      where l.id = $1::uuid and l.party_id = $2::uuid and old.id = l.id
      returning old.revoked_at as was`,
    [input.id, input.partyId, now.toISOString()],
  );
  const row = r.rows[0];
  if (!row) return 'not_found';
  return row.was ? 'already_revoked' : 'revoked';
}

// ---------------------------------------------------------------------------------------------
// The public side (/r/<token>)
// ---------------------------------------------------------------------------------------------

/** The kinds a customer may ask for (the board's other kinds are the farm's own work). */
export const REQUESTABLE_KINDS = [
  'spray',
  'fertilize',
  'plant',
  'harvest',
  'haul',
  'tillage',
  'scout',
  'other',
] as const satisfies readonly JobKind[];

export const MAX_REQUEST_WHERE_CHARS = 200;
export const MAX_REQUEST_NOTES_CHARS = 2_000;
/** How far ahead a customer may ask (a season and a bit). */
export const MAX_REQUEST_DAYS_AHEAD = 400;

const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'pick a date')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T12:00:00Z`)), 'pick a date');
const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

/** The public form, as the page posts it (strings), checked. */
export const linkRequestSchema = z
  .strictObject({
    kind: z.enum(REQUESTABLE_KINDS, { error: 'say what you need done' }),
    fieldId: z.preprocess(blankToNull, z.uuid().nullable()).default(null),
    where: z
      .string()
      .trim()
      .max(MAX_REQUEST_WHERE_CHARS, `say where in at most ${MAX_REQUEST_WHERE_CHARS} characters`)
      .default(''),
    from: z.preprocess(blankToNull, isoDay.nullable()).default(null),
    by: z.preprocess(blankToNull, isoDay.nullable()).default(null),
    notes: z
      .string()
      .trim()
      .max(MAX_REQUEST_NOTES_CHARS, `notes have at most ${MAX_REQUEST_NOTES_CHARS} characters`)
      .default(''),
    name: z
      .string()
      .trim()
      .min(1, 'tell us your name')
      .max(MAX_REQUESTER_NAME_CHARS, `a name has at most ${MAX_REQUESTER_NAME_CHARS} characters`),
    phone: z
      .string()
      .trim()
      .min(7, 'a phone number we can call back')
      .max(
        MAX_REQUESTER_PHONE_CHARS,
        `a phone number has at most ${MAX_REQUESTER_PHONE_CHARS} characters`,
      )
      .regex(/^[0-9+().\-\s#*x]+$/i, 'a phone number we can call back'),
  })
  .refine((r) => !r.from || !r.by || r.from <= r.by, {
    message: 'the last day can’t be before the first',
    path: ['by'],
  })
  .refine((r) => r.fieldId !== null || r.where.length > 0, {
    message: 'pick a field or say where',
    path: ['where'],
  });
export type LinkRequestInput = z.output<typeof linkRequestSchema>;

export interface ResolvedRequestLink {
  id: string;
  partyId: string;
  partyName: string;
  /** The customer's own fields (active, with a boundary) the form offers, by name. */
  fields: { id: string; name: string; acres: number | null }[];
}

/** The parties whose farms count as this link's customer: the party, and a person's org. */
const CUSTOMER_PARTIES = `(select p.id from farm.parties p where p.id = $1::uuid
                           union select p.org_id from farm.parties p
                            where p.id = $1::uuid and p.org_id is not null)`;

async function customerFields(
  ex: Executor,
  partyId: string,
): Promise<ResolvedRequestLink['fields']> {
  const r = await exec<{ id: string; name: string; acres: number | null }>(
    ex,
    `select f.id, f.name, b.acres::float8 as acres
       from farm.fields f
       join farm.farms fa on fa.id = f.farm_id
       join farm.current_boundaries b on b.field_id = f.id
      where f.active and fa.client_party_id in ${CUSTOMER_PARTIES}
      order by lower(f.name), f.id
      limit 500`,
    [partyId],
  );
  return r.rows;
}

/**
 * The live link a token opens, or null (malformed, unknown or revoked: refused alike). Reads only
 * (a GET never spends anything).
 */
export async function resolveRequestLink(
  ex: Executor,
  secret: string,
  token: unknown,
): Promise<ResolvedRequestLink | null> {
  if (!looksLikeRequestToken(token)) return null;
  const r = await exec<{ id: string; party_id: string; party_name: string }>(
    ex,
    `select l.id, l.party_id, p.display_name as party_name
       from farm.job_request_links l join farm.parties p on p.id = l.party_id
      where l.token_hash = $1 and l.revoked_at is null`,
    [requestLinkHash(secret, token)],
  );
  const link = r.rows[0];
  if (!link) return null;
  return {
    id: link.id,
    partyId: link.party_id,
    partyName: link.party_name,
    fields: await customerFields(ex, link.party_id),
  };
}

export type LinkRequestResult =
  | { status: 'created'; jobId: string }
  /** Malformed, unknown or revoked token. */
  | { status: 'refused' }
  /** The link already took REQUEST_LINK_MAX_PER_DAY requests this farm day. */
  | { status: 'limit' }
  /** The field isn't one of the customer's. */
  | { status: 'bad_field' };

/** Where and the customer's notes, as the job's notes (the board shows them in the detail). */
export function requestNotes(input: Pick<LinkRequestInput, 'where' | 'notes'>): string | null {
  const parts = [input.where ? `Where: ${input.where}` : '', input.notes].filter(Boolean);
  const text = parts.join('\n\n').slice(0, MAX_JOB_NOTES_CHARS);
  return text || null;
}

const OPEN = `(${OPEN_JOB_STATUSES.map((s) => `'${s}'`).join(', ')})`;

async function inTransaction<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const c = await pool.connect();
    try {
      await c.query('begin');
      const out = await fn(c);
      await c.query('commit');
      return out;
    } catch (e) {
      await c.query('rollback').catch(() => {});
      // contracts-2a §4.7 rule 4: a deadlock retries the whole transaction once.
      if ((e as { code?: string }).code === '40P01' && attempt === 0) continue;
      throw e;
    } finally {
      c.release();
    }
  }
}

/**
 * The POST of /r/<token>: create the customer's request as a `requested` job, or say why not.
 * `now` is the request's time (the farm day the cap counts and the job's created_at).
 */
export async function submitLinkRequest(
  pool: pg.Pool,
  secret: string,
  token: unknown,
  input: LinkRequestInput,
  now: Date,
): Promise<LinkRequestResult> {
  if (!looksLikeRequestToken(token)) return { status: 'refused' };
  const hash = requestLinkHash(secret, token);
  const at = now.toISOString();
  return inTransaction(pool, async (c) => {
    // 1. The link, locked: parallel posts on one link queue here, so the count below holds.
    const link = await c.query<{ id: string; party_id: string; customer_id: string }>(
      `select l.id, l.party_id,
              case when p.kind = 'person' and 'customer' = any (o.roles) then o.id else p.id end
                as customer_id
         from farm.job_request_links l
         join farm.parties p on p.id = l.party_id
         left join farm.parties o on o.id = p.org_id
        where l.token_hash = $1 and l.revoked_at is null
        for update of l`,
      [hash],
    );
    const l = link.rows[0];
    if (!l) return { status: 'refused' as const };
    // 2. This farm day's requests on the link.
    const used = await c.query<{ n: number }>(
      `select count(*)::int as n from farm.jobs
        where request_link_id = $1
          and created_at >= ${farmDayStart('$2')} and created_at < ${farmDayEnd('$2')}`,
      [l.id, at],
    );
    if ((used.rows[0]?.n ?? 0) >= REQUEST_LINK_MAX_PER_DAY) return { status: 'limit' as const };
    // 3. The field, when one was picked: one of the customer's, with the field rules.
    let acres: number | null = null;
    let cropYear: number | null = null;
    if (input.fieldId) {
      const f = await c.query<{ acres: number | null }>(
        `select b.acres::float8 as acres
           from farm.fields f
           join farm.farms fa on fa.id = f.farm_id
           join farm.current_boundaries b on b.field_id = f.id
          where f.id = $2::uuid and f.active and fa.client_party_id in ${CUSTOMER_PARTIES}`,
        [l.party_id, input.fieldId],
      );
      const field = f.rows[0];
      if (!field) return { status: 'bad_field' as const };
      acres = field.acres;
      cropYear =
        (await fieldGrowingYear(c, input.fieldId, cropSeasonsToSync(now))) ?? currentCropYear(now);
    }
    // 4. The link was used (before the job statement: the topic lock comes last, §4.7).
    await c.query('update farm.job_request_links set last_used_at = $2 where id = $1', [l.id, at]);
    // 5. The request: the only job statement, at the end of its lane's priority.
    const businessLine = DEFAULT_BUSINESS_LINE[input.kind];
    const job = await c.query<{ id: string }>(
      `insert into farm.jobs (
         kind, business_line, status, status_changed_at, customer_party_id, field_id,
         planned_window, crop_year, planned_acres, planned_acres_by_hand, priority, sort_key,
         notes, request_channel, requested_by_party_id, requester_name, requester_phone,
         request_link_id, source, created_at, updated_at)
       values (
         $1, $2, 'requested', $3::timestamptz, $4::uuid, $5::uuid,
         case when $6::date is null and $7::date is null then null
              else tstzrange($6::date::timestamp at time zone '${FARM_TIME_ZONE}',
                             ($7::date + 1)::timestamp at time zone '${FARM_TIME_ZONE}', '[)') end,
         $8::int, $9::numeric, false, $10::int,
         coalesce((select max(j.sort_key) from farm.jobs j
                    where j.business_line = $2 and j.priority = $10::int
                      and j.status in ${OPEN}), 0) + 10,
         $11, 'web_form', $12::uuid, $13, $14, $15::uuid, 'app', $3::timestamptz, $3::timestamptz)
       returning id`,
      [
        input.kind,
        businessLine,
        at,
        l.customer_id,
        input.fieldId,
        input.from,
        input.by,
        cropYear,
        acres,
        JOB_DEFAULT_PRIORITY,
        requestNotes(input),
        l.party_id,
        input.name,
        input.phone,
        l.id,
      ],
    );
    const jobId = job.rows[0]?.id;
    if (!jobId) throw new Error('the request was not saved');
    return { status: 'created' as const, jobId };
  });
}

/**
 * Dates a person can mean, at `now` (farm days, America/Detroit): from yesterday (a request typed
 * just after midnight) to MAX_REQUEST_DAYS_AHEAD ahead. A message, or null when they are fine.
 */
export function requestDatesProblem(
  input: Pick<LinkRequestInput, 'from' | 'by'>,
  now: Date,
): string | null {
  const today = Date.parse(`${farmDate(now)}T00:00:00Z`);
  const day = 86_400_000;
  for (const v of [input.from, input.by]) {
    if (!v) continue;
    const d = Date.parse(`${v}T00:00:00Z`);
    if (d < today - day) return 'pick a day from today on';
    if (d > today + MAX_REQUEST_DAYS_AHEAD * day) return 'pick a day within the next year';
  }
  return null;
}
