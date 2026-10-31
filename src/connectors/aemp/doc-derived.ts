/**
 * The machines builder's unconfirmed ISO 15143-3 (AEMP 2.0) shapes (1f.2, docs/contracts-1f.md
 * part B). Checked against ISO's edition-1 XSDs (standards.iso.org/iso/15143/-3/ed-1), Deere's
 * aemp.yaml, Trackunit's aemp-iso-api.json and Samsara's getAempEquipmentList on Oct 30, 2026:
 * `/Fleet/{pageNumber}` below a per-provider root, 100 per page, the snapshot sections and their
 * fixed units, faults as a separate FaultCode series with no state, each provider's format
 * (Deere and CNH XML, Samsara JSON wrapped in {"Fleet": …}, Trackunit both) are spec-confirmed.
 * Appended to the admin list by src/connectors/doc-derived.ts. The machines builder's client
 * (./client.ts, ./parse.ts, ./auth.ts) added the entries after the first three.
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
  {
    source: 'aemp',
    what: 'GET {baseUrl}/Fleet/{pageNumber}: pages of 100 from 1, follow `next` (URL rebuilt from baseUrl), Accept from the format',
    confirm:
      "one recorded page per provider (Deere partneraemp.deere.com XML, Samsara /beta/aemp JSON wrapped in Fleet, CNH XML, Trackunit XML or JSON): the paths, page size and formats are each provider's spec; only a response is missing",
    file: 'src/connectors/aemp/client.ts, src/connectors/aemp/parse.ts',
    basis: 'spec',
  },
  {
    source: 'aemp',
    what: 'a fault series that answers 404 for a window with no faults',
    confirm:
      'read as "no faults" (Trackunit\'s own importer has a flag for servers that do so: faultCodesAcceptHttpNotFoundAsEmptyData); confirm per provider on a recording',
    file: 'src/connectors/aemp/client.ts (machineFaults)',
    basis: 'doc',
  },
  {
    source: 'aemp',
    what: 'oauth2 client authentication: client_credentials with the secret in the form body, password grant with HTTP Basic',
    confirm:
      "Trackunit's access-token pages (v2 client_credentials body fields; v1 Basic client auth with username and password): confirm with Trackunit credentials; other oauth2 providers may want Basic for client_credentials too",
    file: 'src/connectors/aemp/auth.ts',
    basis: 'spec',
  },
  {
    source: 'aemp',
    what: 'a section without its own datetime is dated by Fleet@snapshotTime; a Distance without units is kilometres',
    confirm:
      "Deere's aemp.yaml example omits section datetimes (the XSD requires them); ISO fixes OdometerUnits to kilometre; confirm on a Deere recording",
    file: 'src/connectors/aemp/mapper.ts',
    basis: 'doc',
  },
];
