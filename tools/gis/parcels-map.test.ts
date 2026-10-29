/** Parcel attribute detection and mapping (pure). */
import type { Polygon } from 'geojson';
import { describe, expect, test } from 'vitest';
import { normalizeParcelNo, parcelId } from '../../src/domain/parcels';
import type { VectorFeature } from './parcels-io';
import { detectColumns, mailingAddress, mapParcelFeatures, parseColumnMap } from './parcels-map';

const square = (lng: number, lat: number, d = 0.004): Polygon => ({
  type: 'Polygon',
  coordinates: [
    [
      [lng, lat],
      [lng + d, lat],
      [lng + d, lat + d],
      [lng, lat + d],
      [lng, lat],
    ],
  ],
});

const feat = (
  props: Record<string, unknown>,
  geometry: VectorFeature['geometry'] = square(-84.05, 41.9),
): VectorFeature => ({
  geometry,
  properties: props,
  layer: 'test',
});

describe('detectColumns', () => {
  test('finds the usual spellings, case-insensitively, most specific first', () => {
    const cols = detectColumns([
      'pin',
      'Owner_Name',
      'OWNER2',
      'MAIL_ADDR',
      'mail_city',
      'MAIL_STATE',
      'MAIL_ZIP',
      'SITUS',
      'Acres',
      'GIS_ACRES',
    ]);
    expect(cols).toEqual({
      parcel: 'pin',
      owner: 'Owner_Name',
      owner2: 'OWNER2',
      mailing: 'MAIL_ADDR',
      mailCity: 'mail_city',
      mailState: 'MAIL_STATE',
      mailZip: 'MAIL_ZIP',
      address: 'SITUS',
      acres: 'Acres',
    });
  });

  test('an explicit map wins and must name a real attribute', () => {
    expect(detectColumns(['PIN', 'TAXNO'], { parcel: 'taxno' }).parcel).toBe('TAXNO');
    expect(() => detectColumns(['PIN'], { owner: 'NOPE' })).toThrow(/no attribute 'NOPE'/);
  });

  test('parseColumnMap reads the CLI form and refuses unknown columns', () => {
    expect(parseColumnMap('parcel=PIN, owner=OWNER1')).toEqual({ parcel: 'PIN', owner: 'OWNER1' });
    expect(() => parseColumnMap('colour=RED')).toThrow(/bad --map/);
  });
});

describe('mapParcelFeatures', () => {
  test('normalizes numbers, builds deterministic ids, joins owners and mailing parts', () => {
    const r = mapParcelFeatures(
      [
        feat({
          PARCEL_NO: ' xa0-123-4567-00 ',
          OWNER1: 'Pat Example',
          OWNER2: 'Sam Example',
          MAIL_ADDR: '100 Ashby Rd',
          MAIL_CITY: 'Adrian',
          MAIL_STATE: 'MI',
          MAIL_ZIP: '49221',
          ACRES: '80.5',
          SITE_ADDR: '',
        }),
      ],
      { countyFips: '26091' },
    );
    expect(r.records).toHaveLength(1);
    const p = r.records[0];
    expect(p?.parcelNo).toBe('XA0-123-4567-00');
    expect(p?.id).toBe(parcelId('26091', 'XA0-123-4567-00'));
    expect(p?.ownerName).toBe('Pat Example & Sam Example');
    expect(p?.ownerMailing).toBe('100 Ashby Rd, Adrian, MI 49221');
    expect(p?.propertyAddress).toBeNull();
    expect(p?.acres).toBe(80.5);
    expect(p?.geometry.type).toBe('MultiPolygon');
    expect(p?.attrs.OWNER1).toBe('Pat Example');
  });

  test('features that normalize to one number become one row with every polygon', () => {
    const r = mapParcelFeatures(
      [
        feat({ PIN: 'AB 1', OWNER: 'One' }, square(-84.05, 41.9)),
        feat({ PIN: 'ab  1', OWNER: null }, square(-84.04, 41.9)),
        feat(
          { PIN: 'AB 2', OWNER: 'Two' },
          { type: 'MultiPolygon', coordinates: [square(-84.03, 41.9).coordinates] },
        ),
      ],
      { countyFips: '26091' },
    );
    expect(r.records.map((x) => [x.parcelNo, x.parts, x.geometry.coordinates.length])).toEqual([
      ['AB 1', 2, 2],
      ['AB 2', 1, 1],
    ]);
    expect(r.merged).toBe(1);
    expect(normalizeParcelNo('ab  1')).toBe('AB 1');
  });

  test('county from a column when --county is not given; bad ones are skipped and counted', () => {
    const r = mapParcelFeatures([
      feat({ PARCEL_ID: '1', COUNTY_FIPS: '26115' }),
      feat({ PARCEL_ID: '2', COUNTY_FIPS: 'Monroe' }),
    ]);
    expect(r.records.map((x) => x.countyFips)).toEqual(['26115']);
    expect(r.skipped.noCounty).toBe(1);
    expect(r.examples.join(' ')).toMatch(/county 'Monroe'/);
  });

  test('skips (and counts) features with no number, no polygon, or a line', () => {
    const r = mapParcelFeatures(
      [
        feat({ PIN: '' }),
        feat({ PIN: '9' }, null),
        feat(
          { PIN: '8' },
          {
            type: 'LineString',
            coordinates: [
              [-84, 41.9],
              [-84.01, 41.9],
            ],
          },
        ),
        feat({ PIN: '7' }),
      ],
      { countyFips: '26091' },
    );
    expect(r.records.map((x) => x.parcelNo)).toEqual(['7']);
    expect(r.skipped).toEqual({ noNumber: 1, notPolygon: 1, noCounty: 0, empty: 1 });
  });

  test('stops on projected coordinates (a shapefile without its .prj) and on missing columns', () => {
    expect(() =>
      mapParcelFeatures([feat({ PIN: '1' }, square(500000, 4637000, 100))], {
        countyFips: '26091',
      }),
    ).toThrow(/not a longitude\/latitude/);
    expect(() => mapParcelFeatures([feat({ NAME: 'x' })], { countyFips: '26091' })).toThrow(
      /no parcel number column/,
    );
    expect(() => mapParcelFeatures([feat({ PIN: '1' })])).toThrow(/--county/);
    expect(() => mapParcelFeatures([feat({ PIN: '1' })], { countyFips: '261' })).toThrow(/5-digit/);
  });

  test('acres: the file value when positive, else null', () => {
    const r = mapParcelFeatures(
      [feat({ PIN: '1', ACRES: '1,234.5' }), feat({ PIN: '2', ACRES: 0 }), feat({ PIN: '3' })],
      { countyFips: '26091' },
    );
    expect(r.records.map((x) => x.acres)).toEqual([1234.5, null, null]);
  });

  test('mailingAddress joins whatever parts exist', () => {
    expect(mailingAddress(null, 'Adrian', 'MI', null)).toBe('Adrian, MI');
    expect(mailingAddress(null, null, null, null)).toBeNull();
  });
});
