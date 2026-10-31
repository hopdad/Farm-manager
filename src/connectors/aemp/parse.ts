/**
 * ISO 15143-3 bodies → the app's AEMP model (./schemas.ts), JSON or XML alike. Shared by the
 * generic AEMP client (./client.ts) and CNH FieldOps' ISO-style telemetry (../cnh). Pure.
 *
 * Lenient by design (docs/contracts-1f.md §B.5): a section that fails its schema is dropped from
 * its machine (the machine is kept), a machine with no usable id or a fault item that fails is
 * dropped, and each drop is reported (`dropped`, with the machine's id when it has one; never a
 * credential) so the caller logs it. Only a body that is no document at all throws.
 */
import type { z } from 'zod';
import type { AempProviderConfig } from '../../config';
import {
  AEMP_SECTIONS,
  type AempCaution,
  type AempEquipment,
  type AempFaultCode,
  type AempHeader,
  type AempLink,
  type AempLocationItem,
  aempCautionSchema,
  aempDistanceSchema,
  aempEngineStatusSchema,
  aempFaultCodeSchema,
  aempFleetEnvelopeSchema,
  aempHeaderSchema,
  aempHoursSchema,
  aempLinks,
  aempLocationItemSchema,
  aempLocationSchema,
  aempPercentSchema,
  asArray,
  canonicalKeys,
} from './schemas';
import { AempXmlError, xmlToObject } from './xml';

export type AempFormat = AempProviderConfig['format'];
export type AempIdElement = NonNullable<AempProviderConfig['idElement']>;

/** Why a body could not be read at all (not JSON, not XML, not an ISO document). */
export class AempParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AempParseError';
  }
}

export interface AempDropped {
  /** What was dropped: a machine, one of its sections, or a series item. */
  what: string;
  /** The machine's id when known (never a credential). */
  id: string | null;
  reason: string;
}

/**
 * The body as JSON-like values: `format` json/xml, or `auto` by the Content-Type (then by the
 * first character: `<` is XML). Keys come back in the standard's spelling (`canonicalKeys`).
 */
export function aempBodyValue(
  body: string,
  contentType: string | null,
  format: AempFormat,
): unknown {
  const ct = (contentType ?? '').toLowerCase();
  const trimmed = body.trimStart();
  const xml =
    format === 'xml' ||
    (format === 'auto' &&
      (ct.includes('xml') || (!ct.includes('json') && trimmed.startsWith('<'))));
  try {
    return canonicalKeys(xml ? xmlToObject(body) : JSON.parse(body));
  } catch (e) {
    if (e instanceof AempXmlError) throw new AempParseError(`not an XML document (${e.message})`);
    throw new AempParseError(xml ? 'not an XML document' : 'body is not JSON');
  }
}

/** Unwrap `{ <root>: … }` (Samsara's `{"Fleet": …}`, every XML document) when it is there. */
function unwrap(value: unknown, root: string): Record<string, unknown> {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new AempParseError(`expected a ${root} object`);
  }
  const inner = v[root];
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
    return inner as Record<string, unknown>;
  }
  return v;
}

const issueOf = (e: { issues: { path: PropertyKey[]; message: string }[] }) => {
  const i = e.issues[0];
  return i ? `${i.path.map(String).join('.') || '(item)'}: ${i.message}` : 'schema mismatch';
};

const ID_ORDER: readonly AempIdElement[] = ['PIN', 'VIN', 'SerialNumber', 'EquipmentID'];

/**
 * The machine's id: the provider's `idElement`, else the first present of PIN, VIN,
 * SerialNumber, EquipmentID (AEMP_PROVIDERS[].idElement; Samsara: EquipmentID). Null = none.
 */
export function aempMachineId(
  header: AempHeader | undefined,
  idElement?: AempIdElement,
): string | null {
  if (!header) return null;
  for (const k of idElement ? [idElement] : ID_ORDER) {
    const v = header[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

const SECTION_SCHEMAS = {
  Location: aempLocationSchema,
  CumulativeOperatingHours: aempHoursSchema,
  Distance: aempDistanceSchema,
  FuelRemaining: aempPercentSchema,
  DEFRemaining: aempPercentSchema,
  EngineStatus: aempEngineStatusSchema,
} as const;

export interface AempMachine {
  /** The provider's id of the machine (`aempMachineId`). */
  id: string;
  equipment: AempEquipment;
}

export interface AempFleetPage {
  version: string | null;
  snapshotTime: string | null;
  links: AempLink[];
  machines: AempMachine[];
  dropped: AempDropped[];
}

/** One `Fleet/{pageNumber}` body (unwrapped from `Fleet` when wrapped). */
export function parseFleetPage(value: unknown, idElement?: AempIdElement): AempFleetPage {
  const fleet = unwrap(value, 'Fleet');
  const env = aempFleetEnvelopeSchema.safeParse(fleet);
  if (!env.success) throw new AempParseError(`not a Fleet page (${issueOf(env.error)})`);
  const dropped: AempDropped[] = [];
  const machines: AempMachine[] = [];
  asArray(env.data.Equipment).forEach((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      dropped.push({ what: `Equipment[${index}]`, id: null, reason: 'not an object' });
      return;
    }
    const item = raw as Record<string, unknown>;
    const h = aempHeaderSchema.safeParse(item.EquipmentHeader ?? {});
    const header = h.success ? h.data : undefined;
    const id = aempMachineId(header, idElement);
    if (!id) {
      dropped.push({
        what: `Equipment[${index}]`,
        id: null,
        reason: `no ${idElement ?? 'PIN, VIN, SerialNumber or EquipmentID'} in EquipmentHeader`,
      });
      return;
    }
    const equipment: AempEquipment = { EquipmentHeader: header };
    for (const section of AEMP_SECTIONS) {
      if (item[section] === undefined || item[section] === '') continue;
      const r = SECTION_SCHEMAS[section].safeParse(item[section]);
      if (r.success) (equipment as Record<string, unknown>)[section] = r.data;
      else dropped.push({ what: section, id, reason: issueOf(r.error) });
    }
    machines.push({ id, equipment });
  });
  return {
    version: env.data.version === undefined ? null : String(env.data.version),
    snapshotTime: env.data.snapshotTime ?? null,
    links: aempLinks(env.data.Links),
    machines,
    dropped,
  };
}

/** A series page: its `Links` and its items (the item list under `itemKey`). */
function seriesPage<T>(
  value: unknown,
  root: string,
  itemKeys: readonly string[],
  schema: z.ZodType<T>,
): { links: AempLink[]; items: T[]; dropped: AempDropped[] } {
  const page = unwrap(value, root);
  const dropped: AempDropped[] = [];
  const items: T[] = [];
  const key = itemKeys.find((k) => page[k] !== undefined);
  asArray(key ? page[key] : undefined).forEach((raw, index) => {
    const r = schema.safeParse(raw);
    if (r.success) items.push(r.data);
    else dropped.push({ what: `${key}[${index}]`, id: null, reason: issueOf(r.error) });
  });
  return { links: aempLinks(page.Links), items, dropped };
}

/** A fault series page (FaultCode.xsd: `DiagnosticTroubleCode { Links, FaultCode[] }`). */
export function parseFaultPage(value: unknown): {
  links: AempLink[];
  items: AempFaultCode[];
  dropped: AempDropped[];
} {
  return seriesPage(value, 'DiagnosticTroubleCode', ['FaultCode'], aempFaultCodeSchema);
}

/** A Locations series page (Locations.xsd: `LocationMessages { Links, Location[] }`). */
export function parseLocationsPage(value: unknown): {
  links: AempLink[];
  items: AempLocationItem[];
  dropped: AempDropped[];
} {
  return seriesPage(value, 'LocationMessages', ['Location'], aempLocationItemSchema);
}

/**
 * A caution-code series page (CautionCode.xsd: `CautionMessages { Links, CautionDescription[] }`;
 * CNH names the items `CautionDescriptions` and adds Severity and Active).
 */
export function parseCautionPage(value: unknown): {
  links: AempLink[];
  items: AempCaution[];
  dropped: AempDropped[];
} {
  return seriesPage(
    value,
    'CautionMessages',
    ['CautionDescriptions', 'CautionDescription'],
    aempCautionSchema,
  );
}

/** The page number a `next` link points at (`…/Fleet/7` → 7), or null. */
export function nextPageNumber(links: readonly AempLink[]): number | null {
  const next = links.find((l) => l.rel === 'next');
  if (!next) return null;
  let path = next.href;
  try {
    path = new URL(next.href, 'https://aemp.invalid').pathname;
  } catch {
    // keep the raw href
  }
  const m = /\/(\d+)\/?$/.exec(path);
  return m ? Number(m[1]) : null;
}

/** The `connections` link Deere adds while the client has no org access yet (aemp.md §2.1). */
export function connectionsLink(links: readonly AempLink[]): string | null {
  return links.find((l) => l.rel === 'connections')?.href ?? null;
}
