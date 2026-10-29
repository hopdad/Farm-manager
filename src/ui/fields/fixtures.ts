/**
 * A complete FieldDetail for tests and for tab authors (no database): a cash-rent Deere field
 * with a landlord, five seasons and notes. Override any part:
 *
 *   const d = makeFieldDetail({ field: { tenure: 'owned', landlord: null } });
 */
import type { FieldDetail, FieldSummary } from '../../domain/fields';

export const FIXTURE_FIELD_ID = '0f0e5c1e-6a57-4c1a-9c55-3d7b2b0c9a01';

type Overrides = Partial<Omit<FieldDetail, 'field'>> & { field?: Partial<FieldSummary> };

export function makeFieldDetail(overrides: Overrides = {}): FieldDetail {
  const { field, ...rest } = overrides;
  return {
    field: {
      id: FIXTURE_FIELD_ID,
      name: 'Abernath East 80',
      farmId: '6d0a3e43-4a0e-4f36-b1f6-5a0f1b7d2c11',
      farmName: 'Adrian',
      tenure: 'cash_rent',
      acres: 78.42,
      countyFips: '26091',
      landlord: {
        id: '2c9b7a3f-1e5d-4c8a-9b0e-7f6d5c4b3a21',
        displayName: 'Ivan Abernath',
        kind: 'person',
        phone: '(517) 555-0109',
        email: 'ivan.abernath@example.com',
      },
      customer: null,
      deereFieldId: 'a09641b6-c3f0-55db-af84-b33b64f1ff85',
      active: true,
      ...field,
    },
    boundary: {
      id: '5b1e2d3c-4f5a-4b6c-8d7e-9f0a1b2c3d4e',
      acres: 78.42,
      source: 'deere',
      sourceRef: 'Abernath East',
      validFrom: '2024-03-01T05:00:00.000Z',
      bbox: [-84.020423, 41.939085, -84.015804, 41.946159],
      editable: false,
      readOnlyReason:
        'This boundary comes from John Deere Operations Center. Change it there; the app picks it up on the next sync.',
    },
    seasons: [
      {
        cropYear: 2025,
        crop: 'soybeans',
        variety: 'NF 2.2E9',
        plantedOn: '2025-05-08',
        harvestedOn: '2025-10-03',
        yieldBuAc: 58.46,
        source: 'deere',
      },
      {
        cropYear: 2024,
        crop: 'corn',
        variety: 'NF 110-79',
        plantedOn: '2024-05-05',
        harvestedOn: '2024-10-14',
        yieldBuAc: 197.94,
        source: 'deere',
      },
      {
        cropYear: 2023,
        crop: 'soybeans',
        variety: 'NF 2.6E9',
        plantedOn: '2023-05-08',
        harvestedOn: '2023-09-24',
        yieldBuAc: 49.6,
        source: 'import',
      },
      {
        cropYear: 2022,
        crop: 'corn',
        variety: null,
        plantedOn: '2022-04-25',
        harvestedOn: '2023-01-04',
        yieldBuAc: 181.67,
        source: 'import',
      },
      {
        cropYear: 2021,
        crop: 'soybeans',
        variety: 'NF 3.2E2',
        plantedOn: null,
        harvestedOn: null,
        yieldBuAc: null,
        source: 'import',
      },
    ],
    soils: [],
    soilsSummary: null,
    parcels: [],
    openJobs: { count: 0, placeholder: true },
    notes: {
      text: 'Wet hole in the NW corner after big rains.\nGate code 1234.',
      updatedAt: '2026-10-29T13:55:00.000Z',
      updatedByName: 'Dana Ruiz',
      version: '2026-10-29T13:55:00.123456Z',
    },
    lineage: { parents: [], children: [] },
    openBoundaryRequests: 0,
    spray: null,
    ...rest,
  };
}
