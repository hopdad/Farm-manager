/**
 * The map unit sheet's pure parts (soil map Phase A): official series description links (which
 * components are series), the view model from a tapped feature and from the loaded detail, the
 * components jsonb parse, tile properties as a preview, finding the map unit under a tap, the
 * in-view list, and the sheet store.
 */
import { beforeEach, describe, expect, test } from 'vitest';
import type { SoilComponent } from '../../domain/soils';
import { FARMLAND_COLORS, HYDGRP_COLORS, NCCPI_COLORS, SOILS_IDS } from '../map/layers/soils';
import {
  compareSymbols,
  IN_VIEW_MAX_ROWS,
  IN_VIEW_MIN_ZOOM,
  readUnitsInView,
  sameInView,
  sameUnits,
  unitsInView,
} from './in-view';
import {
  isSeriesComponent,
  type MapUnitDetail,
  MapUnitDetailCache,
  mapUnitView,
  osdUrl,
  parseComponents,
  previewOf,
} from './map-unit';
import { mapUnitAt, type QueryableMap, useMapUnitSheet } from './sheet-store';

const BLOUNT: MapUnitDetail = {
  mukey: '99901001',
  areasymbol: 'MI091',
  musym: 'BnB',
  muname: 'Blount loam, 1 to 4 percent slopes',
  dominantComponent: 'Blount',
  drainageClass: 'Somewhat poorly drained',
  hydgrp: 'C/D',
  farmlandClass: 'Prime farmland if drained',
  nccpi: 0.622,
  components: [
    {
      name: 'Pewamo',
      pct: 10,
      major: false,
      drainageClass: 'Very poorly drained',
      hydgrp: 'C/D',
      nccpi: 0.66,
    },
    {
      name: 'Blount',
      pct: 85,
      major: true,
      drainageClass: 'Somewhat poorly drained',
      hydgrp: 'C/D',
      nccpi: 0.62,
    },
    {
      name: 'Glynwood',
      pct: 5,
      major: false,
      drainageClass: 'Moderately well drained',
      hydgrp: 'C/D',
      nccpi: null,
    },
  ],
  surveyVersion: 'MI091 2025-09-05',
  synthetic: false,
};

describe('official series descriptions', () => {
  test('the documented URL pattern: first-letter folder, capitals, spaces as underscores', () => {
    expect(osdUrl('Blount')).toBe('https://soilseries.sc.egov.usda.gov/OSD_Docs/B/BLOUNT.html');
    expect(osdUrl('Del Rey')).toBe('https://soilseries.sc.egov.usda.gov/OSD_Docs/D/DEL_REY.html');
    expect(osdUrl(' Pewamo ')).toBe('https://soilseries.sc.egov.usda.gov/OSD_Docs/P/PEWAMO.html');
    expect(osdUrl('McBride')).toBe('https://soilseries.sc.egov.usda.gov/OSD_Docs/M/MCBRIDE.html');
  });

  test('miscellaneous areas, higher taxa and variants have no series page', () => {
    for (const name of [
      'Water',
      'Pits',
      'Urban land',
      'Made land',
      'Udorthents',
      'Aquents',
      'Haplaquolls',
      'Medisaprists',
      'Blount family',
      'Aquents, frequently flooded',
      '',
    ]) {
      expect(isSeriesComponent({ name }), name).toBe(false);
      expect(osdUrl(name), name).toBeNull();
    }
    for (const name of ['Blount', 'Hoytville', 'Lenawee', 'Del Rey', 'Selfridge', 'Granby']) {
      expect(isSeriesComponent({ name }), name).toBe(true);
    }
  });
});

describe('mapUnitView', () => {
  const preview = previewOf({
    mukey: '99901001',
    musym: 'BnB',
    muname: 'Blount loam, 1 to 4 percent slopes',
    drainage_class: 'Somewhat poorly drained',
    hydgrp: 'C/D',
    farmland_class: 'Prime farmland if drained',
    nccpi: 0.622,
  });
  if (!preview) throw new Error('preview');

  test('from the tapped feature at once: the four facts, components still loading', () => {
    const v = mapUnitView(preview, null);
    expect(v.symbol).toBe('BnB');
    expect(v.name).toBe('Blount loam, 1 to 4 percent slopes');
    expect(v.area).toBeNull();
    expect(v.components).toBeNull();
    expect(v.series).toEqual([]);
    expect(v.facts.map((f) => [f.key, f.value])).toEqual([
      ['drainage', 'Somewhat poorly drained'],
      ['hydgrp', 'C/D'],
      ['farmland', 'Prime farmland if drained'],
      ['nccpi', '0.62'],
    ]);
    const fact = (k: string) => v.facts.find((f) => f.key === k);
    expect(fact('hydgrp')?.detail).toBe('C if drained, D if not');
    expect(fact('hydgrp')?.color).toBe(HYDGRP_COLORS['C/D']);
    expect(fact('farmland')?.color).toBe(FARMLAND_COLORS.prime_if_drained);
    expect(fact('nccpi')?.color).toBe(NCCPI_COLORS[3]);
    expect(fact('nccpi')?.detail).toMatch(/0\.60 to 0\.75/);
  });

  test('from the detail: components largest first with %, the survey, the major series page', () => {
    const v = mapUnitView(preview, BLOUNT);
    expect(v.components).toEqual([
      {
        key: '0:Blount',
        name: 'Blount',
        pct: '85 %',
        major: true,
        drainage: 'Somewhat poorly drained',
        hydgrp: 'C/D',
        nccpi: '0.62',
      },
      {
        key: '1:Pewamo',
        name: 'Pewamo',
        pct: '10 %',
        major: false,
        drainage: 'Very poorly drained',
        hydgrp: 'C/D',
        nccpi: '0.66',
      },
      {
        key: '2:Glynwood',
        name: 'Glynwood',
        pct: '5 %',
        major: false,
        drainage: 'Moderately well drained',
        hydgrp: 'C/D',
        nccpi: '—',
      },
    ]);
    expect(v.area).toBe('Lenawee County, Michigan · survey of 2025-09-05');
    expect(v.dominant).toBe('Blount, 85 %');
    expect(v.series).toEqual([
      { name: 'Blount', url: 'https://soilseries.sc.egov.usda.gov/OSD_Docs/B/BLOUNT.html' },
    ]);
    expect(v.synthetic).toBe(false);
    expect(mapUnitView(preview, null).dominant).toBeNull();
  });

  test('tied shares: the loader’s order and its dominant component, not the alphabet', () => {
    // 45 % each; the loader put Pewamo first (lower cokey) and took its drainage and group.
    const tied: MapUnitDetail = {
      ...BLOUNT,
      dominantComponent: 'Pewamo',
      drainageClass: 'Very poorly drained',
      components: [
        { ...(BLOUNT.components[0] as SoilComponent), pct: 45, major: true },
        { ...(BLOUNT.components[1] as SoilComponent), pct: 45 },
        { ...(BLOUNT.components[2] as SoilComponent), pct: 10 },
      ],
    };
    const v = mapUnitView(preview, tied);
    expect(v.components?.map((c) => c.name)).toEqual(['Pewamo', 'Blount', 'Glynwood']);
    expect(v.dominant).toBe('Pewamo, 45 %');
    expect(v.series.map((x) => x.name)).toEqual(['Pewamo', 'Blount']);
  });

  test('the same component name twice: each row keeps its own key', () => {
    // SSURGO lists e.g. two 'Seward' components of 3 % in MI091 YpA.
    const seward = {
      name: 'Seward',
      pct: 3,
      major: false,
      drainageClass: 'Moderately well drained',
      hydgrp: 'B/D',
      nccpi: 0.55,
    };
    const v = mapUnitView(preview, {
      ...BLOUNT,
      components: [...BLOUNT.components, seward, { ...seward, nccpi: 0.5 }],
    });
    const keys = v.components?.map((c) => c.key) ?? [];
    expect(keys).toHaveLength(5);
    expect(new Set(keys).size).toBe(5);
    expect(v.components?.filter((c) => c.name === 'Seward').map((c) => c.nccpi)).toEqual([
      '0.55',
      '0.50',
    ]);
  });

  test('the detail cache holds one soils version: a reload of the soils empties it', () => {
    const cache = new MapUnitDetailCache();
    cache.set('ssurgo-1', BLOUNT.mukey, BLOUNT);
    expect(cache.get('ssurgo-1', BLOUNT.mukey)).toBe(BLOUNT);
    expect(cache.get('ssurgo-1', '99901002')).toBeUndefined();
    // `pnpm gis:soils` ran again: same mukeys, maybe new components.
    expect(cache.get('ssurgo-2', BLOUNT.mukey)).toBeUndefined();
    const reloaded = { ...BLOUNT, nccpi: 0.7 };
    cache.set('ssurgo-2', BLOUNT.mukey, reloaded);
    expect(cache.get('ssurgo-2', BLOUNT.mukey)).toBe(reloaded);
    expect(cache.get('ssurgo-1', BLOUNT.mukey)).toBeUndefined();
  });

  test('water: nothing rated, no series page; the synthetic fixture says so', () => {
    const water: MapUnitDetail = {
      ...BLOUNT,
      mukey: '99901008',
      musym: 'W',
      muname: 'Water',
      drainageClass: null,
      hydgrp: null,
      farmlandClass: 'Not prime farmland',
      nccpi: null,
      components: [
        { name: 'Water', pct: 100, major: true, drainageClass: null, hydgrp: null, nccpi: null },
      ],
      areasymbol: 'MI115',
      surveyVersion: null,
      synthetic: true,
    };
    const v = mapUnitView({ mukey: '99901008' }, water);
    expect(v.facts.map((f) => f.value)).toEqual([
      'Not rated',
      'Not rated',
      'Not prime farmland',
      'Not rated',
    ]);
    expect(v.facts[0]?.detail).toBeNull();
    expect(v.series).toEqual([]);
    expect(v.area).toBe('Monroe County, Michigan');
    expect(v.synthetic).toBe(true);
  });
});

describe('parseComponents and previewOf', () => {
  test('components: well-formed entries kept, the rest dropped or defaulted', () => {
    expect(parseComponents(null)).toEqual([]);
    expect(parseComponents({})).toEqual([]);
    expect(
      parseComponents([
        {
          name: 'Blount',
          pct: 85,
          major: true,
          drainageClass: 'Somewhat poorly drained',
          hydgrp: 'C/D',
          nccpi: 0.62,
        },
        { pct: 10 },
        'junk',
        { name: 'Pits', pct: 'x', major: 'yes', drainageClass: '', hydgrp: 3, nccpi: Number.NaN },
      ]),
    ).toEqual([
      {
        name: 'Blount',
        pct: 85,
        major: true,
        drainageClass: 'Somewhat poorly drained',
        hydgrp: 'C/D',
        nccpi: 0.62,
      },
      { name: 'Pits', pct: 0, major: false, drainageClass: null, hydgrp: null, nccpi: null },
    ]);
  });

  test('previewOf: tile properties, or null without a valid map unit key', () => {
    expect(previewOf({ mukey: '123', musym: 'Pe', nccpi: 0.67 })).toEqual({
      mukey: '123',
      musym: 'Pe',
      muname: null,
      drainage_class: null,
      hydgrp: null,
      farmland_class: null,
      nccpi: 0.67,
    });
    expect(previewOf({ mukey: 'abc' })).toBeNull();
    expect(previewOf({})).toBeNull();
    expect(previewOf(null)).toBeNull();
  });
});

describe('mapUnitAt', () => {
  function fake(hits: Record<string, unknown>[], hasLayer = true) {
    const asked: { point: [number, number]; layers: string[] }[] = [];
    const map: QueryableMap = {
      getLayer: (id) => (hasLayer && id === SOILS_IDS.fill ? {} : undefined),
      project: ([lng, lat]) => ({ x: lng * 10, y: lat * 10 }),
      queryRenderedFeatures: (point, opts) => {
        asked.push({ point, layers: opts.layers });
        return hits.map((properties) => ({ properties }));
      },
    };
    return { map, asked };
  }

  test('the map unit drawn at the tap, from the soils fill only', () => {
    const { map, asked } = fake([{ mukey: '99901002', musym: 'Pe' }, { mukey: '99901001' }]);
    expect(mapUnitAt(map, { lng: 1, lat: 2 })).toMatchObject({ mukey: '99901002', musym: 'Pe' });
    expect(asked).toEqual([{ point: [10, 20], layers: [SOILS_IDS.fill] }]);
  });

  test('null where no soils are drawn, or before the soils layer exists', () => {
    expect(mapUnitAt(fake([]).map, { lng: 1, lat: 2 })).toBeNull();
    const { map, asked } = fake([{ mukey: '1' }], false);
    expect(mapUnitAt(map, { lng: 1, lat: 2 })).toBeNull();
    expect(asked).toEqual([]);
  });
});

describe('the sheet store', () => {
  beforeEach(() => useMapUnitSheet.getState().close());

  test('show and close', () => {
    expect(useMapUnitSheet.getState().current).toBeNull();
    useMapUnitSheet.getState().show({ mukey: '1', musym: 'BnB' });
    expect(useMapUnitSheet.getState().current).toEqual({ mukey: '1', musym: 'BnB' });
    const before = useMapUnitSheet.getState();
    useMapUnitSheet.getState().close();
    expect(useMapUnitSheet.getState().current).toBeNull();
    // Closing a closed sheet changes nothing (no re-render).
    const closed = useMapUnitSheet.getState();
    useMapUnitSheet.getState().close();
    expect(useMapUnitSheet.getState()).toBe(closed);
    expect(before).not.toBe(closed);
  });
});

describe('in this view', () => {
  test('distinct map units by symbol (natural order), however many pieces each has', () => {
    const f = (mukey: string, musym: string | undefined, muname = `Unit ${musym}`) => ({
      properties: { mukey, musym, muname },
    });
    const units = unitsInView([
      f('3', 'Pe'),
      f('1', 'BnB'),
      f('3', 'Pe'),
      f('4', 'W', 'Water'),
      f('2', 'BnC2'),
      f('1', 'BnB'),
      f('5', '10B'),
      f('6', '2B'),
      { properties: { mukey: 'x' } },
      { properties: null },
    ]);
    expect(units.map((u) => u.musym)).toEqual(['2B', '10B', 'BnB', 'BnC2', 'Pe', 'W']);
    expect(units.map((u) => u.mukey)).toEqual(['6', '5', '1', '2', '3', '4']);
    expect(compareSymbols('BnB', 'bnb')).toBe(0);
    expect(IN_VIEW_MAX_ROWS).toBeGreaterThanOrEqual(20);
  });

  test('sameUnits compares the list, not the objects', () => {
    const a = [{ mukey: '1' }, { mukey: '2' }];
    expect(sameUnits(a, [{ mukey: '1' }, { mukey: '2' }])).toBe(true);
    expect(sameUnits(a, [{ mukey: '2' }, { mukey: '1' }])).toBe(false);
    expect(sameUnits(null, [])).toBe(false);
  });

  test('read off the map only from zoom 12: at county zoom it would stall the wall', () => {
    let queries = 0;
    let zoom = 11.5;
    const map = {
      getZoom: () => zoom,
      getLayer: (id: string) => (id === SOILS_IDS.fill ? {} : undefined),
      queryRenderedFeatures: (o: { layers: string[] }) => {
        queries++;
        expect(o.layers).toEqual([SOILS_IDS.fill]);
        return [{ properties: { mukey: '1', musym: 'BnB' } }];
      },
    };
    expect(readUnitsInView(map)).toEqual({ status: 'zoom-in' });
    zoom = 10;
    expect(readUnitsInView(map)).toEqual({ status: 'zoom-in' });
    expect(queries, 'no full-screen query below zoom 12').toBe(0);
    zoom = IN_VIEW_MIN_ZOOM;
    expect(readUnitsInView(map)).toEqual({
      status: 'ready',
      units: [expect.objectContaining({ mukey: '1', musym: 'BnB' })],
    });
    expect(queries).toBe(1);
    // Soils not on the map: nothing to list (and nothing asked).
    expect(readUnitsInView({ ...map, getLayer: () => undefined })).toEqual({
      status: 'ready',
      units: [],
    });
    expect(queries).toBe(1);
    const ready = readUnitsInView(map);
    expect(sameInView(ready, readUnitsInView(map))).toBe(true);
    expect(sameInView({ status: 'zoom-in' }, { status: 'zoom-in' })).toBe(true);
    expect(sameInView(ready, { status: 'zoom-in' })).toBe(false);
    expect(sameInView(null, { status: 'zoom-in' })).toBe(false);
  });
});
