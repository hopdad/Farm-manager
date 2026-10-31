/**
 * The polls of the deere.fields job (slice 1f, docs/contracts-1f.md §5.4, §5.7, §9; owner:
 * deere-data): one `DeereFieldsRun` per job run lists the organizations once, works out the
 * home org (decision 8) and which orgs may be read (decision 5), and builds the raw items of the
 * four streams:
 *
 *   fields     one item per (org, field): the field with its farm, client and active boundary
 *   flags      one item for the run: every listed org's flags (archived ones too)
 *   equipment  one item for the run: every listed org's Equipment API machines
 *   hours      one item per engine-hours report of a machine that maps to a farm.machines row
 *
 * An org whose listing carries a `connections` link is skipped (needs approval); an org that
 * answers 403 mid-run is skipped too, with Deere's reason (`deniedOrgAccess`); each skip is
 * logged and never fails the other orgs. Any other error fails the stream's poll. Polls never
 * write: the writers (src/db/queries/deere-fields.ts, pins.ts, machine-hours.ts) run in the
 * per-event transactions of runSyncStep.
 */
import type { JobLogger } from '../../../jobs/types';
import type { Mode, PollResult, RawItem } from '../../types';
import {
  type DeereHomeOrg,
  deereHomeOrg,
  deereOrgAccess,
  deniedOrgAccess,
  isDeereOrgDenied,
} from '../orgs';
import type { DeereEquipment, DeereOrganization } from '../schemas';
import type { DeereFieldsApi } from './client';
import { activeBoundaryOf } from './mapper';
import type {
  DeereEngineHoursRaw,
  DeereEquipmentRaw,
  DeereFieldRaw,
  DeereFlagsRaw,
} from './schemas';

/** The streams of the deere.fields job (docs/contracts-1f.md §9). */
export const DEERE_FIELDS_STREAMS = {
  fields: 'fields',
  flags: 'flags',
  equipment: 'equipment',
  hours: 'hours',
} as const;

/** externalId of the one raw item of the snapshot streams (flags, equipment). */
export const SNAPSHOT_EXTERNAL_ID = 'orgs';

export interface DeereFieldsRunOptions {
  api: DeereFieldsApi;
  mode: Mode;
  /** DEERE_HOME_ORG_ID (decision 8). */
  homeOrgId?: string | null;
  log: JobLogger;
  now(): Date;
  /**
   * Which of these Deere machine ids (principalIds) of `orgId` map to a farm.machines row (an
   * ('deere', 'machine', …) ref): engine hours are read only for those. A read, never a write.
   */
  mappedMachines(orgId: string, principalIds: readonly string[]): Promise<ReadonlySet<string>>;
}

export interface OrgListing {
  /** The orgs this run reads (connected ones), in listing order. */
  orgs: DeereOrganization[];
  home: DeereHomeOrg;
}

export class DeereFieldsRun {
  private listing: Promise<OrgListing> | null = null;
  private readonly machinesByOrg = new Map<string, Promise<DeereEquipment[]>>();
  private readonly denied = new Set<string>();

  constructor(private readonly opts: DeereFieldsRunOptions) {}

  /** GET /organizations once per run; the orgs that need approval are dropped (logged). */
  orgs(): Promise<OrgListing> {
    this.listing ??= (async () => {
      const all = await this.opts.api.client.organizations();
      const home = deereHomeOrg(this.opts.mode, this.opts.homeOrgId, all);
      const orgs: DeereOrganization[] = [];
      for (const o of all) {
        const access = deereOrgAccess(o);
        if (access.status === 'connected') orgs.push(o);
        else {
          this.opts.log.info('deere org skipped: needs approval in Deere Connections', {
            orgId: o.id,
            detail: access.detail,
          });
        }
      }
      return { orgs, home };
    })();
    // A failed listing is not cached: the next stream tries again.
    this.listing.catch(() => {
      this.listing = null;
    });
    return this.listing;
  }

  /**
   * Run `fn` for one org; a Deere 403 (the org needs approval, terms to accept, or the app's
   * scopes) skips that org for the rest of the run and returns null.
   */
  private async forOrg<T>(org: DeereOrganization, what: string, fn: () => Promise<T>) {
    if (this.denied.has(org.id)) return null;
    try {
      return await fn();
    } catch (e) {
      if (!isDeereOrgDenied(e)) throw e;
      this.denied.add(org.id);
      const access = deniedOrgAccess(org, e);
      this.opts.log.warn('deere org skipped: Deere refused it', {
        orgId: org.id,
        stream: what,
        detail: access.detail,
      });
      return null;
    }
  }

  private cursor(): string {
    return this.opts.now().toISOString();
  }

  /** The org's machines, listed once per run (the equipment and hours streams share them). */
  private machines(orgId: string): Promise<DeereEquipment[]> {
    let p = this.machinesByOrg.get(orgId);
    if (!p) {
      p = this.opts.api.machines(orgId);
      this.machinesByOrg.set(orgId, p);
      p.catch(() => this.machinesByOrg.delete(orgId));
    }
    return p;
  }

  /** Stream `fields`: one raw item per (org, field). */
  async pollFields(): Promise<PollResult<RawItem<DeereFieldRaw>>> {
    const { orgs, home } = await this.orgs();
    const items: RawItem<DeereFieldRaw>[] = [];
    for (const org of orgs) {
      const got = await this.forOrg(org, DEERE_FIELDS_STREAMS.fields, async () => ({
        fields: await this.opts.api.fields(org.id),
        boundaries: await this.opts.api.boundaries(org.id),
      }));
      if (!got) continue;
      for (const field of got.fields) {
        items.push({
          externalId: `${org.id}:${field.id}`,
          payload: {
            orgId: org.id,
            orgName: org.name || null,
            homeOrgId: home.orgId,
            field,
            boundary: activeBoundaryOf(field.id, got.boundaries),
          },
        });
      }
    }
    return { items, cursor: this.cursor(), hasMore: false };
  }

  /** Stream `flags`: every listed org's flags in one raw item (none when no org was read). */
  async pollFlags(): Promise<PollResult<RawItem<DeereFlagsRaw>>> {
    const { orgs } = await this.orgs();
    const listed: DeereFlagsRaw['orgs'] = [];
    for (const org of orgs) {
      const flags = await this.forOrg(org, DEERE_FIELDS_STREAMS.flags, () =>
        this.opts.api.flags(org.id),
      );
      if (flags) listed.push({ orgId: org.id, flags });
    }
    const items = listed.length
      ? [{ externalId: SNAPSHOT_EXTERNAL_ID, payload: { orgs: listed } }]
      : [];
    return { items, cursor: this.cursor(), hasMore: false };
  }

  /** Stream `equipment`: every listed org's machines in one raw item. */
  async pollEquipment(): Promise<PollResult<RawItem<DeereEquipmentRaw>>> {
    const { orgs, home } = await this.orgs();
    const listed: DeereEquipmentRaw['orgs'] = [];
    for (const org of orgs) {
      const machines = await this.forOrg(org, DEERE_FIELDS_STREAMS.equipment, () =>
        this.machines(org.id),
      );
      if (machines) listed.push({ orgId: org.id, machines });
    }
    const items = listed.length
      ? [{ externalId: SNAPSHOT_EXTERNAL_ID, payload: { homeOrgId: home.orgId, orgs: listed } }]
      : [];
    return { items, cursor: this.cursor(), hasMore: false };
  }

  /**
   * Stream `hours`: the latest engine-hours report of every machine that maps to a
   * farm.machines row (telematics-capable, not archived). A machine Deere has no report for (404)
   * is skipped.
   */
  async pollHours(): Promise<PollResult<RawItem<DeereEngineHoursRaw>>> {
    const { orgs } = await this.orgs();
    const items: RawItem<DeereEngineHoursRaw>[] = [];
    for (const org of orgs) {
      const machines = await this.forOrg(org, DEERE_FIELDS_STREAMS.hours, () =>
        this.machines(org.id),
      );
      if (!machines) continue;
      const ids = machines
        .filter((m) => m.principalId && !m.archived && m.telematicsCapable !== false)
        .map((m) => m.principalId as string);
      const mapped = await this.opts.mappedMachines(org.id, ids);
      for (const principalId of ids.filter((id) => mapped.has(id))) {
        const report = await this.forOrg(org, DEERE_FIELDS_STREAMS.hours, () =>
          this.opts.api.lastEngineHours(principalId).catch((e: unknown) => {
            if ((e as { status?: unknown }).status === 404) return null;
            throw e;
          }),
        );
        if (this.denied.has(org.id)) break;
        if (!report) continue;
        items.push({
          externalId: `${org.id}:${principalId}:${new Date(report.reportTime).toISOString()}`,
          payload: { orgId: org.id, principalId, report },
        });
      }
    }
    return { items, cursor: this.cursor(), hasMore: false };
  }
}
