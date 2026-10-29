/**
 * The field panel's tabs (contract: ./tabs.ts). INTEGRATOR-OWNED list: each builder adds only
 * its own import line and its own entry here (merge conflicts stay one-liners), e.g.
 *
 *   import { soilsTab } from './tabs/soils';
 *   export const FIELD_PANEL_TABS: readonly FieldPanelTab[] = [overviewTab, soilsTab];
 *
 * The panel renders `orderTabs(FIELD_PANEL_TABS)`.
 */
import { weatherTab } from '../weather/FieldWeatherTab';
import type { FieldPanelTab } from './tabs';
import { historyTab } from './tabs/history';
import { overviewTab } from './tabs/overview';
import { parcelsTab } from './tabs/parcels';
import { soilsTab } from './tabs/soils';

export const FIELD_PANEL_TABS: readonly FieldPanelTab[] = [
  overviewTab,
  historyTab,
  soilsTab,
  parcelsTab,
  weatherTab,
];
