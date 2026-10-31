/**
 * The Deere stand-in's `ops` knobs (slice 1f, deere-ops; docs/contracts-1f.md §7.1), served at
 * `${VENDOR_SIM_URL}/_control/vendor/deere/ops…` behind the stand-in's loopback/Origin/JSON
 * guard:
 *
 *   GET  /_control/vendor/deere/ops              → DeereOpsKnobStatus
 *   POST /_control/vendor/deere/ops/full-day     { fieldKey: string | null } → DeereOpsKnobStatus
 *        emit (or stop) a full-day sprayer operation on that demo field (SimField.key): one
 *        application whose coverage is a day of passes at one polygon a second (plan §5's
 *        full-size payload, ~9 MB)
 *   POST /_control/vendor/deere/ops/refuse       { fieldKeys: string[] } → DeereOpsKnobStatus
 *        these fields' coverage calls answer 400 too (besides every SIM_OPS_REFUSED_EVERY-th
 *        field), as Deere does for a field with an active boundary
 *
 * Kept in the stand-in's state file; cleared by /_control/reset. Types and zod only (no server
 * code), so tests and tools can import it (the NWS control-types pattern).
 */
import { z } from 'zod';

/** Path of the knobs below VENDOR_SIM_URL. */
export const DEERE_OPS_CONTROL_PATH = '/_control/vendor/deere/ops';

export const deereOpsFullDayRequestSchema = z.strictObject({
  fieldKey: z.string().min(1).max(120).nullable(),
});
export type DeereOpsFullDayRequest = z.infer<typeof deereOpsFullDayRequestSchema>;

export const deereOpsRefuseRequestSchema = z.strictObject({
  fieldKeys: z.array(z.string().min(1).max(120)).max(200),
});
export type DeereOpsRefuseRequest = z.infer<typeof deereOpsRefuseRequestSchema>;

export interface DeereOpsKnobStatus {
  /** The field the full-day sprayer operation is on, and when it was asked for (wall ISO). */
  fullDay: { fieldKey: string; at: string } | null;
  /** Extra fields whose coverage calls answer 400. */
  refuse: string[];
}
