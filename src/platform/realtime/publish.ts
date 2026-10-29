/**
 * Server-side publish: a thin wrapper over `select app.publish(topic, event, payload)`.
 * Works the same locally (pg_notify) and on Supabase (realtime.send); see ./types.ts.
 *
 *   await publish('fleet', 'tick', tick);                 // app pool
 *   await publish('fleet', 'tick', tick, ctx.pool);       // jobs pool
 *   await db.transaction(async (tx) => { …; await publish('admin', 'clock', { paused }, client) })
 *
 * An oversized payload (> MAX_PAYLOAD_BYTES once wrapped) is replaced by
 * `invalidate { event, reason: 'too_large' }` so clients refetch instead of the send failing.
 */
import { getPool, type Queryable } from '../../db/client';
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
  bytes: number;
}

/** Size of the message as app.publish will send it (topic, event, payload + seq). */
export function messageBytes(topic: string, event: string, payload: unknown): number {
  const text = JSON.stringify({ topic, event, payload: { ...(payload as object), seq: 2 ** 53 } });
  return Buffer.byteLength(text, 'utf8');
}

export async function publish<T extends Topic, E extends EventName<T>>(
  topic: T,
  event: E,
  payload: PayloadOf<T, E>,
  executor: Queryable = getPool(),
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
  await executor.query('select app.publish($1, $2, $3::jsonb)', [
    topic,
    sendEvent,
    JSON.stringify(sendPayload),
  ]);
  return { event: sendEvent, bytes };
}
