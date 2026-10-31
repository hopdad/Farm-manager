/**
 * The Deere stand-in's route modules (1f seam, docs/contracts-1f.md §7): the core router
 * (./routes.ts: OAuth, organizations, machines with their equipment type, make and model, a
 * minimal `/organizations/{org}/fields` listing, breadcrumbs) dispatches every platform call to
 * one module per 1f builder first, so each builder adds its endpoints in its own file:
 *
 *   connections  ./connections-routes.ts  sync-health: org approval (decision 5) — an org set to
 *                                         "needs approval" carries a `connections` link and answers
 *                                         403 to every org-scoped call
 *   fields       ./fields-routes.ts       deere-data: farms, fields, boundaries, flags, equipment,
 *                                         engine hours
 *   ops          ./ops-routes.ts          deere-ops: field operations, measurements, coverage
 *
 * Order of a GET /platform/... or /isg/... request (bearer token and Accept already checked by
 * the core):
 *   1. each module's `route()` in DEERE_ROUTE_MODULES order (connections, fields, ops); the first
 *      non-null reply wins, so connections can refuse an org before anyone serves it (it reads
 *      `r.orgIds`: the org of a /platform/organizations/{org}/… path, or the Equipment API's
 *      `organizationIds`);
 *   2. the core routes; 3. 404 "not simulated".
 * A module answers only the paths contracts-1f §7 gives it and returns null for everything else
 * (check `r.api`: most modules answer `platform` requests only). GET /organizations is the
 * core's: modules add links to each org through `orgLinks()`. The fields module shadows the
 * core's minimal fields listing (same ids: ./platform.ts simDeereFields); the core's Equipment
 * API listing (GET /isg/equipment, machines with `principalId`, `isgType`, `make`, `model`) is
 * never shadowed.
 *
 * Knobs: `control()` is served at `/_control/vendor/deere/<key>/...` (req.path is the part after
 * `/<key>`), behind the stand-in's loopback/Origin/JSON guard; a module keeps its state in
 * `ctx.state.vendors['deere.<key>']` and calls `ctx.persist()` after a change (reset clears it).
 * Integrator-owned (contract file).
 */
import type { DeereLink } from '../../../connectors/deere/schemas';
import type { VendorContext, VendorControlContext } from '../context';
import type { SimRequest, SimResponse } from '../http';

/** One GET /deere/platform/... (or /deere/isg/..., the Equipment API) request as a module sees it. */
export interface DeerePlatformRequest {
  req: SimRequest;
  ctx: VendorContext;
  /** Which Deere API: the Operations Center platform, or the Equipment API (equipmentapi.deere.com/isg). */
  api: 'platform' | 'equipment';
  /**
   * Decoded path segments after `/platform` (or `/isg`), e.g. ['organizations', 'org-home',
   * 'fields'] or ['equipment'].
   */
  parts: string[];
  /** The org ids the request names: `/organizations/{org}/…`, or `organizationIds=` (Equipment API). */
  orgIds: string[];
  /** `<origin>/deere/platform`, the base of every platform link in a reply. */
  base: string;
}

export type DeereModuleKey = 'connections' | 'fields' | 'ops';

export interface DeereRouteModule {
  readonly key: DeereModuleKey;
  /** Answer a platform GET this module serves, or null to pass it on. */
  route?(r: DeerePlatformRequest): SimResponse | null | Promise<SimResponse | null>;
  /** Extra links on one organization of GET /organizations (e.g. fields, farms, connections). */
  orgLinks?(org: { id: string; name: string }, r: DeerePlatformRequest): DeereLink[];
  /** This module's knobs: `/_control/vendor/deere/<key>/...`; null = unknown path (404). */
  control?(
    req: SimRequest,
    ctx: VendorControlContext,
  ): SimResponse | null | Promise<SimResponse | null>;
}

/** The persisted knob bag of module `key` (created on first use; call ctx.persist() after a change). */
export function deereModuleState(
  ctx: { state: { vendors?: Record<string, Record<string, unknown>> } },
  key: DeereModuleKey,
): Record<string, unknown> {
  ctx.state.vendors ??= {};
  const bag = `deere.${key}`;
  ctx.state.vendors[bag] ??= {};
  return ctx.state.vendors[bag];
}
