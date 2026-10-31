/**
 * What the Deere stand-in's `fields` module serves, as pure functions of the simulated farm
 * (slice 1f, docs/contracts-1f.md §7.1; owner: deere-data), shared with the replay fixture
 * builder (src/connectors/deere/fixtures/build.ts) so sim and replay agree:
 *
 *  - every (org, field) Deere lists: exactly `simDeereFields(farm)` (the seed's external refs),
 *    plus ONE Deere-only field in the home org that the seed doesn't have (`simDeereOnlyField`:
 *    the creation path, a field the app didn't know landing in its Deere farm with tenure
 *    `unknown`);
 *  - each listing's Deere farm and client (a field's own farm unit in its owning org; a farm of
 *    the sharing org for the `sharedWith` copies; the customer party of a custom-work farm in the
 *    home org as a Deere client);
 *  - each listing's active boundary (the owning org's is `SimField.deereBoundaryId`; a sharing
 *    org's copy has its own id, same ground);
 *  - Deere-shaped JSON for fields, farms, clients, boundaries, flags and engine hours (the shapes
 *    of src/connectors/deere/schemas.ts and ./fields/schemas.ts).
 */
import { area as turfArea } from '@turf/turf';
import type { MultiPolygon, Position } from 'geojson';
import type { SimFlag } from '../../farm/flags';
import { deereGuid } from '../../farm/fleet';
import { SIM_DEERE_HOME_ORG, type SimFarm, type SimFarmUnit } from '../../types';
import { simDeereFields } from './platform';

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const r2 = (v: number) => Math.round(v * 100) / 100;
const enc = encodeURIComponent;

/** Every Deere boundary and field record of the stand-in was last edited then (fixed: stable payloads). */
export const SIM_FIELDS_MODIFIED = '2026-03-02T15:41:15.205Z';

export interface SimDeereRef {
  id: string;
  name: string;
}

/** One field as one org lists it, with its farm, client and active boundary. */
export interface SimDeereFieldRecord {
  orgId: string;
  deereFieldId: string;
  name: string;
  /** The app field it maps to (null for the Deere-only field). */
  fieldId: string | null;
  /** True for a `sharedWith` copy (the second org's). */
  shared: boolean;
  farm: SimDeereRef;
  client: SimDeereRef | null;
  boundaryId: string;
  boundaryName: string;
  boundary: MultiPolygon;
}

/** Bounding box [w, s, e, n] of a MultiPolygon. */
function bboxOf(g: MultiPolygon): [number, number, number, number] {
  const pts = g.coordinates.flat(2);
  const xs = pts.map((p) => p[0] as number);
  const ys = pts.map((p) => p[1] as number);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

const overlaps = (a: number[], b: number[], m: number) =>
  (a[0] as number) < (b[2] as number) + m &&
  (b[0] as number) < (a[2] as number) + m &&
  (a[1] as number) < (b[3] as number) + m &&
  (b[1] as number) < (a[3] as number) + m;

/**
 * The Deere-only field: a half-quarter (80 ac) north of the first home-org field whose north side
 * is open ground (no demo field within ~50 m), in that field's farm unit. Pure: a function of the
 * farm alone.
 */
export function simDeereOnlyField(farm: SimFarm): SimDeereFieldRecord | null {
  const units = new Map(farm.farms.map((u) => [u.id, u]));
  const boxes = farm.fields.map((f) => bboxOf(f.boundary));
  const margin = 0.0005;
  for (const f of farm.fields) {
    const unit = units.get(f.farmId);
    if (!unit || unit.deereOrgId !== SIM_DEERE_HOME_ORG || unit.clientPartyId) continue;
    const [w, , e, n] = bboxOf(f.boundary);
    const h = (n - (bboxOf(f.boundary)[1] as number)) / 2;
    const box = [w, n + margin * 2, e, n + margin * 2 + h];
    if (boxes.some((b) => overlaps(box, b, margin))) continue;
    const ring: Position[] = [
      [r6(box[0] as number), r6(box[1] as number)],
      [r6(box[2] as number), r6(box[1] as number)],
      [r6(box[2] as number), r6(box[3] as number)],
      [r6(box[0] as number), r6(box[3] as number)],
      [r6(box[0] as number), r6(box[1] as number)],
    ];
    const key = 'deere-only-new-ground';
    return {
      orgId: SIM_DEERE_HOME_ORG,
      deereFieldId: deereGuid('field', key),
      name: 'New Ground 80',
      fieldId: null,
      shared: false,
      farm: { id: unit.deereFarmId, name: unit.name },
      client: null,
      boundaryId: deereGuid('boundary', key),
      boundaryName: 'New Ground 80',
      boundary: { type: 'MultiPolygon', coordinates: [[ring]] },
    };
  }
  return null;
}

/** The Deere farm of a sharing org that holds its copies of `unit`'s fields. */
export function sharedFarmOf(orgId: string, unit: SimFarmUnit): SimDeereRef {
  return { id: deereGuid(`farm@${orgId}`, unit.key), name: unit.name };
}

/** The Deere client of a custom-work farm in the home org (its customer party), if any. */
function clientOf(farm: SimFarm, unit: SimFarmUnit): SimDeereRef | null {
  if (!unit.clientPartyId || unit.deereOrgId !== SIM_DEERE_HOME_ORG) return null;
  const party = farm.parties.find((p) => p.id === unit.clientPartyId);
  return party ? { id: deereGuid('client', party.key), name: party.displayName } : null;
}

/** Every field record of every org, in farm order, the Deere-only field last. */
export function simDeereFieldRecords(farm: SimFarm): SimDeereFieldRecord[] {
  const units = new Map(farm.farms.map((u) => [u.id, u]));
  const out: SimDeereFieldRecord[] = simDeereFields(farm).map((x) => {
    const unit = units.get(x.field.farmId) as SimFarmUnit;
    return {
      orgId: x.orgId,
      deereFieldId: x.deereFieldId,
      name: x.field.name,
      fieldId: x.field.id,
      shared: x.shared,
      farm: x.shared ? sharedFarmOf(x.orgId, unit) : { id: unit.deereFarmId, name: unit.name },
      client: x.shared ? null : clientOf(farm, unit),
      boundaryId: x.shared
        ? deereGuid(`boundary@${x.orgId}`, x.field.key)
        : x.field.deereBoundaryId,
      boundaryName: x.field.name,
      boundary: x.field.boundary,
    };
  });
  const only = simDeereOnlyField(farm);
  if (only) out.push(only);
  return out;
}

/** The Deere farms one org lists (each farm of a field it lists, once). */
export function simOrgFarms(records: readonly SimDeereFieldRecord[], orgId: string) {
  const out = new Map<string, { farm: SimDeereRef; client: SimDeereRef | null }>();
  for (const r of records) {
    if (r.orgId === orgId && !out.has(r.farm.id))
      out.set(r.farm.id, { farm: r.farm, client: r.client });
  }
  return [...out.values()];
}

/** The Deere clients one org lists. */
export function simOrgClients(records: readonly SimDeereFieldRecord[], orgId: string) {
  const out = new Map<string, SimDeereRef>();
  for (const r of records) if (r.orgId === orgId && r.client) out.set(r.client.id, r.client);
  return [...out.values()];
}

// ---------------------------------------------------------------------------------------------
// Deere-shaped JSON (`base` = the platform root the links name)
// ---------------------------------------------------------------------------------------------

const link = (rel: string, uri: string) => ({ '@type': 'Link', rel, uri });

export function fieldPath(base: string, orgId: string, fieldId: string): string {
  return `${base}/organizations/${enc(orgId)}/fields/${enc(fieldId)}`;
}

const namedRef = (type: string, base: string, orgId: string, r: SimDeereRef, kind: string) => ({
  '@type': type,
  id: r.id,
  name: r.name,
  links: [link('self', `${base}/organizations/${enc(orgId)}/${kind}/${enc(r.id)}`)],
});

/** A Field; with `embed`, its farm and client embedded (`farms: { farms }`, `clients: { clients }`). */
export function deereFieldJson(base: string, r: SimDeereFieldRecord, embed: boolean) {
  const p = fieldPath(base, r.orgId, r.deereFieldId);
  return {
    '@type': 'Field',
    id: r.deereFieldId,
    name: r.name,
    archived: false,
    lastModifiedTime: SIM_FIELDS_MODIFIED,
    ...(embed
      ? {
          farms: { '@type': 'Farms', farms: [namedRef('Farm', base, r.orgId, r.farm, 'farms')] },
          clients: {
            '@type': 'Clients',
            clients: r.client ? [namedRef('Client', base, r.orgId, r.client, 'clients')] : [],
          },
        }
      : {}),
    links: [
      link('self', p),
      link('clients', `${p}/clients`),
      link('farms', `${p}/farms`),
      link('owningOrganization', `${base}/organizations/${enc(r.orgId)}`),
      link('boundaries', `${p}/boundaries`),
      link('activeBoundary', `${p}/boundaries/${enc(r.boundaryId)}`),
      link('fieldOperation', `${p}/fieldOperations`),
    ],
  };
}

/** A Farm of GET /organizations/{orgId}/farms. */
export function deereFarmJson(
  base: string,
  orgId: string,
  x: { farm: SimDeereRef; client: SimDeereRef | null },
) {
  const self = `${base}/organizations/${enc(orgId)}/farms/${enc(x.farm.id)}`;
  return {
    '@type': 'Farm',
    id: x.farm.id,
    name: x.farm.name,
    archived: false,
    ...(x.client
      ? { clientUri: `${base}/organizations/${enc(orgId)}/clients/${enc(x.client.id)}` }
      : {}),
    links: [
      link('self', self),
      link('fields', `${self}/fields`),
      link('owningOrganization', `${base}/organizations/${enc(orgId)}`),
    ],
  };
}

/** A Client of GET /organizations/{orgId}/clients. */
export function deereClientJson(base: string, orgId: string, c: SimDeereRef) {
  const self = `${base}/organizations/${enc(orgId)}/clients/${enc(c.id)}`;
  return {
    '@type': 'Client',
    id: c.id,
    name: c.name,
    archived: false,
    links: [
      link('self', self),
      link('farms', `${self}/farms`),
      link('owningOrganization', `${base}/organizations/${enc(orgId)}`),
    ],
  };
}

const point = ([lon, lat]: Position) => ({
  '@type': 'Point',
  lat: r6(lat as number),
  lon: r6(lon as number),
});

/** The active Boundary of a field record (area in ha, as Deere's metric default). */
export function deereBoundaryJson(base: string, r: SimDeereFieldRecord) {
  const p = fieldPath(base, r.orgId, r.deereFieldId);
  const ha = r2(turfArea(r.boundary) / 10_000);
  const [w, s, e, n] = bboxOf(r.boundary);
  return {
    '@type': 'Boundary',
    id: r.boundaryId,
    name: r.boundaryName,
    sourceType: 'HandDrawn',
    createdTime: SIM_FIELDS_MODIFIED,
    modifiedTime: SIM_FIELDS_MODIFIED,
    area: { '@type': 'MeasurementAsDouble', valueAsDouble: ha, unit: 'ha' },
    workableArea: { '@type': 'MeasurementAsDouble', valueAsDouble: ha, unit: 'ha' },
    multipolygons: r.boundary.coordinates.map((poly) => ({
      '@type': 'Polygon',
      rings: poly.map((ring, i) => ({
        '@type': 'Ring',
        points: ring.map(point),
        type: i === 0 ? 'exterior' : 'interior',
        passable: true,
      })),
    })),
    extent: {
      '@type': 'Extent',
      topLeft: { '@type': 'Point', lat: r6(n), lon: r6(w) },
      bottomRight: { '@type': 'Point', lat: r6(s), lon: r6(e) },
    },
    active: true,
    archived: false,
    irrigated: false,
    signalType: 'dtiSignalTypeRTK',
    links: [
      link('self', `${p}/boundaries/${enc(r.boundaryId)}`),
      link('owningOrganization', `${base}/organizations/${enc(r.orgId)}`),
      link('field', p),
    ],
  };
}

/** A Flag (geometry as a JSON string, as Deere sends it); with `embed`, its flagCategory. */
export function deereFlagJson(base: string, f: SimFlag, embed: boolean) {
  const categoryUri = `${base}/organizations/${enc(f.orgId)}/flagCategories/${enc(f.category.id)}`;
  return {
    '@type': 'Flag',
    id: f.id,
    geometry: JSON.stringify(f.geometry),
    notes: f.notes,
    archived: f.archived,
    proximityAlertEnabled: f.category.title === 'Rocks' || f.category.title === 'Hazard',
    createdTime: f.createdTime,
    lastModifiedTime: f.lastModifiedTime,
    ...(embed
      ? {
          flagCategory: {
            '@type': 'FlagCategory',
            id: f.category.id,
            categoryTitle: f.category.title,
            preferred: true,
            archived: false,
          },
        }
      : {}),
    links: [
      link('owningOrganization', `${base}/organizations/${enc(f.orgId)}`),
      link('flagCategoryWithPrefrences', `${categoryUri}?embed=preferences`),
      link('createdBy', `${base}/users/simulated-operator`),
      link('field', fieldPath(base, f.orgId, f.deereFieldId)),
    ],
  };
}

/** One engine-hours report (GET /machines/{principalId}/engineHours). */
export function deereEngineHoursJson(
  base: string,
  principalId: string,
  hours: number,
  reportTime: string,
) {
  return {
    reading: {
      '@type': 'measurementAsDouble',
      valueAsDouble: Math.round(hours * 100) / 100,
      unit: 'Hours',
    },
    reportTime,
    source: 'TM',
    links: [link('machine', `${base}/machines/${enc(principalId)}`)],
  };
}
