/**
 * pnpm connectors:record <source> [--scrub]   (slice 1f; owner: sync-health)
 *
 * To build (docs/contracts-1f.md §9, decision 3): run the live client of <source> (deere,
 * samsara, nws) in its configured sandbox or live mode with a recording `fetch`
 * (VendorHttpOptions.fetch), and save the raw responses ONLY under
 * data/raw/recorded/<source>/ (gitignored). `--scrub` writes an anonymized copy as replay fixtures
 * (kind 'recorded') into src/connectors/<source>/fixtures/recorded/<stream>/: names to stable
 * pseudonyms, ids hashed, coordinates moved into the demo area, tokens and auth headers dropped,
 * each file validated by the live zod schemas, and a check that no original id or name survives.
 * Real farm data is never committed.
 *
 * Foundation stub: prints "not built yet" and exits 0.
 */
console.log('connectors:record: not built yet (slice 1f, sync-health builder)');
