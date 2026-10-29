/**
 * Schema `app`: runtime settings, realtime sequence numbers and the shared SQL functions
 * (app.publish, app.claim_due, app.ensure_stream, app.mvt_fields; see db/migrations/0002_*).
 * Keep imports relative (drizzle-kit loads this file).
 */
import { bigint, jsonb, pgSchema, text, timestamp } from 'drizzle-orm/pg-core';

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
