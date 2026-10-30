/**
 * The trucks builder's unconfirmed MyGeotab shapes (1f.2, docs/contracts-1f.md part B).
 * Appended to the admin list by src/connectors/doc-derived.ts; the builder adds its entries.
 */
import type { DocDerivedItem } from '../doc-derived';

export const GEOTAB_DOC_DERIVED: readonly DocDerivedItem[] = [
  {
    source: 'geotab',
    what: 'POST https://{GEOTAB_SERVER|my.geotab.com}/apiv1 JSON-RPC: Authenticate, GetFeed (LogRecord, StatusData, FaultData, fromVersion → toVersion)',
    confirm:
      'the server Authenticate redirects to, the session lifetime (14 days per the SDK README), the GetFeed 60/min and Authenticate 10/min limits, the free demo database for sandbox mode',
    file: 'src/connectors/endpoints.ts (geotabEndpoint)',
  },
];
