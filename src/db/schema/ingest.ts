/**
 * Schema `ingest`: sync plumbing (plan §4 "Reference data and sync plumbing").
 * SQL source of truth: db/migrations. Keep imports relative (drizzle-kit loads this file).
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
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
import { CONNECTOR_MODES } from '../../connectors/types';

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
    /** 'field' | 'farm' | 'machine' | 'party' | 'boundary' | 'operation' | … */
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
 * One row per (source, stream): mode, cursor and the lease. Claim with
 * `select * from app.claim_due(source, stream, lease_seconds)`; create rows with
 * `select app.ensure_stream(source, stream, mode)`.
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
