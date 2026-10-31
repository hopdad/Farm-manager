/**
 * Sync health read model of /admin/connectors (1f, sync-health; docs/contracts-1f.md §11.4),
 * server only: vendor calls today and yesterday per source and mode (ingest.api_calls_daily),
 * the Deere call budget and its split (decision 4), the Deere OAuth grant (connected, expiry,
 * scopes, the scope warning), each Deere org's approval status in the current mode
 * (ingest.connector_orgs, decision 5), the home org and where it came from (decision 8), the
 * unmappable Deere equipment (sync_state deere/equipment `extra.unmappedKinds`) and Terminal's
 * provider rows (sync_state terminal/providers `extra.providers`).
 */
import type { Config } from '../../../config';
import {
  type DeereBudgetView,
  loadDeereBudget,
  loadSourceCalls,
  type SourceCalls,
} from '../../../connectors/call-budget';
import { type OrgStatusView, orgStatusView } from '../../../connectors/deere/connections';
import { type DeereHomeOrgSource, deereHomeOrg } from '../../../connectors/deere/orgs';
import { DEERE_SCOPES } from '../../../connectors/deere/schemas';
import {
  ConnectorModeError,
  deereEndpoints,
  deereRedirectUri,
} from '../../../connectors/endpoints';
import { type GrantInfo, missingScopes, readGrantInfo } from '../../../connectors/oauth/grant-info';
import { userGrantOrg } from '../../../connectors/oauth/token-store';
import type { Mode } from '../../../connectors/types';
import type { TerminalProviderRow } from '../../../connectors/vendors';
import { type Executor, exec } from '../../../db/exec';
import {
  type ConnectorOrgRow,
  listConnectorOrgs,
  storedHomeOrgOf,
} from '../../../db/queries/connector-orgs';
import { nextRun, validateCron } from '../../../jobs/schedule';
import type { JobRegistry } from '../../../jobs/types';

export interface DeereOAuthView {
  mode: Mode;
  /** The stand-in (sim connects by itself, no sign-in link). */
  sim: boolean;
  /** Replay needs no grant (fixtures, fixed token). */
  replay: boolean;
  /** Which grant row: '' (a real account) or 'sim'. */
  grantOrg: string | null;
  grant: GrantInfo | null;
  /** DEERE_SCOPES the stored grant lacks (sign in again, then raise the org's permission). */
  missing: string[];
  /** Where to sign in (outside sim and replay). */
  connectUrl: string | null;
  redirectUri: string;
  /** Why the endpoints can't be built (sandbox/live without the app's credentials). */
  configError: string | null;
}

export interface OrgView extends ConnectorOrgRow {
  view: OrgStatusView;
}

export interface HomeOrgView {
  orgId: string | null;
  source: DeereHomeOrgSource | string;
  /** The org ids to pick DEERE_HOME_ORG_ID from (when unknown). */
  candidates: { id: string; name: string | null; member: boolean | null }[];
  /** When fleet.deere decided it (null = computed here: config, sim or replay). */
  at: string | null;
}

export interface SyncHealthSnapshot {
  calls: SourceCalls[];
  budget: DeereBudgetView;
  oauth: DeereOAuthView;
  orgs: { mode: Mode; rows: OrgView[] };
  homeOrg: HomeOrgView;
  /** `{ "<ISG type name>": <machine count> }` deere-data lists once (deere/equipment extra). */
  unmappedKinds: Record<string, number>;
  terminalProviders: TerminalProviderRow[];
}

export type SyncHealthConfig = Pick<
  Config,
  | 'CONNECTOR_DEERE'
  | 'DEERE_DAILY_CALL_BUDGET'
  | 'DEERE_HOME_ORG_ID'
  | 'DEERE_REDIRECT_URI'
  | 'FLEET_STALE_SECONDS_DEERE'
  | 'PUBLIC_URL'
  | 'VENDOR_SIM_URL'
  | 'TOKEN_ENC_KEY'
  | 'DEERE_CLIENT_ID'
  | 'DEERE_CLIENT_SECRET'
  | 'SAMSARA_API_TOKEN'
  | 'MOTIVE_API_KEY'
  | 'DEERE_API_BASE'
  | 'DEERE_EQUIPMENT_API_BASE'
>;

/** Seconds between two firings of a job's schedule (`every` or a cron's next two runs). */
export function scheduleSeconds(def: JobRegistry[string] | undefined, from: Date): number | null {
  if (!def) return null;
  try {
    if (def.every) return Number.parseInt(def.every, 10) || null;
    const expr = validateCron(def.cron as string);
    const a = nextRun({ kind: 'cron', expr }, from);
    const b = nextRun({ kind: 'cron', expr }, a);
    return Math.round((b.getTime() - a.getTime()) / 1000);
  } catch {
    return null;
  }
}

async function extraOf(ex: Executor, source: string, stream: string): Promise<unknown> {
  const r = await exec<{ extra: unknown }>(
    ex,
    'select extra from ingest.sync_state where source = $1 and stream = $2',
    [source, stream],
  );
  return r.rows[0]?.extra ?? null;
}

/** `extra.unmappedKinds` leniently: numeric values only. */
export function unmappedKindsOf(extra: unknown): Record<string, number> {
  const k = (extra as { unmappedKinds?: unknown } | null)?.unmappedKinds;
  if (!k || typeof k !== 'object' || Array.isArray(k)) return {};
  const out: Record<string, number> = {};
  for (const [name, n] of Object.entries(k as Record<string, unknown>)) {
    if (typeof n === 'number' && Number.isFinite(n)) out[name] = n;
  }
  return out;
}

/** `extra.providers` leniently: rows with a code and capabilities. */
export function terminalProvidersOf(extra: unknown): TerminalProviderRow[] {
  const p = (extra as { providers?: unknown } | null)?.providers;
  if (!Array.isArray(p)) return [];
  return p.filter(
    (r): r is TerminalProviderRow =>
      !!r &&
      typeof r === 'object' &&
      typeof (r as TerminalProviderRow).code === 'string' &&
      !!(r as TerminalProviderRow).capabilities,
  );
}

function oauthView(cfg: SyncHealthConfig): Omit<DeereOAuthView, 'grant' | 'missing'> {
  const mode = cfg.CONNECTOR_DEERE;
  const redirectUri = deereRedirectUri(cfg);
  const base = {
    mode,
    sim: mode === 'sim',
    replay: mode === 'replay',
    redirectUri,
    connectUrl: mode === 'sandbox' || mode === 'live' ? '/api/oauth/deere' : null,
  };
  if (mode === 'off' || mode === 'replay') return { ...base, grantOrg: null, configError: null };
  try {
    const ep = deereEndpoints(mode, cfg);
    return { ...base, grantOrg: userGrantOrg(ep), configError: null };
  } catch (e) {
    return {
      ...base,
      grantOrg: null,
      connectUrl: null,
      configError: e instanceof ConnectorModeError ? e.message : (e as Error).message,
    };
  }
}

export async function loadSyncHealth(
  ex: Executor,
  cfg: SyncHealthConfig,
  registry: JobRegistry,
  now: Date = new Date(),
): Promise<SyncHealthSnapshot> {
  const mode = cfg.CONNECTOR_DEERE;
  const o = oauthView(cfg);
  const [calls, budget, grant, orgRows, locExtra, eqExtra, termExtra] = await Promise.all([
    loadSourceCalls(ex, now),
    loadDeereBudget(ex, {
      budget: cfg.DEERE_DAILY_CALL_BUDGET,
      mode,
      now,
      cronSeconds: scheduleSeconds(registry['fleet.deere'], now),
      staleSecondsDeere: cfg.FLEET_STALE_SECONDS_DEERE,
    }),
    o.grantOrg === null ? Promise.resolve(null) : readGrantInfo(ex, 'deere', o.grantOrg),
    listConnectorOrgs(ex, 'deere', mode),
    extraOf(ex, 'deere', 'locations'),
    extraOf(ex, 'deere', 'equipment'),
    extraOf(ex, 'terminal', 'providers'),
  ]);

  // The home org: config wins in every mode; sim and replay know theirs; sandbox/live need the
  // org listing fleet.deere stored (it has `member`).
  const stored = storedHomeOrgOf(locExtra);
  const computed = deereHomeOrg(mode, cfg.DEERE_HOME_ORG_ID, []);
  const homeOrg: HomeOrgView =
    computed.source === 'config' || computed.source === 'sim' || computed.source === 'replay'
      ? {
          orgId: computed.orgId,
          source: computed.source,
          candidates: stored?.mode === mode ? stored.candidates : [],
          at: null,
        }
      : stored && stored.mode === mode
        ? {
            orgId: stored.orgId,
            source: stored.source,
            candidates: stored.candidates,
            at: stored.at,
          }
        : { orgId: null, source: 'unknown', candidates: [], at: null };

  return {
    calls,
    budget,
    oauth: { ...o, grant, missing: grant ? missingScopes(grant.scopes, DEERE_SCOPES) : [] },
    orgs: { mode, rows: orgRows.map((r) => ({ ...r, view: orgStatusView(r) })) },
    homeOrg,
    unmappedKinds: unmappedKindsOf(eqExtra),
    terminalProviders: terminalProvidersOf(termExtra),
  };
}
