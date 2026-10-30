import { booleanPointInPolygon, point, area as turfArea } from '@turf/turf';
import { describe, expect, test } from 'vitest';
import { EXTERNAL_REF_KINDS, externalRefKey } from '../../connectors/types';
import { PARTY_ROLES, TENURES } from '../../domain/farm';
import { MACHINE_KINDS } from '../../domain/fleet';
import { demoId, isUuid } from '../../domain/ids';
import { toGeoRef } from '../geo/georef';
import { distToSegment, pointInPolygon, type Vec } from '../geo/vec';
import { SIM_DEERE_HOME_ORG, simExternalRefs } from '../types';
import { buildDemoFarm, INTERIOR_INSET_M, ROAD_SIDE_INSET_M, TOWNS } from './build';
import { eldVehicleId } from './fleet';
import { lngLatToGrid } from './grid';
import { Router } from './roads';

const farm = buildDemoFarm(1);
const ring = (coords: readonly (readonly number[])[]): Vec[] =>
  coords.slice(0, -1).map((c) => toGeoRef(c[0] as number, c[1] as number));

describe('buildDemoFarm', () => {
  test('is deterministic per seed and differs between seeds', () => {
    expect(buildDemoFarm(1)).toEqual(farm);
    const other = buildDemoFarm(2);
    expect(other.fields.map((f) => f.boundary)).not.toEqual(farm.fields.map((f) => f.boundary));
    expect(() => buildDemoFarm(-1)).toThrow(/seed/);
  });

  test('about 40 fields around the five towns, 80 and 160 acre aliquots', () => {
    expect(farm.fields).toHaveLength(40);
    for (const town of TOWNS) {
      expect(farm.fields.filter((f) => farm.fieldMeta[f.id]?.town === town.key)).toHaveLength(8);
    }
    for (const f of farm.fields) {
      const nominal = farm.fieldMeta[f.id]?.nominalAcres;
      // Inset from roads and neighbours: a "160" is ~152 ac, an "80" ~75 ac.
      if (nominal === 160) expect(f.acres).toBeGreaterThan(148);
      else expect(f.acres).toBeGreaterThan(72);
      expect(f.acres).toBeLessThan(nominal ?? 0);
      expect(Math.abs(turfArea(f.boundary) / 4046.86 - f.acres)).toBeLessThan(0.1);
      expect(f.boundary.type).toBe('MultiPolygon');
      const outer = f.boundary.coordinates[0]?.[0] ?? [];
      expect(outer[0]).toEqual(outer[outer.length - 1]);
    }
  });

  test('fields are in Lenawee / Monroe and never overlap each other or a yard', () => {
    const rings = farm.fields.map((f) => ring(f.boundary.coordinates[0]?.[0] ?? []));
    const yards = [
      ...farm.elevators.map((e) => ring(e.geofence.coordinates[0] ?? [])),
      ring(farm.shop.geofence.coordinates[0] ?? []),
      ...farm.binSites.map((b) => ring(b.geofence.coordinates[0] ?? [])),
    ];
    rings.forEach((r, i) => {
      for (const [j, other] of rings.entries()) {
        if (j === i) continue;
        for (const p of r) expect(pointInPolygon(p, other)).toBe(false);
      }
      for (const y of yards) for (const p of y) expect(pointInPolygon(p, r)).toBe(false);
    });
    for (const f of farm.fields) expect(['26091', '26115']).toContain(f.countyFips);
    expect(new Set(farm.fields.map((f) => f.countyFips)).size).toBe(2);
  });

  test('tenure mix, landlords on rented ground only, a customer org sharing fields', () => {
    const byTenure = Object.fromEntries(
      TENURES.map((t) => [t, farm.fields.filter((f) => f.tenure === t).length]),
    );
    // 'unknown' (1f) is only for fields the Deere sync creates: the demo farm has none.
    expect(byTenure).toEqual({ owned: 8, cash_rent: 14, share: 7, custom: 11, unknown: 0 });
    const parties = new Map(farm.parties.map((p) => [p.id, p]));
    for (const f of farm.fields) {
      if (f.tenure === 'cash_rent' || f.tenure === 'share') {
        expect(parties.get(f.landlordPartyId ?? '')?.roles).toContain('landlord');
      } else {
        expect(f.landlordPartyId).toBeNull();
      }
    }
    const units = new Map(farm.farms.map((u) => [u.id, u]));
    const customFarms = new Set(
      farm.fields.filter((f) => f.tenure === 'custom').map((f) => f.farmId),
    );
    expect(customFarms.size).toBe(2);
    for (const id of customFarms) {
      const unit = units.get(id);
      expect(parties.get(unit?.clientPartyId ?? '')?.roles).toContain('customer');
    }
    expect(new Set(farm.farms.map((u) => u.deereOrgId))).toEqual(
      new Set([SIM_DEERE_HOME_ORG, 'org-customer-1']),
    );
    const shared = farm.fields.filter((f) => f.sharedWith);
    expect(shared.length).toBe(3);
    for (const f of shared) {
      expect(f.tenure).toBe('custom');
      expect(f.sharedWith?.deereOrgId).toBe('org-customer-2');
      expect(units.get(f.farmId)?.deereOrgId).toBe(SIM_DEERE_HOME_ORG);
    }
    expect(new Set(farm.fields.map((f) => f.name)).size).toBe(farm.fields.length);
  });

  test('parties: owner, crew, landlords, customers, elevators, a vendor; orgs before members', () => {
    const roles = new Set(farm.parties.flatMap((p) => p.roles));
    for (const r of ['owner', 'crew', 'landlord', 'customer', 'elevator', 'vendor'] as const) {
      expect(roles.has(r)).toBe(true);
    }
    for (const r of roles) expect(PARTY_ROLES).toContain(r);
    const seen = new Set<string>();
    for (const p of farm.parties) {
      if (p.orgId) expect(seen.has(p.orgId)).toBe(true);
      seen.add(p.id);
      expect(p.id).toBe(demoId(p.key));
      if (p.phone) expect(p.phone).toMatch(/^\((517|734)\) 555-01\d\d$/);
      if (p.email) expect(p.email).toMatch(/@([a-z0-9-]+\.)?example(\.com)?$/);
    }
    expect(farm.parties.filter((p) => p.roles.includes('crew')).length).toBeGreaterThanOrEqual(6);
  });

  test('every key and id is unique across entity types, and ids are demoId(key)', () => {
    const keys = [
      ...farm.parties.map((p) => p.key),
      ...farm.farms.map((u) => u.key),
      ...farm.fields.map((f) => f.key),
      ...farm.fields.map((f) => `boundary:${f.key}`),
      ...farm.machines.map((m) => m.key),
      ...farm.elevators.map((e) => e.key),
      'shop',
      ...farm.binSites.map((b) => b.key),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    for (const f of farm.fields) {
      expect(f.id).toBe(demoId(f.key));
      expect(f.boundaryId).toBe(demoId(`boundary:${f.key}`));
    }
    for (const u of farm.farms) expect(u.id).toBe(demoId(u.key));
    for (const m of farm.machines) expect(m.id).toBe(demoId(m.key));
    for (const e of farm.elevators) expect(e.id).toBe(demoId(e.key));
    expect(farm.shop.id).toBe(demoId('shop'));
    for (const id of [
      ...farm.fields.map((f) => f.deereFieldId),
      ...farm.farms.map((u) => u.deereFarmId),
    ]) {
      expect(isUuid(id)).toBe(true);
    }
  });

  test('the M0 fleet: 2 combines, 2 carts, sprayer, planter, 4 semis, drone (first, ids unchanged)', () => {
    const m0 = farm.machines.slice(0, 11);
    const count = (k: string) => m0.filter((m) => m.kind === k).length;
    expect([count('combine'), count('grain_cart'), count('sprayer'), count('planter')]).toEqual([
      2, 2, 1, 1,
    ]);
    expect([count('semi'), count('drone')]).toEqual([4, 1]);
    for (const m of m0) {
      const deere = ['combine', 'grain_cart', 'sprayer', 'planter'].includes(m.kind);
      expect(Boolean(m.vendorIds.deere)).toBe(deere);
      expect(m.deereOrgId).toBe(deere ? SIM_DEERE_HOME_ORG : undefined);
      expect(m.telematics?.vendor ?? null).toBe(m.kind === 'semi' ? 'samsara' : null);
    }
    // The semis keep the Samsara vehicle ids the committed replay fixtures use.
    expect(m0.filter((m) => m.kind === 'semi').map((m) => m.telematics?.id)).toEqual(
      ['semi-1', 'semi-2', 'semi-3', 'semi-4'].map((k) => eldVehicleId(k)),
    );
    expect(farm.machines.find((m) => m.unitNo === 'C1')?.implementWidthFt).toBe(40);
  });

  test('1f.2 mixed fleet: every vendor of the brief, one telematics connection each, unique ids', () => {
    const by = (unit: string) => farm.machines.find((m) => m.unitNo === unit);
    const route = (unit: string) => {
      const t = by(unit)?.telematics;
      return t
        ? [by(unit)?.kind, t.vendor, t.provider ?? null, t.feed ?? null, t.via ?? null]
        : null;
    };
    expect(route('C3')).toEqual(['combine', 'aemp', 'cnh', null, null]);
    expect(route('T1')).toEqual(['tractor', 'aemp', 'cnh', null, null]);
    expect(route('SP2')).toEqual(['sprayer', 'samsara', null, 'equipment', 'gateway']);
    expect(route('L1')).toEqual(['loader', 'aemp', 'kubota', null, null]);
    expect(route('H1')).toEqual(['semi', 'motive', null, null, null]);
    expect(route('H2')).toEqual(['semi', 'geotab', null, null, null]);
    expect(route('PU1')).toEqual(['pickup', 'samsara', null, 'vehicle', 'ford_pro']);
    expect(route('PU2')).toEqual(['pickup', 'samsara', null, 'vehicle', 'stellantis']);
    expect(by('PU1')?.telematics?.reportEverySeconds).toBe(30);
    expect(by('C3')?.make).toBe('Case IH');
    expect(by('SP2')?.make).toBe('RoGator');
    expect(by('L1')?.make).toBe('Kubota');
    for (const m of farm.machines) {
      expect(MACHINE_KINDS).toContain(m.kind);
      // A machine is on Deere or on one telematics connection, never both, in the demo.
      expect(Boolean(m.vendorIds.deere) && Boolean(m.telematics)).toBe(false);
    }
    const ids = farm.machines.flatMap((m) => [m.vendorIds.deere, m.telematics?.id]).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
    expect(farm.machines.map((m) => m.unitNo)).toEqual([
      'C1',
      'C2',
      'GC1',
      'GC2',
      'SP1',
      'P1',
      'S1',
      'S2',
      'S3',
      'S4',
      'D1',
      'C3',
      'T1',
      'SP2',
      'L1',
      'H1',
      'H2',
      'PU1',
      'PU2',
    ]);
  });

  test('elevators, the shop and bins have yard geofences beside a section-line road', () => {
    expect(farm.elevators).toHaveLength(3);
    const nodes = new Map(farm.roads.nodes.map((n) => [n.id, n]));
    for (const e of [
      ...farm.elevators,
      { ...farm.shop, entranceNodeId: farm.shop.nodeId, entrance: undefined },
    ]) {
      const node = nodes.get(e.entranceNodeId);
      expect(node).toBeDefined();
      if (e.entrance) expect(node?.lngLat).toEqual(e.entrance);
      const g = 'geofence' in e ? e.geofence : null;
      expect(g?.type).toBe('Polygon');
    }
    const parties = new Set(
      farm.parties.filter((p) => p.roles.includes('elevator')).map((p) => p.id),
    );
    for (const e of farm.elevators) expect(parties.has(e.partyId)).toBe(true);
    expect(booleanPointInPolygon(point(farm.shop.location), farm.shop.geofence)).toBe(true);
    expect(farm.binSites).toHaveLength(1);
  });

  test('field entrances sit on a section-line road edge, outside the inset boundary', () => {
    const nodes = new Map(farm.roads.nodes.map((n) => [n.id, n]));
    for (const f of farm.fields) {
      const node = nodes.get(f.entranceNodeId);
      expect(node?.lngLat).toEqual(f.entrance);
      const g = lngLatToGrid(f.entrance);
      const onLine =
        Math.abs(g.gi - Math.round(g.gi)) < 1e-6 || Math.abs(g.gj - Math.round(g.gj)) < 1e-6;
      expect(onLine).toBe(true);
      const r = ring(f.boundary.coordinates[0]?.[0] ?? []);
      const e = toGeoRef(f.entrance[0], f.entrance[1]);
      expect(pointInPolygon(e, r)).toBe(false);
      const d = Math.min(...r.map((p, i) => distToSegment(e, p, r[(i + 1) % r.length] as Vec)));
      expect(d).toBeGreaterThan(ROAD_SIDE_INSET_M - 0.5);
      expect(d).toBeLessThan(ROAD_SIDE_INSET_M + 0.5);
    }
    expect(INTERIOR_INSET_M).toBeLessThan(ROAD_SIDE_INSET_M);
  });

  test('the road graph is one connected 1-mile grid with routes between every entrance', () => {
    const { nodes, edges } = farm.roads;
    expect(nodes.length).toBeGreaterThan(300);
    for (const e of edges) {
      expect(e.lengthMi).toBeGreaterThan(0);
      expect(e.lengthMi).toBeLessThan(1.01);
      expect(e.name).toMatch(/ (Hwy|Rd)$/);
    }
    const router = new Router(farm.roads);
    const targets = [
      farm.shop.nodeId,
      ...farm.elevators.map((e) => e.entranceNodeId),
      ...farm.fields.map((f) => f.entranceNodeId),
    ];
    for (const t of targets) expect(router.route(farm.shop.nodeId, t).lengthMi).toBeLessThan(30);
    // Manhattan routing on a 1-mile grid: route length >= straight-line distance.
    const e = farm.elevators[0];
    if (!e) throw new Error('no elevator');
    const r = router.route(farm.shop.nodeId, e.entranceNodeId);
    expect(r.nodeIds[0]).toBe(farm.shop.nodeId);
    expect(r.nodeIds.at(-1)).toBe(e.entranceNodeId);
    expect(r.path.length / 1609.344).toBeCloseTo(r.lengthMi, 2);
  });

  test('simExternalRefs on the real farm: the documented tuples, unique keys', () => {
    const rows = simExternalRefs(farm);
    const keys = rows.map((r) =>
      externalRefKey(r.ref.source, r.ref.kind, r.ref.externalId, r.ref.sourceOrg),
    );
    expect(new Set(keys).size).toBe(keys.length);
    // farms + fields + shared fields + boundaries + Deere machines + telematics machines
    // (4 semis, 2 pickups, the RoGator twice: Samsara and AEMP provider samsara, 3 on AEMP,
    // the Motive and Geotab haulers).
    expect(rows.length).toBe(7 + 40 + 3 + 40 + 6 + 13);
    for (const r of rows) expect(EXTERNAL_REF_KINDS).toContain(r.ref.kind);
    const shared = farm.fields.find((f) => f.sharedWith);
    expect(
      rows
        .filter((r) => r.ref.kind === 'field' && r.entityId === shared?.id)
        .map((r) => r.ref.sourceOrg),
    ).toEqual([SIM_DEERE_HOME_ORG, 'org-customer-2']);
    const sources = rows
      .filter((r) => r.entity === 'machine')
      .map((r) => `${r.ref.source}/${r.ref.sourceOrg}`);
    expect([...new Set(sources)].sort()).toEqual([
      'aemp/cnh',
      'aemp/kubota',
      'aemp/samsara',
      'deere/org-home',
      'geotab/',
      'motive/',
      'samsara/',
    ]);
  });
});
