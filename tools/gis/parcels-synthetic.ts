/**
 * The synthetic parcel fixture (D7: "a synthetic parcel fixture covers the demo area until a real
 * file arrives"). Generated from the simulated farm (src/sim/farm/build.ts), committed as
 * tools/gis/fixtures/parcels/synthetic-parcels.geojson and loaded by `pnpm gis:parcels --fixture`
 * (the demo seed / bootstrap call `loadSyntheticParcels`).
 *
 * EVERYTHING HERE IS FICTIONAL. Owner names come from the sim's fictional landlords, customers
 * and the farm itself, plus made-up neighbours below; street names are the sim's fictional
 * section-line roads; parcel numbers start with `SYN-` so they can never be mistaken for a real
 * Lenawee or Monroe number. Only town names and their ZIP codes are real (public), so mailing
 * addresses read naturally.
 *
 * Layout: every section (1 mile square on the demo grid) that holds a demo field is cut into
 * parcels along aliquot lines, the way county parcel maps usually look:
 *  - a quarter with a whole-quarter field: one 160-acre parcel, or two 80s (same owner: one
 *    field, two tax parcels);
 *  - a quarter with a half-quarter field: that half is one 80 owned by the field's owner, the
 *    other half another 80 (another field's, or a neighbour's);
 *  - a quarter with no field: one 160, two 80s or four 40s, all neighbours.
 * The field's owner: the farm itself (owned), its landlord (cash rent, share) or the custom-work
 * customer. Parcel lines run on section and aliquot lines, so fields (inset from the roads) lie
 * inside their parcels.
 *
 * The properties use a county-style schema (PARCEL_NO, OWNER_NAME, MAIL_ADDR, MAIL_CITY,
 * MAIL_STATE, MAIL_ZIP, SITE_ADDR, ACRES, COUNTY_FIPS), so loading the fixture exercises the same
 * attribute detection as a real county file.
 */
import type { Feature, FeatureCollection, Polygon, Position } from 'geojson';
import { buildDemoFarm, DEFAULT_SIM_SEED, type DemoFarm } from '../../src/sim/farm/build';
import {
  type Aliquot,
  aliquotRect,
  type GridRect,
  gridToLngLat,
  type HalfName,
  legalDescription,
  type QuarterName,
} from '../../src/sim/farm/grid';
import { FIRST_NAMES, ROAD_NAMES } from '../../src/sim/farm/names';
import { hash32, Rng } from '../../src/sim/rng';

/** Committed fixture, relative to the project directory. */
export const SYNTHETIC_PARCELS_FILE = 'tools/gis/fixtures/parcels/synthetic-parcels.geojson';
/** gis.parcel_imports.source of the fixture (contracts-m1 §14, D7). */
export const SYNTHETIC_SOURCE = 'synthetic';
export const SYNTHETIC_LICENSE =
  'Synthetic demo data generated from the simulated farm: fictional owners and addresses, not a county record.';

/** Neighbours who own the parcels around the demo fields (fictional). */
const NEIGHBOUR_SURNAMES = [
  'Ambrose',
  'Bettencourt',
  'Calloway',
  'Dunsmore',
  'Eckhardt',
  'Fairbairn',
  'Gallagher',
  'Haverkamp',
  'Ingersoll',
  'Jablonski',
  'Kettering',
  'Lockhart',
  'Mortensen',
  'Nesbitt',
  'Oberlin',
  'Prendergast',
  'Quarles',
  'Rutherford',
  'Steinbach',
  'Thorvald',
  'Underhill',
  'Valentine',
  'Wexford',
  'Yardley',
] as const;

/** ZIP codes of the demo towns (public, real), for natural-looking fictional addresses. */
const TOWN_ZIPS: Record<string, string> = {
  Adrian: '49221',
  Blissfield: '49228',
  Deerfield: '49238',
  Petersburg: '49270',
  Dundee: '48131',
};

export interface SyntheticParcelProps {
  PARCEL_NO: string;
  OWNER_NAME: string;
  MAIL_ADDR: string;
  MAIL_CITY: string;
  MAIL_STATE: string;
  MAIL_ZIP: string;
  SITE_ADDR: string | null;
  ACRES: number;
  COUNTY_FIPS: string;
  LEGAL_DESC: string;
  SYNTHETIC: true;
}

export type SyntheticParcels = FeatureCollection<Polygon, SyntheticParcelProps>;

const QUARTERS: readonly QuarterName[] = ['NE', 'NW', 'SW', 'SE'];

interface Owner {
  name: string;
  city: string;
}

const round7 = (n: number) => Math.round(n * 1e7) / 1e7;

function rectPolygon(r: GridRect): Polygon {
  // Counter-clockwise exterior ring (RFC 7946): SW, SE, NE, NW, SW.
  const ring: Position[] = [
    gridToLngLat(r.gi0, r.gj0),
    gridToLngLat(r.gi1, r.gj0),
    gridToLngLat(r.gi1, r.gj1),
    gridToLngLat(r.gi0, r.gj1),
    gridToLngLat(r.gi0, r.gj0),
  ].map(([x, y]) => [round7(x as number), round7(y as number)]);
  return { type: 'Polygon', coordinates: [ring] };
}

function quarterQuarter(i: number, j: number, quarter: QuarterName, cell: 0 | 1 | 2 | 3): GridRect {
  const q = aliquotRect({ i, j, quarter });
  const east = cell === 1 || cell === 3;
  const north = cell === 0 || cell === 1;
  const gi0 = q.gi0 + (east ? 0.25 : 0);
  const gj0 = q.gj0 + (north ? 0.25 : 0);
  return { gi0, gi1: gi0 + 0.25, gj0, gj1: gj0 + 0.25 };
}

const sameAliquot = (a: Aliquot, b: Aliquot) =>
  a.i === b.i && a.j === b.j && a.quarter === b.quarter && a.half === b.half;

/** The other half of a quarter. */
const OTHER_HALF: Record<HalfName, HalfName> = { N: 'S', S: 'N', E: 'W', W: 'E' };

/** Build the fixture (deterministic for a seed). */
export function buildSyntheticParcels(seed: number = DEFAULT_SIM_SEED): SyntheticParcels {
  const farm: DemoFarm = buildDemoFarm(seed);
  const party = new Map(farm.parties.map((p) => [p.id, p]));
  const farmUnit = new Map(farm.farms.map((u) => [u.id, u]));
  const ownOrg = farm.parties.find((p) => p.key === 'owner-home-farm');

  interface FieldSlot {
    aliquot: Aliquot;
    owner: string;
    county: string;
    town: string;
  }
  const slots: FieldSlot[] = [];
  for (const f of farm.fields) {
    const meta = farm.fieldMeta[f.id];
    if (!meta) continue;
    let owner = ownOrg?.displayName ?? 'Home Farm (demo)';
    if (f.tenure === 'cash_rent' || f.tenure === 'share') {
      owner = (f.landlordPartyId && party.get(f.landlordPartyId)?.displayName) || owner;
    } else if (f.tenure === 'custom') {
      const client = farmUnit.get(f.farmId)?.clientPartyId;
      owner = (client && party.get(client)?.displayName) || owner;
    }
    const town = farm.towns.find((t) => t.key === meta.town)?.name ?? 'Adrian';
    slots.push({ aliquot: meta.aliquot, owner, county: f.countyFips, town });
  }

  // Sections that hold a field, in a stable order.
  const sections = new Map<string, { i: number; j: number; county: string; town: string }>();
  for (const s of slots) {
    const key = `${s.aliquot.i}:${s.aliquot.j}`;
    if (!sections.has(key)) {
      sections.set(key, { i: s.aliquot.i, j: s.aliquot.j, county: s.county, town: s.town });
    }
  }
  const ordered = [...sections.values()].sort((a, b) => b.j - a.j || a.i - b.i);

  const features: Feature<Polygon, SyntheticParcelProps>[] = [];
  for (const sec of ordered) {
    const rng = new Rng(hash32(seed, 'parcels', sec.i, sec.j));
    const neighbour = (): Owner => {
      const r = rng.next();
      const surname = rng.pick(NEIGHBOUR_SURNAMES);
      const name =
        r < 0.5
          ? `${rng.pick(FIRST_NAMES)} & ${rng.pick(FIRST_NAMES)} ${surname}`
          : r < 0.75
            ? `${surname} Family Trust`
            : `${surname} Acres LLC`;
      return { name, city: sec.town };
    };
    let n = 0;
    const add = (rect: GridRect, owner: Owner, acres: number, legal: string, site: boolean) => {
      n += 1;
      const road = rng.pick(ROAD_NAMES);
      const city = TOWN_ZIPS[owner.city] ? owner.city : 'Adrian';
      features.push({
        type: 'Feature',
        geometry: rectPolygon(rect),
        properties: {
          PARCEL_NO: `SYN-${sec.county.slice(2)}-${String(sec.i + 500).padStart(3, '0')}${String(-sec.j).padStart(3, '0')}-${String(n).padStart(2, '0')}`,
          OWNER_NAME: owner.name,
          MAIL_ADDR: `${rng.int(1, 99) * 100 + rng.int(0, 99)} ${road} Rd`,
          MAIL_CITY: city,
          MAIL_STATE: 'MI',
          MAIL_ZIP: TOWN_ZIPS[city] ?? '49221',
          SITE_ADDR: site ? `${rng.int(10, 99) * 100} ${rng.pick(ROAD_NAMES)} Hwy` : null,
          ACRES: acres,
          COUNTY_FIPS: sec.county,
          LEGAL_DESC: legal,
          SYNTHETIC: true,
        },
      });
    };

    for (const quarter of QUARTERS) {
      const inQuarter = slots.filter(
        (s) => s.aliquot.i === sec.i && s.aliquot.j === sec.j && s.aliquot.quarter === quarter,
      );
      const qAliquot: Aliquot = { i: sec.i, j: sec.j, quarter };
      const whole = inQuarter.find((s) => !s.aliquot.half);
      if (whole) {
        const owner = { name: whole.owner, city: whole.town };
        if (rng.chance(0.5)) {
          add(aliquotRect(qAliquot), owner, 160, legalDescription(qAliquot), false);
        } else {
          const [h1, h2] = rng.chance(0.5) ? (['N', 'S'] as const) : (['E', 'W'] as const);
          for (const half of [h1, h2]) {
            const a = { ...qAliquot, half };
            add(aliquotRect(a), owner, 80, legalDescription(a), false);
          }
        }
        continue;
      }
      if (inQuarter.length > 0) {
        const first = inQuarter[0] as FieldSlot;
        const half = first.aliquot.half as HalfName;
        for (const h of [half, OTHER_HALF[half]]) {
          const a: Aliquot = { ...qAliquot, half: h };
          const slot = inQuarter.find((s) => sameAliquot(s.aliquot, a));
          const owner = slot ? { name: slot.owner, city: slot.town } : neighbour();
          add(aliquotRect(a), owner, 80, legalDescription(a), !slot && rng.chance(0.4));
        }
        continue;
      }
      const r = rng.next();
      if (r < 0.4) {
        add(aliquotRect(qAliquot), neighbour(), 160, legalDescription(qAliquot), rng.chance(0.5));
      } else if (r < 0.75) {
        const owners = [neighbour(), neighbour()];
        (['N', 'S'] as const).forEach((h, k) => {
          const a = { ...qAliquot, half: h };
          add(aliquotRect(a), owners[k] as Owner, 80, legalDescription(a), rng.chance(0.4));
        });
      } else {
        for (const cell of [0, 1, 2, 3] as const) {
          add(
            quarterQuarter(sec.i, sec.j, quarter, cell),
            neighbour(),
            40,
            `${['NW', 'NE', 'SW', 'SE'][cell]} 1/4 ${legalDescription(qAliquot)}`,
            rng.chance(0.3),
          );
        }
      }
    }
  }
  return { type: 'FeatureCollection', features };
}

/** The fixture file's exact text: one feature per line (small, diffable), LF, trailing newline. */
export function syntheticParcelsText(seed: number = DEFAULT_SIM_SEED): string {
  const lines = buildSyntheticParcels(seed).features.map((f) => JSON.stringify(f));
  return `{"type":"FeatureCollection","features":[\n${lines.join(',\n')}\n]}\n`;
}
