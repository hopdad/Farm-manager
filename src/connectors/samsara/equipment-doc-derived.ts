/**
 * The machines builder's unconfirmed Samsara equipment shapes (1f.2, docs/contracts-1f.md part B):
 * the /fleet/equipment feeds are in Samsara's SDK; whether a tractor's diagnostic port gives the
 * J1939 data on an AG26 harness, and the manual engine-hours offset, are not. Appended to the
 * admin list by src/connectors/doc-derived.ts; the builder adds its entries.
 */
import type { DocDerivedItem } from '../doc-derived';

export const SAMSARA_EQUIPMENT_DOC_DERIVED: readonly DocDerivedItem[] = [];
