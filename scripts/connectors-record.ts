/**
 * pnpm connectors:record <source> [--scrub] [--out <dir>] [--raw <dir>]   (slice 1f; sync-health)
 *
 * Record what a vendor's API answers, for decision 3 (docs/contracts-1f.md §8, §9, §12): the
 * live client of <source> (deere, samsara) runs in its configured mode (CONNECTOR_DEERE /
 * CONNECTOR_SAMSARA: sandbox or live on Derrick's PC, sim against the stand-in) through a
 * recording fetch (tools/record/record.ts):
 *
 *   raw responses ONLY under data/raw/recorded/<source>/<stream>/ (gitignored; --raw <dir>)
 *   --scrub   an anonymized copy per stream as a recorded replay fixture under
 *             src/connectors/<source>/fixtures/recorded/<stream>/ (or --out <dir>/<stream>/):
 *             ids hashed, names pseudonymized, coordinates moved into the demo area, tokens
 *             and auth headers dropped, each exchange checked by the live schemas, and refused if
 *             an original id or name survives
 *
 * Endpoints the stand-in answers 404 "not simulated" are skipped and listed. Its vendor calls
 * count under stream 'record' in ingest.api_calls_daily (withCallStream + installCallCounting).
 * Deere uses the stored grant (sign in at /api/oauth/deere first); in sim it connects by itself.
 * Real farm data is never committed: review a scrubbed file before adding it to
 * <source>/replay-recorded.ts (the contract and conformance tests read that list; the board
 * never does).
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { getConfig } from '../src/config';
import { configuredCallMode, installCallCounting } from '../src/connectors/call-budget';
import { deereEndpoints } from '../src/connectors/endpoints';
import { withCallStream } from '../src/connectors/http';
import { tokenKey } from '../src/connectors/oauth/crypto';
import { OAuthTokenStore, userGrantOrg } from '../src/connectors/oauth/token-store';
import { createPool } from '../src/db/client';
import { isMainModule } from '../src/lib/proc';
import { RECORD_SOURCES, type RecordSource } from '../tools/record/plans';
import { formatReport, RecordError, recordSource } from '../tools/record/record';

export class UsageError extends Error {}

const USAGE = `usage: pnpm connectors:record <${RECORD_SOURCES.join('|')}> [--scrub] [--out <dir>] [--raw <dir>]`;

export interface RecordArgs {
  source: RecordSource;
  scrub: boolean;
  out: string | null;
  raw: string | null;
}

export function parseRecordArgs(argv: string[]): RecordArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        scrub: { type: 'boolean', default: false },
        out: { type: 'string' },
        raw: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (e) {
    throw new UsageError(`${(e as Error).message}\n${USAGE}`);
  }
  const source = parsed.positionals[0];
  if (parsed.values.help || parsed.positionals.length !== 1) throw new UsageError(USAGE);
  if (!(RECORD_SOURCES as readonly string[]).includes(source ?? '')) {
    throw new UsageError(`unknown source '${source}'\n${USAGE}`);
  }
  const out = typeof parsed.values.out === 'string' ? parsed.values.out : null;
  if (out && parsed.values.scrub !== true) throw new UsageError(`--out needs --scrub\n${USAGE}`);
  return {
    source: source as RecordSource,
    scrub: parsed.values.scrub === true,
    out: out ? path.resolve(out) : null,
    raw: typeof parsed.values.raw === 'string' ? path.resolve(parsed.values.raw) : null,
  };
}

async function main(): Promise<void> {
  let args: RecordArgs;
  try {
    args = parseRecordArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 2;
    return;
  }
  const cfg = getConfig();
  const mode = args.source === 'deere' ? cfg.CONNECTOR_DEERE : cfg.CONNECTOR_SAMSARA;
  const pool = createPool({ max: 2, applicationName: 'farm-record' });
  const stop = installCallCounting(pool, (v) => configuredCallMode(cfg, v));
  try {
    const tokens =
      args.source === 'deere' && mode !== 'replay' && mode !== 'off'
        ? new OAuthTokenStore({
            pool,
            source: 'deere',
            org: userGrantOrg(deereEndpoints(mode, cfg)),
            key: tokenKey(cfg.TOKEN_ENC_KEY),
          })
        : undefined;
    const report = await withCallStream('record', () =>
      recordSource({
        source: args.source,
        mode,
        cfg,
        tokens,
        scrub: args.scrub,
        outDir: args.out,
        rawDir: args.raw ? path.join(args.raw) : undefined,
        projectDir: cfg.projectDir,
        log: (m) => console.log(`[record] ${m}`),
      }),
    );
    console.log(formatReport(report));
    if (report.scrubErrors.length || report.failed.length) process.exitCode = 1;
  } finally {
    stop();
    await pool.end();
  }
}

if (isMainModule(import.meta.url)) {
  try {
    await main();
  } catch (e) {
    console.error(`[record] ${e instanceof RecordError ? '' : 'error: '}${(e as Error).message}`);
    process.exitCode = 1;
  }
}
