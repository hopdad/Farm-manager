/**
 * The machines builder's unconfirmed ISO 15143-3 (AEMP 2.0) shapes (1f.2, docs/contracts-1f.md
 * part B). Checked against ISO's edition-1 XSDs (standards.iso.org/iso/15143/-3/ed-1), Deere's
 * aemp.yaml, Trackunit's aemp-iso-api.json and Samsara's getAempEquipmentList on Oct 30, 2026:
 * `/Fleet/{pageNumber}` below a per-provider root, 100 per page, the snapshot sections and their
 * fixed units, faults as a separate FaultCode series with no state, each provider's format
 * (Deere and CNH XML, Samsara JSON wrapped in {"Fleet": …}, Trackunit both) are spec-confirmed.
 * Appended to the admin list by src/connectors/doc-derived.ts; the builder adds its entries.
 */
import type { DocDerivedItem } from '../doc-derived';

export const AEMP_DOC_DERIVED: readonly DocDerivedItem[] = [
  {
    source: 'aemp',
    what: 'Kubota (KubotaNOW) ISO 15143-3: host, auth scheme, format, fault series',
    confirm:
      "no public Kubota API document: the dealer gives the Fleet ID, username and password (Geotab's partner guide); ask the dealer for the endpoint URL and an example response",
    file: 'src/config.ts (AEMP_PROVIDERS), src/connectors/endpoints.ts (aempEndpoints)',
    basis: 'doc',
  },
  {
    source: 'aemp',
    what: "a provider's fault series (AEMP_PROVIDERS[].faultsPath): identifier form, empty result",
    confirm:
      "Trackunit uses /Fleet/Equipment/ID/{id}/Faults/{start}/{end}/{page}, CNH the same without ID/; whether the id is the PIN, the serial or the provider's own, and what an empty window answers (404 or an empty list); edition 2 (2020) publishes no URL list",
    file: 'src/config.ts (faultsPath), src/connectors/aemp',
    basis: 'doc',
  },
  {
    source: 'aemp',
    what: 'Trackunit JSON (an unwrapped Fleet; `defremaining`), Samsara Links beyond self',
    confirm:
      "Trackunit's spec has no examples (match keys case-insensitively); whether Samsara's Links carry next/last and whether its hrefs omit /beta",
    file: 'src/connectors/aemp',
    basis: 'doc',
  },
];
