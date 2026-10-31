/**
 * fleet-faults' unconfirmed Samsara assumptions (slice 1f): the `faultCodes` stats type as the
 * faults stream reads it. Appended to the /admin/connectors list by src/connectors/doc-derived.ts
 * (whose own entry keeps the two open questions of the vendor docs pass: OBD-II per module and
 * when `oem` is filled).
 *
 * The field names and types are Samsara's own (OpenAPI 3.0.1 VehicleStatsFaultCodesWithDecoration,
 * the SDK, the Fault Monitoring guide: developers.samsara.com/docs/fault-monitoring), so most
 * entries are `spec`: only a recorded reading is missing. What the docs leave open is `doc`.
 */
import type { DocDerivedItem } from '../doc-derived';

const FILE = 'src/connectors/samsara/mapper.ts (mapSamsaraFaults)';

export const SAMSARA_DOC_DERIVED: readonly DocDerivedItem[] = [
  {
    source: 'samsara',
    what: 'GET /fleet/vehicles/stats/feed?types=faultCodes as its own call and cursor (the stat types fill the 3-types limit)',
    confirm:
      'how often a vehicle with unchanged codes reports a reading ("whenever a fault code is reported by the ECU and after each complete emissions monitor drive-cycle"); the stand-in reports a reading only when the set changes',
    file: 'src/connectors/samsara/client.ts (faultCodesFeed), src/sim/vendors/samsara/fault-codes.ts',
    basis: 'spec',
  },
  {
    source: 'samsara',
    what: 'faultCodes j1939: one reading = the complete active set; checkEngineLights apply to every code of the reading; txId = the source address',
    confirm:
      'that a truck reading always carries the j1939 block (a missing block is read as "no J1939 codes"); that the reading lamps (stop = red, warning = amber, protect, emissions) are the DM1 lamps of the codes listed; that txId is the J1939 source address (Samsara\'s example: txId 1, "Engine #2")',
    file: FILE,
    basis: 'spec',
  },
  {
    source: 'samsara',
    what: 'faultCodes obdii: codes per module (txId); a module the reading leaves out keeps its codes; the MIL from the module milStatus, else checkEngineLightIsOn',
    confirm:
      'whether one reading names every module (then per-module clearing changes nothing) or only those that reported; that a code listed as both confirmed and permanent is one fault (kept as confirmed)',
    file: `${FILE}, src/db/queries/machine-faults.ts (faultScope, machine_faults.module)`,
    basis: 'doc',
  },
  {
    source: 'samsara',
    what: 'faultCodes obdii dtcId → DTC when dtcShortCode is missing (SAE J2012 encoding: 135 → P0087)',
    confirm: "that dtcId is the J2012 two-byte number (Samsara's example pairs 135 with P0087)",
    file: `${FILE} (obdDtcFromId)`,
    basis: 'spec',
  },
  {
    source: 'samsara',
    what: 'faultCodes oem: part of the full snapshot (absent = no OEM codes); codeSeverity kept verbatim, severity by the OEM default (warning) unless it reads high/medium/low',
    confirm:
      "when oem is filled (OEM-integrated vehicles?) and whether it arrives in the same reading as the j1939/obdii blocks; what codeSeverity values ('L03') mean",
    file: FILE,
    basis: 'doc',
  },
];
