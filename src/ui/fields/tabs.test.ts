import { describe, expect, test } from 'vitest';
import { FIELD_PANEL_TABS } from './tab-registry';
import { type FieldPanelTab, orderTabs, TAB_ORDER } from './tabs';

function EmptyTab() {
  return null;
}

const tab = (id: string, order: number): FieldPanelTab => ({
  id,
  label: id,
  order,
  Component: EmptyTab,
});

describe('orderTabs', () => {
  test('sorts by order, then id', () => {
    const tabs = [tab('soils', 30), tab('overview', 10), tab('b-extra', 30), tab('history', 20)];
    expect(orderTabs(tabs).map((t) => t.id)).toEqual(['overview', 'history', 'b-extra', 'soils']);
  });

  test('refuses duplicate and malformed ids', () => {
    expect(() => orderTabs([tab('soils', 30), tab('soils', 31)])).toThrow(/twice/);
    expect(() => orderTabs([tab('Soils', 30)])).toThrow(/slug/);
  });

  test('the registry is always orderable and the reserved slots are distinct', () => {
    expect(() => orderTabs(FIELD_PANEL_TABS)).not.toThrow();
    const slots = Object.values(TAB_ORDER);
    expect(new Set(slots).size).toBe(slots.length);
  });
});
