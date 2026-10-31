/**
 * ISO 15143-3 (AEMP 2.0) shapes, read leniently (docs/contracts-1f.md part B, §B.5): one model
 * for every provider, JSON or XML (./xml.ts turns XML into the same values).
 *
 * Sources (read Oct 30, 2026; vendor-docs aemp.md): ISO's edition-1 XSDs
 * (https://standards.iso.org/iso/15143/-3/ed-1/en/ common.xsd, FaultCode.xsd, Locations.xsd,
 * CautionCode.xsd), Deere's aemp.yaml (developer.deere.com/dev-docs/aemp), Samsara's
 * getAempEquipmentList (developers.samsara.com/openapi/samsara-api.json), Trackunit's
 * aemp-iso-api.json (developers.trackunit.com) and CNH's FieldOps OpenAPI (its ISO-style paths).
 *
 * The rules (aemp.md §5 "Parser checklist"):
 *  - keys are the standard's PascalCase names matched CASE-INSENSITIVELY (`canonicalKeys`): CNH
 *    sends `latitude`, Trackunit's JSON `defremaining`, everybody `datetime` / `snapshotTime`;
 *  - every element is optional (even where the XSD requires one: Samsara sends no `EngineNumber`);
 *  - an optional `Fleet` wrapper is unwrapped (Samsara wraps, Trackunit doesn't);
 *  - `version` is a string or a number (informational);
 *  - numbers may come as strings (XML), with more decimals than the XSD allows (Deere's odometer);
 *  - `Equipment`, `Links`, `FaultCode`, `Location` lists are arrays even with one element;
 *  - Links are `{ rel, href }`, also nested in a `Link` (Deere's YAML example renders them so).
 * One machine (or fault) that fails these schemas is dropped and reported, never the page.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------------------------
// Case-insensitive keys
// ---------------------------------------------------------------------------------------------

/** Every element and attribute name the client reads, in the standard's spelling. */
const CANONICAL_NAMES = [
  // Fleet snapshot (common.xsd) and paging
  'Fleet',
  'version',
  'snapshotTime',
  'Links',
  'Link',
  'rel',
  'href',
  'Equipment',
  'EquipmentHeader',
  'UnitInstallDateTime',
  'OEMName',
  'Model',
  'EquipmentID',
  'SerialNumber',
  'PIN',
  'VIN',
  'datetime',
  'Location',
  'Latitude',
  'Longitude',
  'Altitude',
  'AltitudeUnits',
  'CumulativeOperatingHours',
  'CumulativeIdleHours',
  'Hour',
  'Distance',
  'OdometerUnits',
  'Odometer',
  'FuelRemaining',
  'DEFRemaining',
  'Percent',
  'EngineStatus',
  'EngineNumber',
  'Running',
  'FuelUsed',
  'FuelUsedLast24',
  'FuelUnits',
  'FuelConsumed',
  'MaximumSpeedLast24',
  'Speed',
  'SpeedUnits',
  // Time series roots (Locations.xsd, FaultCode.xsd, CautionCode.xsd; CNH's variants)
  'LocationMessages',
  'DiagnosticTroubleCode',
  'FaultCode',
  'CodeIdentifier',
  'CodeDescription',
  'CodeSeverity',
  'CodeSource',
  'CautionMessages',
  'CautionDescription',
  'CautionDescriptions',
  'Identifier',
  'Description',
  'Severity',
  'Active',
] as const;

const BY_LOWER = new Map<string, string>(CANONICAL_NAMES.map((n) => [n.toLowerCase(), n]));

/** A deep copy of `value` with every known key in the standard's spelling (others unchanged). */
export function canonicalKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const key = BY_LOWER.get(k.toLowerCase()) ?? k;
      // Two spellings of one key in one object: the standard's own wins.
      if (key in out && k !== key) continue;
      out[key] = canonicalKeys(v);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------------------------

const NUMERIC = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;

/** A number, or a numeric string (XML text, some JSON providers). */
export const aempNumber = z
  .union([z.number(), z.string().trim().regex(NUMERIC)])
  .transform((v) => Number(v))
  .refine((n) => Number.isFinite(n), 'not a finite number');

/** true/false, or their string forms (XML text: `true`, `false`, `1`, `0`). */
export const aempBoolean = z.union([
  z.boolean(),
  z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^(true|false|1|0)$/)
    .transform((s) => s === 'true' || s === '1'),
]);

/** An xs:dateTime as a canonical UTC ISO string (a value with no zone is read as UTC). */
export const aempDateTime = z
  .string()
  .trim()
  .transform((s, ctx) => {
    const zoned = /([zZ]|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}Z`;
    const t = Date.parse(zoned);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(s) || Number.isNaN(t)) {
      ctx.addIssue({ code: 'custom', message: `not a date-time: ${s.slice(0, 40)}` });
      return z.NEVER;
    }
    return new Date(t).toISOString();
  });

const text = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .pipe(z.string());

/** Lists that hold one element in XML (and sometimes in JSON) are arrays here. */
export const asArray = (v: unknown): unknown[] =>
  v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v : [v];

// ---------------------------------------------------------------------------------------------
// Fleet snapshot sections (common.xsd)
// ---------------------------------------------------------------------------------------------

export const aempHeaderSchema = z.looseObject({
  UnitInstallDateTime: text.optional(),
  OEMName: text.optional(),
  Model: text.optional(),
  EquipmentID: text.optional(),
  SerialNumber: text.optional(),
  PIN: text.optional(),
  /** CNH adds the VIN. */
  VIN: text.optional(),
});
export type AempHeader = z.infer<typeof aempHeaderSchema>;

const dated = { datetime: aempDateTime.optional() };

export const aempLocationSchema = z.looseObject({
  ...dated,
  Latitude: aempNumber.pipe(z.number().min(-90).max(90)),
  Longitude: aempNumber.pipe(z.number().min(-180).max(180)),
  Altitude: aempNumber.optional(),
  AltitudeUnits: text.optional(),
});
export type AempLocation = z.infer<typeof aempLocationSchema>;

export const aempHoursSchema = z.looseObject({
  ...dated,
  Hour: aempNumber.pipe(z.number().min(0)),
});
export type AempHours = z.infer<typeof aempHoursSchema>;

export const aempDistanceSchema = z.looseObject({
  ...dated,
  Odometer: aempNumber.pipe(z.number().min(0)),
  OdometerUnits: text.optional(),
});
export type AempDistance = z.infer<typeof aempDistanceSchema>;

export const aempPercentSchema = z.looseObject({
  ...dated,
  Percent: aempNumber.pipe(z.number().min(0).max(100)),
});
export type AempPercent = z.infer<typeof aempPercentSchema>;

export const aempEngineStatusSchema = z.looseObject({
  ...dated,
  EngineNumber: text.optional(),
  Running: aempBoolean,
});
export type AempEngineStatus = z.infer<typeof aempEngineStatusSchema>;

/** The snapshot sections the app reads (the other ISO sections pass through untouched). */
export const AEMP_SECTIONS = [
  'Location',
  'CumulativeOperatingHours',
  'Distance',
  'FuelRemaining',
  'DEFRemaining',
  'EngineStatus',
] as const;
export type AempSection = (typeof AEMP_SECTIONS)[number];

/** One machine of a Fleet page (common.xsd `Equipment`), the sections the app reads. */
export const aempEquipmentSchema = z.looseObject({
  EquipmentHeader: aempHeaderSchema.optional(),
  Location: aempLocationSchema.optional(),
  CumulativeOperatingHours: aempHoursSchema.optional(),
  Distance: aempDistanceSchema.optional(),
  FuelRemaining: aempPercentSchema.optional(),
  DEFRemaining: aempPercentSchema.optional(),
  EngineStatus: aempEngineStatusSchema.optional(),
});
export type AempEquipment = z.infer<typeof aempEquipmentSchema>;

// ---------------------------------------------------------------------------------------------
// Pages and links
// ---------------------------------------------------------------------------------------------

export interface AempLink {
  rel: string;
  href: string;
}

const linkSchema = z.looseObject({ rel: text, href: text });

/** `Links` as a flat list: `{ rel, href }` items, also nested in `Link` (Deere's YAML). */
export function aempLinks(value: unknown): AempLink[] {
  const out: AempLink[] = [];
  for (const item of asArray(value)) {
    const nested = (item as { Link?: unknown } | null)?.Link;
    for (const l of nested !== undefined ? asArray(nested) : [item]) {
      const r = linkSchema.safeParse(l);
      if (r.success) out.push({ rel: r.data.rel.toLowerCase(), href: r.data.href });
    }
  }
  return out;
}

/** A Fleet page's envelope (its machines are parsed one by one, see ./parse.ts). */
export const aempFleetEnvelopeSchema = z.looseObject({
  version: z.union([z.string(), z.number()]).optional(),
  snapshotTime: aempDateTime.optional(),
  Links: z.unknown().optional(),
  Equipment: z.unknown().optional(),
});

// ---------------------------------------------------------------------------------------------
// Time series items
// ---------------------------------------------------------------------------------------------

/**
 * One FaultCode (FaultCode.xsd): an OCCURRENCE at `datetime`, with no active/cleared state
 * (aemp.md §1.3). CodeIdentifier's structure "can differ among OEMs" (parseIsoJ1939 decides).
 */
export const aempFaultCodeSchema = z.looseObject({
  datetime: aempDateTime,
  CodeIdentifier: text.pipe(z.string().min(1)),
  CodeDescription: text.optional(),
  CodeSeverity: text.optional(),
  CodeSource: text.optional(),
});
export type AempFaultCode = z.infer<typeof aempFaultCodeSchema>;

/** One Location of a `LocationMessages` series (Locations.xsd; CNH's lower-case keys). */
export const aempLocationItemSchema = aempLocationSchema.extend({ datetime: aempDateTime });
export type AempLocationItem = z.infer<typeof aempLocationItemSchema>;

/** One caution code (CautionCode.xsd `CautionDescription`; CNH: `CautionDescriptions` + Severity, Active). */
export const aempCautionSchema = z.looseObject({
  datetime: aempDateTime,
  Identifier: text.pipe(z.string().min(1)),
  Description: text.optional(),
  Severity: text.optional(),
  Active: aempBoolean.optional(),
});
export type AempCaution = z.infer<typeof aempCautionSchema>;
