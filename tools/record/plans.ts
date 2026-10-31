/**
 * What `pnpm connectors:record <source>` calls (1f decision 3; owner: sync-health): each
 * source's live client, endpoint by endpoint, with the zod schema every recorded page must pass.
 * Calls are bounded (a few orgs, machines, fields and operations), since they count against the
 * vendor's call budget (stream 'record').
 *
 * Deere: organizations; per connected org (at most `maxOrgs`): the Equipment API's machines,
 * breadcrumbs of the first machines (the last hour), their engine hours, farms, clients, fields,
 * boundaries, flags; field operations of the first fields this crop season and the first
 * operation's measurement types. Samsara: the vehicle locations feed (two pages at most), the
 * stats feed and the faultCodes feed. An endpoint the stand-in answers 404 "not simulated" is skipped and listed, so a
 * run against sim records only what the stand-in serves.
 */
import type { z } from 'zod';
import type { DeereClient } from '../../src/connectors/deere/client';
import {
  deereClientsSchema,
  deereEngineHoursListSchema,
  deereFarmsSchema,
} from '../../src/connectors/deere/fields/schemas';
import { deereOrgAccess } from '../../src/connectors/deere/orgs';
import {
  deereBoundariesSchema,
  deereBreadcrumbsSchema,
  deereEquipmentListSchema,
  deereFieldOperationMeasurementsSchema,
  deereFieldOperationsSchema,
  deereFieldsSchema,
  deereFlagsSchema,
  deereOrganizationsSchema,
} from '../../src/connectors/deere/schemas';
import type { SamsaraClient } from '../../src/connectors/samsara/client';
import {
  samsaraFaultCodesFeedSchema,
  samsaraLocationsFeedSchema,
  samsaraStatsFeedSchema,
} from '../../src/connectors/samsara/schemas';

/** One step of a plan: what it records under (stream, name) and the schema of its pages. */
export interface PlanStep {
  stream: string;
  name: string;
  schema: z.ZodType;
}

/** Runs one step's calls with every exchange tagged with the step (null = skipped or failed). */
export type StepRunner = <T>(step: PlanStep, fn: () => Promise<T>) => Promise<T | null>;

export interface PlanLimits {
  maxOrgs: number;
  maxMachines: number;
  maxFields: number;
  /** Breadcrumb window (ms back from now). */
  lookbackMs: number;
}

export const DEFAULT_LIMITS: PlanLimits = {
  maxOrgs: 3,
  maxMachines: 3,
  maxFields: 2,
  lookbackMs: 60 * 60_000,
};

export async function deerePlan(
  client: DeereClient,
  step: StepRunner,
  now: Date,
  limits: PlanLimits = DEFAULT_LIMITS,
): Promise<void> {
  const orgs =
    (await step(
      { stream: 'organizations', name: 'organizations', schema: deereOrganizationsSchema },
      () => client.organizations(),
    )) ?? [];
  const connected = orgs.filter((o) => deereOrgAccess(o).status === 'connected');
  for (const org of connected.slice(0, limits.maxOrgs)) {
    const machines =
      (await step(
        { stream: 'locations', name: 'equipment', schema: deereEquipmentListSchema },
        () => client.machines(org.id),
      )) ?? [];
    for (const m of machines.filter((x) => x.principalId).slice(0, limits.maxMachines)) {
      const pid = String(m.principalId);
      await step({ stream: 'locations', name: 'breadcrumbs', schema: deereBreadcrumbsSchema }, () =>
        client.breadcrumbs(pid, new Date(now.getTime() - limits.lookbackMs), now),
      );
      await step(
        { stream: 'hours', name: 'engine-hours', schema: deereEngineHoursListSchema },
        () =>
          client.getOne(
            deereEngineHoursListSchema,
            `${client.apiUrl('machines', pid, 'engineHours')}?lastKnown=true`,
          ),
      );
    }
    await step({ stream: 'fields', name: 'farms', schema: deereFarmsSchema }, () =>
      client.getPaged(deereFarmsSchema, client.apiUrl('organizations', org.id, 'farms')),
    );
    await step({ stream: 'fields', name: 'clients', schema: deereClientsSchema }, () =>
      client.getPaged(deereClientsSchema, client.apiUrl('organizations', org.id, 'clients')),
    );
    const fields =
      (await step({ stream: 'fields', name: 'fields', schema: deereFieldsSchema }, () =>
        client.fields(org.id),
      )) ?? [];
    await step({ stream: 'boundaries', name: 'boundaries', schema: deereBoundariesSchema }, () =>
      client.orgBoundaries(org.id),
    );
    await step({ stream: 'flags', name: 'flags', schema: deereFlagsSchema }, () =>
      client.flags(org.id),
    );
    for (const f of fields.slice(0, limits.maxFields)) {
      const ops =
        (await step(
          { stream: 'operations', name: 'field-operations', schema: deereFieldOperationsSchema },
          () => client.fieldOperations(org.id, f.id, { cropSeason: String(now.getUTCFullYear()) }),
        )) ?? [];
      const op = ops[0];
      if (op) {
        await step(
          {
            stream: 'operations',
            name: 'measurement-types',
            schema: deereFieldOperationMeasurementsSchema,
          },
          () => client.fieldOperationMeasurements(op.id),
        );
      }
    }
  }
}

export async function samsaraPlan(client: SamsaraClient, step: StepRunner): Promise<void> {
  const first = await step(
    { stream: 'positions', name: 'locations-feed', schema: samsaraLocationsFeedSchema },
    () => client.locationsFeed(null),
  );
  if (first?.pagination.hasNextPage && first.pagination.endCursor) {
    const after = first.pagination.endCursor;
    await step(
      { stream: 'positions', name: 'locations-feed', schema: samsaraLocationsFeedSchema },
      () => client.locationsFeed(after),
    );
  }
  await step({ stream: 'stats', name: 'stats-feed', schema: samsaraStatsFeedSchema }, () =>
    client.statsFeed(null),
  );
  await step(
    { stream: 'faults', name: 'fault-codes-feed', schema: samsaraFaultCodesFeedSchema },
    () => client.faultCodesFeed(null),
  );
}

/** Sources `connectors:record` knows. */
export const RECORD_SOURCES = ['deere', 'samsara'] as const;
export type RecordSource = (typeof RECORD_SOURCES)[number];
