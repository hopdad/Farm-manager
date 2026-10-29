/**
 * Which registered tabs the panel shows (pure; unit-tested): those the session's role may see
 * (`minRole`, default viewer) and, once the detail is loaded, whose `visible(detail)` agrees. A
 * tab whose `visible()` throws is hidden (and logged), never the panel's problem.
 */
import type { FieldDetail } from '../../domain/fields';
import { type Role, roleAtLeast } from '../../platform/auth/types';
import { type FieldPanelTab, orderTabs } from './tabs';

export function visibleTabs(
  tabs: readonly FieldPanelTab[],
  role: Role,
  detail: FieldDetail | null,
): FieldPanelTab[] {
  return orderTabs(tabs).filter((t) => {
    if (!roleAtLeast(role, t.minRole ?? 'viewer')) return false;
    if (!detail || !t.visible) return true;
    try {
      return t.visible(detail);
    } catch (e) {
      console.error(`[field panel] tab '${t.id}' visible() threw`, e);
      return false;
    }
  });
}
