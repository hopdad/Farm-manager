/**
 * The vendor registry (slice 1f.2, docs/contracts-1f.md part B): every telematics vendor, OEM,
 * aggregator provider and data route the app knows, with a label and its capability matrix
 * (modelled on Terminal's `/providers`). Code, not a table: a new vendor needs no migration
 * (machine_state.position_vendor and machines.telematics_via take any id of the
 * POSITION_VENDOR_PATTERN format); an id the registry doesn't know is shown as is.
 *
 *  - `connection` entries are the connections with a mode key (CONNECTOR_SAMSARA, …): the
 *    /admin/connectors capability matrix lists one row per connection.
 *  - `provider` entries are the providers behind an aggregator route (`aemp_kubota`: Kubota's
 *    ISO 15143-3 feed through the generic AEMP client). position_vendor = `<route>_<provider>`.
 *  - `via` entries are how a vendor gets the data (`ford_pro`, `stellantis`: carmaker clouds;
 *    `gateway`: an asset gateway); they override what the route can report.
 *
 * Capability values: `yes` = confirmed from an SDK or a published spec; `doc` = vendor docs or a
 * search summary say so (doc-derived, confirm); `unknown` = no source either way; `no` =
 * documented as absent. A stat whose support isn't yes/doc shows as "not reported" when the
 * machine has no value (never 0): `statsNotReported`.
 *
 * Pure TS. Owned by the foundation (contract file); builders add entries through their report.
 */
import type { FaultSystem } from '../domain/fault-codes';
import { isPositionVendor } from '../domain/fleet';
import type { Mode, TelematicsSource, VehicleStatField } from './types';

/** What a vendor mainly serves. */
export const VENDOR_KINDS = ['truck', 'machine', 'pickup'] as const;
export type VendorKind = (typeof VENDOR_KINDS)[number];

export const SUPPORT_LEVELS = ['yes', 'doc', 'unknown', 'no'] as const;
export type Support = (typeof SUPPORT_LEVELS)[number];

/** One connection's (or provider's, or route's) capability matrix. */
export interface VendorCapabilities {
  positions: { live: Support; lastKnown: Support };
  stats: Record<VehicleStatField, Support>;
  faults: Record<FaultSystem, Support>;
  /** Field operations (seeding, application, harvest records). */
  fieldOperations: Support;
  /** Push notifications (all need a public HTTPS endpoint: MD; the app polls meanwhile). */
  webhooks: Support;
}

/** A `via` route overrides only what it changes. */
export interface CapabilityOverride {
  positions?: Partial<VendorCapabilities['positions']>;
  stats?: Partial<VendorCapabilities['stats']>;
  faults?: Partial<VendorCapabilities['faults']>;
}

/** The connections: one mode key each (src/config.ts), one row on /admin/connectors. */
export const CONNECTIONS = [
  'deere',
  'samsara',
  'motive',
  'geotab',
  'aemp',
  'cnh',
  'terminal',
] as const;
export type Connection = (typeof CONNECTIONS)[number];

/** The config key of each connection's mode. */
export const CONNECTION_MODE_KEYS = {
  deere: 'CONNECTOR_DEERE',
  samsara: 'CONNECTOR_SAMSARA',
  motive: 'CONNECTOR_MOTIVE',
  geotab: 'CONNECTOR_GEOTAB',
  aemp: 'CONNECTOR_AEMP',
  cnh: 'CONNECTOR_CNH',
  terminal: 'CONNECTOR_TERMINAL',
} as const satisfies Record<Connection, string>;
export type ConnectionModeKey = (typeof CONNECTION_MODE_KEYS)[Connection];
export type ConnectionModes = Record<ConnectionModeKey, Mode>;

/** Who builds a connection's client (the registry's honesty column on /admin/connectors). */
export const VENDOR_BUILD_STATES = ['built', 'planned', 'fallback'] as const;
export type VendorBuildState = (typeof VENDOR_BUILD_STATES)[number];

interface EntryBase {
  id: string;
  label: string;
  kind: VendorKind;
  /** built = the client exists; planned = a 1f.2 builder; fallback = only if needed, not built. */
  build: VendorBuildState;
  /** The public reference the capabilities were read from. */
  reference: string;
}
export interface ConnectionEntry extends EntryBase {
  role: 'connection';
  connection: Connection;
  capabilities: VendorCapabilities;
}
export interface ProviderEntry extends EntryBase {
  role: 'provider';
  /** The aggregator route (`aemp`, `terminal`) it comes through. */
  connection: Extract<Connection, 'aemp' | 'terminal'>;
  provider: string;
  capabilities: VendorCapabilities;
}
export interface ViaEntry extends EntryBase {
  role: 'via';
  /** Null = not tied to one connection (a carmaker cloud several vendors read). */
  connection: Connection | null;
  overrides: CapabilityOverride;
}
export type VendorEntry = ConnectionEntry | ProviderEntry | ViaEntry;

const stats = (
  engineHours: Support,
  odometerMi: Support,
  fuelPct: Support,
  defPct: Support,
  engineOn: Support,
): VendorCapabilities['stats'] => ({ engineHours, odometerMi, fuelPct, defPct, engineOn });
const faults = (j1939: Support, obd2: Support, oem: Support): VendorCapabilities['faults'] => ({
  j1939,
  obd2,
  oem,
});

export const VENDORS: readonly VendorEntry[] = [
  // ---- trucks ---------------------------------------------------------------------------------
  {
    id: 'samsara',
    role: 'connection',
    connection: 'samsara',
    label: 'Samsara',
    kind: 'truck',
    build: 'built',
    reference: '@samsarahq/samsara 14.11 (vehicle and equipment feeds, faultCodes stat type)',
    capabilities: {
      positions: { live: 'yes', lastKnown: 'no' },
      stats: stats('yes', 'yes', 'yes', 'yes', 'yes'),
      faults: faults('yes', 'yes', 'no'),
      fieldOperations: 'no',
      webhooks: 'yes',
    },
  },
  {
    id: 'motive',
    role: 'connection',
    connection: 'motive',
    label: 'Motive',
    kind: 'truck',
    // The 1a placeholder reads positions; the trucks builder adds stats and faults (1f.2).
    build: 'built',
    reference:
      'developer.gomotive.com (snippets): /v1|v2 vehicle_locations (v3 Vehicle Gateway only), true_engine_hours / true_odometer, /v1/fault_codes',
    capabilities: {
      positions: { live: 'doc', lastKnown: 'no' },
      stats: stats('doc', 'doc', 'unknown', 'unknown', 'unknown'),
      faults: faults('doc', 'doc', 'no'),
      fieldOperations: 'no',
      webhooks: 'doc',
    },
  },
  {
    id: 'geotab',
    role: 'connection',
    connection: 'geotab',
    label: 'Geotab',
    kind: 'truck',
    build: 'planned',
    reference:
      'mg-api-js 3.0.3 (JSON-RPC, GetFeed with toVersion); LogRecord / StatusData / FaultData (Geotab docs, snippets)',
    capabilities: {
      positions: { live: 'doc', lastKnown: 'no' },
      stats: stats('doc', 'doc', 'doc', 'unknown', 'doc'),
      faults: faults('doc', 'doc', 'no'),
      fieldOperations: 'no',
      webhooks: 'no',
    },
  },
  {
    id: 'terminal',
    role: 'connection',
    connection: 'terminal',
    label: 'Terminal',
    kind: 'truck',
    build: 'planned',
    reference:
      'terminal-cli (generated from Terminal OpenAPI): latest and historical vehicle locations, vehicle stats, fault code events, /providers; Connection-Token header',
    capabilities: {
      positions: { live: 'yes', lastKnown: 'yes' },
      stats: stats('doc', 'doc', 'doc', 'unknown', 'unknown'),
      faults: faults('yes', 'yes', 'no'),
      fieldOperations: 'no',
      webhooks: 'unknown',
    },
  },
  // ---- machines -------------------------------------------------------------------------------
  {
    id: 'deere',
    role: 'connection',
    connection: 'deere',
    label: 'John Deere',
    kind: 'machine',
    build: 'built',
    reference:
      'Deere OpenAPI (machine-locations, engineHours, machine-alerts, field-operations; ProductOfAmerica/deere-sdk specs/raw)',
    capabilities: {
      positions: { live: 'yes', lastKnown: 'no' },
      stats: stats('yes', 'no', 'yes', 'unknown', 'unknown'),
      faults: faults('unknown', 'no', 'yes'),
      fieldOperations: 'yes',
      webhooks: 'yes',
    },
  },
  {
    id: 'cnh',
    role: 'connection',
    connection: 'cnh',
    label: 'CNH FieldOps',
    kind: 'machine',
    build: 'planned',
    reference:
      'develop.cnh.com (snippets): vehicle telemetry "based upon" ISO 15143-3, Caution Codes / Fault Codes, Farm Setup / Operations; Locations unconfirmed (sources conflict)',
    capabilities: {
      positions: { live: 'unknown', lastKnown: 'doc' },
      stats: stats('doc', 'unknown', 'doc', 'doc', 'unknown'),
      faults: faults('unknown', 'no', 'doc'),
      fieldOperations: 'doc',
      webhooks: 'doc',
    },
  },
  {
    id: 'aemp',
    role: 'connection',
    connection: 'aemp',
    label: 'AEMP (ISO 15143-3)',
    kind: 'machine',
    build: 'planned',
    reference:
      'ISO 15143-3 / AEMP 2.0: Deere aemp.yaml, Trackunit aemp-iso-api.json, Samsara /beta/aemp/Fleet/{pageNumber}; each provider sends a subset; faults are a separate time series',
    capabilities: {
      positions: { live: 'no', lastKnown: 'yes' },
      stats: stats('yes', 'yes', 'yes', 'yes', 'yes'),
      faults: faults('unknown', 'no', 'unknown'),
      fieldOperations: 'no',
      webhooks: 'no',
    },
  },
  {
    id: 'aemp_cnh',
    role: 'provider',
    connection: 'aemp',
    provider: 'cnh',
    label: 'CNH (AEMP)',
    kind: 'machine',
    build: 'planned',
    reference:
      'CNH telemetry "based upon" ISO 15143-3 (snippet); the demo serves Case IH here until CNH FieldOps shapes are confirmed',
    capabilities: {
      positions: { live: 'no', lastKnown: 'doc' },
      stats: stats('doc', 'unknown', 'doc', 'doc', 'unknown'),
      faults: faults('unknown', 'no', 'unknown'),
      fieldOperations: 'no',
      webhooks: 'no',
    },
  },
  {
    id: 'aemp_kubota',
    role: 'provider',
    connection: 'aemp',
    provider: 'kubota',
    label: 'Kubota (AEMP)',
    kind: 'machine',
    build: 'planned',
    reference:
      'KubotaNOW AEMP 2.0 with dealer credentials (Geotab Kubota guide and data set; KUBOTA_NOW in @trackunit/rest-apis-iso-feeds)',
    capabilities: {
      positions: { live: 'no', lastKnown: 'doc' },
      stats: stats('doc', 'unknown', 'doc', 'unknown', 'unknown'),
      faults: faults('unknown', 'no', 'unknown'),
      fieldOperations: 'no',
      webhooks: 'no',
    },
  },
  {
    id: 'aemp_samsara',
    role: 'provider',
    connection: 'aemp',
    provider: 'samsara',
    label: 'Samsara (AEMP)',
    kind: 'machine',
    build: 'planned',
    reference:
      '@samsarahq/samsara 14.11: GET /beta/aemp/Fleet/{pageNumber} ("Read AEMP" scope, 5 req/s)',
    capabilities: {
      positions: { live: 'no', lastKnown: 'yes' },
      stats: stats('yes', 'yes', 'yes', 'unknown', 'unknown'),
      faults: faults('unknown', 'no', 'no'),
      fieldOperations: 'no',
      webhooks: 'no',
    },
  },
  {
    id: 'gateway',
    role: 'via',
    connection: null,
    label: 'Asset gateway',
    kind: 'machine',
    build: 'built',
    reference:
      '@samsarahq/samsara 14.11: /fleet/equipment/locations|stats/feed (gps, fuelPercents, gatewayJ1939EngineSeconds; no equipment fault field)',
    overrides: {
      stats: { odometerMi: 'no', defPct: 'unknown', engineOn: 'unknown' },
      faults: { j1939: 'unknown', obd2: 'no' },
    },
  },
  // ---- pickups (carmaker clouds through the telematics vendor; decision D3 / 1f.2) -----------
  {
    id: 'ford_pro',
    role: 'via',
    connection: null,
    label: 'Ford Pro',
    kind: 'pickup',
    build: 'built',
    reference:
      'Samsara Ford integration (marketplace, blog: GPS, fuel, tire pressure, seatbelt, health and diagnostics); engine hours unconfirmed',
    overrides: {
      positions: { live: 'doc' },
      stats: {
        engineHours: 'unknown',
        odometerMi: 'unknown',
        fuelPct: 'doc',
        defPct: 'unknown',
        engineOn: 'unknown',
      },
      faults: { j1939: 'no', obd2: 'doc' },
    },
  },
  {
    id: 'stellantis',
    role: 'via',
    connection: null,
    label: 'Stellantis Mobilisights',
    kind: 'pickup',
    build: 'built',
    reference:
      'Samsara Stellantis (Free2move) integration: GPS, engine hours, fuel, tire pressure (Automotive Fleet); diagnostics unconfirmed',
    overrides: {
      positions: { live: 'doc' },
      stats: {
        engineHours: 'doc',
        odometerMi: 'unknown',
        fuelPct: 'doc',
        defPct: 'unknown',
        engineOn: 'unknown',
      },
      faults: { j1939: 'no', obd2: 'unknown' },
    },
  },
  {
    id: 'obd_device',
    role: 'via',
    connection: null,
    label: 'OBD-II gateway',
    kind: 'pickup',
    build: 'built',
    reference: 'Samsara VG34/VG54 datasheet: plug-in OBD-II vehicle gateway on the same API',
    overrides: { faults: { j1939: 'no' } },
  },
  {
    id: 'smartcar',
    role: 'via',
    connection: null,
    label: 'Smartcar',
    kind: 'pickup',
    build: 'fallback',
    reference:
      'smartcar.com (owner OAuth via FordPass / Uconnect): location, odometer, fuel; no engine hours; DTCs GM-only. Fallback only, not built',
    overrides: {
      stats: { engineHours: 'no', odometerMi: 'doc', fuelPct: 'doc', defPct: 'no', engineOn: 'no' },
      faults: { j1939: 'no', obd2: 'no', oem: 'no' },
    },
  },
];

const BY_ID = new Map(VENDORS.map((v) => [v.id, v]));

/** The registry entry for an id, or null. */
export function vendorEntry(id: string | null | undefined): VendorEntry | null {
  return id ? (BY_ID.get(id) ?? null) : null;
}

const titleCase = (s: string) =>
  s
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

/**
 * A display label for any vendor id (position_vendor, telematics_via): the registry's label; an
 * unknown aggregator provider `aemp_<x>` → "<X> (AEMP)", `terminal_<x>` → "<X> (via Terminal)";
 * anything else the raw id.
 */
export function vendorLabel(id: string): string {
  const e = vendorEntry(id);
  if (e) return e.label;
  if (isPositionVendor(id)) {
    if (id.startsWith('aemp_')) return `${titleCase(id.slice(5))} (AEMP)`;
    if (id.startsWith('terminal_')) return `${titleCase(id.slice(9))} (via Terminal)`;
  }
  return id;
}

/** The connection a position_vendor id comes through (`aemp_kubota` → aemp), or null. */
export function connectionOf(id: string | null | undefined): Connection | null {
  if (!id) return null;
  const e = vendorEntry(id);
  if (e && e.role !== 'via') return e.connection;
  if (id.startsWith('aemp_')) return 'aemp';
  if (id.startsWith('terminal_')) return 'terminal';
  return (CONNECTIONS as readonly string[]).includes(id) ? (id as Connection) : null;
}

/** The connection's own entry (always present for a Connection). */
export function connectionEntry(c: Connection): ConnectionEntry {
  const e = BY_ID.get(c);
  if (e?.role !== 'connection') throw new Error(`vendors: no connection entry for ${c}`);
  return e;
}

/**
 * What a machine's route can report: the vendor's matrix (a provider's own when the registry has
 * it, else its connection's), with its `via` overrides applied. Null for an unknown vendor id.
 */
export function capabilitiesFor(
  vendorId: string | null | undefined,
  via?: string | null,
): VendorCapabilities | null {
  const e = vendorEntry(vendorId);
  let base: VendorCapabilities | null = null;
  if (e && e.role !== 'via') base = e.capabilities;
  else {
    const c = connectionOf(vendorId);
    base = c ? connectionEntry(c).capabilities : null;
  }
  if (!base) return null;
  const v = vendorEntry(via);
  if (v?.role !== 'via') return base;
  return {
    ...base,
    positions: { ...base.positions, ...v.overrides.positions },
    stats: { ...base.stats, ...v.overrides.stats },
    faults: { ...base.faults, ...v.overrides.faults },
  };
}

/** A capability the route is known or documented to have. */
export const reports = (s: Support): boolean => s === 'yes' || s === 'doc';

/**
 * The stats a machine's route doesn't report (support unknown or no): the panel shows "not
 * reported" for them when the machine has no value, never 0. Unknown vendor = [] (show "—").
 */
export function statsNotReported(
  vendorId: string | null | undefined,
  via?: string | null,
): VehicleStatField[] {
  const caps = capabilitiesFor(vendorId, via);
  if (!caps) return [];
  return (Object.keys(caps.stats) as VehicleStatField[]).filter((f) => !reports(caps.stats[f]));
}

/** One row of the /admin/connectors capability matrix. */
export interface ConnectionRow {
  connection: Connection;
  label: string;
  kind: VendorKind;
  build: VendorBuildState;
  modeKey: ConnectionModeKey;
  mode: Mode;
  capabilities: VendorCapabilities;
  /** Provider entries behind an aggregator route (AEMP providers). */
  providers: ProviderEntry[];
  reference: string;
}

/** The capability matrix, one row per connection, in CONNECTIONS order. */
export function capabilityMatrix(modes: Pick<ConnectionModes, ConnectionModeKey>): ConnectionRow[] {
  return CONNECTIONS.map((c) => {
    const e = connectionEntry(c);
    const modeKey = CONNECTION_MODE_KEYS[c];
    return {
      connection: c,
      label: e.label,
      kind: e.kind,
      build: e.build,
      modeKey,
      mode: modes[modeKey],
      capabilities: e.capabilities,
      providers: VENDORS.filter(
        (v): v is ProviderEntry => v.role === 'provider' && v.connection === c,
      ),
      reference: e.reference,
    };
  });
}

/** Every connection's mode from a config: `{ deere, samsara, … }` (the fleet panel's `modes`). */
export function connectionModes(
  cfg: Pick<ConnectionModes, ConnectionModeKey>,
): Record<Connection, Mode> {
  return Object.fromEntries(CONNECTIONS.map((c) => [c, cfg[CONNECTION_MODE_KEYS[c]]])) as Record<
    Connection,
    Mode
  >;
}

/** The mode of a connection from a config (or any object with the mode keys). */
export function connectionMode(cfg: Pick<ConnectionModes, ConnectionModeKey>, c: Connection): Mode {
  return cfg[CONNECTION_MODE_KEYS[c]];
}

/** The telematics connection of a source, or null (deere is a connection, nws isn't). */
export function connectionOfSource(source: string): Connection | null {
  return (CONNECTIONS as readonly string[]).includes(source) ? (source as Connection) : null;
}

/** Type guard used by the jobs. */
export function isTelematicsSource(s: string): s is TelematicsSource {
  return ['samsara', 'motive', 'geotab', 'aemp', 'cnh', 'terminal'].includes(s);
}
