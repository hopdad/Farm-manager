/**
 * The History tab (src/ui/fields/tabs/history.tsx) rendered to HTML: what it shows before its
 * own fetch lands, and which controls each role gets. Taps and saves: e2e/field-data-fields.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import type { FieldDetail } from '@/domain/fields';
import type { Role } from '@/platform/auth/types';
import { FIELD_PANEL_TABS } from '@/ui/fields/tab-registry';
import { orderTabs } from '@/ui/fields/tabs';
import { HistoryTab, historyTab } from '@/ui/fields/tabs/history';

const detail: FieldDetail = {
  field: {
    id: '4b7f1c52-8e0a-5d3b-9a61-2f0c8d4e7a19',
    name: 'North 160',
    farmId: 'farm',
    farmName: 'Home',
    tenure: 'owned',
    acres: 158.3,
    countyFips: '26091',
    landlord: null,
    customer: null,
    deereFieldId: null,
    active: true,
  },
  boundary: null,
  seasons: [
    {
      cropYear: 2025,
      crop: 'corn',
      variety: 'P1197',
      plantedOn: '2025-04-28',
      harvestedOn: '2025-10-30',
      yieldBuAc: 212.5,
      source: 'import',
    },
    {
      cropYear: 2024,
      crop: 'soybeans',
      variety: null,
      plantedOn: null,
      harvestedOn: null,
      yieldBuAc: null,
      source: 'deere',
    },
  ],
  soils: [],
  soilsSummary: null,
  parcels: [],
  openJobs: { count: 0, placeholder: true },
  notes: { text: null, updatedAt: null, updatedByName: null, version: '2026-10-29T00:00:00.000Z' },
  lineage: { parents: [], children: [] },
  openBoundaryRequests: 0,
  spray: null,
};

const render = (role: Role, variant: 'wall' | 'phone' = 'wall', d: FieldDetail | null = detail) =>
  renderToStaticMarkup(
    createElement(HistoryTab, {
      fieldId: detail.field.id,
      detail: d,
      variant,
      role,
      onChanged: () => {},
    }),
  );

describe('History tab', () => {
  test('is registered in its slot', () => {
    expect(FIELD_PANEL_TABS).toContain(historyTab);
    expect(historyTab).toMatchObject({ id: 'history', label: 'History', order: 20 });
    expect(() => orderTabs(FIELD_PANEL_TABS)).not.toThrow();
  });

  test("renders the panel's seasons at once, newest first", () => {
    const html = render('viewer');
    expect(html.indexOf('history-season-2025')).toBeLessThan(html.indexOf('history-season-2024'));
    expect(html).toContain('212.5');
    expect(html).toContain('Apr 28');
    expect(html).toContain('Ops Center');
    expect(html).toContain('Loading older years');
  });

  test('a viewer reads, a manager edits', () => {
    expect(render('viewer')).not.toContain('history-add');
    expect(render('operator')).not.toContain('history-edit-2025');
    const manager = render('manager');
    expect(manager).toContain('data-testid="history-add"');
    expect(manager).toContain('data-testid="history-edit-2024"');
  });

  test('phones get 48 px targets and no source column; nothing yet is a skeleton', () => {
    expect(render('manager', 'phone')).toContain('min-height:48px');
    expect(render('manager', 'phone')).not.toContain('>From<');
    expect(render('manager', 'wall')).toContain('min-height:72px');
    expect(render('viewer', 'wall', null)).toContain('field-history-loading');
  });
});
