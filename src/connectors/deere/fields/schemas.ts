/**
 * The Deere shapes the deere.fields sync reads beyond the 1a ones in ../schemas.ts (slice 1f,
 * docs/contracts-1f.md §5.7, owner: deere-data): fields with their farm and client embedded,
 * farms and clients, flags with their category embedded, engine hours, plus the raw items the
 * sync lands in ingest.raw_events (streams `fields`, `flags`, `equipment`, `hours`).
 *
 * SOURCES (Deere's own specs, the portal's spec feed developer.deere.com/devDoc/apiDetails/<key>,
 * read Oct 30, 2026):
 *  - Fields (fields__fields.yaml): GET /organizations/{orgId}/fields?recordFilter=AVAILABLE|
 *    ARCHIVED|ALL&embed=farms,clients,…; with `embed=farms,clients` a Field carries
 *    `farms: { farms: [Farm { id, name, links }] }` and `clients: { clients: [Client { id, name,
 *    links }] }` (schema FieldResponse); Deere's call-review tips recommend the embed over separate
 *    farms and clients calls. Archived fields are listed only with `recordFilter=ALL`.
 *  - Farms (farms__farms.yaml): GET /organizations/{orgId}/farms?recordFilter=available|archived|
 *    all, Farm { id, name, archived, clientUri, links }.
 *  - Clients (clients__clients.yaml): GET /organizations/{orgId}/clients?recordFilter=ACTIVE|ALL|
 *    ARCHIVED, Client { id, name, archived, links }.
 *  - Flags (flags__flags.yaml, flags__flag-categories.yaml): GET /organizations/{orgId}/flags?
 *    recordFilter=active|archived|all&embed=flagCategory; archived flags are returned only when
 *    asked for. The category is a FlagCategory { id, categoryTitle, preferred, archived }; how
 *    `embed=flagCategory` places it on the flag is not in Deere's examples (`flagCategory` is
 *    read here, leniently). // doc-derived, confirm
 *  - Engine hours (machine-engine-hours__machine-engine-hours.yaml): GET
 *    /machines/{principalId}/engineHours?lastKnown=true, EngineHours { reading:
 *    MeasurementAsDouble { valueAsDouble, unit: 'Hours' }, reportTime, source: TM | MIG | CI }.
 * Objects are `loose`: extra vendor fields never fail a response.
 */
import { z } from 'zod';
import {
  deereBoundarySchema,
  deereCollectionSchema,
  deereEquipmentSchema,
  deereFieldSchema,
  deereFlagSchema,
  deereLinkSchema,
  deereMeasurementAsDoubleSchema,
} from '../schemas';

const time = z.iso.datetime({ offset: true });

/** A farm or a client as Deere embeds or lists it (`{ id, name, archived?, links }`). */
export const deereNamedRefSchema = z.looseObject({
  '@type': z.string().optional(),
  id: z.string().min(1),
  name: z.string(),
  archived: z.boolean().optional(),
  links: z.array(deereLinkSchema).optional(),
});
export type DeereNamedRef = z.infer<typeof deereNamedRefSchema>;

/** GET /organizations/{orgId}/farms: a Farm (with the URI of its client, when it has one). */
export const deereFarmSchema = deereNamedRefSchema.extend({ clientUri: z.string().optional() });
export type DeereFarm = z.infer<typeof deereFarmSchema>;
export const deereFarmsSchema = deereCollectionSchema(deereFarmSchema);

/** GET /organizations/{orgId}/clients: a Client (the grower a farm belongs to). */
export const deereClientSchema = deereNamedRefSchema;
export type DeereClientRecord = z.infer<typeof deereClientSchema>;
export const deereClientsSchema = deereCollectionSchema(deereClientSchema);

/** `farms` / `clients` of a field listed with `embed=farms,clients` (schema FieldResponse). */
const embeddedFarms = z.looseObject({ farms: z.array(deereNamedRefSchema).default([]) });
const embeddedClients = z.looseObject({ clients: z.array(deereNamedRefSchema).default([]) });

/** A field listed with `embed=farms,clients`. */
export const deereFieldWithRefsSchema = deereFieldSchema.extend({
  farms: embeddedFarms.optional(),
  clients: embeddedClients.optional(),
});
export type DeereFieldWithRefs = z.infer<typeof deereFieldWithRefsSchema>;
export const deereFieldsWithRefsSchema = deereCollectionSchema(deereFieldWithRefsSchema);

/** A flag category (FlagCategory: `categoryTitle` is its name). */
export const deereFlagCategorySchema = z.looseObject({
  '@type': z.string().optional(),
  id: z.string().optional(),
  categoryTitle: z.string().optional(),
  /** Not in Deere's FlagCategory schema; accepted in case an embed names it so. */
  name: z.string().optional(),
  archived: z.boolean().optional(),
  preferred: z.boolean().optional(),
});
export type DeereFlagCategory = z.infer<typeof deereFlagCategorySchema>;

/** A flag listed with `embed=flagCategory` (the embedded category: doc-derived, confirm). */
export const deereFlagWithCategorySchema = deereFlagSchema.extend({
  flagCategory: deereFlagCategorySchema.optional(),
});
export type DeereFlagWithCategory = z.infer<typeof deereFlagWithCategorySchema>;
export const deereFlagsWithCategorySchema = deereCollectionSchema(deereFlagWithCategorySchema);

/** One engine-hours report (GET /machines/{principalId}/engineHours). */
export const deereEngineHoursSchema = z.looseObject({
  '@type': z.string().optional(),
  reading: deereMeasurementAsDoubleSchema,
  reportTime: time,
  /** TM (MTG/UTG), MIG or CI (GlobalTracs). */
  source: z.string().optional(),
  links: z.array(deereLinkSchema).nullish(),
});
export type DeereEngineHours = z.infer<typeof deereEngineHoursSchema>;
export const deereEngineHoursListSchema = deereCollectionSchema(deereEngineHoursSchema);

// ---------------------------------------------------------------------------------------------
// Raw items (ingest.raw_events.payload) of the deere.fields streams
// ---------------------------------------------------------------------------------------------

/** What a run knows about the org a raw item was read from (decision 8). */
const orgContext = {
  orgId: z.string().min(1),
  orgName: z.string().nullable(),
  /** The home org of the run (decision 8), null when none is known. */
  homeOrgId: z.string().nullable(),
};

/**
 * Stream `fields`: ONE field as one org lists it, with its active boundary from the org's
 * boundary listing (null when it has none). externalId `<orgId>:<fieldId>`.
 */
export const deereFieldRawSchema = z.object({
  ...orgContext,
  field: deereFieldWithRefsSchema,
  boundary: deereBoundarySchema.nullable(),
});
export type DeereFieldRaw = z.infer<typeof deereFieldRawSchema>;

/**
 * Stream `flags`: every flag of every org listed this run, in ONE item (externalId `orgs`), so
 * the writer applies them in one transaction, resolves the pins of flags no longer listed (a
 * flag deleted in Operations Center) and publishes `pins`/`updated` at most once.
 */
export const deereFlagsRawSchema = z.object({
  orgs: z.array(
    z.object({ orgId: z.string().min(1), flags: z.array(deereFlagWithCategorySchema) }),
  ),
});
export type DeereFlagsRaw = z.infer<typeof deereFlagsRawSchema>;

/**
 * Stream `equipment`: the Equipment API listing of every org listed this run, in ONE item
 * (externalId `orgs`), so the unmappable kinds are counted over the whole listing.
 */
export const deereEquipmentRawSchema = z.object({
  homeOrgId: z.string().nullable(),
  orgs: z.array(z.object({ orgId: z.string().min(1), machines: z.array(deereEquipmentSchema) })),
});
export type DeereEquipmentRaw = z.infer<typeof deereEquipmentRawSchema>;

/** Stream `hours`: one engine-hours report. externalId `<orgId>:<principalId>:<reportTime>`. */
export const deereEngineHoursRawSchema = z.object({
  orgId: z.string().min(1),
  principalId: z.string().min(1),
  report: deereEngineHoursSchema,
});
export type DeereEngineHoursRaw = z.infer<typeof deereEngineHoursRawSchema>;
