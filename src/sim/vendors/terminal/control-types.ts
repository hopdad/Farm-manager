/**
 * The Terminal stand-in's control API (slice 1f.2, terminal-pickups; docs/contracts-1f.md §B.7),
 * served at `${VENDOR_SIM_URL}/_control/vendor/terminal/…` behind the stand-in's
 * loopback/Origin/JSON guard:
 *
 *   GET  /_control/vendor/terminal/fault-codes   -> TerminalSimStatus
 *   POST /_control/vendor/terminal/fault-codes   TerminalSimFaultRequest -> TerminalSimStatus
 *        { action: 'open', vehicleId?, kind?, status? }   a fault code event (status open, or
 *                                                        pending) observed now on a Terminal
 *                                                        vehicle (H3 when left out); kinds:
 *                                                        j1939 (SPN 110 FMI 0, red stop lamp
 *                                                        unknown: MIL on), obdii (P0217),
 *                                                        j1939_no_fmi (an SPN alone: the client
 *                                                        skips it), j1939_bad_address (source
 *                                                        address 256, the spec's own example)
 *        { action: 'close', code }                       a `closed` event for that code now
 *        { action: 'clear' }                             no fault events at all
 *   POST /_control/vendor/terminal/sync          { stalled: boolean }   Terminal's own sync
 *        stops (history, stat logs and fault events stop growing; latest locations, a live call
 *        to the provider, keep coming) or catches up (everything stored since, at once)
 *   POST /_control/vendor/terminal/connections   { connectionId?, status }   a hauler's
 *        connection disconnected (its data calls answer 422 connection_disconnected) or back
 *   POST /_control/vendor/terminal/rate-limit    { count, retryAfter? }   the next `count`
 *        data calls answer 429 with `Retry-After: <retryAfter>` (default "0.62", fractional as
 *        in Terminal's docs)
 *
 * Kept in the stand-in's state file (`state.vendors.terminal`); cleared by /_control/reset.
 * Types and zod only (no server code), like the NWS and Motive stand-ins' control types.
 */
import { z } from 'zod';
import { SIM_TERMINAL_CONNECTION_ID } from '../../types';

export const TERMINAL_SIM_FAULT_CODES_PATH = '/_control/vendor/terminal/fault-codes';
export const TERMINAL_SIM_SYNC_PATH = '/_control/vendor/terminal/sync';
export const TERMINAL_SIM_CONNECTIONS_PATH = '/_control/vendor/terminal/connections';
export const TERMINAL_SIM_RATE_LIMIT_PATH = '/_control/vendor/terminal/rate-limit';

/**
 * Wall seconds between the breadcrumbs the stand-in's hauler reports (the record-time grid of
 * history and of the latest location; no jitter). Omnitracs XRS samples every 60 s at Terminal;
 * the stand-in reports every 10 s so the M0 demo's 60 s threshold holds (§B.7: every 15 s or less).
 */
export const TERMINAL_SIM_REPORT_EVERY_SECONDS = 10;
/** Wall seconds between stat logs (engine runtime, odometer, engine state). */
export const TERMINAL_SIM_STATS_EVERY_SECONDS = 60;
/**
 * Terminal's own sync lag in the stand-in: a record is stored (listed by history, stats and fault
 * events, `metadata.modifiedAt`) this many seconds after its record time. Latest locations (a
 * live call to the provider) have none.
 */
export const TERMINAL_SIM_SYNC_LAG_SECONDS = 10;
/** How far back the stand-in keeps history and stat logs (Omnitracs XRS: 120 days at Terminal). */
export const TERMINAL_SIM_HISTORY_MS = 30 * 60_000;
/** The second, disconnected connection the stand-in lists (a hauler who left: no vehicles). */
export const SIM_TERMINAL_GONE_CONNECTION_ID = 'conn_01JSIMHAULER0000000000002';
export const SIM_TERMINAL_GONE_CONNECTION_TOKEN = 'sim-terminal-connection-gone';

export const TERMINAL_SIM_FAULT_KINDS = [
  'j1939',
  'obdii',
  'j1939_no_fmi',
  'j1939_bad_address',
] as const;
export type TerminalSimFaultKind = (typeof TERMINAL_SIM_FAULT_KINDS)[number];

const iso = z.iso.datetime({ offset: true });

/** One stored fault code event. */
export const terminalSimFaultEventSchema = z.object({
  /** `fc_evt_…` */
  id: z.string().min(1),
  vehicleId: z.string().min(1),
  kind: z.enum(TERMINAL_SIM_FAULT_KINDS),
  status: z.enum(['open', 'pending', 'closed']),
  /** Wall time it was observed. */
  observedAt: iso,
});
export type TerminalSimFaultEvent = z.infer<typeof terminalSimFaultEventSchema>;

/** `state.vendors.terminal`. */
export const terminalSimStateSchema = z.object({
  events: z.array(terminalSimFaultEventSchema),
  nextEvent: z.number().int().positive(),
  /** Terminal's sync stopped at this wall time (null: running). */
  stalledAt: iso.nullable(),
  /** ...and caught up at this one (everything stored in between lands at once). */
  resumedAt: iso.nullable(),
  /** Connection id → status override (`disconnected`). */
  connections: z.record(z.string(), z.enum(['connected', 'disconnected'])),
  rateLimit: z.object({ remaining: z.number().int().min(0), retryAfter: z.string() }),
});
export type TerminalSimState = z.infer<typeof terminalSimStateSchema>;

export const EMPTY_TERMINAL_SIM_STATE: TerminalSimState = Object.freeze({
  events: [],
  nextEvent: 1,
  stalledAt: null,
  resumedAt: null,
  connections: {},
  rateLimit: { remaining: 0, retryAfter: '0.62' },
}) as TerminalSimState;

export const terminalSimFaultRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('open'),
    vehicleId: z.string().min(1).optional(),
    kind: z.enum(TERMINAL_SIM_FAULT_KINDS).optional(),
    status: z.enum(['open', 'pending']).optional(),
  }),
  z.strictObject({ action: z.literal('close'), code: z.string().min(1) }),
  z.strictObject({ action: z.literal('clear') }),
]);
export type TerminalSimFaultRequest = z.infer<typeof terminalSimFaultRequestSchema>;

export const terminalSimSyncRequestSchema = z.strictObject({ stalled: z.boolean() });

export const terminalSimConnectionRequestSchema = z.strictObject({
  connectionId: z.string().min(1).default(SIM_TERMINAL_CONNECTION_ID),
  status: z.enum(['connected', 'disconnected']),
});

export const terminalSimRateLimitRequestSchema = z.strictObject({
  count: z.number().int().min(0).max(100),
  retryAfter: z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .optional(),
});

/** What every knob answers. */
export interface TerminalSimStatus {
  connections: { id: string; status: 'connected' | 'disconnected'; vehicles: string[] }[];
  vehicles: { id: string; unitNo: string; connectionId: string; provider: string }[];
  events: TerminalSimFaultEvent[];
  sync: { stalledAt: string | null; resumedAt: string | null };
  rateLimit: { remaining: number; retryAfter: string };
}

/** The fault code event's `code` per kind (what `close` names). */
export const TERMINAL_SIM_FAULT_CODE: Record<TerminalSimFaultKind, string> = {
  j1939: 'SPN110-FMI0',
  obdii: 'P0217',
  j1939_no_fmi: 'SPN3031',
  j1939_bad_address: 'SPN3031-FMI9',
};
