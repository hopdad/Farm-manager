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
import type { FieldPart } from '../../domain/fields';
import type { FleetTick, MachineStatus } from '../../domain/fleet';

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
 * fleet/machine (M1 1a): one machine's status changed (marked down from a phone, back up).
 * Clients that know it (the fleet panel) patch their model at once; the next tick carries the
 * status too. In the same transaction the publisher also sends fleet/invalidate
 * `{ event: 'machine', reason: 'changed' }`, so subscribers that only read ticks (the M0 map's
 * feed, src/ui/map/fleet/feed.ts) refetch GET /api/fleet within the 2 s target instead of waiting
 * for the next fleet.deere tick (docs/contracts-m1.md §6).
 */
export interface MachineStatusPayload {
  machineId: string;
  status: MachineStatus;
  downReason: string | null;
  /** UTC ISO; null when not down. */
  downAt: string | null;
  /** Display name of who changed it; null for a sync. */
  by: string | null;
}

/**
 * fields/updated (M1): one field's data changed. Panels showing it refetch the listed parts
 * (GET /api/fields/<id>); the map refetches field tiles when 'boundary' or 'identity' is listed
 * (the tiles' `?v=` version changes).
 */
export interface FieldUpdatedPayload {
  fieldId: string;
  parts: FieldPart[];
}

/**
 * weather/updated (M1 1b): a forecast issue or observations landed. Strips refetch their view
 * (GET /api/weather/strip). Small on purpose: grid ids only.
 */
export interface WeatherUpdatedPayload {
  gridIds: string[];
  /** The newest forecast issue that landed, if any. */
  issuedAt: string | null;
}

/**
 * spray/assessed (M1 1b): new go/no-go verdicts for `forHour`. Listing every field id of a
 * 500-field farm would pass the pg_notify limit: publish() then sends `invalidate` instead, and
 * clients refetch all verdicts (that is the contract, not an error).
 */
export interface SprayAssessedPayload {
  forHour: string;
  fieldIds: string[];
  counts: { go: number; caution: number; noGo: number };
}

/**
 * layers/updated (M1 1d): a gis.map_layers row was added or got a new version (a gis:* build, a
 * parcels import, a drawn tile line). The rail refetches GET /api/layers; maps re-add the layer's
 * source with the new `?v=`.
 */
export interface LayerUpdatedPayload {
  key: string;
  version: string | null;
}

/**
 * Topic catalogue: topic -> event -> payload type. Topic names are lower-case words (the SSE
 * route rejects anything else); per-entity topics would use a colon (e.g. 'field:<uuid>'), but
 * M1 keeps one topic per kind with the id in the payload. Every topic has 'invalidate'.
 *  - 'fleet':   'tick' (one batched FleetTick per sync run), 'machine' (status change, 1a)
 *  - 'admin':   'clock', 'sync.status'
 *  - 'fields':  'updated' (notes, boundary, seasons, parties, … of one field; 1a/1c)
 *  - 'weather': 'updated' (forecast/observations landed; 1b)
 *  - 'spray':   'assessed' (new verdicts; 1b)
 *  - 'layers':  'updated' (a map layer was rebuilt or added; 1d)
 * Add a topic or event through the contracts (docs/contracts-m1.md §6), never ad hoc.
 */
export interface TopicEvents {
  fleet: {
    tick: FleetTick;
    machine: MachineStatusPayload;
    invalidate: InvalidatePayload;
  };
  admin: {
    clock: ClockPayload;
    'sync.status': SyncStatusPayload;
    invalidate: InvalidatePayload;
  };
  fields: {
    updated: FieldUpdatedPayload;
    invalidate: InvalidatePayload;
  };
  weather: {
    updated: WeatherUpdatedPayload;
    invalidate: InvalidatePayload;
  };
  spray: {
    assessed: SprayAssessedPayload;
    invalidate: InvalidatePayload;
  };
  layers: {
    updated: LayerUpdatedPayload;
    invalidate: InvalidatePayload;
  };
}

/** Every topic, for subscribers that list them (the SSE `?topics=` parameter, admin pages). */
export const TOPICS = [
  'fleet',
  'admin',
  'fields',
  'weather',
  'spray',
  'layers',
] as const satisfies readonly (keyof TopicEvents)[];

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
