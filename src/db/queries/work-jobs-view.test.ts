/**
 * toJobView (src/db/queries/work-jobs-view.ts): the view's TS half, from a statement row: the
 * summary, initials, two-decimal acres, alsoOn summaries and the flags, all from the stored
 * values; the result matches the contract's jobViewSchema.
 */
import { describe, expect, test } from 'vitest';
import { jobViewSchema } from '../../ui/work/contract';
import { type JobViewRow, toJobView, toLanes } from './work-jobs-view';

const ID = '1a1a1a1a-0000-4000-8000-000000000001';
const FIELD = '2b2b2b2b-0000-4000-8000-000000000002';
const M = '3c3c3c3c-0000-4000-8000-000000000003';
const P = '4d4d4d4d-0000-4000-8000-000000000004';
const OTHER = '5e5e5e5e-0000-4000-8000-000000000005';

function row(over: Partial<JobViewRow> = {}): JobViewRow {
  return {
    id: ID,
    version: 3,
    kind: 'spray',
    business_line: 'spraying',
    status: 'assigned',
    status_changed_at: '2026-11-06T14:30:00.000Z',
    title: null,
    field_id: FIELD,
    field_name: 'Halvorsen Corwin 80',
    farm_name: 'Halvorsen',
    boundary_acres: 78.43219,
    customer_id: null,
    customer_name: null,
    window: { from: '2026-11-06T13:00:00.000Z', to: '2026-11-06T22:00:00.000Z' },
    crop_year: 2027,
    planned_acres: 78.4321,
    planned_acres_by_hand: false,
    planned_qty: null,
    planned_unit: null,
    priority: 2,
    sort_key: 10,
    notes: null,
    request_channel: null,
    requested_by_party_id: null,
    requester_name: null,
    requester_phone: null,
    via_link: false,
    cancelled_reason: null,
    deere_work_plan_id: null,
    created_at: '2026-11-05T10:00:00.000Z',
    updated_at: '2026-11-06T14:30:00.000Z',
    assignments: [
      {
        id: '6f6f6f6f-0000-4000-8000-000000000006',
        role: 'operator',
        machine: { id: M, unitNo: 'SP2', kind: 'sprayer', status: 'down', workPlanCapable: false },
        person: { partyId: P, name: 'Dale Mercer' },
        plannedFor: null,
        alsoOn: [
          {
            jobId: OTHER,
            title: null,
            kind: 'harvest',
            fieldName: 'Stanwick 80',
            plannedAcres: null,
            plannedQty: 9500,
            plannedUnit: 'bu',
          },
        ],
      },
    ],
    products: [
      {
        id: '7a7a7a7a-0000-4000-8000-000000000007',
        productId: '8b8b8b8b-0000-4000-8000-000000000008',
        name: 'Atrazine',
        kind: 'chemical',
        rate: 1,
        unit: 'qt_ac',
        suppliedBy: 'us',
        restrictedUse: true,
        epaRegNo: 'DEMO-0003',
      },
    ],
    ...over,
  };
}

describe('toJobView', () => {
  test('a full row: summary, initials, rounded acres, alsoOn summaries, flags; schema-valid', () => {
    const v = toJobView(row());
    expect(jobViewSchema.parse(v)).toEqual(v);
    expect(v).toMatchObject({
      summary: 'Spray · Halvorsen Corwin 80 · 78 ac',
      plannedAcres: 78.43,
      field: { id: FIELD, boundaryAcres: 78.43 },
      assignments: [
        {
          person: { partyId: P, name: 'Dale Mercer', initials: 'DM' },
          alsoOn: [{ jobId: OTHER, summary: 'Harvest · Stanwick 80 · 9,500 bu' }],
        },
      ],
      // The stored acres differ by 0.0001: not flagged; a down machine, an overlap, a
      // restricted-use product are.
      flags: ['machine_down', 'double_booked', 'restricted_use'],
      request: null,
    });
  });

  test('no field: no field view, no boundary acres, no_field; JSON text columns parse too', () => {
    const v = toJobView(
      row({
        field_id: null,
        field_name: null,
        boundary_acres: 12,
        planned_acres: 30,
        assignments: '[]',
        products: '[]',
        request_channel: 'phone',
        requester_name: 'Gail',
        via_link: true,
      }),
    );
    expect(v).toMatchObject({
      field: null,
      flags: ['no_field'],
      summary: 'Spray · 30 ac',
      request: { channel: 'phone', partyId: null, name: 'Gail', phone: null, viaLink: true },
      assignments: [],
      products: [],
    });
  });

  test('acres that differ by more than 1 % of the boundary are flagged', () => {
    expect(toJobView(row({ planned_acres: 80, assignments: [], products: [] })).flags).toEqual([
      'acres_differ',
    ]);
  });
});

describe('toLanes', () => {
  test('always the four lanes in BUSINESS_LINES order, each with its jobs in the order given', () => {
    const a = toJobView(row({ assignments: [], products: [] }));
    const b = { ...a, id: OTHER, businessLine: 'store' as const };
    const lanes = toLanes([b, a]);
    expect(lanes.map((l) => [l.businessLine, l.label, l.jobs.map((j) => j.id)])).toEqual([
      ['spraying', 'Spraying', [ID]],
      ['grain', 'Grain', []],
      ['trucking', 'Trucking', []],
      ['store', 'Store', [OTHER]],
    ]);
  });
});
