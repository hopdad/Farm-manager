/**
 * Terminal shapes (slice 1f.2, the terminal-pickups builder; docs/contracts-1f.md part B §B.1).
 * Confirmed from Terminal's official OpenAPI 3.1 (https://api.withterminal.com/tsp/openapi, the
 * same document as https://docs.withterminal.com/terminal.openapi.json) and docs.withterminal.com,
 * checked Oct 30, 2026; what the spec leaves open is in ./doc-derived.ts:
 *
 *   GET {base}/connections?status=connected        Authorization: Bearer <secret key> alone;
 *                                                  each FullConnection carries its own `token`
 *   GET {base}/connections/current                 + Connection-Token (a pinned token's row)
 *   GET {base}/providers                           a bare array; no key needed
 *   GET {base}/vehicles?expand=groups              + Connection-Token
 *   GET {base}/vehicles/locations?vehicleIds=      latest (a live call to the provider; ≤ 50 ids)
 *   GET {base}/vehicles/{id}/locations?startAt=    history (Terminal's own sync: it lags)
 *   GET {base}/vehicles/{id}/stats/historical?types=&startAt=
 *   GET {base}/fault-codes/events?modifiedAfter=&vehicleIds=
 *
 * Lists answer `{ results, next? }` ("rely on the presence of `next`, not the count"); errors
 * answer `{ code, message, detail? }`. Units are METRIC: odometer km, speed km/h, engine runtime
 * ms, fuel volume litres (percentages are 0-100).
 *
 * LENIENT (docs/contracts-1f.md §B.5): the envelopes are checked here, each item is parsed on its
 * own by the client (a bad item is dropped and logged with its id, never the page), objects keep
 * unknown keys, and everything the spec doesn't mark required is optional. Shared by the client,
 * the stand-in (src/sim/vendors/terminal) and the replay fixtures (./fixtures).
 */
import { z } from 'zod';

const iso = z.iso.datetime({ offset: true });
const text = z.string().nullish();
/** An `Expandable*` reference: the id, or the expanded object with its `id`. */
const expandable = z.union([z.string().min(1), z.looseObject({ id: z.string().min(1) })]);

/** The id of an Expandable reference (`vcl_…`, or the expanded object's `id`). */
export function expandedId(v: z.infer<typeof expandable>): string {
  return typeof v === 'string' ? v : v.id;
}

/** Every list reply: `{ results, next? }`; items are parsed one by one by the client. */
export const terminalListSchema = z.looseObject({
  results: z.array(z.unknown()),
  /** Pattern `^[A-Za-z0-9+/=_-]+$`; absent on the last page. */
  next: z.string().nullish(),
});
export type TerminalList = z.infer<typeof terminalListSchema>;

/** Terminal's flat error body (its `components.responses`). */
export const terminalErrorSchema = z.looseObject({
  code: z.string(),
  message: z.string(),
  detail: z.unknown().optional(),
  /** 429 only: whole seconds (the Retry-After header may be fractional). */
  retryAfter: z.number().optional(),
});

// ---- connections ------------------------------------------------------------------------------

export const TERMINAL_CONNECTION_STATUSES = [
  'connected',
  'disconnected',
  'archived',
  'pending_deletion',
] as const;

/** FullConnection (the fields we use; `token` is required by the spec). */
export const terminalConnectionSchema = z.looseObject({
  /** `conn_…` (a ULID): the external_refs source_org of the hauler's vehicles. */
  id: z.string().min(1),
  provider: z.looseObject({ code: z.string().min(1), name: z.string().nullish() }),
  company: z.looseObject({ name: text, dotNumbers: z.array(z.string()).nullish() }).nullish(),
  /** `con_tkn_…`: the Connection-Token header for this hauler's data. */
  token: z.string().min(1),
  status: z.string().nullish(),
  externalId: text,
  syncMode: text,
  createdAt: iso.nullish(),
  updatedAt: iso.nullish(),
});
export type TerminalConnection = z.infer<typeof terminalConnectionSchema>;

/** GET /connections/current (FullConnection + lastSync, agreements); only what we read. */
export const terminalCurrentConnectionSchema = terminalConnectionSchema.extend({
  token: z.string().min(1).optional(),
});

// ---- providers --------------------------------------------------------------------------------

export const TERMINAL_SUPPORT_STATUSES = [
  'supported',
  'not_supported_by_terminal',
  'not_supported_by_provider',
] as const;

const modelSupport = z.looseObject({
  supportedOperations: z.looseObject({ read: z.string().nullish() }).nullish(),
});

/** One Provider of GET /providers (the capability matrix Terminal publishes per provider). */
export const terminalProviderSchema = z.looseObject({
  name: z.string().min(1),
  /** Kebab-case: `omnitracs-xrs`, `people-net`. */
  code: z.string().min(1),
  status: z.string().nullish(),
  supportedModels: z
    .looseObject({
      LatestVehicleLocation: modelSupport.nullish(),
      VehicleLocation: modelSupport.extend({ sampleRate: text, availableHistory: text }).nullish(),
      VehicleStatLog: modelSupport.extend({ types: z.array(z.string()).nullish() }).nullish(),
      FaultCodeEvent: modelSupport.nullish(),
      Vehicle: modelSupport.nullish(),
    })
    .nullish(),
});
export type TerminalProvider = z.infer<typeof terminalProviderSchema>;

/** GET /providers: a bare array (no pagination). Items are checked one by one. */
export const terminalProvidersSchema = z.array(z.unknown());

// ---- vehicles ---------------------------------------------------------------------------------

/** An ExpandedGroup (`expand=groups`): the provider's group, with its name. */
export const terminalGroupSchema = z.looseObject({
  id: z.string().min(1),
  name: text,
});

/** Vehicle (GET /vehicles). Terminal vehicles have NO tags: `groups` are the provider's groups. */
export const terminalVehicleSchema = z.looseObject({
  /** `vcl_…` */
  id: z.string().min(1),
  sourceId: text,
  provider: z.string().min(1),
  status: text,
  vin: text,
  name: text,
  make: text,
  model: text,
  year: z.number().int().nullish(),
  /** Group ids, or ExpandedGroup objects with `expand=groups`. */
  groups: z.array(z.union([z.string(), terminalGroupSchema])).nullish(),
});
export type TerminalVehicle = z.infer<typeof terminalVehicleSchema>;

// ---- locations --------------------------------------------------------------------------------

export const terminalCoordinatesSchema = z.looseObject({
  longitude: z.number().min(-180).max(180),
  latitude: z.number().min(-90).max(90),
});

/** BaseVehicleLocation: heading (degrees) and speed (km/h, 2 decimals) are optional. */
const baseLocation = z.looseObject({
  provider: z.string().min(1),
  vehicle: expandable,
  driver: expandable.nullish(),
  locatedAt: iso,
  location: terminalCoordinatesSchema,
  heading: z.number().nullish(),
  /** km/h. */
  speed: z.number().nullish(),
});

export const TERMINAL_ENGINE_STATES = ['on', 'off', 'idle'] as const;

/** LatestVehicleLocation (GET /vehicles/locations): the provider's real-time last fix. */
export const terminalLatestLocationSchema = baseLocation.extend({
  /** km. */
  odometer: z.number().nullish(),
  fuel: z
    .looseObject({
      primaryPercentage: z.number().nullish(),
      secondaryPercentage: z.number().nullish(),
    })
    .nullish(),
  engineState: z.string().nullish(),
  /** ms, "Total engine runtime duration". */
  engineRuntime: z.number().nullish(),
});
export type TerminalLatestLocation = z.infer<typeof terminalLatestLocationSchema>;

/** VehicleLocation (GET /vehicles/{id}/locations): one breadcrumb of Terminal's sync. */
export const terminalHistoricalLocationSchema = baseLocation.extend({
  /** `vcl_loc_…`: the idempotency key. */
  id: z.string().min(1),
  sourceId: text,
  /** When Terminal stored it (NOT the provider's time): the client's watermark. */
  metadata: z.looseObject({ modifiedAt: iso }),
});
export type TerminalHistoricalLocation = z.infer<typeof terminalHistoricalLocationSchema>;

// ---- stats ------------------------------------------------------------------------------------

/** The VehicleStatLog types the app reads (the enum has twelve). */
export const TERMINAL_STAT_TYPES = [
  'odometer',
  'engine_runtime',
  'fuel_level',
  'engine_state',
] as const;
export type TerminalStatType = (typeof TERMINAL_STAT_TYPES)[number];

/**
 * VehicleStatLog (GET /vehicles/{id}/stats/historical): one value field chosen by `type`:
 * engine_state → `state`, odometer → `odometer` (km), engine_runtime → `duration` (ms; the
 * spec's own example is 1234.5, so read a number), fuel_level → `fuelPercentage`.
 */
export const terminalStatLogSchema = z.looseObject({
  /** `vcl_st_…` */
  id: z.string().min(1),
  sourceId: text,
  provider: z.string().min(1),
  type: z.string().min(1),
  timestamp: iso,
  vehicle: expandable,
  metadata: z.looseObject({ modifiedAt: iso }),
  state: z.string().nullish(),
  odometer: z.number().nullish(),
  duration: z.number().nullish(),
  fuelPercentage: z.number().nullish(),
});
export type TerminalStatLog = z.infer<typeof terminalStatLogSchema>;

// ---- fault code events ------------------------------------------------------------------------

export const TERMINAL_FAULT_STATUSES = ['open', 'pending', 'closed'] as const;

/**
 * FaultCodeEvent (GET /fault-codes/events): `protocol` j1939 (with `j1939`, where only `spn` is
 * required: `fmi` may be missing, and the spec's own example has `sourceAddress` 256) or obdii
 * (with `obdii`). No lamp beyond `milStatus`, no severity, no first-seen or cleared time: only
 * `observedAt` and the event's `status` ("some providers do not report closed statuses").
 */
export const terminalFaultEventSchema = z.looseObject({
  /** `fc_evt_…` */
  id: z.string().min(1),
  provider: z.string().min(1),
  vehicle: expandable,
  protocol: z.string().min(1),
  status: z.string().min(1),
  code: z.string().min(1),
  description: text,
  observedAt: iso,
  milStatus: z.string().nullish(),
  j1939: z
    .looseObject({
      spn: z.number().int(),
      fmi: z.number().int().nullish(),
      spnDescription: text,
      fmiDescription: text,
      occurrenceCount: z.number().int().nullish(),
      sourceAddress: z.number().int().nullish(),
    })
    .nullish(),
  obdii: z.looseObject({ code: z.string().nullish(), description: text }).nullish(),
  metadata: z.looseObject({ addedAt: iso.nullish(), modifiedAt: iso }),
});
export type TerminalFaultEvent = z.infer<typeof terminalFaultEventSchema>;

// ---- raw items (what the client lands in ingest.raw_events) -----------------------------------

/** A position: a history breadcrumb (`live`) or the provider's latest fix (`last_known`). */
export type TerminalPositionRaw =
  | { connectionId: string; kind: 'history'; location: TerminalHistoricalLocation }
  | { connectionId: string; kind: 'latest'; location: TerminalLatestLocation };

/** A stat: one VehicleStatLog, or the stats a latest location carries. */
export type TerminalStatRaw =
  | { connectionId: string; kind: 'log'; log: TerminalStatLog }
  | { connectionId: string; kind: 'latest'; location: TerminalLatestLocation };

export interface TerminalFaultRaw {
  connectionId: string;
  event: TerminalFaultEvent;
}

export interface TerminalVehicleRaw {
  connectionId: string;
  vehicle: TerminalVehicle;
  /** Its group names (ExpandedGroup.name), sorted: the kind tags. */
  groups: string[];
}

/** The providers behind our connections, as GET /providers lists them. */
export interface TerminalProvidersRaw {
  /** The provider codes our connections use, sorted. */
  codes: string[];
  providers: TerminalProvider[];
}
