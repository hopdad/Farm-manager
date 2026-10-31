/**
 * Schema `ingest`: sync plumbing (plan §4 "Reference data and sync plumbing").
 * SQL source of truth: db/migrations. Keep imports relative (drizzle-kit loads this file).
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { CONNECTOR_MODES, COUNTED_MODES } from '../../connectors/types';

export const ingest = pgSchema('ingest');

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Vendor id -> our entity id. One row per (source, kind, external_id, source_org); sim and live
 * sources, and the same field seen from two orgs, map onto one entity. `source_org` is '' when
 * the vendor has no org concept.
 */
export const externalRefs = ingest.table(
  'external_refs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: text('source').notNull(),
    /** EXTERNAL_REF_KINDS (src/connectors/types.ts); build keys with externalRef(). */
    kind: text('kind').notNull(),
    externalId: text('external_id').notNull(),
    sourceOrg: text('source_org').notNull().default(''),
    entityId: uuid('entity_id').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('external_refs_source_kind_external_id_source_org_key').on(
      t.source,
      t.kind,
      t.externalId,
      t.sourceOrg,
    ),
    index('external_refs_entity_id_idx').on(t.entityId),
  ],
);

/**
 * One row per (source, stream): mode, cursor and the lease. Use src/db/leases.ts (ensureStream,
 * claimDue, advanceCursor, releaseLease) rather than calling app.claim_due & co. directly.
 * Job-level leases live here too, as rows ('job', <job name>).
 */
export const syncState = ingest.table(
  'sync_state',
  {
    source: text('source').notNull(),
    stream: text('stream').notNull(),
    mode: text('mode', { enum: CONNECTOR_MODES }).notNull().default('sim'),
    cursor: jsonb('cursor'),
    leaseUntil: tstz('lease_until'),
    leaseToken: uuid('lease_token'),
    /** Not due before this (backoff, Retry-After). Webhooks set it to now() to nudge. */
    nextRunAt: tstz('next_run_at'),
    lastRunAt: tstz('last_run_at'),
    lastOkAt: tstz('last_ok_at'),
    lastError: text('last_error'),
    lastErrorAt: tstz('last_error_at'),
    /** Webhook subscription ids, once-per-local-day guards, call counters. */
    extra: jsonb('extra').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'sync_state_pkey', columns: [t.source, t.stream] }),
    check('sync_state_mode_check', sql`${t.mode} in ('sim', 'replay', 'sandbox', 'live', 'off')`),
  ],
);

/** One row per job execution (both hosts). */
export const jobRuns = ingest.table(
  'job_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    job: text('job').notNull(),
    host: text('host', { enum: ['app', 'pc'] })
      .notNull()
      .default('app'),
    startedAt: tstz('started_at').notNull().defaultNow(),
    finishedAt: tstz('finished_at'),
    ok: boolean('ok'),
    items: integer('items'),
    note: text('note'),
    error: text('error'),
  },
  (t) => [
    index('job_runs_job_started_at_idx').on(t.job, t.startedAt.desc()),
    check('job_runs_host_check', sql`${t.host} in ('app', 'pc')`),
  ],
);

/** Raw landing zone and webhook inbox. 90-day retention except billing inputs. */
export const rawEvents = ingest.table(
  'raw_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: text('source').notNull(),
    stream: text('stream').notNull(),
    externalId: text('external_id').notNull(),
    payload: jsonb('payload').notNull(),
    /** sha256 hex of the canonical payload JSON. */
    sha256: text('sha256').notNull(),
    fetchedAt: tstz('fetched_at').notNull().defaultNow(),
    status: text('status', { enum: ['pending', 'processed', 'dead'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    processedAt: tstz('processed_at'),
  },
  (t) => [
    unique('raw_events_source_stream_external_id_sha256_key').on(
      t.source,
      t.stream,
      t.externalId,
      t.sha256,
    ),
    index('raw_events_pending_idx')
      .on(t.source, t.stream, t.fetchedAt)
      .where(sql`${t.status} = 'pending'`),
    check('raw_events_status_check', sql`${t.status} in ('pending', 'processed', 'dead')`),
    check('raw_events_sha256_check', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

/** OAuth tokens, AES-256-GCM encrypted (key: TOKEN_ENC_KEY). Refresh under pg_advisory_xact_lock. */
export const oauthTokens = ingest.table(
  'oauth_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: text('source').notNull(),
    orgExternalId: text('org_external_id').notNull().default(''),
    ciphertext: text('ciphertext').notNull(),
    expiresAt: tstz('expires_at'),
    refreshExpiresAt: tstz('refresh_expires_at'),
    scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [unique('oauth_tokens_source_org_external_id_key').on(t.source, t.orgExternalId)],
);

// =============================================================================================
// 1f live connectors (db/migrations/0007_m1f_live_connectors.sql; docs/contracts-1f.md §3)
// =============================================================================================

/**
 * Vendor API calls per source, stream, connector mode and UTC day (decision 4): what
 * /admin/connectors shows against the budget and what fleet.deere and deere.ops pace themselves
 * from (sandbox/live rows only: sim and replay calls never count against a real budget).
 * Upserted with `calls = calls + excluded.calls` by the call counter in src/connectors/http.ts
 * (sync-health). `stream` is '' for calls outside a sync step (the OAuth callback); the CLIs
 * count under 'backfill' and 'record'.
 */
export const apiCallsDaily = ingest.table(
  'api_calls_daily',
  {
    source: text('source').notNull(),
    stream: text('stream').notNull().default(''),
    /** The connector mode the calls went through. */
    mode: text('mode', { enum: COUNTED_MODES }).notNull(),
    /** UTC calendar day. */
    day: date('day', { mode: 'string' }).notNull(),
    /** Every HTTP attempt sent to the vendor (retries count). */
    calls: integer('calls').notNull().default(0),
    /** Attempts answered with a non-2xx other than 429, or that never got an answer. */
    errors: integer('errors').notNull().default(0),
    /** Attempts answered 429. */
    rateLimited: integer('rate_limited').notNull().default(0),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'api_calls_daily_pkey', columns: [t.source, t.stream, t.mode, t.day] }),
    check('api_calls_daily_mode_check', sql`${t.mode} in ('sim', 'replay', 'sandbox', 'live')`),
    check(
      'api_calls_daily_counts_check',
      sql`${t.calls} >= 0 and ${t.errors} >= 0 and ${t.rateLimited} >= 0`,
    ),
  ],
);

/**
 * The vendor orgs a connection can see and whether each is usable (decision 5): a Deere org
 * whose listing carries a `connections` link, or that answers 403, `needs_approval` (skipped by
 * every sync, shown on /admin/connectors with `approval_url`); else `connected`. Per connector
 * mode: the page shows the current mode's rows, and each successful org listing deletes the rows
 * of that source and mode it no longer lists.
 */
export const connectorOrgs = ingest.table(
  'connector_orgs',
  {
    source: text('source').notNull(),
    /** The connector mode the org was seen through. */
    mode: text('mode', { enum: COUNTED_MODES }).notNull(),
    orgExternalId: text('org_external_id').notNull(),
    name: text('name'),
    status: text('status', { enum: ['connected', 'needs_approval'] }).notNull(),
    /** Where a person approves the connection (Deere Connections), when known. */
    approvalUrl: text('approval_url'),
    /** Short reason ("403 from /organizations/{id}/fields"), no secrets. */
    detail: text('detail'),
    firstSeenAt: tstz('first_seen_at').notNull().defaultNow(),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'connector_orgs_pkey', columns: [t.source, t.mode, t.orgExternalId] }),
    check('connector_orgs_mode_check', sql`${t.mode} in ('sim', 'replay', 'sandbox', 'live')`),
    check('connector_orgs_status_check', sql`${t.status} in ('connected', 'needs_approval')`),
  ],
);
