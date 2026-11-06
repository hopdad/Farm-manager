/**
 * Schema `app`: runtime settings, realtime sequence numbers, usage events (2a) and the shared SQL
 * functions (app.publish, app.claim_due, app.ensure_stream, app.mvt_fields; see
 * db/migrations/0002_*). Keep imports relative (drizzle-kit loads this file).
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  index,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { USAGE_KINDS } from '../../domain/work-jobs';
import { appUsers, devices } from './farm';

export const app = pgSchema('app');

/**
 * Runtime-tunable settings. Keys (documented in docs/contracts.md):
 *  - 'clock.paused' (boolean, default false): the job clock skips scheduled runs while true.
 * Readers must treat a missing key as its default.
 */
export const settings = app.table('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

/** Per-topic realtime sequence, incremented by app.publish(). */
export const topicSeq = app.table('topic_seq', {
  topic: text('topic').primaryKey(),
  seq: bigint('seq', { mode: 'number' }).notNull().default(0),
});

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Who used the app when (2a, plan §4; decision 2a-11): the Phase 2 gate report ("crew used the
 * board every day") at /admin/usage. Written from server code after the session is known (the
 * /board and /m pages, an operator PIN sign-in, each job write, the board's heartbeat), never
 * from proxy.ts. At most one row per device + person + kind + route per USAGE_BUCKET_MINUTES:
 * the writer inserts with `on conflict (actor_key, kind, route, bucket_at) do nothing`.
 * `actor_key` is '<device id or ->:<app user id or ->' at write time, so a person or device
 * deleted later (its id set null here) never collides with another row. Exported by data:export
 * for your own people and devices; kept USAGE_RETENTION_DAYS.
 */
export const usageEvents = app.table(
  'usage_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    at: tstz('at').notNull().defaultNow(),
    /** The farm's date of `at` (America/Detroit, farmDate()). */
    farmDay: date('farm_day', { mode: 'string' }).notNull(),
    kind: text('kind', { enum: USAGE_KINDS }).notNull(),
    /** The page or API route ('/board', '/m', '/api/v1/jobs/[id]/status'); '' when none. */
    route: text('route').notNull().default(''),
    appUserId: uuid('app_user_id').references(() => appUsers.id, { onDelete: 'set null' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    actorKey: text('actor_key').notNull(),
    /** `at` floored to USAGE_BUCKET_MINUTES (UTC). */
    bucketAt: tstz('bucket_at').notNull(),
  },
  (t) => [
    unique('usage_events_bucket_key').on(t.actorKey, t.kind, t.route, t.bucketAt),
    index('usage_events_farm_day_idx').on(t.farmDay),
    index('usage_events_app_user_id_idx').on(t.appUserId),
    index('usage_events_device_id_idx').on(t.deviceId),
    check(
      'usage_events_kind_check',
      sql`${t.kind} in (${sql.raw(USAGE_KINDS.map((v) => `'${v}'`).join(', '))})`,
    ),
    check('usage_events_route_check', sql`length(${t.route}) <= 200`),
    check(
      'usage_events_actor_key_check',
      sql`${t.actorKey} ~ '^([0-9a-f-]{36}|-):([0-9a-f-]{36}|-)$'`,
    ),
    check('usage_events_bucket_at_check', sql`${t.bucketAt} <= ${t.at}`),
  ],
);
