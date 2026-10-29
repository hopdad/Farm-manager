/**
 * The Soils tab (react-dom/server, no browser): the view model (series, drainage, percent,
 * weighted NCCPI, coverage), the wall table and the phone list, the empty and loading states,
 * and its registration. The tap-through on the board is e2e/soils.spec.ts.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import type { FieldDetail } from '../../../domain/fields';
import { type FieldSoilRow, summarizeFieldSoils } from '../../../domain/soils';
import { DRAINAGE_COLORS, DRAINAGE_UNKNOWN_COLOR } from '../../map/layers/soils';
import { FIELD_PANEL_TABS } from '../tab-registry';
import { orderTabs } from '../tabs';
import { SoilsBody, SoilsTab, soilsSourceOf, soilsTab, soilsTabView } from './soils';

const ROWS: FieldSoilRow[] = [
  {
    mukey: '99901001',
    musym: 'BnB',
    muname: 'Blount loam, 1 to 4 percent slopes',
    dominantComponent: 'Blount',
    drainageClass: 'Somewhat poorly drained',
    hydgrp: 'C/D',
    farmlandClass: 'Prime farmland if drained',
    nccpi: 0.615,
    acres: 48.2,
    pct: 61.6,
  },
  {
    mukey: '99901008',
    musym: 'W',
    muname: 'Water',
    dominantComponent: 'Water',
    drainageClass: null,
    hydgrp: null,
    farmlandClass: 'Not prime farmland',
    nccpi: null,
    acres: 2.1,
    pct: 2.7,
  },
  {
    mukey: '99901002',
    musym: 'Pe',
    muname: 'Pewamo silty clay loam, 0 to 1 percent slopes',
    dominantComponent: 'Pewamo',
    drainageClass: 'Very poorly drained',
    hydgrp: 'C/D',
    farmlandClass: 'Prime farmland if drained',
    nccpi: 0.68,
    acres: 27.9,
    pct: 35.7,
  },
];

function detail(soils: FieldSoilRow[] = ROWS): FieldDetail {
  return {
    field: {
      id: 'f1',
      name: 'Abernath East 80',
      farmId: 'farm1',
      farmName: 'Adrian',
      tenure: 'owned',
      acres: 78.2,
      countyFips: '26091',
      landlord: null,
      customer: null,
      deereFieldId: null,
      active: true,
    },
    boundary: null,
    seasons: [],
    soils,
    soilsSummary: soils.length ? summarizeFieldSoils(soils) : null,
    parcels: [],
    openJobs: { count: 0, placeholder: true },
    notes: { text: null, updatedAt: null, updatedByName: null, version: '2026-10-29T00:00:00Z' },
    lineage: { parents: [], children: [] },
    openBoundaryRequests: 0,
    spray: null,
  };
}

const render = (d: FieldDetail | null, variant: 'wall' | 'phone' = 'wall') =>
  d
    ? renderToStaticMarkup(createElement(SoilsBody, { detail: d, variant, source: null }))
    : renderToStaticMarkup(
        createElement(SoilsTab, {
          fieldId: 'f1',
          detail: null,
          variant,
          role: 'viewer',
          onChanged: () => {},
        }),
      );

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe('soilsTabView', () => {
  test('rows largest first with series, drainage colour, hydgrp, acres, share and NCCPI', () => {
    const v = soilsTabView(ROWS);
    expect(v.empty).toBe(false);
    expect(v.rows.map((r) => r.symbol)).toEqual(['BnB', 'Pe', 'W']);
    expect(v.rows[0]).toEqual({
      mukey: '99901001',
      symbol: 'BnB',
      name: 'Blount loam, 1 to 4 percent slopes',
      series: 'Blount',
      drainage: 'Somewhat poorly drained',
      drainageColor: DRAINAGE_COLORS['Somewhat poorly drained'],
      hydgrp: 'C/D',
      acres: '48.2',
      pct: '62 %',
      nccpi: '0.61',
    });
    expect(v.rows[2]).toMatchObject({
      drainage: 'Not rated',
      drainageColor: DRAINAGE_UNKNOWN_COLOR,
      hydgrp: '—',
      nccpi: '—',
      pct: '2.7 %',
    });
  });

  test('weighted NCCPI over rated acres, dominant unit, drainage mix driest first', () => {
    const v = soilsTabView(ROWS);
    // (0.615·48.2 + 0.68·27.9) / (48.2 + 27.9) = 0.6388…
    expect(v.weightedNccpi).toBe('0.64');
    expect(v.nccpiPercent).toBe(64);
    expect(v.dominant).toBe('Mostly Blount (BnB), somewhat poorly drained · 62 %');
    expect(v.drainage.map((d) => d.label)).toEqual([
      'Somewhat poorly drained',
      'Very poorly drained',
      'Not rated',
    ]);
    expect(v.coverage).toBeNull();
  });

  test('says when soils cover only part of the boundary', () => {
    const v = soilsTabView([{ ...(ROWS[0] as FieldSoilRow), pct: 80 }]);
    expect(v.coverage).toBe('Soils cover 80 % of the boundary');
  });

  test('no NCCPI anywhere is a dash, not 0', () => {
    const v = soilsTabView([ROWS[1] as FieldSoilRow]);
    expect(v.weightedNccpi).toBe('—');
    expect(v.nccpiPercent).toBeNull();
  });

  test('no rows is the empty state', () => {
    expect(soilsTabView([])).toMatchObject({ empty: true, rows: [] });
  });
});

describe('rendered', () => {
  test('wall: a table row per map unit and the weighted NCCPI', () => {
    const html = render(detail());
    expect(html).toContain('data-testid="field-soils"');
    expect(count(html, 'data-testid="field-soils-row"')).toBe(3);
    expect(html).toContain('<table');
    expect(html).toMatch(/data-testid="field-soils-nccpi"[^>]*>0\.64</);
    expect(html).toContain('Blount loam, 1 to 4 percent slopes');
    expect(html).toContain('data-testid="field-soils-gauge"');
  });

  test('phone: a list, no table', () => {
    const html = render(detail(), 'phone');
    expect(html).not.toContain('<table');
    expect(count(html, 'data-testid="field-soils-row"')).toBe(3);
  });

  test('empty: says how to load soils', () => {
    const html = render(detail([]));
    expect(html).toContain('data-testid="field-soils-empty"');
    expect(html).toContain('pnpm gis:soils');
  });

  test('loading: a skeleton', () => {
    expect(render(null)).toContain('data-testid="field-soils-loading"');
  });

  test('a synthetic fixture says so', () => {
    const html = renderToStaticMarkup(
      createElement(SoilsBody, {
        detail: detail(),
        variant: 'wall',
        source: { text: 'Synthetic test fixture, not survey data', synthetic: true },
      }),
    );
    expect(html).toContain('Synthetic test fixture, not survey data');
  });
});

describe('soilsSourceOf', () => {
  const layer = (meta: Record<string, unknown>, sourceVintage: string | null) => ({
    layers: [
      {
        key: 'soils',
        kind: 'mvt' as const,
        urlOrKey: '/api/tiles/soils',
        version: 'x',
        cachePolicy: 'public' as const,
        minzoom: 10,
        maxzoom: 16,
        attribution: 'Soils: USDA NRCS SSURGO',
        legend: null,
        sourceVintage,
        builtAt: null,
        defaultVisible: false,
        meta,
        url: '/api/tiles/soils/{z}/{x}/{y}?v=x',
      },
    ],
  });
  test('real survey vintage, the fixture, or nothing', () => {
    expect(soilsSourceOf(layer({ fixture: false }, 'SSURGO MI091 2025-09-05'))).toEqual({
      text: 'SSURGO MI091 2025-09-05',
      synthetic: false,
    });
    expect(soilsSourceOf(layer({ fixture: true }, 'x'))?.synthetic).toBe(true);
    expect(soilsSourceOf({ layers: [] })).toBeNull();
    expect(soilsSourceOf(null)).toBeNull();
  });
});

describe('registration', () => {
  test('in the soils slot of the registry', () => {
    expect(FIELD_PANEL_TABS).toContain(soilsTab);
    expect(soilsTab).toMatchObject({ id: 'soils', label: 'Soils', order: 30 });
    expect(() => orderTabs(FIELD_PANEL_TABS)).not.toThrow();
  });
});
