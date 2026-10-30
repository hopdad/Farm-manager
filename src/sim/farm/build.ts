/**
 * buildSimFarm(seed): the deterministic demo farm (plan §5 "World", contracts §9).
 *
 * About 40 fields around Adrian, Blissfield, Deerfield, Petersburg and Dundee as quarter- and
 * half-quarter-section rectangles on the 1-mile grid, a tenure mix (owned, cash rent, share,
 * custom work for two customers, one of which also has its own Deere org sharing some fields),
 * fictional landlords, customers, crew and three elevators with yard geofences on section-line
 * roads, the shop with its bin site, the fleet, and the section-line road graph.
 *
 * Everything is a pure function of `seed`. Keys are stable for a given seed and ids are
 * demoId(key) (src/domain/ids.ts), as the seed and external refs require.
 */
import { area as turfArea } from '@turf/turf';
import type { MultiPolygon, Polygon } from 'geojson';
import type { Tenure } from '../../domain/farm';
import { demoId } from '../../domain/ids';
import { metresPerDegree, offsetLngLat } from '../geo/lnglat';
import { type Rng, rngFor } from '../rng';
import {
  type LngLat,
  SIM_DEERE_HOME_ORG,
  type SimElevator,
  type SimFarm,
  type SimFarmUnit,
  type SimField,
  type SimMachine,
  type SimParty,
  type SimShop,
} from '../types';
import { deereGuid, deereMachineId, FLEET, telematicsId } from './fleet';
import {
  type Aliquot,
  aliquotCells,
  aliquotNominalAcres,
  aliquotRect,
  type GridRect,
  gridToLngLat,
  type HalfName,
  legalDescription,
  lngLatToGrid,
  type QuarterName,
} from './grid';
import {
  CREW,
  CUSTOMERS,
  ELEVATORS,
  FIRST_NAMES,
  fictionalPhone,
  LANDLORD_ORGS,
  LANDLORD_SURNAMES,
  OWNER_ORG,
  slug,
  VENDOR,
} from './names';
import { buildRoadGraph, type RoadSplit, roadName, roundLngLat } from './roads';

export const DEFAULT_SIM_SEED = 1;

/** Acres per square metre denominator (matches the boundary trigger). */
const SQ_M_PER_ACRE = 4046.86;
/** Field edges are drawn this far from a section-line road centreline (33 ft half right-of-way + ditch). */
export const ROAD_SIDE_INSET_M = 15;
/** ... and this far from an interior (quarter) line, so neighbouring fields never touch. */
export const INTERIOR_INSET_M = 4;
/** Lenawee (26091) / Monroe (26115) county line, approximately (Deerfield is in Lenawee). */
const COUNTY_LINE_LNG = -83.773;

export interface Town {
  key: string;
  name: string;
  lngLat: LngLat;
}

export const TOWNS: readonly Town[] = [
  { key: 'adrian', name: 'Adrian', lngLat: [-84.0372, 41.8975] },
  { key: 'blissfield', name: 'Blissfield', lngLat: [-83.8624, 41.8325] },
  { key: 'deerfield', name: 'Deerfield', lngLat: [-83.7741, 41.887] },
  { key: 'petersburg', name: 'Petersburg', lngLat: [-83.7149, 41.9012] },
  { key: 'dundee', name: 'Dundee', lngLat: [-83.6597, 41.9573] },
];

type TenureSlot = 'owned' | 'cash_rent' | 'share' | 'custom:halvorsen' | 'custom:juniper';

/** How many fields of each tenure go around each town (8 per town, 40 in all). */
const TOWN_PROFILES: Record<string, Partial<Record<TenureSlot, number>>> = {
  adrian: { owned: 3, cash_rent: 3, share: 2 },
  blissfield: { owned: 2, cash_rent: 4, share: 2 },
  deerfield: { 'custom:halvorsen': 5, cash_rent: 2, owned: 1 },
  petersburg: { 'custom:juniper': 4, share: 2, cash_rent: 2 },
  dundee: { owned: 2, cash_rent: 3, share: 1, 'custom:juniper': 2 },
};

/** Juniper Hill (customer 2) runs its own Deere org that shares these fields with us. */
export const SHARED_CUSTOMER_ORG = 'org-customer-2';
/** Halvorsen (customer 1) lives only in its own org, which it shared with us. */
export const CUSTOMER_ONLY_ORG = 'org-customer-1';

export interface SimFieldMeta {
  town: string;
  aliquot: Aliquot;
  nominalAcres: number;
  /** Legal description on the demo grid. */
  legal: string;
}

export interface SimBinSite {
  id: string;
  key: string;
  name: string;
  location: LngLat;
  geofence: Polygon;
}

/** The SimFarm plus the extras the seed and the scenarios use. Still a SimFarm. */
export interface DemoFarm extends SimFarm {
  seed: number;
  binSites: SimBinSite[];
  /** By field id. */
  fieldMeta: Record<string, SimFieldMeta>;
  towns: readonly Town[];
}

// ---------------------------------------------------------------------------------------------

interface Yard {
  entrance: LngLat;
  /** Split point on the road graph. */
  split: RoadSplit;
  /** Unit vector (east, north) along the road and away from it. */
  along: [number, number];
  away: [number, number];
  /** Section reserved for the yard (no fields there). */
  reserved: { i: number; j: number };
}

/** A yard beside the E-W section-line road nearest `near`, on the side where `near` lies. */
function placeYard(near: LngLat, nodeId: string): Yard {
  const g = lngLatToGrid(near);
  const j = Math.round(g.gj);
  const i = Math.floor(g.gi);
  const gi = Math.round(Math.min(i + 0.8, Math.max(i + 0.2, g.gi)) * 1e6) / 1e6;
  const north = g.gj >= j;
  return {
    entrance: gridToLngLat(gi, j),
    split: { nodeId, line: 'ew', j, gi },
    along: [1, 0],
    away: [0, north ? 1 : -1],
    reserved: { i, j: north ? j : j - 1 },
  };
}

/** Rectangle in yard-local metres (u along the road, w away from it) as a closed lng/lat ring. */
function yardRect(y: Yard, u0: number, u1: number, w0: number, w1: number): Polygon {
  const at = (u: number, w: number): LngLat =>
    roundLngLat(
      offsetLngLat(y.entrance, y.along[0] * u + y.away[0] * w, y.along[1] * u + y.away[1] * w),
    );
  let ring = [at(u0, w0), at(u1, w0), at(u1, w1), at(u0, w1)];
  // Counter-clockwise exterior ring (RFC 7946).
  if (ringSignedArea(ring) < 0) ring = ring.reverse();
  return { type: 'Polygon', coordinates: [[...ring, ring[0] as LngLat]] };
}

function ringSignedArea(ring: readonly LngLat[]): number {
  let s = 0;
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k] as LngLat;
    const b = ring[(k + 1) % ring.length] as LngLat;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s;
}

function polygonCentroid(poly: Polygon): LngLat {
  const ring = (poly.coordinates[0] ?? []).slice(0, -1);
  const n = ring.length || 1;
  return roundLngLat([
    ring.reduce((s, p) => s + (p[0] as number), 0) / n,
    ring.reduce((s, p) => s + (p[1] as number), 0) / n,
  ]);
}

/** Field rectangle (grid units) -> inset MultiPolygon in lng/lat. */
function fieldBoundary(r: GridRect): MultiPolygon {
  const sw = gridToLngLat(r.gi0, r.gj0);
  const ne = gridToLngLat(r.gi1, r.gj1);
  const m = metresPerDegree((sw[1] + ne[1]) / 2);
  const inset = (onLine: boolean) => (onLine ? ROAD_SIDE_INSET_M : INTERIOR_INSET_M);
  const isLine = (v: number) => Math.abs(v - Math.round(v)) < 1e-9;
  const west = sw[0] + inset(isLine(r.gi0)) / m.lng;
  const east = ne[0] - inset(isLine(r.gi1)) / m.lng;
  const south = sw[1] + inset(isLine(r.gj0)) / m.lat;
  const north = ne[1] - inset(isLine(r.gj1)) / m.lat;
  const ring: LngLat[] = [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ].map((p) => roundLngLat(p as LngLat));
  return { type: 'MultiPolygon', coordinates: [[ring]] };
}

interface EntranceChoice {
  lngLat: LngLat;
  split: RoadSplit;
  roadName: string;
  side: 'N' | 'S' | 'E' | 'W';
}

function chooseEntrance(r: GridRect, rng: Rng, nodeId: string): EntranceChoice {
  const isLine = (v: number) => Math.abs(v - Math.round(v)) < 1e-9;
  const sides: EntranceChoice['side'][] = [];
  if (isLine(r.gj1)) sides.push('N');
  if (isLine(r.gj0)) sides.push('S');
  if (isLine(r.gi1)) sides.push('E');
  if (isLine(r.gi0)) sides.push('W');
  if (!sides.length) throw new Error('field has no side on a section line');
  const side = rng.pick(sides);
  const f = rng.range(0.3, 0.7);
  const q = (v: number) => Math.round(v * 1e6) / 1e6;
  if (side === 'N' || side === 'S') {
    const j = Math.round(side === 'N' ? r.gj1 : r.gj0);
    const gi = q(r.gi0 + (r.gi1 - r.gi0) * f);
    return {
      lngLat: roundLngLat(gridToLngLat(gi, j)),
      split: { nodeId, line: 'ew', j, gi },
      roadName: roadName('ew', j),
      side,
    };
  }
  const i = Math.round(side === 'E' ? r.gi1 : r.gi0);
  const gj = q(r.gj0 + (r.gj1 - r.gj0) * f);
  return {
    lngLat: roundLngLat(gridToLngLat(i, gj)),
    split: { nodeId, line: 'ns', i, gj },
    roadName: roadName('ns', i),
    side,
  };
}

const QUARTERS: readonly QuarterName[] = ['NE', 'NW', 'SE', 'SW'];
const HALVES: readonly HalfName[] = ['N', 'S', 'E', 'W'];

function milesBetween(a: LngLat, b: LngLat): number {
  const m = metresPerDegree((a[1] + b[1]) / 2);
  return Math.hypot((a[0] - b[0]) * m.lng, (a[1] - b[1]) * m.lat) / 1609.344;
}

function dirWord(a: Aliquot): string {
  if (a.half === 'E') return 'East';
  if (a.half === 'W') return 'West';
  if (a.half === 'N') return 'North';
  if (a.half === 'S') return 'South';
  return a.quarter.startsWith('N') ? 'North' : 'South';
}

// ---------------------------------------------------------------------------------------------

export function buildDemoFarm(seed: number = DEFAULT_SIM_SEED): DemoFarm {
  if (!Number.isInteger(seed) || seed < 0) throw new RangeError(`seed must be an integer >= 0`);

  // --- yards first: elevators and the shop reserve their sections --------------------------
  const elevatorYards = ELEVATORS.map((e) => ({ def: e, yard: placeYard(e.near, `e:${e.key}`) }));
  const shopYard = placeYard([-83.8155, 41.8628], 'e:shop');
  const reserved = new Set<string>();
  for (const y of [...elevatorYards.map((e) => e.yard), shopYard]) {
    reserved.add(`${y.reserved.i}:${y.reserved.j}`);
  }

  // --- field slots around each town ----------------------------------------------------------
  const occupied = new Set<string>();
  interface Slot {
    town: Town;
    aliquot: Aliquot;
    tenure: TenureSlot;
    n: number;
  }
  const slots: Slot[] = [];
  for (const town of TOWNS) {
    const rng = rngFor(seed, 'fields', town.key);
    const tg = lngLatToGrid(town.lngLat);
    const candidates: { i: number; j: number }[] = [];
    for (let i = Math.floor(tg.gi) - 5; i <= Math.floor(tg.gi) + 5; i++) {
      for (let j = Math.floor(tg.gj) - 5; j <= Math.floor(tg.gj) + 5; j++) {
        const centre = gridToLngLat(i + 0.5, j + 0.5);
        const d = milesBetween(centre, town.lngLat);
        if (d < 1.1 || d > 4.2 || reserved.has(`${i}:${j}`)) continue;
        // Keep out of every town's footprint, not just this one's.
        if (TOWNS.some((t) => milesBetween(centre, t.lngLat) < 1.1)) continue;
        candidates.push({ i, j });
      }
    }
    const profile = TOWN_PROFILES[town.key] ?? {};
    const tenures = rng.shuffle(
      Object.entries(profile).flatMap(([t, k]) => Array<TenureSlot>(k ?? 0).fill(t as TenureSlot)),
    );
    const usedSections = new Set<string>();
    const pickFrom = (pool: { i: number; j: number }[], allowSecond: boolean): Aliquot | null => {
      for (const s of pool) {
        const sk = `${s.i}:${s.j}`;
        if (!allowSecond && usedSections.has(sk)) continue;
        const options: Aliquot[] = rng.chance(0.55)
          ? rng.shuffle(QUARTERS).map((quarter) => ({ ...s, quarter }))
          : rng
              .shuffle(QUARTERS)
              .flatMap((quarter) => rng.shuffle(HALVES).map((half) => ({ ...s, quarter, half })));
        for (const a of options) {
          const cells = aliquotCells(a);
          if (cells.some((c) => occupied.has(c))) continue;
          for (const c of cells) occupied.add(c);
          usedSections.add(sk);
          return a;
        }
      }
      return null;
    };
    const order = rng.shuffle(candidates);
    tenures.forEach((tenure, k) => {
      const a = pickFrom(order, false) ?? pickFrom(order, true);
      if (!a) throw new Error(`no room for field ${k + 1} near ${town.name}`);
      slots.push({ town, aliquot: a, tenure, n: k + 1 });
    });
  }

  // --- parties ---------------------------------------------------------------------------------
  const parties: SimParty[] = [];
  let phoneN = 0;
  const phone = (area: '517' | '734') => fictionalPhone(area, phoneN++);
  const owner: SimParty = {
    id: demoId(OWNER_ORG.key),
    key: OWNER_ORG.key,
    kind: 'org',
    displayName: OWNER_ORG.name,
    roles: ['owner'],
    orgId: null,
    phone: phone('517'),
    email: 'office@home-farm.example',
  };
  parties.push(owner);
  for (const c of CREW) {
    parties.push({
      id: demoId(c.key),
      key: c.key,
      kind: 'person',
      displayName: `${c.first} ${c.last}`,
      roles: ['crew'],
      orgId: owner.id,
      phone: phone('517'),
      email: `${slug(c.first)}.${slug(c.last)}@example.com`,
    });
  }

  // Landlords: rented fields grouped 1-3 per landlord, within a town.
  const landlordRng = rngFor(seed, 'landlords');
  const surnames = landlordRng.shuffle(LANDLORD_SURNAMES);
  const orgNames = [...LANDLORD_ORGS];
  const landlordOf = new Map<Slot, SimParty>();
  for (const town of TOWNS) {
    const rented = landlordRng.shuffle(
      slots.filter((s) => s.town === town && (s.tenure === 'cash_rent' || s.tenure === 'share')),
    );
    while (rented.length) {
      const take = Math.min(rented.length, landlordRng.int(1, 3));
      const group = rented.splice(0, take);
      const area = (group[0] as Slot).town.lngLat[0] < COUNTY_LINE_LNG ? '517' : '734';
      let party: SimParty;
      if (orgNames.length && landlordRng.chance(0.2)) {
        const name = orgNames.shift() as string;
        party = {
          id: demoId(`landlord-${slug(name)}`),
          key: `landlord-${slug(name)}`,
          kind: 'org',
          displayName: name,
          roles: ['landlord'],
          orgId: null,
          phone: phone(area),
          email: `office@${slug(name)}.example`,
        };
      } else {
        const last = surnames.shift();
        if (!last) throw new Error('ran out of landlord names');
        const first = landlordRng.pick(FIRST_NAMES);
        const key = `landlord-${slug(last)}`;
        party = {
          id: demoId(key),
          key,
          kind: 'person',
          displayName: `${first} ${last}`,
          roles: ['landlord'],
          orgId: null,
          phone: phone(area),
          email: `${slug(first)}.${slug(last)}@example.com`,
        };
      }
      parties.push(party);
      for (const s of group) landlordOf.set(s, party);
    }
  }

  const customerParty = new Map<string, SimParty>();
  for (const c of CUSTOMERS) {
    const org: SimParty = {
      id: demoId(c.key),
      key: c.key,
      kind: 'org',
      displayName: c.name,
      roles: ['customer'],
      orgId: null,
      phone: phone(c.key === 'customer-halvorsen' ? '517' : '734'),
      email: `office@${slug(c.short)}.example`,
    };
    const contactKey = `${c.key}-${slug(c.contact.first)}`;
    parties.push(org, {
      id: demoId(contactKey),
      key: contactKey,
      kind: 'person',
      displayName: `${c.contact.first} ${c.contact.last}`,
      roles: ['customer'],
      orgId: org.id,
      phone: phone(c.key === 'customer-halvorsen' ? '517' : '734'),
      email: `${slug(c.contact.first)}@${slug(c.short)}.example`,
    });
    customerParty.set(c.key, org);
  }

  for (const e of ELEVATORS) {
    const area = e.near[0] < COUNTY_LINE_LNG ? '517' : '734';
    const org: SimParty = {
      id: demoId(e.partyKey),
      key: e.partyKey,
      kind: 'org',
      displayName: e.name,
      roles: ['elevator'],
      orgId: null,
      phone: phone(area),
      email: `grain@${slug(e.name.split(' (')[0] as string)}.example`,
    };
    const personKey = `${e.partyKey}-${slug(e.merchandiser.first)}`;
    parties.push(org, {
      id: demoId(personKey),
      key: personKey,
      kind: 'person',
      displayName: `${e.merchandiser.first} ${e.merchandiser.last}`,
      roles: ['elevator'],
      orgId: org.id,
      phone: phone(area),
    });
  }
  parties.push({
    id: demoId(VENDOR.key),
    key: VENDOR.key,
    kind: 'org',
    displayName: VENDOR.name,
    roles: ['vendor'],
    orgId: null,
    phone: phone('517'),
    email: `orders@${slug(VENDOR.name)}.example`,
  });

  // --- farm units ------------------------------------------------------------------------------
  const farms: SimFarmUnit[] = [];
  const homeFarmOf = new Map<string, SimFarmUnit>();
  for (const town of TOWNS) {
    if (!slots.some((s) => s.town === town && !s.tenure.startsWith('custom:'))) continue;
    const key = `farm-${town.key}`;
    const unit: SimFarmUnit = {
      id: demoId(key),
      key,
      name: town.name,
      clientPartyId: null,
      deereFarmId: deereGuid('farm', key),
      deereOrgId: SIM_DEERE_HOME_ORG,
    };
    farms.push(unit);
    homeFarmOf.set(town.key, unit);
  }
  const halvorsen = customerParty.get('customer-halvorsen') as SimParty;
  const juniper = customerParty.get('customer-juniper-hill') as SimParty;
  const halvorsenFarm: SimFarmUnit = {
    id: demoId('farm-halvorsen'),
    key: 'farm-halvorsen',
    name: 'Halvorsen Bros.',
    clientPartyId: halvorsen.id,
    deereFarmId: deereGuid('farm', 'farm-halvorsen'),
    deereOrgId: CUSTOMER_ONLY_ORG,
  };
  const juniperFarm: SimFarmUnit = {
    id: demoId('farm-juniper-hill'),
    key: 'farm-juniper-hill',
    name: 'Juniper Hill',
    clientPartyId: juniper.id,
    deereFarmId: deereGuid('farm', 'farm-juniper-hill'),
    deereOrgId: SIM_DEERE_HOME_ORG,
  };
  farms.push(halvorsenFarm, juniperFarm);

  // --- fields ----------------------------------------------------------------------------------
  const fields: SimField[] = [];
  const fieldMeta: Record<string, SimFieldMeta> = {};
  const splits: RoadSplit[] = [];
  const usedNames = new Set<string>();
  const uniqueName = (candidates: string[]): string => {
    for (const c of candidates) {
      if (!usedNames.has(c)) {
        usedNames.add(c);
        return c;
      }
    }
    for (let k = 2; ; k++) {
      const c = `${candidates[0]} ${k}`;
      if (!usedNames.has(c)) {
        usedNames.add(c);
        return c;
      }
    }
  };
  const landlordFieldCount = new Map<string, number>();
  const usedLandlordDirs = new Set<string>();
  for (const s of slots) {
    const l = landlordOf.get(s);
    if (l) landlordFieldCount.set(l.id, (landlordFieldCount.get(l.id) ?? 0) + 1);
  }
  const sharedRng = rngFor(seed, 'shared-fields');
  const juniperSlots = slots.filter((s) => s.tenure === 'custom:juniper');
  const sharedSlots = new Set(sharedRng.shuffle(juniperSlots).slice(0, 3));

  for (const s of slots) {
    const key = `field-${s.town.key}-${s.n}`;
    const id = demoId(key);
    const rect = aliquotRect(s.aliquot);
    const boundary = fieldBoundary(rect);
    const entrance = chooseEntrance(rect, rngFor(seed, 'entrance', key), `e:${key}`);
    splits.push(entrance.split);
    const nominal = aliquotNominalAcres(s.aliquot);
    const roadShort = entrance.roadName.replace(/ (Hwy|Rd)$/, '');
    const landlord = landlordOf.get(s) ?? null;
    let tenure: Tenure;
    let farm: SimFarmUnit;
    let name: string;
    if (s.tenure === 'custom:halvorsen' || s.tenure === 'custom:juniper') {
      tenure = 'custom';
      const cust = CUSTOMERS.find((c) =>
        s.tenure === 'custom:halvorsen'
          ? c.key === 'customer-halvorsen'
          : c.key !== 'customer-halvorsen',
      );
      farm = s.tenure === 'custom:halvorsen' ? halvorsenFarm : juniperFarm;
      name = uniqueName([
        `${cust?.short} ${roadShort} ${nominal}`,
        `${cust?.short} ${roadShort} ${dirWord(s.aliquot)} ${nominal}`,
      ]);
    } else {
      tenure = s.tenure;
      farm = homeFarmOf.get(s.town.key) as SimFarmUnit;
      if (landlord) {
        const short =
          landlord.kind === 'org'
            ? (landlord.displayName.split(' ')[0] as string)
            : (landlord.displayName.split(' ').slice(1).join(' ') as string);
        const many = (landlordFieldCount.get(landlord.id) ?? 1) > 1;
        const dirKey = `${landlord.id}:${dirWord(s.aliquot)}`;
        const dirFree = !usedLandlordDirs.has(dirKey);
        usedLandlordDirs.add(dirKey);
        name = uniqueName(
          many
            ? dirFree
              ? [`${short} ${dirWord(s.aliquot)} ${nominal}`, `${short} ${roadShort} ${nominal}`]
              : [`${short} ${roadShort} ${nominal}`, `${short} ${dirWord(s.aliquot)} ${nominal}`]
            : [`${short} ${nominal}`, `${short} ${dirWord(s.aliquot)} ${nominal}`],
        );
      } else {
        name = uniqueName([
          `${roadShort} ${nominal}`,
          `${roadShort} ${dirWord(s.aliquot)} ${nominal}`,
          `Home ${roadShort} ${nominal}`,
        ]);
      }
    }
    const field: SimField = {
      id,
      key,
      name,
      farmId: farm.id,
      tenure,
      landlordPartyId: landlord?.id ?? null,
      countyFips: entrance.lngLat[0] < COUNTY_LINE_LNG ? '26091' : '26115',
      boundary,
      acres: Math.round((turfArea(boundary) / SQ_M_PER_ACRE) * 10) / 10,
      entrance: entrance.lngLat,
      entranceNodeId: entrance.split.nodeId,
      deereFieldId: deereGuid('field', key),
      deereBoundaryId: deereGuid('boundary', key),
      boundaryId: demoId(`boundary:${key}`),
      ...(sharedSlots.has(s)
        ? {
            sharedWith: {
              deereOrgId: SHARED_CUSTOMER_ORG,
              deereFieldId: deereGuid(`field@${SHARED_CUSTOMER_ORG}`, key),
            },
          }
        : {}),
    };
    fields.push(field);
    fieldMeta[id] = {
      town: s.town.key,
      aliquot: s.aliquot,
      nominalAcres: nominal,
      legal: legalDescription(s.aliquot),
    };
  }

  // --- elevators, shop, bins -------------------------------------------------------------------
  const elevators: SimElevator[] = elevatorYards.map(({ def, yard }) => {
    splits.push(yard.split);
    return {
      id: demoId(def.key),
      key: def.key,
      partyId: demoId(def.partyKey),
      name: def.name,
      geofence: yardRect(yard, ...ELEVATOR_YARD),
      entrance: roundLngLat(yard.entrance),
      entranceNodeId: yard.split.nodeId,
    };
  });
  splits.push(shopYard.split);
  const shopGeofence = yardRect(shopYard, ...SHOP_YARD);
  const shop: SimShop = {
    id: demoId('shop'),
    name: 'Home Farm shop',
    location: polygonCentroid(shopGeofence),
    geofence: shopGeofence,
    nodeId: shopYard.split.nodeId,
  };
  const binGeofence = yardRect(shopYard, ...BIN_YARD);
  const binSites: SimBinSite[] = [
    {
      id: demoId('bins-home'),
      key: 'bins-home',
      name: 'Home bins (shop)',
      location: polygonCentroid(binGeofence),
      geofence: binGeofence,
    },
  ];

  // --- roads -----------------------------------------------------------------------------------
  const sections = [
    ...slots.map((s) => ({ i: s.aliquot.i, j: s.aliquot.j })),
    ...elevatorYards.map((e) => e.yard.reserved),
    shopYard.reserved,
  ];
  const roads = buildRoadGraph(
    {
      i0: Math.min(...sections.map((s) => s.i)) - 1,
      i1: Math.max(...sections.map((s) => s.i)) + 2,
      j0: Math.min(...sections.map((s) => s.j)) - 1,
      j1: Math.max(...sections.map((s) => s.j)) + 2,
    },
    splits,
  );

  // --- machines --------------------------------------------------------------------------------
  const machines: SimMachine[] = FLEET.map((f) => ({
    id: demoId(f.key),
    key: f.key,
    kind: f.kind,
    unitNo: f.unitNo,
    make: f.make,
    model: f.model,
    year: f.year,
    vendorIds: f.deere ? { deere: deereMachineId(f.key) } : {},
    ...(f.telematics
      ? {
          telematics: {
            ...f.telematics,
            id: telematicsId(f.telematics.vendor, f.key, f.telematics.provider),
          },
        }
      : {}),
    ...(f.deere ? { deereOrgId: SIM_DEERE_HOME_ORG } : {}),
    ...(f.implementWidthFt ? { implementWidthFt: f.implementWidthFt } : {}),
  }));

  return {
    seed,
    parties,
    farms,
    fields,
    machines,
    elevators,
    shop,
    roads,
    binSites,
    fieldMeta,
    towns: TOWNS,
  };
}

/** Yard layouts in yard-local metres: [u0, u1, w0, w1] (u along the road, w away from it). */
export const ELEVATOR_YARD = [-40, 200, 12, 150] as const;
export const SHOP_YARD = [-30, 120, 12, 110] as const;
export const BIN_YARD = [130, 190, 12, 70] as const;

/** A fresh Rng for callers that need one tied to the farm (scenarios). */
export function farmRng(farm: DemoFarm, ...labels: (string | number)[]): Rng {
  return rngFor(farm.seed, ...labels);
}
