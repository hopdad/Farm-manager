/**
 * Shared helpers of the Deere stand-in's platform API (`/deere/platform/...`): the vendor-shaped
 * error body, `pageOffset` / `itemLimit` paging with `nextPage` links, the simulated orgs and
 * which org lists which demo field (`simDeereFields`, so the core fields listing, the fields
 * module and the ops module agree). Used by the core router (./routes.ts) and by the 1f route
 * modules (./modules.ts), which must not import ./routes.ts (it imports them). Integrator-owned
 * in 1f (docs/contracts-1f.md §7).
 */
import type { DeereLink } from '../../../connectors/deere/schemas';
import { SIM_DEERE_HOME_ORG, type SimFarm, type SimField } from '../../types';
import { json, type SimRequest, type SimResponse } from '../http';

/** Deere's API error body (`{ errors: [{ message, guid }] }`). */
export function apiError(
  status: number,
  message: string,
  headers: Record<string, string> = {},
): SimResponse {
  return json(status, { errors: [{ message, guid: `sim-${status}` }] }, headers);
}

/**
 * `pageOffset` / `itemLimit` of a collection request (1-100 on /platform; the Equipment API
 * allows up to 5000), or the 400 reply.
 */
export function paging(
  url: URL,
  defaultLimit: number,
  maxLimit = 100,
): { offset: number; limit: number } | SimResponse {
  const offset = Number(url.searchParams.get('pageOffset') ?? 0);
  const limit = Number(url.searchParams.get('itemLimit') ?? defaultLimit);
  if (!Number.isInteger(offset) || offset < 0) return apiError(400, 'pageOffset must be >= 0');
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
    return apiError(400, `itemLimit must be 1-${maxLimit}`);
  }
  return { offset, limit };
}

/** One collection page `{ links, total, values }` with a `nextPage` link when more remain. */
export function collection<T>(url: URL, all: T[], offset: number, limit: number) {
  const self = new URL(url);
  const links: DeereLink[] = [{ rel: 'self', uri: self.toString() }];
  if (offset + limit < all.length) {
    const next = new URL(url);
    next.searchParams.set('pageOffset', String(offset + limit));
    next.searchParams.set('itemLimit', String(limit));
    links.push({ rel: 'nextPage', uri: next.toString() });
  }
  return { links, total: all.length, values: all.slice(offset, offset + limit) };
}

/** A whole paged collection reply (paging read from the request), or the 400 reply. */
export function pagedReply<T>(req: SimRequest, all: T[], defaultLimit = 10): SimResponse {
  const pg = paging(req.url, defaultLimit);
  if ('kind' in pg) return pg;
  return json(200, collection(req.url, all, pg.offset, pg.limit));
}

/** `<origin>/deere/platform`: the base of every link the stand-in sends. */
export function platformBase(req: SimRequest): string {
  return `${req.url.origin}/deere/platform`;
}

/** The Deere orgs of the simulated farm (home first by id order), each with a display name. */
export function simDeereOrgs(farm: SimFarm): { id: string; name: string }[] {
  const names = new Map<string, string>();
  const add = (id: string | undefined, name: string) => {
    if (id && !names.has(id)) names.set(id, name);
  };
  for (const u of farm.farms) add(u.deereOrgId, u.name);
  for (const m of farm.machines) add(m.deereOrgId, `Simulated org ${m.deereOrgId}`);
  for (const f of farm.fields)
    add(f.sharedWith?.deereOrgId, `Simulated org ${f.sharedWith?.deereOrgId}`);
  add(SIM_DEERE_HOME_ORG, 'Home operation (simulated)');
  return [...names].map(([id, name]) => ({ id, name })).sort((a, b) => a.id.localeCompare(b.id));
}

/** One entry of a simulated org's Deere field listing. */
export interface SimDeereField {
  /** The org that lists the field. */
  orgId: string;
  /** The field's id in that org (SimField.deereFieldId, or sharedWith.deereFieldId). */
  deereFieldId: string;
  field: SimField;
  /** True for the second org's copy (SimField.sharedWith); false for the owning org's. */
  shared: boolean;
}

/**
 * Every (org, Deere field id) under which Deere knows a demo field, in farm order: the owning
 * unit's org with SimField.deereFieldId, plus SimField.sharedWith's org and id. These are
 * exactly the field tuples of `simExternalRefs`, so whatever a sync reads maps onto the seed.
 */
export function simDeereFields(farm: SimFarm): SimDeereField[] {
  const orgOfFarm = new Map(farm.farms.map((u) => [u.id, u.deereOrgId]));
  const out: SimDeereField[] = [];
  for (const field of farm.fields) {
    const orgId = orgOfFarm.get(field.farmId);
    if (!orgId) continue;
    out.push({ orgId, deereFieldId: field.deereFieldId, field, shared: false });
    if (field.sharedWith) {
      out.push({
        orgId: field.sharedWith.deereOrgId,
        deereFieldId: field.sharedWith.deereFieldId,
        field,
        shared: true,
      });
    }
  }
  return out;
}
