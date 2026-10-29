/**
 * The local realtime hub (server only): ONE dedicated `pg.Client` (farm_app, not from the pool)
 * that runs `LISTEN app_events` and fans each notification out to the SSE subscribers of its
 * topic. Plan §1 "Realtime": app.publish() -> pg_notify -> one LISTEN connection -> /api/realtime.
 *
 *  - `getRealtimeHub()` is a globalThis singleton, so `next dev` hot reloads never open a second
 *    LISTEN connection.
 *  - The connection is opened lazily by the first subscriber and kept open.
 *  - When it drops (database restart, terminated backend, network blip) the hub reconnects with
 *    exponential backoff. Notifications sent while it was down are lost (NOTIFY has no replay),
 *    so after every reconnect each subscriber gets `onResync('reconnected')` and the browser
 *    refetches its snapshot.
 *  - A liveness ping (`select 1`) detects a silently dead connection.
 *
 * Notifications are parsed once here (to route them by topic) and forwarded as the raw NOTIFY
 * text, which is already the JSON `{"topic": …, "event": …, "payload": {…, "seq": n}}`.
 */
import pg from 'pg';
import { getConfig } from '../../config';
import { LOCAL_NOTIFY_CHANNEL } from './types';

/** One notification, routed by topic. `raw` is the exact NOTIFY payload (JSON text). */
export interface HubMessage {
  topic: string;
  event: string;
  seq: number | null;
  raw: string;
}

export interface HubSubscriber {
  /** Topics this subscriber receives. */
  readonly topics: readonly string[];
  onMessage(msg: HubMessage): void;
  /** Messages may have been missed (the LISTEN connection was re-established). */
  onResync(reason: string): void;
}

export type HubState = 'idle' | 'connecting' | 'listening' | 'reconnecting' | 'closed';

export interface HubLog {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface RealtimeHubOptions {
  /** farm_app URL (DATABASE_URL). */
  connectionString: string;
  applicationName?: string;
  /** First reconnect delay; doubles per failed attempt up to maxBackoffMs. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Liveness check interval (`select 1`); 0 disables. */
  pingIntervalMs?: number;
  /** A ping slower than this counts as a dead connection. */
  pingTimeoutMs?: number;
  log?: HubLog;
}

export interface HubStats {
  state: HubState;
  subscribers: number;
  topics: Record<string, number>;
  /** Successful LISTENs so far (1 after the first connect; more after reconnects). */
  connects: number;
  delivered: number;
  lastError: string | null;
}

const defaultLog: HubLog = {
  info: (m) => console.log(`[realtime] ${m}`),
  warn: (m) => console.warn(`[realtime] ${m}`),
  error: (m) => console.error(`[realtime] ${m}`),
};

/** Parse a NOTIFY payload into a routable message; null when it isn't one of ours. */
export function parseNotifyPayload(raw: string): HubMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { topic, event, payload } = parsed as Record<string, unknown>;
  if (typeof topic !== 'string' || typeof event !== 'string') return null;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const seq = (payload as Record<string, unknown>).seq;
  return { topic, event, seq: typeof seq === 'number' ? seq : null, raw };
}

export class RealtimeHub {
  private readonly opts: Required<Omit<RealtimeHubOptions, 'log'>> & { log: HubLog };
  private client: pg.Client | null = null;
  private stateValue: HubState = 'idle';
  private readonly byTopic = new Map<string, Set<HubSubscriber>>();
  private readonly subscribers = new Set<HubSubscriber>();
  private attempt = 0;
  private connects = 0;
  private delivered = 0;
  private lastError: string | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private waiters: { resolve(): void; reject(e: Error): void }[] = [];

  constructor(options: RealtimeHubOptions) {
    this.opts = {
      applicationName: 'farm-realtime',
      minBackoffMs: 500,
      maxBackoffMs: 15_000,
      pingIntervalMs: 30_000,
      pingTimeoutMs: 10_000,
      log: defaultLog,
      ...options,
    };
  }

  get state(): HubState {
    return this.stateValue;
  }

  stats(): HubStats {
    const topics: Record<string, number> = {};
    for (const [t, set] of this.byTopic) topics[t] = set.size;
    return {
      state: this.stateValue,
      subscribers: this.subscribers.size,
      topics,
      connects: this.connects,
      delivered: this.delivered,
      lastError: this.lastError,
    };
  }

  /** Register a subscriber (opens the LISTEN connection if needed). Returns unsubscribe. */
  subscribe(sub: HubSubscriber): () => void {
    if (this.stateValue === 'closed') throw new Error('realtime hub is closed');
    this.subscribers.add(sub);
    for (const topic of sub.topics) {
      let set = this.byTopic.get(topic);
      if (!set) {
        set = new Set();
        this.byTopic.set(topic, set);
      }
      set.add(sub);
    }
    this.start();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.subscribers.delete(sub);
      for (const topic of sub.topics) {
        const set = this.byTopic.get(topic);
        set?.delete(sub);
        if (set && set.size === 0) this.byTopic.delete(topic);
      }
    };
  }

  /** Resolve once LISTEN is active (opens the connection if idle); reject after timeoutMs. */
  ready(timeoutMs = 5_000): Promise<void> {
    if (this.stateValue === 'listening') return Promise.resolve();
    if (this.stateValue === 'closed') return Promise.reject(new Error('realtime hub is closed'));
    this.start();
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(
          new Error(
            `realtime LISTEN not ready after ${timeoutMs} ms${this.lastError ? `: ${this.lastError}` : ''}`,
          ),
        );
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** Close the connection for good (tests, shutdown). */
  async close(): Promise<void> {
    this.stateValue = 'closed';
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopPing();
    const c = this.client;
    this.client = null;
    for (const w of this.waiters.splice(0)) w.reject(new Error('realtime hub is closed'));
    if (c) await c.end().catch(() => {});
  }

  /**
   * Drop the LISTEN connection as if the database had (diagnostics and tests): the hub
   * reconnects and every subscriber gets `onResync('reconnected')`. False when not connected.
   */
  reconnect(reason = 'dropped on request'): boolean {
    const c = this.client;
    if (!c) return false;
    this.lost(c, new Error(reason));
    return true;
  }

  // -------------------------------------------------------------------------------------------

  private start(): void {
    if (this.stateValue === 'idle') void this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stateValue === 'closed') return;
    this.stateValue = this.connects > 0 ? 'reconnecting' : 'connecting';
    const client = new pg.Client({
      connectionString: this.opts.connectionString,
      application_name: this.opts.applicationName,
      keepAlive: true,
      connectionTimeoutMillis: 10_000,
    });
    client.on('notification', (n) => {
      if (client === this.client) this.dispatch(n);
    });
    client.on('error', (err) => this.lost(client, err));
    client.on('end', () => this.lost(client, new Error('connection ended')));
    try {
      await client.connect();
      await client.query(`listen ${pg.escapeIdentifier(LOCAL_NOTIFY_CHANNEL)}`);
    } catch (e) {
      client.removeAllListeners('end');
      client.on('error', () => {});
      await client.end().catch(() => {});
      this.lastError = (e as Error).message;
      this.scheduleReconnect();
      return;
    }
    // close() may have run while we were connecting.
    if (this.state === 'closed') {
      await client.end().catch(() => {});
      return;
    }
    const wasReconnect = this.connects > 0;
    this.client = client;
    this.connects++;
    this.attempt = 0;
    this.stateValue = 'listening';
    if (wasReconnect) this.opts.log.info(`LISTEN ${LOCAL_NOTIFY_CHANNEL} re-established`);
    for (const w of this.waiters.splice(0)) w.resolve();
    this.startPing(client);
    if (wasReconnect) {
      for (const sub of [...this.subscribers]) this.safe(() => sub.onResync('reconnected'));
    }
  }

  private lost(client: pg.Client, err: Error): void {
    if (client !== this.client || this.stateValue === 'closed') return;
    this.client = null;
    this.stopPing();
    this.lastError = err.message;
    this.opts.log.warn(`LISTEN connection lost (${err.message}); reconnecting`);
    client.removeAllListeners('end');
    client.on('error', () => {});
    client.end().catch(() => {});
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stateValue === 'closed' || this.reconnectTimer) return;
    this.stateValue = 'reconnecting';
    const delay = Math.min(this.opts.maxBackoffMs, this.opts.minBackoffMs * 2 ** this.attempt);
    this.attempt++;
    if (this.attempt === 4) {
      this.opts.log.error(
        `cannot LISTEN on the database (${this.lastError ?? 'unknown error'}); still retrying`,
      );
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private startPing(client: pg.Client): void {
    this.stopPing();
    if (!this.opts.pingIntervalMs) return;
    this.pingTimer = setInterval(() => {
      const timeout = setTimeout(
        () => this.lost(client, new Error('liveness ping timed out')),
        this.opts.pingTimeoutMs,
      );
      client
        .query('select 1')
        .then(() => clearTimeout(timeout))
        .catch((e: Error) => {
          clearTimeout(timeout);
          this.lost(client, e);
        });
    }, this.opts.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private dispatch(n: pg.Notification): void {
    if (n.channel !== LOCAL_NOTIFY_CHANNEL || !n.payload) return;
    const msg = parseNotifyPayload(n.payload);
    if (!msg) {
      this.opts.log.warn(`ignored a malformed ${LOCAL_NOTIFY_CHANNEL} notification`);
      return;
    }
    const set = this.byTopic.get(msg.topic);
    if (!set) return;
    for (const sub of [...set]) {
      this.delivered++;
      this.safe(() => sub.onMessage(msg));
    }
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.opts.log.error(`subscriber failed: ${(e as Error).message}`);
    }
  }
}

const HUB_KEY = Symbol.for('farm-manager.realtime.hub.v1');
type HubGlobal = typeof globalThis & { [HUB_KEY]?: RealtimeHub };

/** The process-wide hub over DATABASE_URL (globalThis singleton: survives `next dev` HMR). */
export function getRealtimeHub(): RealtimeHub {
  const g = globalThis as HubGlobal;
  let hub = g[HUB_KEY];
  if (!hub || hub.state === 'closed') {
    hub = new RealtimeHub({ connectionString: getConfig().DATABASE_URL });
    g[HUB_KEY] = hub;
  }
  return hub;
}
