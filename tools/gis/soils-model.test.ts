import { describe, expect, test } from 'vitest';
import {
  buildMapunitRecords,
  type ComponentRow,
  dominantComponent,
  surveyVersion,
  toComponentRows,
  toMapunitStatsRows,
  toPolygonRows,
  toSurveyAreaRows,
  weightedNccpi,
} from './soils-model';

const comp = (o: Partial<ComponentRow>): ComponentRow => ({
  mukey: '1',
  cokey: '10',
  compname: 'Blount',
  comppct: 85,
  major: true,
  compkind: 'Series',
  drainagecl: 'Somewhat poorly drained',
  hydgrp: 'C/D',
  nccpi: 0.6,
  ...o,
});

describe('SDA records → rows', () => {
  test('values arrive as strings (or null) and are typed here', () => {
    expect(
      toComponentRows([
        {
          mukey: '168',
          cokey: '2354',
          compname: 'Pewamo',
          comppct_r: '10',
          majcompflag: 'No ',
          compkind: 'Series',
          drainagecl: 'Very poorly drained',
          hydgrp: 'C/D',
          nccpi: '0.6612',
        },
        {
          mukey: '168',
          cokey: '2355',
          compname: null,
          comppct_r: null,
          majcompflag: 'Yes',
          compkind: 'Miscellaneous area',
          drainagecl: null,
          hydgrp: null,
          nccpi: null,
        },
      ]),
    ).toEqual([
      {
        mukey: '168',
        cokey: '2354',
        compname: 'Pewamo',
        comppct: 10,
        major: false,
        compkind: 'Series',
        drainagecl: 'Very poorly drained',
        hydgrp: 'C/D',
        nccpi: 0.6612,
      },
      {
        mukey: '168',
        cokey: '2355',
        compname: 'Unnamed',
        comppct: null,
        major: true,
        compkind: 'Miscellaneous area',
        drainagecl: null,
        hydgrp: null,
        nccpi: null,
      },
    ]);
  });

  test('stats, polygons and survey rows', () => {
    expect(
      toMapunitStatsRows([
        {
          mukey: 168,
          musym: 'BnB',
          muname: 'Blount loam',
          farmlndcl: null,
          polygons: '3',
          vertices: null,
        },
      ]),
    ).toEqual([
      {
        mukey: '168',
        musym: 'BnB',
        muname: 'Blount loam',
        farmlndcl: null,
        polygons: 3,
        vertices: 0,
      },
    ]);
    expect(
      toPolygonRows([{ mupolygonkey: '9', mukey: '168', wkt: 'POLYGON ((0 0, 1 0, 0 1, 0 0))' }]),
    ).toEqual([{ mupolygonkey: '9', mukey: '168', wkt: 'POLYGON ((0 0, 1 0, 0 1, 0 0))' }]);
    expect(
      toSurveyAreaRows([{ areasymbol: 'mi091', areaname: 'Lenawee', saverest: null }]),
    ).toEqual([{ areasymbol: 'MI091', areaname: 'Lenawee', saverest: null }]);
  });

  test('a bad key or a missing name is an error, not a silent row', () => {
    expect(() => toPolygonRows([{ mupolygonkey: 'abc', mukey: '1', wkt: 'x' }])).toThrow(
      /not a key/,
    );
    expect(() => toMapunitStatsRows([{ mukey: '1', muname: null }])).toThrow(/muname/);
  });
});

describe('weightedNccpi (soilDB "Weighted Average": rated components only)', () => {
  test('weights by component percent', () => {
    expect(
      weightedNccpi([comp({ comppct: 85, nccpi: 0.6 }), comp({ comppct: 15, nccpi: 0.8 })]),
    ).toBe(0.63);
  });

  test('unrated components (water) do not pull it down', () => {
    expect(
      weightedNccpi([
        comp({ comppct: 80, nccpi: 0.5 }),
        comp({ comppct: 20, nccpi: null, compname: 'Water' }),
      ]),
    ).toBe(0.5);
  });

  test('null when nothing is rated', () => {
    expect(weightedNccpi([comp({ nccpi: null })])).toBeNull();
    expect(weightedNccpi([])).toBeNull();
    expect(weightedNccpi([comp({ comppct: null })])).toBeNull();
  });
});

describe('dominantComponent', () => {
  test('highest percent; ties to the lowest cokey (numeric)', () => {
    const a = comp({ cokey: '100', comppct: 45 });
    const b = comp({ cokey: '99', comppct: 45 });
    const c = comp({ cokey: '5', comppct: 10 });
    expect(dominantComponent([a, c, b])).toBe(b);
    expect(dominantComponent([])).toBeNull();
  });
});

describe('surveyVersion', () => {
  test('SDA US dates and ISO dates become YYYY-MM-DD', () => {
    expect(
      surveyVersion({ areasymbol: 'MI091', areaname: null, saverest: '9/5/2025 12:00:00 AM' }),
    ).toBe('MI091 2025-09-05');
    expect(
      surveyVersion({ areasymbol: 'MI115', areaname: null, saverest: '2025-09-05T00:00:00' }),
    ).toBe('MI115 2025-09-05');
    expect(surveyVersion({ areasymbol: 'MI115', areaname: null, saverest: null })).toBeNull();
    expect(surveyVersion(undefined)).toBeNull();
  });
});

describe('buildMapunitRecords', () => {
  test('dominant component attributes, weighted NCCPI, every component kept, in percent order', () => {
    const [r] = buildMapunitRecords(
      'MI091',
      {
        areasymbol: 'MI091',
        areaname: 'Lenawee County, Michigan',
        saverest: '9/5/2025 12:00:00 AM',
      },
      [
        {
          mukey: '1',
          musym: 'BnB',
          muname: 'Blount loam',
          farmlndcl: 'Prime farmland if drained',
          polygons: 2,
          vertices: 20,
        },
      ],
      [
        comp({
          cokey: '12',
          compname: 'Pewamo',
          comppct: 15,
          drainagecl: 'Very poorly drained',
          nccpi: 0.7,
          major: false,
        }),
        comp({ cokey: '11', compname: 'Blount', comppct: 85, nccpi: 0.6 }),
        comp({ mukey: '2', cokey: '21', compname: 'Other' }),
      ],
    );
    expect(r).toEqual({
      mukey: '1',
      areasymbol: 'MI091',
      musym: 'BnB',
      muname: 'Blount loam',
      dominantComponent: 'Blount',
      drainageClass: 'Somewhat poorly drained',
      hydgrp: 'C/D',
      farmlandClass: 'Prime farmland if drained',
      nccpi: 0.615,
      components: [
        {
          name: 'Blount',
          pct: 85,
          major: true,
          drainageClass: 'Somewhat poorly drained',
          hydgrp: 'C/D',
          nccpi: 0.6,
        },
        {
          name: 'Pewamo',
          pct: 15,
          major: false,
          drainageClass: 'Very poorly drained',
          hydgrp: 'C/D',
          nccpi: 0.7,
        },
      ],
      surveyVersion: 'MI091 2025-09-05',
    });
  });

  test('a map unit without components still gets a row', () => {
    const [r] = buildMapunitRecords(
      'MI115',
      undefined,
      [{ mukey: '7', musym: 'W', muname: 'Water', farmlndcl: null, polygons: 1, vertices: 5 }],
      [],
    );
    expect(r).toMatchObject({
      mukey: '7',
      dominantComponent: null,
      nccpi: null,
      components: [],
      surveyVersion: null,
    });
  });
});
