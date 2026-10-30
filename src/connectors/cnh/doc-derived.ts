/**
 * The machines builder's unconfirmed CNH FieldOps shapes (1f.2, docs/contracts-1f.md part B):
 * scaffolding only; develop.cnh.com was blocked from the build machine. Appended to the admin
 * list by src/connectors/doc-derived.ts; the builder adds its entries.
 */
import type { DocDerivedItem } from '../doc-derived';

export const CNH_DOC_DERIVED: readonly DocDerivedItem[] = [
  {
    source: 'cnh',
    what: 'CNH_API_BASE default https://api-data.cnh.com/v1 (Leaf guide; a third party says api.fieldops.cnh.com)',
    confirm:
      'the API host for staging and production, the telemetry paths (Locations is disputed), the "120" limit (users or requests per second)',
    file: 'src/connectors/endpoints.ts (cnhEndpoints)',
  },
  {
    source: 'cnh',
    what: 'OAuth at https://identity.cnhind.com (CNH_AUTH_BASE) plus a subscription-key header on every call',
    confirm:
      'authorize and token paths, the audience, the subscription-key header name, the 403 a machine without its owner EULA answers',
    file: 'src/connectors/endpoints.ts (cnhEndpoints)',
  },
];
