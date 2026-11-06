/**
 * Row fixtures for the job board's DB tests (slice 2a, jobs-api): machines, crew people with or
 * without a sign-in, products, customers and jobs written straight into a test database. Tests
 * only (production code never imports it). Every row is source 'test' with a random key, so
 * tests in one file don't collide.
 */
import type { MultiPolygon } from 'geojson';
import type { AppRole } from '../../domain/farm';
import type { MachineKind, MachineStatus } from '../../domain/fleet';
import type {
  BusinessLine,
  JobKind,
  JobStatus,
  ProductKind,
  ProductUnit,
} from '../../domain/work-jobs';
import { insertField, squareMultiPolygon } from '../../test/fixtures';
import type { Db } from '../client';
import { type Executor, exec } from '../exec';

const key = () => Math.random().toString(16).slice(2, 10);

export async function insertTestMachine(
  ex: Executor,
  opts: { unitNo?: string; kind?: MachineKind; status?: MachineStatus; source?: string } = {},
): Promise<string> {
  const r = await exec<{ id: string }>(
    ex,
    `insert into farm.machines (kind, unit_no, status, source, source_id)
     values ($1, $2, $3, $4, $5) returning id::text as id`,
    [
      opts.kind ?? 'sprayer',
      opts.unitNo ?? `T${key().slice(0, 4).toUpperCase()}`,
      opts.status ?? 'active',
      opts.source ?? 'test',
      `machine:${key()}`,
    ],
  );
  return r.rows[0]?.id as string;
}

/** A crew person (party kind person, role crew), with a sign-in when `appRole` is given. */
export async function insertTestPerson(
  ex: Executor,
  name: string,
  opts: { appRole?: AppRole; active?: boolean; roles?: string[]; kind?: 'person' | 'org' } = {},
): Promise<{ partyId: string; appUserId: string | null }> {
  const p = await exec<{ id: string }>(
    ex,
    `insert into farm.parties (kind, display_name, roles, source, source_id)
     values ($1, $2, $3::text[], 'test', $4) returning id::text as id`,
    [opts.kind ?? 'person', name, opts.roles ?? ['crew'], `party:${key()}`],
  );
  const partyId = p.rows[0]?.id as string;
  if (!opts.appRole) return { partyId, appUserId: null };
  const u = await exec<{ id: string }>(
    ex,
    `insert into farm.app_users (party_id, role, active, source, source_id)
     values ($1::uuid, $2, $3, 'test', $4) returning id::text as id`,
    [partyId, opts.appRole, opts.active ?? true, `user:${key()}`],
  );
  return { partyId, appUserId: u.rows[0]?.id as string };
}

/** A customer org party. */
export async function insertTestCustomer(ex: Executor, name: string): Promise<string> {
  const r = await exec<{ id: string }>(
    ex,
    `insert into farm.parties (kind, display_name, roles, source, source_id)
     values ('org', $1, '{customer}', 'test', $2) returning id::text as id`,
    [name, `customer:${key()}`],
  );
  return r.rows[0]?.id as string;
}

export async function insertTestProduct(
  ex: Executor,
  opts: {
    name?: string;
    kind?: ProductKind;
    unit?: ProductUnit;
    restrictedUse?: boolean;
    active?: boolean;
    epaRegNo?: string | null;
  } = {},
): Promise<string> {
  const r = await exec<{ id: string }>(
    ex,
    `insert into farm.products (kind, name, epa_reg_no, restricted_use, unit, active, source, source_id)
     values ($1, $2, $3, $4, $5, $6, 'test', $7) returning id::text as id`,
    [
      opts.kind ?? 'chemical',
      opts.name ?? `Product ${key()}`,
      opts.epaRegNo ?? null,
      opts.restrictedUse ?? false,
      opts.unit ?? 'gal',
      opts.active ?? true,
      `product:${key()}`,
    ],
  );
  return r.rows[0]?.id as string;
}

export interface TestJobInput {
  kind?: JobKind;
  businessLine?: BusinessLine;
  status?: JobStatus;
  title?: string | null;
  fieldId?: string | null;
  customerPartyId?: string | null;
  /** [from, to) as ISO strings; null = no window. */
  window?: { from: string | null; to: string | null } | null;
  plannedAcres?: number | null;
  priority?: number;
  sortKey?: number;
  statusChangedAt?: Date;
  source?: string;
}

/** A job row written directly (no API rules applied). */
export async function insertTestJob(ex: Executor, j: TestJobInput = {}): Promise<string> {
  const r = await exec<{ id: string }>(
    ex,
    `insert into farm.jobs (kind, business_line, status, status_changed_at, title, field_id,
                            customer_party_id, planned_window, planned_acres, priority, sort_key,
                            source, source_id)
     values ($1, $2, $3, coalesce($4::timestamptz, now()), $5, $6::uuid, $7::uuid,
             case when $8::boolean then tstzrange($9::timestamptz, $10::timestamptz, '[)') end,
             $11, $12, $13, $14, $15)
     returning id::text as id`,
    [
      j.kind ?? 'spray',
      j.businessLine ?? 'spraying',
      j.status ?? 'planned',
      j.statusChangedAt ?? null,
      j.title ?? null,
      j.fieldId ?? null,
      j.customerPartyId ?? null,
      j.window != null,
      j.window?.from ?? null,
      j.window?.to ?? null,
      j.plannedAcres ?? null,
      j.priority ?? 3,
      j.sortKey ?? 0,
      j.source ?? 'test',
      `job:${key()}`,
    ],
  );
  return r.rows[0]?.id as string;
}

export async function insertTestAssignment(
  ex: Executor,
  jobId: string,
  a: {
    machineId?: string | null;
    partyId?: string | null;
    plannedFor?: { from: string; to: string } | null;
  },
): Promise<string> {
  const r = await exec<{ id: string }>(
    ex,
    `insert into farm.job_assignments (job_id, machine_id, party_id, role, planned_for)
     values ($1::uuid, $2::uuid, $3::uuid, $4,
             case when $5::timestamptz is null then null
                  else tstzrange($5::timestamptz, $6::timestamptz, '[)') end)
     returning id::text as id`,
    [
      jobId,
      a.machineId ?? null,
      a.partyId ?? null,
      a.machineId ? 'operator' : 'crew',
      a.plannedFor?.from ?? null,
      a.plannedFor?.to ?? null,
    ],
  );
  return r.rows[0]?.id as string;
}

/** A field with a square boundary of `sideMetres` whose south-west corner is (lng, lat). */
export async function insertTestField(
  db: Db,
  opts: { name?: string; lng: number; lat: number; sideMetres?: number },
): Promise<{ farmId: string; fieldId: string; geom: MultiPolygon }> {
  const geom = squareMultiPolygon(opts.lng, opts.lat, opts.sideMetres ?? 400);
  const { farmId, fieldId } = await insertField(db, {
    name: opts.name ?? `Jobs ${key()}`,
    geom,
    tenure: 'owned',
  });
  return { farmId, fieldId, geom };
}
