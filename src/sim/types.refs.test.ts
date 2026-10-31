import type { MultiPolygon, Polygon } from 'geojson';
import { describe, expect, test } from 'vitest';
import { EXTERNAL_REF_KINDS, externalRef, externalRefKey } from '../connectors/types';
import { SIM_DEERE_HOME_ORG, type SimFarm, simExternalRefs, simTelematicsMachines } from './types';

const square: MultiPolygon = { type: 'MultiPolygon', coordinates: [] };
const yard: Polygon = { type: 'Polygon', coordinates: [] };

/** A two-org farm, hand-built (the real one comes from the sim agent's buildSimFarm). */
const farm: SimFarm = {
  parties: [],
  farms: [
    {
      id: 'farm-home',
      key: 'home',
      name: 'Home',
      clientPartyId: null,
      deereFarmId: 'df-1',
      deereOrgId: SIM_DEERE_HOME_ORG,
    },
    {
      id: 'farm-cust',
      key: 'cust',
      name: 'Customer',
      clientPartyId: 'party-cust',
      deereFarmId: 'df-9',
      deereOrgId: 'org-customer-1',
    },
  ],
  fields: [
    {
      id: 'field-a',
      key: 'a',
      name: 'A',
      farmId: 'farm-home',
      tenure: 'owned',
      landlordPartyId: null,
      countyFips: '26091',
      boundary: square,
      acres: 160,
      entrance: [-84, 41.9],
      entranceNodeId: 'n1',
      deereFieldId: 'fld-a',
      deereBoundaryId: 'bnd-a',
      boundaryId: 'boundary-a',
      sharedWith: { deereOrgId: 'org-customer-1', deereFieldId: 'fld-a-cust' },
    },
    {
      id: 'field-b',
      key: 'b',
      name: 'B',
      farmId: 'farm-cust',
      tenure: 'custom',
      landlordPartyId: null,
      countyFips: '26115',
      boundary: square,
      acres: 80,
      entrance: [-83.6, 41.9],
      entranceNodeId: 'n2',
      deereFieldId: 'fld-b',
      deereBoundaryId: 'bnd-b',
      boundaryId: 'boundary-b',
    },
  ],
  machines: [
    {
      id: 'm-combine',
      key: 'c1',
      kind: 'combine',
      unitNo: 'C1',
      make: 'John Deere',
      model: 'X9 1100',
      year: 2024,
      vendorIds: { deere: 'jd-c1' },
      deereOrgId: SIM_DEERE_HOME_ORG,
    },
    {
      id: 'm-semi',
      key: 's1',
      kind: 'semi',
      unitNo: 'S1',
      make: 'Peterbilt',
      model: '579',
      year: 2021,
      vendorIds: {},
      telematics: { vendor: 'samsara', id: 'veh-281474976710656', feed: 'vehicle' },
    },
    {
      id: 'm-loader',
      key: 'l1',
      kind: 'loader',
      unitNo: 'L1',
      make: 'Kubota',
      model: 'SVL97-2',
      year: 2020,
      vendorIds: {},
      telematics: { vendor: 'aemp', id: 'KUB1234567', provider: 'kubota' },
    },
    {
      id: 'm-sprayer',
      key: 'sp2',
      kind: 'sprayer',
      unitNo: 'SP2',
      make: 'RoGator',
      model: 'RG1100C',
      year: 2021,
      vendorIds: {},
      telematics: { vendor: 'samsara', id: '281474976710999', feed: 'equipment', via: 'gateway' },
    },
    {
      id: 'm-hauler',
      key: 'h1',
      kind: 'semi',
      unitNo: 'H1',
      make: 'Kenworth',
      model: 'T880',
      year: 2020,
      vendorIds: {},
      telematics: { vendor: 'motive', id: '123456' },
    },
  ],
  elevators: [],
  shop: { id: 'shop', name: 'Shop', location: [-84, 41.9], geofence: yard, nodeId: 'n0' },
  roads: { nodes: [], edges: [] },
};

describe('external ref vocabulary', () => {
  test('externalRef validates source, kind, id and the Deere org', () => {
    expect(externalRef('samsara', 'machine', 'veh-1')).toEqual({
      source: 'samsara',
      kind: 'machine',
      externalId: 'veh-1',
      sourceOrg: '',
    });
    expect(() => externalRef('deere', 'field', 'fld-1')).toThrow(/org/);
    expect(() => externalRef('samsara', 'vehicle' as never, 'veh-1')).toThrow(/kind/);
    expect(() => externalRef('acme' as never, 'machine', 'x')).toThrow(/source/);
    expect(() => externalRef('motive', 'machine', '')).toThrow(/empty/);
    expect(EXTERNAL_REF_KINDS).toEqual(['party', 'farm', 'field', 'boundary', 'machine']);
    expect(externalRefKey('deere', 'field', 'fld-1', 'org-home')).toBe(
      'deere|field|org-home|fld-1',
    );
  });

  test('simExternalRefs returns exactly the documented tuples', () => {
    const rows = simExternalRefs(farm).map((r) => [
      externalRefKey(r.ref.source, r.ref.kind, r.ref.externalId, r.ref.sourceOrg),
      r.entityId,
      r.entity,
    ]);
    expect(rows).toEqual([
      ['deere|farm|org-home|df-1', 'farm-home', 'farm'],
      ['deere|farm|org-customer-1|df-9', 'farm-cust', 'farm'],
      ['deere|field|org-home|fld-a', 'field-a', 'field'],
      ['deere|field|org-customer-1|fld-a-cust', 'field-a', 'field'],
      ['deere|boundary|org-home|bnd-a', 'boundary-a', 'field_boundary'],
      ['deere|field|org-customer-1|fld-b', 'field-b', 'field'],
      ['deere|boundary|org-customer-1|bnd-b', 'boundary-b', 'field_boundary'],
      ['deere|machine|org-home|jd-c1', 'm-combine', 'machine'],
      ['samsara|machine||veh-281474976710656', 'm-semi', 'machine'],
      ['aemp|machine|kubota|KUB1234567', 'm-loader', 'machine'],
      ['samsara|machine||281474976710999', 'm-sprayer', 'machine'],
      ['aemp|machine|samsara|281474976710999', 'm-sprayer', 'machine'],
      ['motive|machine||123456', 'm-hauler', 'machine'],
    ]);
  });

  test('simTelematicsMachines: each stand-in lists exactly its own machines', () => {
    const keys = (ms: { key: string }[]) => ms.map((m) => m.key);
    expect(keys(simTelematicsMachines(farm, 'samsara'))).toEqual(['s1', 'sp2']);
    expect(keys(simTelematicsMachines(farm, 'samsara', { feed: 'vehicle' }))).toEqual(['s1']);
    expect(keys(simTelematicsMachines(farm, 'samsara', { feed: 'equipment' }))).toEqual(['sp2']);
    expect(keys(simTelematicsMachines(farm, 'aemp', { provider: 'kubota' }))).toEqual(['l1']);
    expect(keys(simTelematicsMachines(farm, 'aemp', { provider: 'samsara' }))).toEqual(['sp2']);
    expect(keys(simTelematicsMachines(farm, 'motive'))).toEqual(['h1']);
    expect(simTelematicsMachines(farm, 'geotab')).toEqual([]);
  });

  test('a Deere machine without deereOrgId is a contract error', () => {
    const bad: SimFarm = {
      ...farm,
      machines: [{ ...(farm.machines[0] as SimFarm['machines'][number]), deereOrgId: undefined }],
    };
    expect(() => simExternalRefs(bad)).toThrow(/org/);
  });
});
