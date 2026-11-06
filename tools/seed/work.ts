/**
 * The job board's demo data (slice 2a; docs/contracts-2a.md §9), written by `pnpm db:seed demo`
 * after the demo farm and the demo people (tools/seed/extras.ts):
 *
 *  - eight products (decision 2a-12): two herbicides and a restricted-use one with (made-up,
 *    clearly marked) EPA numbers, a fungicide, seed corn and soybeans, 28% UAN, diesel;
 *  - ten jobs across the four lanes in mixed statuses on demo fields, among them the done-when's
 *    pieces: an UNASSIGNED spray job on a Halvorsen field (planned, no one on it) and a
 *    REQUESTED spray job with no field yet (Juniper Hill phoned it in), to drag onto a field,
 *    then onto SP2 and an operator; SP2 is left free;
 *  - the Halvorsen data-rights agreement, all uses (decision 2a-10); none for Juniper Hill, so
 *    /admin/connectors shows both states;
 *  - the customer orgs' party links the gate resolves (contracts-2a §4.4): ('deere', 'party',
 *    <org>, <org>) -> the customer party, for Halvorsen's own org (org-customer-1) and Juniper
 *    Hill's (org-customer-2, which shares its fields with us and has no farm ref of its own).
 *    Written only when the org has no link yet (a link made on /admin/connectors stays).
 *
 * Every row is source 'demo' with id = demoId(key), so it never travels in data:export and the
 * ids survive db:reset. Idempotent: products and the agreement change only when a seeded column
 * differs (`active`, `label_rules` and the agreement's `revoked_on` are written on insert only:
 * they are yours to change on /admin); jobs are written ONCE (insert only, with their
 * assignments and products), so what the demo did on the board stays until db:reset. Windows
 * are set from the farm day of the first run (America/Detroit). The rows are found in the
 * database by their demo keys (farms, fields, machines, crew), so any `--seed` works.
 */
import type pg from 'pg';
import { exec } from '../../src/db/exec';
import { fieldGrowingYear } from '../../src/db/queries/operations';
import { cropSeasonsToSync, currentCropYear } from '../../src/domain/crops';
import { demoId } from '../../src/domain/ids';
import type {
  BusinessLine,
  JobKind,
  JobPlannedUnit,
  JobPriority,
  JobStatus,
  PermittedUse,
  ProductKind,
  ProductUnit,
  RateUnit,
  RequestChannel,
  SuppliedBy,
} from '../../src/domain/work-jobs';
import { PERMITTED_USES } from '../../src/domain/work-jobs';
import { demoUserId } from '../../src/platform/auth/demo';
import { CUSTOMER_ONLY_ORG, SHARED_CUSTOMER_ORG } from '../../src/sim/farm/build';
import { civilDayNumber, hhmm, localDayTime, localParts } from '../../src/sim/time';

export const WORK_DEMO_SOURCE = 'demo';

export interface DemoProduct {
  key: string;
  kind: ProductKind;
  name: string;
  epaRegNo: string | null;
  restrictedUse: boolean;
  unit: ProductUnit;
}

/** Decision 2a-12. EPA numbers are placeholders (DEMO-…), never a real registration. */
export const DEMO_PRODUCTS: readonly DemoProduct[] = [
  {
    key: 'product-glyphosate',
    kind: 'chemical',
    name: 'Glyphosate 5.5 (demo)',
    epaRegNo: 'DEMO-0001',
    restrictedUse: false,
    unit: 'gal',
  },
  {
    key: 'product-24d',
    kind: 'chemical',
    name: '2,4-D Amine 4 (demo)',
    epaRegNo: 'DEMO-0002',
    restrictedUse: false,
    unit: 'gal',
  },
  {
    key: 'product-atrazine',
    kind: 'chemical',
    name: 'Atrazine 4L (demo, restricted use)',
    epaRegNo: 'DEMO-0003',
    restrictedUse: true,
    unit: 'gal',
  },
  {
    key: 'product-fungicide',
    kind: 'chemical',
    name: 'Azoxystrobin fungicide (demo)',
    epaRegNo: 'DEMO-0004',
    restrictedUse: false,
    unit: 'gal',
  },
  {
    key: 'product-seed-corn',
    kind: 'seed',
    name: 'Seed corn 108-day (demo)',
    epaRegNo: null,
    restrictedUse: false,
    unit: 'unit',
  },
  {
    key: 'product-seed-soy',
    kind: 'seed',
    name: 'Soybean seed 2.8 RM (demo)',
    epaRegNo: null,
    restrictedUse: false,
    unit: 'unit',
  },
  {
    key: 'product-uan28',
    kind: 'fertilizer',
    name: '28% UAN',
    epaRegNo: null,
    restrictedUse: false,
    unit: 'gal',
  },
  {
    key: 'product-diesel',
    kind: 'fuel',
    name: 'Off-road diesel',
    epaRegNo: null,
    restrictedUse: false,
    unit: 'gal',
  },
];

/** Which demo field a job is on: the n-th field (by key) of a demo farm group. */
type FieldPick = { group: 'own' | 'halvorsen' | 'juniper'; n: number };

export interface DemoJob {
  key: string;
  kind: JobKind;
  businessLine: BusinessLine;
  status: JobStatus;
  title: string | null;
  field: FieldPick | null;
  customer: 'halvorsen' | 'juniper' | null;
  /** Farm day offset from the first run's farm day, and local 'HH:MM' times. */
  window: { day: number; from: string; toDay?: number; to: string } | null;
  plannedQty?: number;
  plannedUnit?: JobPlannedUnit;
  priority: JobPriority;
  notes?: string;
  /** Who asked: their party (a demo key) and, as typed, a name and phone. */
  request?: { channel: RequestChannel; partyKey: string; name: string; phone: string };
  /** Machine keys (src/sim/farm/fleet.ts) and crew keys (src/sim/farm/names.ts), one row each. */
  assignments: { machine?: string; person?: string }[];
  products: { key: string; rate: number; unit: RateUnit; suppliedBy: SuppliedBy }[];
}

export const DEMO_JOBS: readonly DemoJob[] = [
  {
    // The done-when's job "on a field with no assignment".
    key: 'job-spray-halvorsen-burndown',
    kind: 'spray',
    businessLine: 'spraying',
    status: 'planned',
    title: null,
    field: { group: 'halvorsen', n: 0 },
    customer: 'halvorsen',
    window: { day: 0, from: '08:00', to: '17:00' },
    priority: 2,
    notes: 'Fall burndown. Mark wants it done before the rain.',
    assignments: [],
    products: [
      { key: 'product-glyphosate', rate: 32, unit: 'floz_ac', suppliedBy: 'us' },
      { key: 'product-24d', rate: 1, unit: 'pt_ac', suppliedBy: 'us' },
    ],
  },
  {
    // A request by phone, no field yet: drag it onto a field, then onto SP2 and an operator.
    key: 'job-spray-juniper-request',
    kind: 'spray',
    businessLine: 'spraying',
    status: 'requested',
    title: 'Fungicide pass',
    field: null,
    customer: 'juniper',
    window: { day: 1, from: '09:00', to: '15:00' },
    priority: 3,
    request: {
      channel: 'phone',
      partyKey: 'customer-juniper-hill-gail',
      name: 'Gail Pressler',
      phone: '734-555-0142',
    },
    assignments: [],
    products: [{ key: 'product-fungicide', rate: 6, unit: 'floz_ac', suppliedBy: 'customer' }],
  },
  {
    key: 'job-spray-own-atrazine',
    kind: 'spray',
    businessLine: 'spraying',
    status: 'assigned',
    title: null,
    field: { group: 'own', n: 0 },
    customer: null,
    window: { day: 0, from: '07:00', to: '12:00' },
    priority: 3,
    assignments: [{ machine: 'sprayer-1', person: 'crew-tom' }],
    products: [{ key: 'product-atrazine', rate: 1, unit: 'qt_ac', suppliedBy: 'us' }],
  },
  {
    key: 'job-scout-halvorsen',
    kind: 'scout',
    businessLine: 'spraying',
    status: 'done',
    title: 'Weed check before the burndown',
    field: { group: 'halvorsen', n: 1 },
    customer: 'halvorsen',
    window: { day: 0, from: '07:00', to: '08:00' },
    priority: 3,
    assignments: [{ person: 'crew-amy' }],
    products: [],
  },
  {
    key: 'job-harvest-c1',
    kind: 'harvest',
    businessLine: 'grain',
    status: 'in_progress',
    title: null,
    field: { group: 'own', n: 1 },
    customer: null,
    window: { day: 0, from: '07:00', to: '19:00' },
    plannedQty: 12_000,
    plannedUnit: 'bu',
    priority: 1,
    assignments: [
      { machine: 'combine-1', person: 'crew-dale' },
      { machine: 'cart-1', person: 'crew-jake' },
    ],
    products: [],
  },
  {
    key: 'job-harvest-c2',
    kind: 'harvest',
    businessLine: 'grain',
    status: 'assigned',
    title: null,
    field: { group: 'own', n: 2 },
    customer: null,
    window: { day: 0, from: '08:00', toDay: 1, to: '19:00' },
    plannedQty: 9_500,
    plannedUnit: 'bu',
    priority: 2,
    assignments: [{ machine: 'combine-2', person: 'crew-luis' }],
    products: [],
  },
  {
    key: 'job-tillage-t1',
    kind: 'tillage',
    businessLine: 'grain',
    // A field and a machine: assigned (autoJobStatus), though no one is on the tractor yet.
    status: 'assigned',
    title: 'Fall chisel behind the combine',
    field: { group: 'own', n: 3 },
    customer: null,
    window: { day: 2, from: '08:00', to: '18:00' },
    priority: 4,
    assignments: [{ machine: 'tractor-cnh-1' }],
    products: [],
  },
  {
    key: 'job-haul-s1',
    kind: 'haul',
    businessLine: 'trucking',
    status: 'in_progress',
    title: 'Corn to the elevator',
    field: { group: 'own', n: 1 },
    customer: null,
    window: { day: 0, from: '07:30', to: '19:30' },
    plannedQty: 14,
    plannedUnit: 'loads',
    priority: 2,
    assignments: [{ machine: 'semi-1', person: 'crew-ben' }],
    products: [],
  },
  {
    key: 'job-haul-s2',
    kind: 'haul',
    businessLine: 'trucking',
    status: 'planned',
    title: null,
    field: { group: 'own', n: 2 },
    customer: null,
    window: { day: 1, from: '08:00', to: '18:00' },
    plannedQty: 10,
    plannedUnit: 'loads',
    priority: 3,
    assignments: [],
    products: [],
  },
  {
    key: 'job-store-uan-juniper',
    kind: 'other',
    businessLine: 'store',
    status: 'planned',
    title: 'Deliver 28% to Juniper Hill',
    field: null,
    customer: 'juniper',
    window: { day: 3, from: '10:00', to: '12:00' },
    plannedQty: 2_500,
    plannedUnit: 'gal',
    priority: 3,
    assignments: [{ machine: 'semi-2' }],
    products: [{ key: 'product-uan28', rate: 2_500, unit: 'gal', suppliedBy: 'us' }],
  },
];

/** The Halvorsen agreement (decision 2a-10): all uses; none for Juniper Hill. */
export const DEMO_AGREEMENT = {
  key: 'agreement-halvorsen',
  customer: 'customer-halvorsen',
  signedOn: '2026-10-01',
  permittedUses: [...PERMITTED_USES] as PermittedUse[],
  notes: 'Demo agreement (fictional): signed by Mark Halvorsen for all four uses.',
} as const;

/**
 * The demo's customer orgs and their parties (contracts-2a §4.4): the ('deere', 'party', org,
 * org) links the data-rights gate and customerOrgParty resolve. Juniper Hill's org has no farm
 * ref (its fields are shared from its own org into ours), so without this link the gate could
 * not tell whose org it is.
 */
export const DEMO_CUSTOMER_ORGS = [
  { org: CUSTOMER_ONLY_ORG, party: 'customer-halvorsen' },
  { org: SHARED_CUSTOMER_ORG, party: 'customer-juniper-hill' },
] as const;

export interface WorkSeedReport {
  products: { inserted: number; updated: number; unchanged: number };
  jobs: { inserted: number; existing: number; skipped: number };
  agreements: { inserted: number; updated: number; unchanged: number };
  /** Customer-org party links written (an org already linked is left alone). */
  orgLinks: { inserted: number; existing: number };
}

type Outcome = 'inserted' | 'updated' | 'unchanged';

async function upsert(c: pg.PoolClient, text: string, values: unknown[]): Promise<Outcome> {
  const r = await exec<{ inserted: boolean }>(c, text, values);
  const row = r.rows[0];
  if (!row) return 'unchanged';
  return row.inserted ? 'inserted' : 'updated';
}

/** Demo field ids by group, ordered by their demo key (source_id). */
async function demoFields(c: pg.PoolClient): Promise<Record<FieldPick['group'], string[]>> {
  const r = await exec<{ id: string; farm: string | null; client: string | null }>(
    c,
    `select f.id::text as id, fa.source_id as farm, fa.client_party_id::text as client
       from farm.fields f join farm.farms fa on fa.id = f.farm_id
      where f.source = 'demo' and f.active
        and exists (select 1 from farm.current_boundaries b where b.field_id = f.id)
      order by f.source_id`,
  );
  return {
    own: r.rows.filter((x) => x.client === null).map((x) => x.id),
    halvorsen: r.rows.filter((x) => x.farm === 'farm-halvorsen').map((x) => x.id),
    juniper: r.rows.filter((x) => x.farm === 'farm-juniper-hill').map((x) => x.id),
  };
}

/** The UTC instant of local 'HH:MM' on the farm day `dayOffset` days after `now`'s. */
function localInstant(now: Date, dayOffset: number, time: string): Date {
  const p = localParts(now.getTime());
  return new Date(localDayTime(civilDayNumber(p.y, p.m, p.d) + dayOffset, hhmm(time)));
}

/**
 * Write the job board's demo rows (see the header). Needs the demo farm (tools/seed/demo.ts);
 * without it nothing is written. One transaction. The caller owns the pool.
 */
export async function seedDemoWork(
  pool: pg.Pool,
  opts: { now?: Date } = {},
): Promise<WorkSeedReport> {
  const now = opts.now ?? new Date();
  const report: WorkSeedReport = {
    products: { inserted: 0, updated: 0, unchanged: 0 },
    jobs: { inserted: 0, existing: 0, skipped: 0 },
    agreements: { inserted: 0, updated: 0, unchanged: 0 },
    orgLinks: { inserted: 0, existing: 0 },
  };
  const c = await pool.connect();
  try {
    await c.query('begin');
    const farmSeeded = await exec<{ n: number }>(
      c,
      `select count(*)::int as n from farm.fields where source = 'demo'`,
    );
    if (!farmSeeded.rows[0]?.n) {
      await c.query('rollback');
      report.jobs.skipped = DEMO_JOBS.length;
      return report;
    }

    for (const p of DEMO_PRODUCTS) {
      report.products[
        await upsert(
          c,
          `insert into farm.products as t (id, kind, name, epa_reg_no, restricted_use, unit, source, source_id)
           values ($1::uuid, $2, $3, $4, $5, $6, $7, $8)
           on conflict (id) do update set
             kind = excluded.kind, name = excluded.name, epa_reg_no = excluded.epa_reg_no,
             restricted_use = excluded.restricted_use, unit = excluded.unit, updated_at = now()
           where (t.kind, t.name, t.epa_reg_no, t.restricted_use, t.unit)
             is distinct from (excluded.kind, excluded.name, excluded.epa_reg_no,
                               excluded.restricted_use, excluded.unit)
           returning (xmax = 0) as inserted`,
          [
            demoId(p.key),
            p.kind,
            p.name,
            p.epaRegNo,
            p.restrictedUse,
            p.unit,
            WORK_DEMO_SOURCE,
            p.key,
          ],
        )
      ]++;
    }

    const fields = await demoFields(c);
    const customers = {
      halvorsen: demoId('customer-halvorsen'),
      juniper: demoId('customer-juniper-hill'),
    };
    const amy = demoUserId('crew-amy');
    const seasons = cropSeasonsToSync(now);
    for (const [i, j] of DEMO_JOBS.entries()) {
      const fieldId = j.field ? (fields[j.field.group][j.field.n] ?? null) : null;
      if (j.field && !fieldId) {
        report.jobs.skipped++;
        continue;
      }
      // Decision 2a-6 (contracts-2a §4.6): the field's growing year, else the calendar year.
      const cropYear = fieldId
        ? ((await fieldGrowingYear(c, fieldId, seasons)) ?? currentCropYear(now))
        : null;
      const win = j.window
        ? {
            from: localInstant(now, j.window.day, j.window.from),
            to: localInstant(now, j.window.toDay ?? j.window.day, j.window.to),
          }
        : null;
      const customer = j.customer ? customers[j.customer] : null;
      const inserted = await exec<{ id: string }>(
        c,
        `insert into farm.jobs (id, kind, business_line, status, status_changed_at, title,
                                customer_party_id, field_id, planned_window, crop_year,
                                planned_acres, planned_qty, planned_unit, priority, sort_key,
                                notes, request_channel, requested_by_party_id, requester_name,
                                requester_phone, created_by, updated_by, source, source_id)
         select $1::uuid, $2, $3, $4, $5, $6,
                (select id from farm.parties where id = $7::uuid), $8::uuid,
                case when $9::timestamptz is null then null
                     else tstzrange($9::timestamptz, $10::timestamptz, '[)') end,
                $11::int,
                (select acres from farm.current_boundaries where field_id = $8::uuid),
                $12, $13, $14, $15, $16, $17,
                (select id from farm.parties where id = $23::uuid),
                $18, $19,
                (select id from farm.app_users where id = $20::uuid),
                (select id from farm.app_users where id = $20::uuid),
                $21, $22
         on conflict (id) do nothing
         returning id::text as id`,
        [
          demoId(j.key),
          j.kind,
          j.businessLine,
          j.status,
          now,
          j.title,
          customer,
          fieldId,
          win?.from ?? null,
          win?.to ?? null,
          cropYear,
          j.plannedQty ?? null,
          j.plannedUnit ?? null,
          j.priority,
          (i + 1) * 10,
          j.notes ?? null,
          j.request?.channel ?? null,
          j.request?.name ?? null,
          j.request?.phone ?? null,
          amy,
          WORK_DEMO_SOURCE,
          j.key,
          j.request ? demoId(j.request.partyKey) : null,
        ],
      );
      if (!inserted.rows[0]) {
        report.jobs.existing++;
        continue;
      }
      report.jobs.inserted++;
      for (const [n, a] of j.assignments.entries()) {
        await exec(
          c,
          `insert into farm.job_assignments (id, job_id, party_id, machine_id, role, assigned_by)
           values ($1::uuid, $2::uuid, (select id from farm.parties where id = $3::uuid),
                   (select id from farm.machines where id = $4::uuid), $5,
                   (select id from farm.app_users where id = $6::uuid))
           on conflict (id) do nothing`,
          [
            demoId(`${j.key}:assignment:${n}`),
            demoId(j.key),
            a.person ? demoId(a.person) : null,
            a.machine ? demoId(a.machine) : null,
            a.machine ? 'operator' : 'crew',
            amy,
          ],
        );
      }
      for (const [n, p] of j.products.entries()) {
        await exec(
          c,
          `insert into farm.job_products (id, job_id, product_id, rate, unit, supplied_by)
           values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)
           on conflict (id) do nothing`,
          [
            demoId(`${j.key}:product:${n}`),
            demoId(j.key),
            demoId(p.key),
            p.rate,
            p.unit,
            p.suppliedBy,
          ],
        );
      }
    }

    const a = DEMO_AGREEMENT;
    report.agreements[
      await upsert(
        c,
        `insert into farm.data_rights_agreements as t (id, party_id, signed_on, permitted_uses, notes, source, source_id)
         select $1::uuid, p.id, $3::date, $4::text[], $5, $6, $7
           from farm.parties p where p.id = $2::uuid
         on conflict (id) do update set
           party_id = excluded.party_id, signed_on = excluded.signed_on,
           permitted_uses = excluded.permitted_uses, notes = excluded.notes, updated_at = now()
         where (t.party_id, t.signed_on, t.permitted_uses, t.notes)
           is distinct from (excluded.party_id, excluded.signed_on, excluded.permitted_uses,
                             excluded.notes)
         returning (xmax = 0) as inserted`,
        [
          demoId(a.key),
          demoId(a.customer),
          a.signedOn,
          a.permittedUses,
          a.notes,
          WORK_DEMO_SOURCE,
          a.key,
        ],
      )
    ]++;

    for (const o of DEMO_CUSTOMER_ORGS) {
      const r = await exec(
        c,
        `insert into ingest.external_refs (source, kind, external_id, source_org, entity_id)
         select 'deere', 'party', $1, $1, p.id from farm.parties p where p.id = $2::uuid
         on conflict (source, kind, external_id, source_org) do nothing`,
        [o.org, demoId(o.party)],
      );
      report.orgLinks[r.rowCount ? 'inserted' : 'existing']++;
    }
    await c.query('commit');
    return report;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** Report lines for the seed's output (two-space indent like formatSeedReport). */
export function formatWorkReport(r: WorkSeedReport): string[] {
  return [
    `  job board          ${DEMO_PRODUCTS.length} products (${r.products.inserted} new), ${r.jobs.inserted} jobs new, ${r.jobs.existing} kept${r.jobs.skipped ? `, ${r.jobs.skipped} skipped (no demo field)` : ''}, Halvorsen agreement ${r.agreements.inserted ? 'added' : 'on file'}${r.orgLinks.inserted ? `, ${r.orgLinks.inserted} customer-org links` : ''}`,
  ];
}
