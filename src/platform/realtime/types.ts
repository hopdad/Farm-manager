/**
 * Realtime contract (plan §1 "Realtime (Supabase Realtime)").
 *
 * Server side: `publish(topic, event, payload)` (./publish.ts) runs `select app.publish(...)`,
 * which adds a per-topic `seq` and sends through realtime.send on Supabase or
 * pg_notify('app_events') locally. Publishing inside a transaction delivers on commit.
 *
 * Client side: one `RealtimeClient` per tab (one shared EventSource locally). Implementations:
 *   - local: src/platform/realtime/client.ts -> EventSource('/api/realtime?topics=...') (SSE)
 *   - production (MD): Supabase Broadcast, private channels, chosen by NEXT_PUBLIC_REALTIME.
 * Broadcast doesn't replay missed messages, so subscribers MUST refetch their snapshot in
 * `onResync`, which the client calls on every (re)subscribe, whenever `seq` skips, and when an
 * `invalidate` event arrives.
 *
 * Owned by the foundation stage; the realtime agent implements the client and the SSE route.
 */
import type { FleetTick } from '../../domain/fleet';

/** pg_notify channel the local adapter LISTENs on. */
export const LOCAL_NOTIFY_CHANNEL = 'app_events';

/**
 * Keep payloads under pg_notify's limit (it rejects 8000 bytes or more) and cheap on Supabase.
 * Measured on the exact NOTIFY text Postgres builds (publish.ts `messageBytes`/`notifyText`:
 * jsonb text output with its extra spaces, plus the topic/event wrapper and a 16-digit seq).
 * A FleetTick fits about 20 machines (21 compact ones); M0 runs about 11.
 */
export const MAX_PAYLOAD_BYTES = 7_500;

/** Sent instead of an oversized payload, or when a server change can't be expressed as a delta. */
export interface InvalidatePayload {
  /** The event that would have been sent, if any. */
  event?: string;
  reason: 'too_large' | 'changed';
}

/** Job clock state, published on 'admin' whenever app.settings 'clock.paused' changes. */
export interface ClockPayload {
  paused: boolean;
}

/** One connector's health, published on 'admin' after each sync run. */
export interface SyncStatusPayload {
  source: string;
  stream: string;
  mode: string;
  ok: boolean;
  lastOkAt: string | null;
  lastError: string | null;
}

/**
 * Topic catalogue: topic -> event -> payload type. Topic names are lower-case words;
 * per-entity topics use a colon (e.g. 'field:<uuid>', from M2).
 *  - 'fleet': 'tick' (one batched FleetTick per sync run), 'invalidate'
 *  - 'admin': 'clock', 'sync.status', 'invalidate'
 */
export interface TopicEvents {
  fleet: {
    tick: FleetTick;
    invalidate: InvalidatePayload;
  };
  admin: {
    clock: ClockPayload;
    'sync.status': SyncStatusPayload;
    invalidate: InvalidatePayload;
  };
}

export type Topic = keyof TopicEvents;
export type EventName<T extends Topic> = keyof TopicEvents[T] & string;
export type PayloadOf<T extends Topic, E extends EventName<T>> = TopicEvents[T][E];

/** A loosely typed message (untyped transports, logs). Subscribers get `TopicMessage<T>`. */
export interface RealtimeEvent<P = unknown> {
  event: string;
  payload: P;
  /** Per-topic sequence number from app.topic_seq (strictly increasing per topic). */
  seq: number;
}

/**
 * What a subscriber to topic T receives: a union discriminated on `event`, so narrowing on
 * `evt.event` narrows `evt.payload` (no casts):
 *
 *   client.subscribe('fleet', (evt) => {
 *     if (evt.event === 'tick') draw(evt.payload.machines);   // payload: FleetTick
 *   }, { onResync: refetch });
 *
 * `payload` excludes `seq` (the client lifts it out). The client handles 'invalidate' itself by
 * calling onResync, and still passes it on.
 */
export type TopicMessage<T extends Topic> = {
  [E in EventName<T>]: {
    event: E;
    payload: TopicEvents[T][E];
    /** Per-topic sequence number from app.topic_seq (strictly increasing per topic). */
    seq: number;
  };
}[EventName<T>];

/** Raw local message as delivered on pg_notify('app_events'): payload includes `seq`. */
export interface NotifyMessage {
  topic: string;
  event: string;
  payload: Record<string, unknown> & { seq: number };
}

export interface SubscribeOptions {
  /** Refetch your snapshot. Called after (re)connect, on a `seq` gap, and on 'invalidate'. */
  onResync(): void;
}

/** Browser-side client. `subscribe` returns an unsubscribe function. */
export interface RealtimeClient {
  subscribe<T extends Topic>(
    topic: T,
    onEvent: (evt: TopicMessage<T>) => void,
    opts: SubscribeOptions,
  ): () => void;
}
