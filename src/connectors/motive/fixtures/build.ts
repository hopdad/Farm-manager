/**
 * Builds the DOC-DERIVED Motive replay fixtures (slice 1f.2, the trucks builder;
 * docs/contracts-1f.md §B.6). SHAPES: Motive's official OpenAPI 3.1 (the examples behind
 *   https://developer-docs.gomotive.com/reference/identify-a-company-using-its-access-token
 *   https://developer-docs.gomotive.com/reference/fetch-a-list-of-all-the-vehicles-and-their-locations-v2
 *   https://developer-docs.gomotive.com/reference/fetch-a-list-of-all-the-vehicles-and-their-locations-v3
 *   https://developer-docs.gomotive.com/reference/fetch-a-list-of-all-the-vehicles-fault-codes
 *   https://developer-docs.gomotive.com/reference/list-all-the-company-vehicles
 *   https://developer-docs.gomotive.com/reference/fetch-a-list-of-all-the-groups-of-a-company
 * ), typed by ../schemas.ts. VALUES: the simulated demo farm (src/sim, seed 1, harvest-day): no
 * real farm data; the one vehicle is the hired hauler H1 under the id the demo seed maps
 * (`simExternalRefs`), so `CONNECTOR_MOTIVE=replay` drives the board.
 *
 * Motive answers only current state (no cursor), so each exchange is the one page a poll gets:
 * H1's location at the fixture's `anchor`, which the 1 s time-shift step moves to the moment of
 * the call (every poll a fresh fix, as the live API would give a parked truck). The fault
 * fixture (60 s step) carries one open J1939 fault and one closed OBD-II code, so replay
 * exercises both mappings; the vehicle list names H1's group "Semi".
 *
 * The committed JSON under ./doc-derived/ is this module's output; ./fixtures.test.ts fails when
 * they drift. Regenerate with
 *   pnpm exec tsx src/connectors/motive/fixtures/write.ts   then   pnpm lint:fix
 */

import { simTelematicsMachines } from '../../../sim/types';
import {
  SIM_MOTIVE_COMPANY_CODE,
  SIM_MOTIVE_COMPANY_ID,
} from '../../../sim/vendors/motive/control-types';
import { createDemoWorld, type DemoWorld } from '../../../sim/world';
import type { ReplayFixture } from '../../replay';
import type {
  MotiveCompanies,
  MotiveFaultCodes,
  MotiveGroups,
  MotiveVehicleLocations,
  MotiveVehicles,
} from '../schemas';

const SEED = 1;
/** The instant the fixtures treat as "now" (the Samsara fixtures' anchor: 09:00 EDT). */
export const MOTIVE_ANCHOR = '2026-10-15T13:00:00.000Z';
const KMH_PER_MPH = 1.609344;
const SEMI_GROUP_ID = 11_204;

const DOCS = 'https://developer-docs.gomotive.com/reference';
const SIMULATED =
  'Values: the simulated demo farm (src/sim, seed 1, harvest-day), no real farm data.';
const REF = {
  companies: `${DOCS}/identify-a-company-using-its-access-token (GET /v1/companies → companies[].company.id, the sourceOrg)`,
  positions: `${DOCS}/fetch-a-list-of-all-the-vehicles-and-their-locations-v2 (GET /v2/vehicle_locations: speed in mph, true_engine_hours, true_odometer, fuel_primary_remaining_percentage; pagination) and ${DOCS}/fetch-a-list-of-all-the-vehicles-and-their-locations-v3 (GET /v3/vehicle_locations, Vehicle Gateway units only: kph, vehicle_state)`,
  faults: `${DOCS}/fetch-a-list-of-all-the-vehicles-fault-codes (GET /v1/fault_codes: status open/closed, first/last_observed_at, network, code_label SPN-n + fmi; per_page/page_no/total at the top level)`,
  vehicles: `${DOCS}/list-all-the-company-vehicles (GET /v1/vehicles: group_ids, eld_device) and ${DOCS}/fetch-a-list-of-all-the-groups-of-a-company (GET /v1/groups)`,
};

const r1 = (v: number) => Math.round(v * 10) / 10;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

function hauler(world: DemoWorld) {
  const m = simTelematicsMachines(world.farm, 'motive')[0];
  if (!m?.telematics) throw new Error('the demo farm has no Motive vehicle');
  const s = world.machineAt(m.id, new Date(MOTIVE_ANCHOR));
  if (!s) throw new Error('no sample for the Motive vehicle at the anchor');
  return { m, id: m.telematics.id, s };
}

function companiesFixture(): ReplayFixture {
  const body: MotiveCompanies = {
    companies: [
      {
        company: {
          id: Number(SIM_MOTIVE_COMPANY_ID),
          company_id: SIM_MOTIVE_COMPANY_CODE,
          name: 'Hired hauler (simulated)',
          time_zone: 'Eastern Time (US & Canada)',
          metric_units: false,
          subscription_plan: 'Enterprise',
        },
      },
    ],
    pagination: { per_page: 25, page_no: 1, total: 1 },
  };
  return {
    format: 1,
    source: 'motive',
    stream: 'companies',
    kind: 'doc-derived',
    reference: `${REF.companies}. ${SIMULATED}`,
    anchor: MOTIVE_ANCHOR,
    exchanges: [
      { request: { method: 'GET', path: '/v1/companies' }, response: { status: 200, body } },
    ],
  };
}

function positionsFixture(world: DemoWorld): ReplayFixture {
  const { m, id, s } = hauler(world);
  const base = {
    id: Number(id),
    number: m.unitNo,
    year: String(m.year),
    make: m.make,
    model: m.model,
    vin: null,
  };
  const v3: MotiveVehicleLocations = {
    vehicles: [
      {
        vehicle: {
          ...base,
          current_location: {
            lat: r6(s.lat),
            lon: r6(s.lng),
            bearing: r1(s.heading),
            located_at: MOTIVE_ANCHOR,
            kph: r1(Math.max(0, s.speedMph) * KMH_PER_MPH),
            vehicle_state: s.engineOn ? 'on' : 'off',
          },
        },
      },
    ],
    pagination: { per_page: 100, page_no: 1, total: 1 },
  };
  const v2: MotiveVehicleLocations = {
    vehicles: [
      {
        vehicle: {
          ...base,
          current_location: {
            lat: r6(s.lat),
            lon: r6(s.lng),
            bearing: Math.round(s.heading) % 360,
            located_at: MOTIVE_ANCHOR,
            description: 'Adrian, MI',
            speed: r1(Math.max(0, s.speedMph)),
            true_engine_hours: r1(s.engineHours),
            engine_hours: r1(s.engineHours - 12.5),
            true_odometer: r1(s.odometerMi),
            odometer: r1(s.odometerMi - 1_520.3),
            fuel_primary_remaining_percentage: r1(s.fuelPct),
          },
        },
      },
    ],
    pagination: { per_page: 100, page_no: 1, total: 1 },
  };
  return {
    format: 1,
    source: 'motive',
    stream: 'positions',
    kind: 'doc-derived',
    reference: `${REF.positions}. ${SIMULATED}`,
    anchor: MOTIVE_ANCHOR,
    shiftStepSeconds: 1,
    exchanges: [
      {
        request: { method: 'GET', path: '/v3/vehicle_locations' },
        response: { status: 200, body: v3 },
      },
      {
        request: { method: 'GET', path: '/v2/vehicle_locations' },
        response: { status: 200, body: v2 },
      },
    ],
  };
}

function faultsFixture(world: DemoWorld): ReplayFixture {
  const { m, id } = hauler(world);
  const vehicle = {
    id: Number(id),
    number: m.unitNo,
    year: String(m.year),
    make: m.make,
    model: m.model,
    vin: '',
    metric_units: false,
  };
  const eld_device = { id: 63_621, identifier: `SIM${id}`, model: 'lbb-3.6ca' };
  const body: MotiveFaultCodes = {
    fault_codes: [
      {
        fault_code: {
          id: 51_204,
          code: '110',
          code_label: 'SPN-110',
          code_description: 'Engine Coolant Temperature',
          source_address_label: 'Engine #1',
          status: 'open',
          first_observed_at: '2026-10-15T12:31:00Z',
          last_observed_at: '2026-10-15T12:59:00Z',
          type: 'intermittent',
          fmi: 0,
          occurrence_count: 2,
          num_observations: 29,
          sum_num_observations: 29,
          source_address_name: null,
          source_address: '0',
          is_sid: false,
          fmi_description: 'Data Valid But Above Normal Operational Range - Most Severe Level',
          dtc_status: null,
          dtc_severity: null,
          functional_grp_id: null,
          ftb: null,
          eld_device,
          vehicle,
          network: 'j1939',
        },
      },
      {
        fault_code: {
          id: 51_198,
          code: 'P0217',
          code_label: 'P0217',
          code_description: 'Engine Coolant Over Temperature Condition',
          source_address_label: '2024',
          status: 'closed',
          first_observed_at: '2026-10-14T19:02:00Z',
          last_observed_at: '2026-10-14T19:40:00Z',
          type: 'constant',
          fmi: null,
          occurrence_count: null,
          num_observations: 39,
          sum_num_observations: 39,
          source_address_name: null,
          source_address: '2024',
          is_sid: false,
          fmi_description: null,
          dtc_status: null,
          dtc_severity: null,
          functional_grp_id: null,
          ftb: null,
          eld_device,
          vehicle,
          network: 'obdii',
        },
      },
    ],
    per_page: 100,
    page_no: 1,
    total: 2,
  };
  return {
    format: 1,
    source: 'motive',
    stream: 'faults',
    kind: 'doc-derived',
    reference: `${REF.faults}. ${SIMULATED}`,
    anchor: MOTIVE_ANCHOR,
    exchanges: [
      { request: { method: 'GET', path: '/v1/fault_codes' }, response: { status: 200, body } },
    ],
  };
}

function vehiclesFixture(world: DemoWorld): ReplayFixture {
  const { m, id } = hauler(world);
  const vehicles: MotiveVehicles = {
    vehicles: [
      {
        vehicle: {
          id: Number(id),
          company_id: Number(SIM_MOTIVE_COMPANY_ID),
          number: m.unitNo,
          status: 'active',
          ifta: true,
          vin: '',
          make: m.make,
          model: m.model,
          year: String(m.year),
          metric_units: false,
          fuel_type: 'diesel',
          group_ids: [SEMI_GROUP_ID],
          created_at: '2025-03-01T00:00:00Z',
          updated_at: '2026-10-01T12:00:00Z',
          eld_device: { id: 746_694, identifier: `SIM${id}`, model: 'lbb-3.6ca' },
        },
      },
    ],
    pagination: { per_page: 100, page_no: 1, total: 1 },
  };
  const groups: MotiveGroups = {
    groups: [
      {
        group: {
          id: SEMI_GROUP_ID,
          name: 'Semi',
          company_id: Number(SIM_MOTIVE_COMPANY_ID),
          parent_id: null,
        },
      },
    ],
    pagination: { per_page: 100, page_no: 1, total: 1 },
  };
  return {
    format: 1,
    source: 'motive',
    stream: 'vehicles',
    kind: 'doc-derived',
    reference: `${REF.vehicles}. ${SIMULATED}`,
    anchor: MOTIVE_ANCHOR,
    exchanges: [
      {
        request: { method: 'GET', path: '/v1/vehicles' },
        response: { status: 200, body: vehicles },
      },
      { request: { method: 'GET', path: '/v1/groups' }, response: { status: 200, body: groups } },
    ],
  };
}

/** Every Motive doc-derived fixture, by its path under ./doc-derived/. */
export function buildMotiveDocDerivedFixtures(): Record<string, ReplayFixture> {
  const world = createDemoWorld({ scenario: 'harvest-day', seed: SEED });
  return {
    'companies/01-companies.json': companiesFixture(),
    'positions/01-vehicle-locations.json': positionsFixture(world),
    'faults/01-fault-codes.json': faultsFixture(world),
    'vehicles/01-vehicles.json': vehiclesFixture(world),
  };
}
