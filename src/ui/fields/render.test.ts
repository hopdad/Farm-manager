/**
 * The panel's tabs rendered to HTML (react-dom/server, no browser): what each role sees, the
 * seasons table on the wall and the list on phones, and the registry's tab filtering. The
 * interactive parts (taps, the sheet, realtime) are covered by e2e/field-panel*.spec.ts.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import type { Role } from '../../platform/auth/types';
import { FIXTURE_FIELD_ID, makeFieldDetail } from './fixtures';
import { FIELD_PANEL_TABS } from './tab-registry';
import type { FieldPanelTab } from './tabs';
import { OverviewTab, overviewTab } from './tabs/overview';
import { visibleTabs } from './visible-tabs';

function overview(role: Role, variant: 'wall' | 'phone' = 'wall', detail = makeFieldDetail()) {
  return renderToStaticMarkup(
    createElement(OverviewTab, {
      fieldId: FIXTURE_FIELD_ID,
      detail,
      variant,
      role,
      onChanged: () => {},
    }),
  );
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe('overview tab', () => {
  test('is registered in the overview slot', () => {
    expect(FIELD_PANEL_TABS).toContain(overviewTab);
    expect(overviewTab).toMatchObject({ id: 'overview', label: 'Overview', order: 10 });
  });

  test('shows the landlord with contacts, notes, five seasons, open jobs and the boundary', () => {
    const html = overview('viewer');
    expect(html).toContain('data-testid="field-party" data-role="Landlord"');
    expect(html).toContain('Ivan Abernath');
    expect(html).toContain('href="tel:5175550109"');
    expect(html).toContain('href="mailto:ivan.abernath@example.com"');
    expect(html).toContain('Wet hole in the NW corner after big rains.\nGate code 1234.');
    expect(count(html, 'data-testid="season-row"')).toBe(5);
    expect(html).toContain('<table');
    expect(html).toContain('>197.9<');
    expect(html).toContain('bu/ac');
    expect(html).toContain('data-testid="field-open-jobs"');
    expect(html).toContain('John Deere Operations Center');
    expect(html).toMatch(/Change it there/);
  });

  test('only managers and owners get the notes editor button', () => {
    for (const role of ['viewer', 'driver', 'operator'] as const) {
      expect(overview(role)).not.toContain('field-notes-edit');
    }
    for (const role of ['manager', 'owner'] as const) {
      expect(overview(role)).toContain('data-testid="field-notes-edit"');
    }
  });

  test('phones get the compact seasons list', () => {
    const html = overview('viewer', 'phone');
    expect(html).not.toContain('<table');
    expect(count(html, 'data-testid="season-row"')).toBe(5);
    expect(html).toContain('planted May 8');
  });

  test('empty states: no seasons, no notes, no boundary', () => {
    const html = overview(
      'manager',
      'wall',
      makeFieldDetail({
        seasons: [],
        boundary: null,
        notes: { text: null, updatedAt: null, updatedByName: null, version: 'v' },
      }),
    );
    expect(html).toContain('No seasons recorded yet.');
    expect(html).toContain('No notes yet.');
    expect(html).toContain('Add notes');
    expect(html).toContain('No boundary yet.');
  });

  test('a skeleton while the first load is in flight', () => {
    const html = renderToStaticMarkup(
      createElement(OverviewTab, {
        fieldId: FIXTURE_FIELD_ID,
        detail: null,
        variant: 'wall',
        role: 'viewer',
        onChanged: () => {},
      }),
    );
    expect(html).toContain('data-testid="field-overview-loading"');
    expect(html).toContain('aria-busy="true"');
  });
});

function None() {
  return null;
}

describe('visibleTabs', () => {
  const tab = (id: string, order: number, extra: Partial<FieldPanelTab> = {}): FieldPanelTab => ({
    id,
    label: id,
    order,
    Component: None,
    ...extra,
  });
  const tabs = [
    tab('soils', 30, { visible: (d) => d.soils.length > 0 }),
    tab('overview', 10),
    tab('admin', 60, { minRole: 'manager' }),
    tab('broken', 70, {
      visible: () => {
        throw new Error('boom');
      },
    }),
  ];

  test('in order, filtered by role and by visible(detail)', () => {
    const d = makeFieldDetail();
    expect(visibleTabs(tabs, 'viewer', d).map((t) => t.id)).toEqual(['overview']);
    expect(visibleTabs(tabs, 'manager', d).map((t) => t.id)).toEqual(['overview', 'admin']);
  });

  test('before the detail loads, visible() is not asked', () => {
    expect(visibleTabs(tabs, 'viewer', null).map((t) => t.id)).toEqual([
      'overview',
      'soils',
      'broken',
    ]);
  });
});
