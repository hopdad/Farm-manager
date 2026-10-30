/**
 * The machines builder's unconfirmed ISO 15143-3 (AEMP 2.0) shapes (1f.2, docs/contracts-1f.md
 * part B). Appended to the admin list by src/connectors/doc-derived.ts; the builder adds its
 * entries (element names, the fault time series path, JSON vs XML per provider).
 */
import type { DocDerivedItem } from '../doc-derived';

export const AEMP_DOC_DERIVED: readonly DocDerivedItem[] = [
  {
    source: 'aemp',
    what: 'GET {provider baseUrl}/Fleet/{pageNumber} (AEMP_PROVIDERS[].baseUrl; Samsara /beta/aemp)',
    confirm:
      "each provider's host and auth (Deere: partneraemp.deere.com vs sandboxapi.deere.com/aemp, OAuth2 eq2; Kubota: dealer credentials), JSON or XML, page size, the 2020-edition fault paths",
    file: 'src/connectors/endpoints.ts (aempEndpoints), src/config.ts (AEMP_PROVIDERS)',
  },
];
