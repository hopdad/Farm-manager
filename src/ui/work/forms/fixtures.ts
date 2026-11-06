/**
 * Complete JobViews and JobOptionsResponses for tests and e2e route mocks (no database), checked
 * against the contract's schemas by ./fixtures.test.ts. Override any part:
 *
 *   const job = makeJobView({ status: 'requested', field: null });
 *   const options = makeJobOptions({ products: [] });
 *
 * The ids are fixed uuids so the e2e mocks and the unit tests can name them.
 */
import { type BusinessLine, DEFAULT_BUSINESS_LINE, type JobKind } from '../../../domain/work-jobs';
import type { BoardSnapshot, JobOptionsResponse, JobView } from '../contract';

export const FIXTURE_IDS = {
  job: '6a1f3a0e-5f2e-4d61-9a3c-0d6b8e6c1a01',
  field: '0f0e5c1e-6a57-4c1a-9c55-3d7b2b0c9a01',
  otherField: '0f0e5c1e-6a57-4c1a-9c55-3d7b2b0c9a02',
  customer: '2c9b7a3f-1e5d-4c8a-9b0e-7f6d5c4b3a31',
  person: '2c9b7a3f-1e5d-4c8a-9b0e-7f6d5c4b3a32',
  glyphosate: '7d4c1b2a-3e4f-4a5b-8c6d-1e2f3a4b5c01',
  atrazine: '7d4c1b2a-3e4f-4a5b-8c6d-1e2f3a4b5c02',
  uan: '7d4c1b2a-3e4f-4a5b-8c6d-1e2f3a4b5c03',
  machine: '9e8d7c6b-5a49-4382-9716-a5b4c3d2e101',
  crew: '9e8d7c6b-5a49-4382-9716-a5b4c3d2e201',
  assignment: '9e8d7c6b-5a49-4382-9716-a5b4c3d2e301',
  jobProduct: '9e8d7c6b-5a49-4382-9716-a5b4c3d2e401',
} as const;

const AT = '2026-11-06T13:00:00.000Z';

export function makeJobView(overrides: Partial<JobView> = {}): JobView {
  const kind: JobKind = overrides.kind ?? 'spray';
  const businessLine: BusinessLine = overrides.businessLine ?? DEFAULT_BUSINESS_LINE[kind];
  return {
    id: FIXTURE_IDS.job,
    version: 3,
    kind,
    businessLine,
    status: 'planned',
    statusChangedAt: AT,
    title: null,
    summary: 'Spray · Abernath East 80 · 78.4 ac',
    field: {
      id: FIXTURE_IDS.field,
      name: 'Abernath East 80',
      farmName: 'Adrian',
      boundaryAcres: 78.42,
    },
    customer: { id: FIXTURE_IDS.customer, name: 'Halvorsen Bros. Farms' },
    window: { from: '2026-11-09T13:00:00.000Z', to: '2026-11-09T22:00:00.000Z' },
    cropYear: 2026,
    plannedAcres: 78.42,
    plannedAcresByHand: false,
    plannedQty: null,
    plannedUnit: null,
    priority: 3,
    sortKey: 10,
    notes: null,
    request: null,
    cancelledReason: null,
    deereWorkPlanId: null,
    assignments: [],
    products: [
      {
        id: FIXTURE_IDS.jobProduct,
        productId: FIXTURE_IDS.glyphosate,
        name: 'Glyphosate 5.5',
        kind: 'chemical',
        rate: 32,
        unit: 'floz_ac',
        suppliedBy: 'us',
        restrictedUse: false,
        epaRegNo: 'DEMO-0001',
      },
    ],
    flags: [],
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

export function makeJobOptions(overrides: Partial<JobOptionsResponse> = {}): JobOptionsResponse {
  return {
    products: [
      {
        id: FIXTURE_IDS.glyphosate,
        kind: 'chemical',
        name: 'Glyphosate 5.5',
        unit: 'gal',
        epaRegNo: 'DEMO-0001',
        restrictedUse: false,
        active: true,
      },
      {
        id: FIXTURE_IDS.atrazine,
        kind: 'chemical',
        name: 'Atrazine 4L',
        unit: 'gal',
        epaRegNo: 'DEMO-0003',
        restrictedUse: true,
        active: true,
      },
      {
        id: FIXTURE_IDS.uan,
        kind: 'fertilizer',
        name: '28% UAN',
        unit: 'gal',
        epaRegNo: null,
        restrictedUse: false,
        active: true,
      },
    ],
    customers: [
      { id: FIXTURE_IDS.customer, name: 'Halvorsen Bros. Farms', kind: 'org', orgName: null },
      {
        id: FIXTURE_IDS.person,
        name: 'Gail Pressler',
        kind: 'person',
        orgName: 'Juniper Hill Farms LLC',
      },
    ],
    fields: [
      {
        id: FIXTURE_IDS.field,
        name: 'Abernath East 80',
        farmName: 'Adrian',
        acres: 78.42,
        customerId: FIXTURE_IDS.customer,
      },
      {
        id: FIXTURE_IDS.otherField,
        name: 'Home 40',
        farmName: 'Home farm',
        acres: 39.6,
        customerId: null,
      },
    ],
    cropYears: [2026, 2027],
    currentCropYear: 2026,
    ...overrides,
  };
}

/** A board snapshot with these jobs, each in its lane (the shape GET /api/v1/jobs answers). */
export function makeSnapshot(
  jobs: JobView[],
  viewer: Partial<BoardSnapshot['viewer']> = {},
): BoardSnapshot {
  const lines: BusinessLine[] = ['spraying', 'grain', 'trucking', 'store'];
  const labels: Record<BusinessLine, string> = {
    spraying: 'Spraying',
    grain: 'Grain',
    trucking: 'Trucking',
    store: 'Store',
  };
  return {
    asOf: AT,
    viewer: { role: 'viewer', partyId: null, canPlan: false, ...viewer },
    lanes: lines.map((l) => ({
      businessLine: l,
      label: labels[l],
      jobs: jobs.filter((j) => j.businessLine === l),
    })),
  };
}
