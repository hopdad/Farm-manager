/**
 * The synthetic parcel fixture (D7): committed file = generator output; every demo field lies in
 * parcels owned by its owner/landlord/customer; parcels never overlap; nothing looks like a real
 * county number. Plus the gis:parcels argument parser.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { area, bbox, booleanContains, intersect } from '@turf/turf';
import type { Feature, Polygon } from 'geojson';
import { describe, expect, test } from 'vitest';
import { buildDemoFarm } from '../../src/sim/farm/build';
import { parseParcelsArgs } from './parcels';
import { parseGeoJsonText } from './parcels-io';
import { mapParcelFeatures } from './parcels-map';
import {
  buildSyntheticParcels,
  SYNTHETIC_PARCELS_FILE,
  SYNTHETIC_SOURCE,
  syntheticParcelsText,
} from './parcels-synthetic';

describe('synthetic parcels', () => {
  const fc = buildSyntheticParcels();
  const farm = buildDemoFarm();

  test('the committed fixture is exactly the generator output (pnpm gis:parcels --write-fixture)', async () => {
    const committed = await readFile(path.join(process.cwd(), SYNTHETIC_PARCELS_FILE), 'utf8');
    expect(committed).toBe(syntheticParcelsText());
  });

  test('deterministic, synthetic-looking numbers, county-style attributes the importer maps', () => {
    expect(buildSyntheticParcels()).toEqual(fc);
    expect(fc.features.length).toBeGreaterThan(100);
    for (const f of fc.features) {
      expect(f.properties.PARCEL_NO).toMatch(/^SYN-(091|115)-\d{6}-\d{2}$/);
      expect(f.properties.SYNTHETIC).toBe(true);
      expect([40, 80, 160]).toContain(f.properties.ACRES);
    }
    const mapped = mapParcelFeatures(parseGeoJsonText(syntheticParcelsText(), 'fixture'));
    expect(mapped.records).toHaveLength(fc.features.length);
    expect(mapped.merged).toBe(0);
    expect(mapped.columns).toMatchObject({
      parcel: 'PARCEL_NO',
      owner: 'OWNER_NAME',
      mailing: 'MAIL_ADDR',
      acres: 'ACRES',
      county: 'COUNTY_FIPS',
    });
    expect(mapped.records[0]?.ownerMailing).toMatch(/, MI \d{5}$/);
  });

  test('every demo field lies inside parcels of its owner, landlord or customer', () => {
    const party = new Map(farm.parties.map((p) => [p.id, p.displayName]));
    const unit = new Map(farm.farms.map((u) => [u.id, u]));
    for (const field of farm.fields) {
      const fieldFeature: Feature<Polygon> = {
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: field.boundary.coordinates[0] ?? [] },
      };
      const fb = bbox(fieldFeature);
      const near = fc.features.filter((p) => {
        const b = bbox(p);
        return b[0] < fb[2] && fb[0] < b[2] && b[1] < fb[3] && fb[1] < b[3];
      });
      const hits = near.filter((p) =>
        intersect({ type: 'FeatureCollection', features: [p, fieldFeature] }),
      );
      const covered = hits.reduce((s, p) => {
        const i = intersect({ type: 'FeatureCollection', features: [p, fieldFeature] });
        return s + (i ? area(i) : 0);
      }, 0);
      expect(covered / area(fieldFeature)).toBeGreaterThan(0.999);
      const expected =
        field.tenure === 'owned'
          ? 'Home Farm (demo)'
          : field.tenure === 'custom'
            ? party.get(unit.get(field.farmId)?.clientPartyId ?? '')
            : party.get(field.landlordPartyId ?? '');
      for (const p of hits) {
        if (booleanContains(p, fieldFeature) || hits.length > 1) {
          expect(p.properties.OWNER_NAME, field.name).toBe(expected);
        }
      }
    }
  });

  test('parcels never overlap each other (axis-aligned rectangles: bbox overlap is exact)', () => {
    const boxes = fc.features.map((f) => bbox(f));
    const eps = 1e-9;
    let overlaps = 0;
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i] as number[];
      for (let j = i + 1; j < boxes.length; j++) {
        const b = boxes[j] as number[];
        const w =
          Math.min(a[2] as number, b[2] as number) - Math.max(a[0] as number, b[0] as number);
        const h =
          Math.min(a[3] as number, b[3] as number) - Math.max(a[1] as number, b[1] as number);
        if (w > eps && h > eps) overlaps += 1;
      }
    }
    expect(overlaps).toBe(0);
    // Every parcel is a closed rectangle (5 positions, first = last).
    for (const f of fc.features) {
      const ring = f.geometry.coordinates[0] ?? [];
      expect(ring).toHaveLength(5);
      expect(ring[4]).toEqual(ring[0]);
    }
  });
});

describe('gis:parcels arguments', () => {
  test('a file with options', () => {
    expect(
      parseParcelsArgs([
        'parcels.zip',
        '--county',
        '26091',
        '--source',
        'lenawee-county',
        '--received-on',
        '2027-01-05',
        '--map',
        'parcel=PIN',
        '--replace',
      ]),
    ).toMatchObject({
      input: 'parcels.zip',
      county: '26091',
      source: 'lenawee-county',
      receivedOn: '2027-01-05',
      columns: { parcel: 'PIN' },
      replace: true,
      fixture: false,
    });
  });

  test('--fixture defaults to the synthetic source and licence', () => {
    const a = parseParcelsArgs(['--fixture']);
    expect(a).toMatchObject({ fixture: true, input: null, source: SYNTHETIC_SOURCE });
    expect(a.license).toMatch(/Synthetic/);
  });

  test('refuses bad input', () => {
    expect(() => parseParcelsArgs([])).toThrow(/no file/);
    expect(() => parseParcelsArgs(['a.zip', 'b.zip'])).toThrow(/one file/);
    // --map repeated, or split into separate arguments by PowerShell: all the same.
    for (const argv of [
      ['a.zip', '--map', 'parcel=PIN,owner=OWNER1'],
      ['a.zip', '--map', 'parcel=PIN', '--map', 'owner=OWNER1'],
      ['a.zip', '--map', 'parcel=PIN', 'owner=OWNER1'],
      ['a.zip', '--map', 'parcel=PIN owner=OWNER1'],
    ]) {
      expect(parseParcelsArgs(argv)).toMatchObject({
        input: 'a.zip',
        columns: { parcel: 'PIN', owner: 'OWNER1' },
      });
    }
    expect(() => parseParcelsArgs(['a.zip', '--county', 'Lenawee'])).toThrow(/FIPS/);
    expect(() => parseParcelsArgs(['a.zip', '--received-on', 'Jan 5'])).toThrow(/YYYY-MM-DD/);
    expect(() => parseParcelsArgs(['a.zip', '--source', 'Lenawee County'])).toThrow(/lower-case/);
    expect(() => parseParcelsArgs(['--fixture', 'a.zip'])).toThrow(/no file/);
  });
});
