/**
 * The MyGeotab stand-in's control API (slice 1f.2, the trucks builder; docs/contracts-1f.md
 * §B.7), served at `${VENDOR_SIM_URL}/_control/vendor/geotab/…` behind the stand-in's
 * loopback/Origin/JSON guard:
 *
 *   GET  /_control/vendor/geotab/status     -> GeotabSimStatus (call counts, sessions, knobs)
 *   POST /_control/vendor/geotab/faults     GeotabSimFaultRequest -> GeotabSimStatus
 *        { action: 'raise', deviceId?, kind? }  a FaultData record (Active, lamps on) for a Geotab
 *                                               device (the first one when left out): a J1939
 *                                               SPN 110 FMI 0 with the red stop lamp, an OBD-II
 *                                               P0135 with the MIL, or a proprietary code
 *        { action: 'clear', id }                a later Inactive record of the same fault
 *        { action: 'reset' }                    no fault records at all
 *   POST /_control/vendor/geotab/server     GeotabSimServerRequest -> GeotabSimStatus
 *        { loginPath? }        what Authenticate's LoginResult.path says: "ThisServer" (default),
 *                              a host (`localhost:4010`: the same stand-in under another name),
 *                              or null (absent: the property is deprecated in api.json)
 *        { limitedScope? }     the service user is scoped to some groups: GetFeed on LogRecord
 *                              and StatusData throws (MyGeotab 11.119)
 *        { expireSessions? }   every session ends (a password change or a server restart)
 *
 * Kept in the stand-in's state file (`state.vendors.geotab`); cleared by /_control/reset.
 * Types and zod only (no server code), like the NWS stand-in's control types.
 */
import { z } from 'zod';

export const GEOTAB_SIM_STATUS_PATH = '/_control/vendor/geotab/status';
export const GEOTAB_SIM_FAULTS_PATH = '/_control/vendor/geotab/faults';
export const GEOTAB_SIM_SERVER_PATH = '/_control/vendor/geotab/server';

export const GEOTAB_SIM_FAULT_KINDS = ['j1939', 'obd2', 'oem'] as const;
export type GeotabSimFaultKind = (typeof GEOTAB_SIM_FAULT_KINDS)[number];

const iso = z.iso.datetime({ offset: true });

/** One FaultData record the stand-in serves (its feed version is `seq`). */
export const geotabSimFaultSchema = z.object({
  /** FaultData id. */
  id: z.string().min(1),
  /** The fault this record belongs to (a clear record names the raise record's id). */
  faultId: z.string().min(1),
  seq: z.number().int().positive(),
  deviceId: z.string().min(1),
  kind: z.enum(GEOTAB_SIM_FAULT_KINDS),
  state: z.enum(['Active', 'Inactive']),
  dateTime: iso,
});
export type GeotabSimFault = z.infer<typeof geotabSimFaultSchema>;

/** `state.vendors.geotab`. */
export const geotabSimStateSchema = z.object({
  /** sessionId → when it was issued (wall). */
  sessions: z.record(z.string(), iso),
  /** LoginResult.path: 'ThisServer', a host, or null (absent). */
  loginPath: z.string().nullable(),
  limitedScope: z.boolean(),
  faults: z.array(geotabSimFaultSchema),
  nextSeq: z.number().int().positive(),
});
export type GeotabSimState = z.infer<typeof geotabSimStateSchema>;

export const EMPTY_GEOTAB_SIM_STATE: GeotabSimState = Object.freeze({
  sessions: {},
  loginPath: 'ThisServer',
  limitedScope: false,
  faults: [],
  nextSeq: 1,
}) as GeotabSimState;

export const geotabSimFaultRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('raise'),
    deviceId: z.string().min(1).optional(),
    kind: z.enum(GEOTAB_SIM_FAULT_KINDS).optional(),
  }),
  z.strictObject({ action: z.literal('clear'), id: z.string().min(1) }),
  z.strictObject({ action: z.literal('reset') }),
]);
export type GeotabSimFaultRequest = z.infer<typeof geotabSimFaultRequestSchema>;

export const geotabSimServerRequestSchema = z.strictObject({
  loginPath: z
    .string()
    .regex(/^(ThisServer|[a-z0-9.-]+(:\d{1,5})?)$/i)
    .nullable()
    .optional(),
  limitedScope: z.boolean().optional(),
  expireSessions: z.literal(true).optional(),
});
export type GeotabSimServerRequest = z.infer<typeof geotabSimServerRequestSchema>;

/** What every knob answers (counts since the stand-in started or was reset). */
export interface GeotabSimStatus {
  devices: { id: string; unitNo: string }[];
  loginPath: string | null;
  limitedScope: boolean;
  sessions: number;
  calls: {
    authenticate: number;
    getFeed: Record<string, number>;
    get: Record<string, number>;
    overLimit: number;
    /** JSON-RPC requests by the Host they were sent to. */
    hosts: Record<string, number>;
  };
  faults: GeotabSimFault[];
}
