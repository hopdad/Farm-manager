/**
 * deere-data's unconfirmed Deere paths and shapes (slice 1f; plan §5 "Keeping it honest"), as
 * the deere.fields sync uses them. Appended to the admin list by src/connectors/doc-derived.ts.
 * Each entry cites where the assumption lives and the doc it comes from; a conformance run
 * (`pnpm connectors:record deere`) against a real account removes entries. `spec` = from Deere's
 * own published spec (developer.deere.com/devDoc/apiDetails/<key>, read Oct 30, 2026), only a
 * recorded response missing; `doc` = Deere's docs don't say.
 */
import type { DocDerivedItem } from '../../doc-derived';

export const DEERE_FIELDS_DOC_DERIVED: readonly DocDerivedItem[] = [
  {
    source: 'deere',
    what: 'GET /platform/organizations/{orgId}/fields?recordFilter=ALL&embed=farms,clients',
    confirm:
      'that the embed puts `farms: { farms: [Farm] }` and `clients: { clients: [Client] }` on each field (spec schema FieldResponse; no example shows it), and that recordFilter=ALL lists archived fields (https://developer.deere.com/dev-docs/fields)',
    file: 'src/connectors/deere/fields/client.ts, src/connectors/deere/fields/schemas.ts',
    basis: 'spec',
  },
  {
    source: 'deere',
    what: 'GET /platform/organizations/{orgId}/boundaries?recordFilter=active (the documented default, named)',
    confirm:
      "that the default listing has each field's active boundary with `active: true` and a `field` link, and what `active` in recordFilter means beside a boundary's own `active` flag (https://developer.deere.com/dev-docs/boundaries)",
    file: 'src/connectors/deere/fields/client.ts, src/connectors/deere/fields/mapper.ts (activeBoundaryOf)',
    basis: 'spec',
  },
  {
    source: 'deere',
    what: 'GET /platform/organizations/{orgId}/flags?recordFilter=all&embed=flagCategory',
    confirm:
      "where `embed=flagCategory` puts the category on a flag (read as `flagCategory.categoryTitle`; Deere's examples only show the `flagCategoryWithPrefrences` link), the reference category titles a real org uses (pin kinds: pinKindOfCategory), and that recordFilter=all returns archived flags (https://developer.deere.com/dev-docs/flags)",
    file: 'src/connectors/deere/fields/schemas.ts, src/connectors/deere/fields/mapper.ts',
    basis: 'doc',
  },
  {
    source: 'deere',
    what: 'Equipment API isgType.name / type.name → machine kind (Combine, Tractor, Sprayer …)',
    confirm:
      'the real ISG type names (one GET https://equipmentapi.deere.com/isg/equipmentISGTypes?category=machine on a real account; the docs show only Combine, Tractor and Scraper): machineKindOfType is lenient, and unmappable kinds are listed on /admin/connectors (sync_state deere/equipment extra.unmappedKinds)',
    file: 'src/connectors/deere/fields/mapper.ts (machineKindOfType)',
    basis: 'doc',
  },
  {
    source: 'deere',
    what: 'GET /platform/machines/{principalId}/engineHours?lastKnown=true',
    confirm:
      "the reading's unit as a real machine reports it (the spec example says Hours), how often a JDLink machine reports, and the status for a machine with no report yet (404 is taken as none) (https://developer.deere.com/dev-docs/machine-engine-hours)",
    file: 'src/connectors/deere/fields/client.ts (lastEngineHours), src/connectors/deere/fields/mapper.ts (engineHoursOf)',
    basis: 'spec',
  },
  {
    source: 'deere',
    what: 'farms and fields of a customer org: the org as the customer (decision 8)',
    confirm:
      'whether a partner org\'s fields come with its own farm and client records, and whether its listing marks the org `member: false` (the docs define `member` only as "the user is a member"); until then a farm created there gets the org\'s party',
    file: 'src/db/queries/deere-fields.ts (customerOrgParty)',
    basis: 'doc',
  },
];
