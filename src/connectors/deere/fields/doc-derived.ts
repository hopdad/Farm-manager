/**
 * deere-data's unconfirmed Deere paths and shapes (1f; plan §5 "Keeping it honest"): farms,
 * clients, equipment, engine hours … as the deere.fields sync uses them. Appended to the admin
 * list by src/connectors/doc-derived.ts. Each entry cites where the assumption lives; a
 * conformance run (`pnpm connectors:record deere`) removes entries. Empty until the builder adds.
 */
import type { DocDerivedItem } from '../../doc-derived';

export const DEERE_FIELDS_DOC_DERIVED: readonly DocDerivedItem[] = [];
