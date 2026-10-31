/**
 * The Deere calls of the deere.fields sync (slice 1f, docs/contracts-1f.md §5.7; owner:
 * deere-data), made through the 1f client seam (`apiUrl`, `getOne`, `getPaged` of ../client.ts:
 * bearer token, one refresh on 401, every page validated, `nextPage` links followed):
 *
 *   GET /organizations/{orgId}/fields?recordFilter=ALL&embed=farms,clients   (ag1; archived
 *       fields too, so a field archived in Operations Center hides here)
 *   GET /organizations/{orgId}/boundaries?recordFilter=active                (ag1; the documented
 *       default, named so a replay fixture can tell this listing from the 1a one)
 *   GET /organizations/{orgId}/farms, /clients                                (ag1; the stand-in
 *       and tests; the sync reads farms and clients from the fields embed)
 *   GET /organizations/{orgId}/flags?recordFilter=all&embed=flagCategory     (ag1; Deere hides
 *       archived flags by default)
 *   GET /machines/{principalId}/engineHours?lastKnown=true                   (eq1)
 * Machines come from the Equipment API through `client.machines(orgId)` (../client.ts).
 *
 * Also the plan §5 ports over these calls (FieldSource, FlagSource, MachineSource), for whoever
 * wants normalized items without the sync (the sync itself lands raw items, ./sync.ts).
 */
import type {
  FieldSource,
  FlagSource,
  MachineSource,
  NormalizedField,
  NormalizedFlag,
  NormalizedMachine,
} from '../../types';
import type { DeereClient } from '../client';
import { deereOrgAccess } from '../orgs';
import { type DeereBoundary, type DeereEquipment, deereBoundariesSchema } from '../schemas';
import { activeBoundaryOf, mapDeereEquipment, mapDeereField, mapDeereFlag } from './mapper';
import {
  type DeereClientRecord,
  type DeereEngineHours,
  type DeereFarm,
  type DeereFieldWithRefs,
  type DeereFlagWithCategory,
  deereClientsSchema,
  deereEngineHoursListSchema,
  deereFarmsSchema,
  deereFieldsWithRefsSchema,
  deereFlagsWithCategorySchema,
} from './schemas';

/** Query of the fields listing (recordFilter values as the Fields API spells them). */
export const DEERE_FIELDS_QUERY = { recordFilter: 'ALL', embed: 'farms,clients' } as const;
/** Query of the org boundary listing (the documented default, named explicitly). */
export const DEERE_BOUNDARIES_QUERY = { recordFilter: 'active' } as const;
/** Query of the flags listing (archived flags too; the category embedded). */
export const DEERE_FLAGS_QUERY = { recordFilter: 'all', embed: 'flagCategory' } as const;

function withQuery(url: string, query: Readonly<Record<string, string>>): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return u.toString();
}

export class DeereFieldsApi {
  constructor(readonly client: DeereClient) {}

  /** Every field of the org, archived ones included, each with its farm and client embedded. */
  fields(orgId: string): Promise<DeereFieldWithRefs[]> {
    return this.client.getPaged(
      deereFieldsWithRefsSchema,
      withQuery(this.client.apiUrl('organizations', orgId, 'fields'), DEERE_FIELDS_QUERY),
    );
  }

  /** The org's boundaries as Deere lists them by default (each links its field). */
  boundaries(orgId: string): Promise<DeereBoundary[]> {
    return this.client.getPaged(
      deereBoundariesSchema,
      withQuery(this.client.apiUrl('organizations', orgId, 'boundaries'), DEERE_BOUNDARIES_QUERY),
    );
  }

  /** The org's farms (archived ones too). */
  farms(orgId: string): Promise<DeereFarm[]> {
    return this.client.getPaged(
      deereFarmsSchema,
      withQuery(this.client.apiUrl('organizations', orgId, 'farms'), { recordFilter: 'all' }),
    );
  }

  /** The org's clients (archived ones too). */
  clients(orgId: string): Promise<DeereClientRecord[]> {
    return this.client.getPaged(
      deereClientsSchema,
      withQuery(this.client.apiUrl('organizations', orgId, 'clients'), { recordFilter: 'ALL' }),
    );
  }

  /** Every flag of the org, archived ones included, with its category. */
  flags(orgId: string): Promise<DeereFlagWithCategory[]> {
    return this.client.getPaged(
      deereFlagsWithCategorySchema,
      withQuery(this.client.apiUrl('organizations', orgId, 'flags'), DEERE_FLAGS_QUERY),
    );
  }

  /** The machine's latest engine-hours report (`lastKnown=true`), or null when it has none. */
  async lastEngineHours(principalId: string): Promise<DeereEngineHours | null> {
    const page = await this.client.getOne(
      deereEngineHoursListSchema,
      withQuery(this.client.apiUrl('machines', principalId, 'engineHours'), { lastKnown: 'true' }),
    );
    const latest = [...page.values].sort((a, b) => b.reportTime.localeCompare(a.reportTime));
    return latest[0] ?? null;
  }

  /** The org's machines (Equipment API, every category-Machine item). */
  machines(orgId: string): Promise<DeereEquipment[]> {
    return this.client.machines(orgId);
  }

  /** Orgs of the connection that approved the app (decision 5). */
  private async connectedOrgs() {
    const orgs = await this.client.organizations();
    return orgs.filter((o) => deereOrgAccess(o).status === 'connected');
  }

  /** FieldSource: every field of every connected org, with its active boundary. */
  asFieldSource(): FieldSource {
    return {
      listFields: async (): Promise<NormalizedField[]> => {
        const out: NormalizedField[] = [];
        for (const org of await this.connectedOrgs()) {
          const boundaries = await this.boundaries(org.id);
          for (const field of await this.fields(org.id)) {
            const raw = {
              orgId: org.id,
              orgName: org.name,
              homeOrgId: null,
              field,
              boundary: activeBoundaryOf(field.id, boundaries),
            };
            out.push(...mapDeereField(raw).map((i) => i.field));
          }
        }
        return out;
      },
    };
  }

  /** FlagSource: every flag of every connected org (Deere has no flag feed: the cursor is now). */
  asFlagSource(now: () => Date = () => new Date()): FlagSource {
    return {
      flagsSince: async () => {
        const items: NormalizedFlag[] = [];
        for (const org of await this.connectedOrgs()) {
          for (const f of await this.flags(org.id)) {
            const n = mapDeereFlag(org.id, f);
            if (n) items.push(n);
          }
        }
        return { items, cursor: now().toISOString(), hasMore: false };
      },
    };
  }

  /** MachineSource: every machine of every connected org (kind null when it doesn't map). */
  asMachineSource(): MachineSource {
    return {
      listMachines: async (): Promise<NormalizedMachine[]> => {
        const out: NormalizedMachine[] = [];
        for (const org of await this.connectedOrgs()) {
          for (const e of await this.machines(org.id)) {
            const m = mapDeereEquipment(org.id, e);
            if (m) out.push(m.machine);
          }
        }
        return out;
      },
    };
  }
}
