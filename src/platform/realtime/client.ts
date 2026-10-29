/**
 * Browser realtime client, local SSE adapter (plan §1 "Realtime"; contract docs/contracts.md §6).
 *
 *   const rt = getRealtimeClient(publicConfig.realtime);  // one per tab (globalThis singleton)
 *   const off = rt.subscribe('fleet', (evt) => {
 *     if (evt.event === 'tick') draw(evt.payload.machines);
 *   }, { onResync: () => refetch('/api/fleet') });
 *
 * - ONE shared EventSource per tab: `/api/realtime?topics=<union of subscribed topics>`. A new
 *   topic reconnects with the larger union (batched per microtask); unsubscribing never
 *   reconnects; the connection closes a few seconds after the last subscriber leaves.
 * - `onResync` fires after every (re)connect (the server's `ready` event), when a subscriber
 *   joins an already-open connection, on a `seq` gap (or a seq that goes backwards: the
 *   database was reset), on a server `resync` event (its LISTEN reconnected) and on
 *   `invalidate` (which is still passed to `onEvent` first).
 * - Reconnects with exponential backoff and jitter (1 s .. 30 s) after any error, and a watchdog
 *   reconnects when nothing (not even the 15 s ping) arrived for 45 s (half-open sockets on
 *   phones). Coming back online retries at once.
 *
 * No `window` or env access at import time, so any module may import it.
 */
import type { PublicConfig } from '../../config';
import type { RealtimeClient, SubscribeOptions, Topic, TopicMessage } from './types';

/** NEXT_PUBLIC_REALTIME: which adapter the browser uses (server components pass it down). */
export type RealtimeKind = PublicConfig['realtime'];

/** The part of EventSource this client uses (lets tests and Node inject an implementation). */
export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (ev: { data?: unknown }) => void): void;
  close(): void;
}
export type EventSourceFactory = (url: string) => EventSourceLike;

export type ConnectionState = 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'closed';

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SseClientOptions {
  /** Default '/api/realtime'. */
  url?: string;
  /** Default: the browser's EventSource. */
  createEventSource?: EventSourceFactory;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Reconnect when nothing arrives for this long (the server pings every 15 s). */
  watchdogMs?: number;
  /** Keep the connection this long after the last unsubscribe (React StrictMode, navigation). */
  idleCloseMs?: number;
  timers?: Timers;
  random?: () => number;
  /** Report subscriber exceptions (default console.error). */
  onError?: (err: unknown) => void;
}

export interface SseRealtimeClient extends RealtimeClient {
  readonly state: ConnectionState;
  /** Topics of the current connection. */
  readonly topics: readonly string[];
  /** Observe connection state (diagnostics pages). Returns unsubscribe. */
  onStateChange(listener: (state: ConnectionState) => void): () => void;
  /** Retry now if waiting in backoff (e.g. the browser came back online). */
  retryNow(): void;
  /** Close for good. */
  close(): void;
}

interface Sub {
  topic: string;
  onEvent(evt: unknown): void;
  onResync(): void;
  live: boolean;
}

interface WireMessage {
  topic: string;
  event: string;
  payload: Record<string, unknown>;
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>),
};

function parseWire(data: unknown): WireMessage | null {
  if (typeof data !== 'string') return null;
  try {
    const m = JSON.parse(data) as Partial<WireMessage>;
    if (typeof m.topic !== 'string' || typeof m.event !== 'string') return null;
    if (!m.payload || typeof m.payload !== 'object' || Array.isArray(m.payload)) return null;
    return m as WireMessage;
  } catch {
    return null;
  }
}

type TimerKey = 'reconnectTimer' | 'watchdogTimer' | 'idleTimer';

class SseClient implements SseRealtimeClient {
  private readonly url: string;
  private readonly factory: EventSourceFactory;
  private readonly minBackoff: number;
  private readonly maxBackoff: number;
  private readonly watchdogMs: number;
  private readonly idleCloseMs: number;
  private readonly timers: Timers;
  private readonly random: () => number;
  private readonly reportError: (err: unknown) => void;

  private readonly subs = new Set<Sub>();
  private readonly lastSeq = new Map<string, number>();
  private readonly stateListeners = new Set<(s: ConnectionState) => void>();
  private es: EventSourceLike | null = null;
  private connected: string[] = [];
  private stateValue: ConnectionState = 'idle';
  private attempt = 0;
  private everReady = false;
  private syncQueued = false;
  private reconnectTimer: unknown = null;
  private watchdogTimer: unknown = null;
  private idleTimer: unknown = null;

  constructor(opts: SseClientOptions) {
    this.url = opts.url ?? '/api/realtime';
    const factory =
      opts.createEventSource ??
      (typeof EventSource === 'function'
        ? (url: string) => new EventSource(url) as unknown as EventSourceLike
        : null);
    if (!factory) throw new Error('EventSource is not available here');
    this.factory = factory;
    this.minBackoff = opts.minBackoffMs ?? 1_000;
    this.maxBackoff = opts.maxBackoffMs ?? 30_000;
    this.watchdogMs = opts.watchdogMs ?? 45_000;
    this.idleCloseMs = opts.idleCloseMs ?? 5_000;
    this.timers = opts.timers ?? defaultTimers;
    this.random = opts.random ?? Math.random;
    this.reportError = opts.onError ?? ((e) => console.error('[realtime] subscriber failed:', e));
  }

  get state(): ConnectionState {
    return this.stateValue;
  }

  get topics(): readonly string[] {
    return this.connected;
  }

  subscribe<T extends Topic>(
    topic: T,
    onEvent: (evt: TopicMessage<T>) => void,
    opts: SubscribeOptions,
  ): () => void {
    if (this.stateValue === 'closed') throw new Error('realtime client is closed');
    const sub: Sub = {
      topic,
      onEvent: onEvent as (evt: unknown) => void,
      onResync: () => opts.onResync(),
      live: true,
    };
    this.subs.add(sub);
    this.clearTimer('idleTimer');
    if (this.es && this.connected.includes(topic)) {
      // Joining a live connection: load the snapshot now. (While it is still connecting, the
      // coming `ready` resyncs everyone.)
      if (this.stateValue === 'ready') queueMicrotask(() => sub.live && this.call(sub.onResync));
    } else {
      this.queueSync();
    }
    return () => {
      if (!sub.live) return;
      sub.live = false;
      this.subs.delete(sub);
      if (this.subs.size === 0) this.scheduleIdleClose();
    };
  }

  onStateChange(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  retryNow(): void {
    if (this.stateValue !== 'reconnecting' || this.reconnectTimer === null) return;
    this.clearTimer('reconnectTimer');
    this.attempt = 0;
    this.openWanted();
  }

  close(): void {
    this.teardown();
    this.clearTimer('reconnectTimer');
    this.clearTimer('idleTimer');
    for (const s of this.subs) s.live = false;
    this.subs.clear();
    this.setState('closed');
  }

  // -------------------------------------------------------------------------------------------

  private wanted(): string[] {
    return [...new Set([...this.subs].map((s) => s.topic))].sort();
  }

  private queueSync(): void {
    if (this.syncQueued) return;
    this.syncQueued = true;
    queueMicrotask(() => {
      this.syncQueued = false;
      if (this.stateValue === 'closed') return;
      const wanted = this.wanted();
      if (!wanted.length) return;
      if (this.es && wanted.every((t) => this.connected.includes(t))) return;
      // Waiting in backoff: the pending retry opens with the new topic set.
      if (this.reconnectTimer !== null) return;
      this.open(wanted);
    });
  }

  private openWanted(): void {
    const wanted = this.wanted();
    if (wanted.length) this.open(wanted);
    else this.setState('idle');
  }

  private open(topics: string[]): void {
    this.teardown();
    this.connected = topics;
    this.setState(this.everReady ? 'reconnecting' : 'connecting');
    const es = this.factory(`${this.url}?topics=${encodeURIComponent(topics.join(','))}`);
    this.es = es;
    es.addEventListener('ready', () => this.onReady(es));
    es.addEventListener('message', (ev) => this.onData(es, ev.data));
    es.addEventListener('resync', () => this.onServerResync(es));
    es.addEventListener('ping', () => this.armWatchdog(es));
    es.addEventListener('error', () => this.onFailure(es));
    this.armWatchdog(es);
  }

  private teardown(): void {
    this.clearTimer('watchdogTimer');
    const es = this.es;
    this.es = null;
    this.connected = [];
    if (es) {
      try {
        es.close();
      } catch {
        // already closed
      }
    }
  }

  private onReady(es: EventSourceLike): void {
    if (es !== this.es) return;
    this.attempt = 0;
    this.everReady = true;
    this.lastSeq.clear();
    this.armWatchdog(es);
    this.setState('ready');
    this.resyncConnected();
  }

  private onData(es: EventSourceLike, data: unknown): void {
    if (es !== this.es) return;
    this.armWatchdog(es);
    const msg = parseWire(data);
    if (!msg) return;
    const { seq: rawSeq, ...payload } = msg.payload;
    const seq = typeof rawSeq === 'number' ? rawSeq : null;
    let resync = msg.event === 'invalidate';
    if (seq !== null) {
      const prev = this.lastSeq.get(msg.topic);
      if (prev !== undefined) {
        if (seq === prev) return; // duplicate
        // A skipped seq means a missed message; a smaller one means the counter was reset.
        if (seq !== prev + 1) resync = true;
      }
      this.lastSeq.set(msg.topic, seq);
    }
    const evt = { event: msg.event, payload, seq: seq ?? 0 };
    const targets = [...this.subs].filter((s) => s.live && s.topic === msg.topic);
    for (const sub of targets) this.call(() => sub.onEvent(evt));
    if (resync) for (const sub of targets) if (sub.live) this.call(sub.onResync);
  }

  private onServerResync(es: EventSourceLike): void {
    if (es !== this.es) return;
    this.armWatchdog(es);
    this.lastSeq.clear();
    this.resyncConnected();
  }

  private resyncConnected(): void {
    for (const sub of [...this.subs]) {
      if (sub.live && this.connected.includes(sub.topic)) this.call(sub.onResync);
    }
  }

  private onFailure(es: EventSourceLike): void {
    if (es !== this.es) return;
    // Take over from EventSource's own fixed-interval retry: close it and back off.
    this.teardown();
    if (!this.subs.size) {
      this.setState('idle');
      return;
    }
    this.setState('reconnecting');
    const base = Math.min(this.maxBackoff, this.minBackoff * 2 ** this.attempt);
    const delay = Math.round(base * (0.5 + this.random() * 0.5));
    this.attempt++;
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      this.openWanted();
    }, delay);
  }

  private armWatchdog(es: EventSourceLike): void {
    this.clearTimer('watchdogTimer');
    this.watchdogTimer = this.timers.setTimeout(() => {
      this.watchdogTimer = null;
      this.onFailure(es);
    }, this.watchdogMs);
  }

  private scheduleIdleClose(): void {
    this.clearTimer('idleTimer');
    this.idleTimer = this.timers.setTimeout(() => {
      this.idleTimer = null;
      if (this.subs.size) return;
      this.teardown();
      this.clearTimer('reconnectTimer');
      this.attempt = 0;
      this.lastSeq.clear();
      this.setState('idle');
    }, this.idleCloseMs);
  }

  private clearTimer(key: TimerKey): void {
    const h = this[key];
    if (h !== null) this.timers.clearTimeout(h);
    this[key] = null;
  }

  private setState(s: ConnectionState): void {
    if (s === this.stateValue) return;
    this.stateValue = s;
    for (const l of [...this.stateListeners]) this.call(() => l(s));
  }

  private call(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.reportError(e);
    }
  }
}

/** A client with explicit dependencies (tests, Node). Browsers use getRealtimeClient(). */
export function createSseRealtimeClient(opts: SseClientOptions = {}): SseRealtimeClient {
  return new SseClient(opts);
}

/** Where EventSource doesn't exist (server render): no live updates, one snapshot load. */
const inertClient: RealtimeClient = {
  subscribe(_topic, _onEvent, opts) {
    let live = true;
    queueMicrotask(() => {
      if (live) opts.onResync();
    });
    return () => {
      live = false;
    };
  },
};

const CLIENT_KEY = Symbol.for('farm-manager.realtime.client.v1');
type ClientGlobal = typeof globalThis & { [CLIENT_KEY]?: SseRealtimeClient };

function sharedClient(): SseRealtimeClient | null {
  if (typeof EventSource !== 'function') return null;
  const g = globalThis as ClientGlobal;
  let client = g[CLIENT_KEY];
  if (!client || client.state === 'closed') {
    const created = createSseRealtimeClient();
    client = created;
    g[CLIENT_KEY] = created;
    if (typeof window !== 'undefined') window.addEventListener('online', () => created.retryNow());
  }
  return client;
}

let warnedSupabase = false;

/**
 * The tab's realtime client for adapter `kind` (NEXT_PUBLIC_REALTIME, from publicConfig):
 * 'sse' = one shared EventSource (globalThis singleton, survives HMR). The Supabase Broadcast
 * adapter arrives at MD; until then 'supabase' gets the inert client (one onResync, no live
 * events), so callers fall back to polling their snapshot.
 */
export function getRealtimeClient(kind: RealtimeKind = 'sse'): RealtimeClient {
  if (kind === 'supabase') {
    if (!warnedSupabase) {
      warnedSupabase = true;
      console.warn(
        '[realtime] NEXT_PUBLIC_REALTIME=supabase: the Supabase adapter is not built yet (MD); no live updates',
      );
    }
    return inertClient;
  }
  return sharedClient() ?? inertClient;
}

/** The same shared client with its diagnostics (state, topics); null outside the browser. */
export function getSseRealtimeClient(): SseRealtimeClient | null {
  return sharedClient();
}
