/**
 * Server-side publish: a thin wrapper over `select app.publish(topic, event, payload)`.
 * Works the same locally (pg_notify) and on Supabase (realtime.send); see ./types.ts.
 *
 *   await publish('fleet', 'tick', tick);                 // app pool
 *   await publish('fleet', 'tick', tick, ctx.pool);       // jobs pool
 *   await db.transaction(async (tx) => { …; await publish('admin', 'clock', { paused }, tx) })
 *
 * The executor is anything src/db/exec.ts accepts: a pg Pool / PoolClient / Client or a Drizzle
 * db / transaction. Inside a transaction the message is delivered on commit (none on rollback).
 *
 * An oversized payload is replaced by `invalidate { event, reason: 'too_large' }` so clients
 * refetch instead of the send failing. "Oversized" is measured on the exact text Postgres sends
 * (see notifyText): pg_notify rejects payloads of 8000 bytes or more.
 */
import { getPool } from '../../db/client';
import { type Executor, exec } from '../../db/exec';
import {
  type EventName,
  type InvalidatePayload,
  MAX_PAYLOAD_BYTES,
  type PayloadOf,
  type Topic,
} from './types';

export interface PublishResult {
  /** The event actually sent ('invalidate' when the payload was too large). */
  event: string;
  /** Upper bound of the NOTIFY payload in bytes (exact except for the seq digits). */
  bytes: number;
}

/** The largest seq we budget for (16 digits): sizes are upper bounds for any real seq. */
const SEQ_BUDGET = 2 ** 53;

/**
 * A JS number as Postgres prints the numeric it becomes in jsonb: JSON's exponent forms
 * (1e+21, 1.5e-7) are written out in full (1000000000000000000000, 0.00000015).
 */
function numericText(n: number): string {
  const s = JSON.stringify(n);
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/i.exec(s);
  if (!m) return s;
  const [, sign = '', int = '', frac = '', exp = '0'] = m;
  const digits = int + frac;
  const point = int.length + Number(exp);
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/**
 * Postgres's jsonb text output: `{"k": v, "k2": v2}` and `[a, b]` (a space after every ':' and
 * ','). Strings are escaped exactly as JSON.stringify does. Key order differs (jsonb sorts keys),
 * which doesn't change the length. `v` must already be plain JSON data (see normalize()).
 */
export function pgJsonbText(v: unknown): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      return numericText(v);
    case 'string':
      return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(pgJsonbText).join(', ')}]`;
  const entries = Object.entries(v as Record<string, unknown>);
  return `{${entries.map(([k, x]) => `${JSON.stringify(k)}: ${pgJsonbText(x)}`).join(', ')}}`;
}

/** What we actually send: JSON round-trip (drops undefined, applies toJSON, NaN -> null). */
function normalize(payload: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
}

/**
 * The exact NOTIFY text app.publish produces locally:
 * `json_build_object('topic', t, 'event', e, 'payload', payload || {seq})::text`, i.e.
 * `{"topic" : "fleet", "event" : "tick", "payload" : {"ts": "…", "machines": […], "seq": 7}}`.
 */
export function notifyText(topic: string, event: string, payload: unknown, seq: number): string {
  const body = pgJsonbText({ ...normalize(payload), seq });
  return `{"topic" : ${JSON.stringify(topic)}, "event" : ${JSON.stringify(event)}, "payload" : ${body}}`;
}

/** Bytes of the NOTIFY payload app.publish will send, budgeting a 16-digit seq. */
export function messageBytes(topic: string, event: string, payload: unknown): number {
  return Buffer.byteLength(notifyText(topic, event, payload, SEQ_BUDGET), 'utf8');
}

export async function publish<T extends Topic, E extends EventName<T>>(
  topic: T,
  event: E,
  payload: PayloadOf<T, E>,
  executor: Executor = getPool(),
): Promise<PublishResult> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('realtime payloads must be JSON objects');
  }
  let sendEvent: string = event;
  let sendPayload: unknown = payload;
  let bytes = messageBytes(topic, event, payload);
  if (bytes > MAX_PAYLOAD_BYTES) {
    const inv: InvalidatePayload = { event, reason: 'too_large' };
    sendEvent = 'invalidate';
    sendPayload = inv;
    bytes = messageBytes(topic, sendEvent, inv);
  }
  await exec(executor, 'select app.publish($1, $2, $3::jsonb)', [
    topic,
    sendEvent,
    JSON.stringify(sendPayload),
  ]);
  return { event: sendEvent, bytes };
}
