/**
 * The sync-health cards of /admin/connectors (1f, sync-health; docs/contracts-1f.md §11.4):
 * vendor calls and the Deere budget, the Deere connection (OAuth grant, orgs and their approval,
 * the home org, unmappable equipment), every connection's capability matrix with the
 * deprecated-key warning, the dead letters with requeue/discard, and the doc-derived list.
 * Server components; the forms are the admin page's server actions.
 */
import { Fragment, type ReactNode } from 'react';
import type { CallCounts } from '@/connectors/call-budget';
import { approvalLink, connectorsPageUrl } from '@/connectors/deere/connections';
import type { DocDerivedItem } from '@/connectors/doc-derived';
import type {
  ConnectionRow,
  Support,
  TerminalProviderRow,
  VendorCapabilities,
} from '@/connectors/vendors';
import {
  DEERE_SIM_ORG_STATE_LABELS,
  type DeereSimConnectionsStatus,
} from '@/sim/vendors/deere/connections-control-types';
import type { SamsaraSimFaultsStatus } from '@/sim/vendors/samsara/control-types';
import { ActionForm, SubmitButton } from '../_components/controls';
import css from '../admin.module.css';
import { ago, detroitTime, short } from '../format';
import {
  discardDeadAction,
  requeueDeadAction,
  simDeereOrgAction,
  simTruckFaultAction,
} from './actions';
import type { ConnectorsSnapshot } from './data';
import type { SyncHealthSnapshot } from './health';

type Kind = 'ok' | 'bad' | 'warn' | 'idle';

export function Badge({ kind, children }: { kind: Kind; children: ReactNode }) {
  return <span className={`${css.badge} ${css[kind]}`}>{children}</span>;
}

const n = (x: number) => x.toLocaleString('en-US');

function Counts({ c }: { c: CallCounts }) {
  return (
    <>
      <span>{n(c.calls)}</span>
      {(c.errors > 0 || c.rateLimited > 0) && (
        <div className={css.muted}>
          {c.errors > 0 && <span className={css.error}>{n(c.errors)} errors</span>}
          {c.errors > 0 && c.rateLimited > 0 && ' · '}
          {c.rateLimited > 0 && <span className={css.error}>{n(c.rateLimited)} × 429</span>}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Calls and the budget
// ---------------------------------------------------------------------------------------------

export function CallsCard({ health }: { health: SyncHealthSnapshot }) {
  const { calls, budget } = health;
  return (
    <section className={css.card} data-testid="calls-card">
      <h2>Vendor calls</h2>
      <p className={css.muted}>
        Every HTTP attempt to a vendor, retries included, per source and connector mode (UTC days).
        Sim and replay calls are counted under their own mode and never count against a budget.
      </p>
      {calls.length === 0 ? (
        <p className={css.muted}>No vendor calls counted today or yesterday.</p>
      ) : (
        <div className={css.tableWrap}>
          <table className={css.table} data-testid="calls">
            <thead>
              <tr>
                <th>Source</th>
                <th>Mode</th>
                <th>Today</th>
                <th>Yesterday</th>
                <th>Budget</th>
                <th>By stream (today / yesterday)</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((s) => (
                <tr key={`${s.source}|${s.mode}`} data-testid={`calls-${s.source}-${s.mode}`}>
                  <td className={css.mono}>{s.source}</td>
                  <td>
                    <Badge kind={s.mode === 'live' ? 'ok' : 'warn'}>{s.mode}</Badge>
                  </td>
                  <td data-testid="calls-today">
                    <Counts c={s.today} />
                  </td>
                  <td>
                    <Counts c={s.yesterday} />
                  </td>
                  <td>
                    {s.source === 'deere'
                      ? budget.budget
                        ? s.mode === 'sandbox' || s.mode === 'live'
                          ? `${n(s.today.calls)} of ${n(budget.budget)} a day`
                          : 'not counted (sim/replay)'
                        : 'limit unknown'
                      : '-'}
                  </td>
                  <td className={css.mono}>
                    {s.streams
                      .map(
                        (st) =>
                          `${st.stream || '(outside a step)'} ${n(st.today.calls)}/${n(st.yesterday.calls)}`,
                      )
                      .join(' · ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <BudgetPanel budget={budget} />
    </section>
  );
}

function BudgetPanel({ budget }: { budget: SyncHealthSnapshot['budget'] }) {
  return (
    <div data-testid="deere-budget">
      <h3>Deere call budget</h3>
      {!budget.budget ? (
        <p>
          <Badge kind="idle">limit unknown</Badge>{' '}
          <span className={css.muted}>
            DEERE_DAILY_CALL_BUDGET is unset: the Deere jobs keep their cron (decision 4). Set it
            once Deere names your app's daily limit (the sandbox allows 150,000 calls a month).
          </span>
        </p>
      ) : !budget.applies ? (
        <p>
          <Badge kind="idle">{`${n(budget.budget)} a day`}</Badge>{' '}
          <span className={css.muted}>
            Deere runs in {budget.mode}: its calls never count against the budget, nothing is paced.
          </span>
        </p>
      ) : budget.split ? (
        <>
          <dl className={css.kv}>
            <dt>Budget</dt>
            <dd>
              {n(budget.split.budget)} a day; the jobs plan on 80 % (
              {n(Math.round(budget.split.target))})
            </dd>
            <dt>Last full day</dt>
            <dd>
              {budget.lastDay} (UTC): locations {n(budget.split.lastDay.locations)} · operations{' '}
              {n(budget.split.lastDay.operations)} · others {n(budget.split.lastDay.others)}
            </dd>
            <dt>fleet.deere (locations)</dt>
            <dd data-testid="deere-pace">
              share {n(Math.round(budget.split.shares.locations))} a day · {budget.pace.reason}
            </dd>
            <dt>deere.ops (operations)</dt>
            <dd>
              share {n(Math.round(budget.split.shares.operations))} a day (fields per run capped)
            </dd>
          </dl>
          {budget.split.othersOverTarget && (
            <div className={css.banner} data-testid="budget-warning">
              The Deere streams other than locations spent more than 80 % of the budget on{' '}
              {budget.lastDay}: machine locations are down to their 10 % floor. Lower the other
              streams' cadence or ask Deere for a higher limit.
            </div>
          )}
        </>
      ) : null}
      {budget.staleWarning && (
        <div className={css.banner} data-testid="stale-warning">
          {budget.staleWarning}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The Deere connection
// ---------------------------------------------------------------------------------------------

const HOME_SOURCE_TEXT: Record<string, string> = {
  config: 'DEERE_HOME_ORG_ID',
  sim: 'the simulated home org (sim)',
  replay: "the replay fixtures' home org",
  only_member: 'the only org you are a member of',
  unknown: 'unknown',
};

export function DeereCard({
  health,
  publicUrl,
  simOrgs,
  simOrgsError,
}: {
  health: SyncHealthSnapshot;
  publicUrl: string;
  simOrgs: DeereSimConnectionsStatus | null;
  simOrgsError: string | null;
}) {
  const { oauth, orgs, homeOrg, unmappedKinds } = health;
  const back = connectorsPageUrl(publicUrl);
  const unmapped = Object.entries(unmappedKinds).sort((a, b) => b[1] - a[1]);
  return (
    <section className={css.card} data-testid="deere-card">
      <h2>John Deere</h2>
      <h3>Connection</h3>
      <dl className={css.kv} data-testid="deere-oauth">
        <dt>Mode</dt>
        <dd>{oauth.mode}</dd>
        <dt>Status</dt>
        <dd data-testid="deere-oauth-status">
          {oauth.replay ? (
            <Badge kind="ok">replay (fixtures, no sign-in)</Badge>
          ) : oauth.mode === 'off' ? (
            <Badge kind="idle">off</Badge>
          ) : oauth.configError ? (
            <>
              <Badge kind="bad">not configured</Badge>{' '}
              <span className={css.error}>{oauth.configError}</span>
            </>
          ) : oauth.grant ? (
            <Badge kind="ok">connected</Badge>
          ) : (
            <Badge kind="warn">not connected</Badge>
          )}{' '}
          {oauth.sim && !oauth.grant && (
            <span className={css.muted}>sim connects by itself on the next fleet.deere run</span>
          )}
          {oauth.connectUrl && (
            <a href={oauth.connectUrl} data-testid="deere-connect">
              {oauth.grant ? 'Sign in again' : 'Connect John Deere'}
            </a>
          )}
        </dd>
        {oauth.grant && (
          <>
            <dt>Access token</dt>
            <dd title={detroitTime(oauth.grant.expiresAt)}>
              expires {ago(oauth.grant.expiresAt)} (refreshed automatically) · saved{' '}
              {ago(oauth.grant.updatedAt)}
            </dd>
            <dt>Scopes</dt>
            <dd className={css.mono} data-testid="deere-scopes">
              {oauth.grant.scopes.join(' ') || '(not reported)'}
            </dd>
          </>
        )}
        <dt>Callback</dt>
        <dd className={css.mono}>{oauth.redirectUri}</dd>
      </dl>
      {oauth.missing.length > 0 && (
        <div className={css.banner} data-testid="deere-scope-warning">
          The stored Deere grant lacks {oauth.missing.join(', ')}: calls that need it answer 403.
          Sign in again{oauth.connectUrl ? ' (link above)' : ''} and raise the org's permission in
          connections.deere.com.
        </div>
      )}

      <h3>Home organization</h3>
      <p data-testid="deere-home-org">
        {homeOrg.orgId ? (
          <>
            <span className={css.mono}>{homeOrg.orgId}</span>{' '}
            <span className={css.muted}>
              from {HOME_SOURCE_TEXT[homeOrg.source] ?? homeOrg.source}
            </span>
          </>
        ) : (
          <>
            <Badge kind="warn">not known</Badge>{' '}
            <span>
              Set DEERE_HOME_ORG_ID in .env.local to your own operation's Deere org id. Until then
              no farm, field or machine is created from Deere (rows already linked still update).
            </span>
            {homeOrg.candidates.length > 0 && (
              <span className={css.muted}>
                {' '}
                Orgs seen:{' '}
                {homeOrg.candidates
                  .map((c) => `${c.id}${c.name ? ` (${c.name})` : ''}${c.member ? ', member' : ''}`)
                  .join('; ')}
              </span>
            )}
          </>
        )}
      </p>
      <p className={css.muted}>
        Machines are created only from the home org; farms and fields from any other org belong to
        that org's customer.
      </p>

      <h3>Organizations ({orgs.mode})</h3>
      {orgs.rows.length === 0 ? (
        <p className={css.muted}>
          None seen in {orgs.mode} mode yet: fleet.deere lists them on every run.
        </p>
      ) : (
        <div className={css.tableWrap}>
          <table className={css.table} data-testid="deere-orgs">
            <thead>
              <tr>
                <th>Org</th>
                <th>Status</th>
                <th>Action</th>
                <th>Seen</th>
              </tr>
            </thead>
            <tbody>
              {orgs.rows.map((o) => (
                <tr key={o.orgId} data-testid={`deere-org-${o.orgId}`} data-status={o.view.kind}>
                  <td>
                    {o.name ?? o.orgId}
                    <div className={css.mono}>{o.orgId}</div>
                  </td>
                  <td>
                    <Badge kind={o.view.kind === 'connected' ? 'ok' : 'bad'}>{o.view.label}</Badge>
                    {o.detail && o.view.kind !== 'connected' && (
                      <div className={css.muted} title={o.detail}>
                        {short(o.detail, 90)}
                      </div>
                    )}
                  </td>
                  <td>
                    {o.view.kind === 'terms' && o.view.termsUrl ? (
                      <a href={o.view.termsUrl} rel="noreferrer" target="_blank">
                        Accept Deere's terms
                      </a>
                    ) : o.view.kind === 'needs_approval' && o.approvalUrl ? (
                      <a
                        href={approvalLink(o.approvalUrl, back)}
                        rel="noreferrer"
                        data-testid="approve-link"
                      >
                        Approve in Deere Connections
                      </a>
                    ) : o.view.kind === 'scope' ? (
                      <span className={css.muted}>
                        sign in again with every scope; check the API's licence in My Applications
                      </span>
                    ) : (
                      '-'
                    )}
                  </td>
                  <td>{ago(o.lastSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className={css.muted}>
        Customer organizations are connected only after a data-rights agreement with that customer
        (plan 2a). Nothing ever blocks your own (home) org. Deere sends you back here after an
        approval when {back} is registered as a Redirect URI in the Deere app profile.
      </p>

      {oauth.sim && (
        <>
          <h3>Simulated org approval</h3>
          {simOrgsError ? (
            <p className={css.muted}>{simOrgsError}</p>
          ) : simOrgs ? (
            <div className={css.stack} data-testid="sim-orgs">
              {simOrgs.orgs.map((o) => (
                <ActionForm key={o.id} action={simDeereOrgAction} className={css.row}>
                  <input type="hidden" name="orgId" value={o.id} />
                  <span className={css.mono}>{o.id}</span>
                  <span>{DEERE_SIM_ORG_STATE_LABELS[o.state]}</span>
                  {o.state === 'connected' ? (
                    <SubmitButton
                      name="state"
                      value="needs_approval"
                      testId={`sim-org-${o.id}-needs-approval`}
                    >
                      Make it need approval
                    </SubmitButton>
                  ) : (
                    <SubmitButton name="state" value="connected" testId={`sim-org-${o.id}-connect`}>
                      Approve (connect)
                    </SubmitButton>
                  )}
                </ActionForm>
              ))}
            </div>
          ) : null}
        </>
      )}

      <h3>Unmappable equipment</h3>
      {unmapped.length === 0 ? (
        <p className={css.muted}>
          None: every Deere machine of the home org maps to a machine kind.
        </p>
      ) : (
        <ul className={css.events} data-testid="unmapped-kinds">
          {unmapped.map(([type, count]) => (
            <li key={type}>
              {type}: {count} machine{count === 1 ? '' : 's'} skipped
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Connections and their capability matrix (1f.2)
// ---------------------------------------------------------------------------------------------

const LEVEL_KIND: Record<Support, Kind> = { yes: 'ok', doc: 'warn', unknown: 'idle', no: 'bad' };

function Level({ s, label }: { s: Support; label: string }) {
  return (
    <span className={`${css.badge} ${css[LEVEL_KIND[s]]}`} title={`${label}: ${s}`}>
      {label} {s}
    </span>
  );
}

function CapabilityCells({ c }: { c: VendorCapabilities }) {
  return (
    <>
      <td>
        <Level s={c.positions.live} label="live" />{' '}
        <Level s={c.positions.lastKnown} label="last-known" />
      </td>
      <td>
        <Level s={c.stats.engineHours} label="hours" />{' '}
        <Level s={c.stats.odometerMi} label="odometer" /> <Level s={c.stats.fuelPct} label="fuel" />{' '}
        <Level s={c.stats.defPct} label="DEF" /> <Level s={c.stats.engineOn} label="engine" />
      </td>
      <td>
        <Level s={c.faults.j1939} label="J1939" /> <Level s={c.faults.obd2} label="OBD-II" />{' '}
        <Level s={c.faults.oem} label="OEM" />
      </td>
      <td>
        <Level s={c.fieldOperations} label="field ops" />
      </td>
      <td>
        <Level s={c.webhooks} label="webhooks" />
      </td>
    </>
  );
}

/** Sim only: the Samsara stand-in's fault-code knob (fleet-faults), one row per truck. */
export function SimTruckFaultsCard({
  status,
  error,
}: {
  status: SamsaraSimFaultsStatus | null;
  error: string | null;
}) {
  return (
    <section className={css.card} data-testid="sim-truck-faults">
      <h2>Simulated truck fault codes</h2>
      <p className={css.muted}>
        Samsara's faultCodes feed in the stand-in. A critical code shows on the fleet panel within
        one fleet.trucks run and offers drivers "Critical fault: mark down?"; it never marks the
        truck down by itself.
        {status?.schedule
          ? ` The ${status.scenario} scenario gives ${status.schedule.vehicle} a code at ${detroitTime(new Date(status.schedule.simAt))} sim time.`
          : ''}
      </p>
      {error ? (
        <p className={css.muted}>{error}</p>
      ) : status ? (
        <div className={css.stack}>
          {status.vehicles.map((v) => (
            <ActionForm key={v.id} action={simTruckFaultAction} className={css.row}>
              <input type="hidden" name="vehicle" value={v.name} />
              <span className={css.mono}>{v.name}</span>
              <span data-testid={`sim-truck-${v.name}-codes`}>
                {v.codes.length === 0
                  ? 'no codes'
                  : v.codes
                      .map((c) =>
                        c.system === 'j1939'
                          ? `J1939 SPN ${c.spn} FMI ${c.fmi}`
                          : c.system === 'obd2'
                            ? c.dtc
                            : `OEM ${c.code}`,
                      )
                      .join(', ')}
                {v.from === 'knob' ? ' (set here)' : v.from === 'schedule' ? ' (scenario)' : ''}
              </span>
              <SubmitButton name="op" value="raise" testId={`sim-truck-${v.name}-raise`}>
                Critical engine code
              </SubmitButton>
              <SubmitButton name="op" value="clear" testId={`sim-truck-${v.name}-clear`}>
                Clear
              </SubmitButton>
              {v.from === 'knob' && (
                <SubmitButton name="op" value="schedule" testId={`sim-truck-${v.name}-schedule`}>
                  Back to the scenario
                </SubmitButton>
              )}
            </ActionForm>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function ConnectionsCard({
  rows,
  aliasNotes,
  terminalProviders,
  modeNotes,
}: {
  rows: ConnectionRow[];
  aliasNotes: { message: string }[];
  terminalProviders: TerminalProviderRow[];
  modeNotes: { label: string; value: string }[];
}) {
  return (
    <section className={css.card} data-testid="connections-card">
      <h2>Connections</h2>
      {aliasNotes.map((a) => (
        <div key={a.message} className={css.banner} data-testid="connector-alias-warning">
          {a.message}
        </div>
      ))}
      <p className={css.muted}>
        Every connection runs at once, each on its own mode key. Levels: yes = the vendor's spec or
        SDK; doc = vendor prose or a third party (confirm); unknown; no = documented as absent.
      </p>
      <div className={css.tableWrap}>
        <table className={css.table} data-testid="capability-matrix">
          <thead>
            <tr>
              <th>Connection</th>
              <th>Mode</th>
              <th>Positions</th>
              <th>Stats</th>
              <th>Faults</th>
              <th>Operations</th>
              <th>Webhooks</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Fragment key={row.connection}>
                <tr data-testid={`connection-${row.connection}`}>
                  <td>
                    <strong>{row.label}</strong>
                    <div className={css.muted}>
                      {row.kind}
                      {row.build === 'built' ? '' : ' · client not built yet'}
                    </div>
                  </td>
                  <td data-testid={`connector-mode-${row.connection}`}>
                    <Badge kind={row.mode === 'live' ? 'ok' : row.mode === 'off' ? 'idle' : 'warn'}>
                      {row.mode}
                    </Badge>
                    <div className={css.mono}>{row.modeKey}</div>
                  </td>
                  <CapabilityCells c={row.capabilities} />
                </tr>
                {row.providers.map((p) => (
                  <tr key={p.id} data-testid={`provider-${p.id}`}>
                    <td>
                      <span className={css.muted}>↳ provider</span> {p.label}
                      {p.build === 'built' ? '' : <div className={css.muted}>not built yet</div>}
                    </td>
                    <td className={css.mono}>{p.id}</td>
                    <CapabilityCells c={p.capabilities} />
                  </tr>
                ))}
                {row.connection === 'terminal' &&
                  terminalProviders.map((p) => (
                    <tr key={p.code} data-testid={`terminal-provider-${p.code}`}>
                      <td>
                        <span className={css.muted}>↳ Terminal provider</span> {p.label}
                      </td>
                      <td className={css.mono}>{p.vendorId}</td>
                      <CapabilityCells c={p.capabilities} />
                    </tr>
                  ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <dl className={css.kv}>
        {modeNotes.map((m) => (
          <Fragment key={m.label}>
            <dt>{m.label}</dt>
            <dd>{m.value}</dd>
          </Fragment>
        ))}
      </dl>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Dead letters
// ---------------------------------------------------------------------------------------------

export function DeadLettersCard({ snap, now }: { snap: ConnectorsSnapshot; now: Date }) {
  return (
    <section className={css.card} data-testid="dead-card">
      <h2>
        Dead-lettered events <span data-testid="dead-total">{snap.deadTotal}</span>
      </h2>
      {snap.deadTotal === 0 ? (
        <p className={css.muted}>None. Events go here after 5 failed attempts.</p>
      ) : (
        <>
          <p className={css.muted}>
            Requeue sends an event back to its stream (attempts reset; the next run retries it).
            Discard keeps it as processed with the reason, so the same payload never lands again.
          </p>
          <div className={css.row} style={{ marginBottom: 10 }}>
            {snap.deadByStream.map((g) => (
              <span key={`${g.source}|${g.stream}`} className={css.mono}>
                {g.source}/{g.stream} {g.count}
              </span>
            ))}
          </div>
          <div className={css.row} style={{ marginBottom: 10 }}>
            <ActionForm action={requeueDeadAction}>
              <input type="hidden" name="all" value="1" />
              <SubmitButton testId="dead-requeue-all">Requeue all {snap.deadTotal}</SubmitButton>
            </ActionForm>
            <ActionForm action={discardDeadAction}>
              <input type="hidden" name="all" value="1" />
              <SubmitButton className={`${css.button} ${css.danger}`} testId="dead-discard-all">
                Discard all {snap.deadTotal}
              </SubmitButton>
            </ActionForm>
          </div>
          <div className={css.tableWrap}>
            <table className={css.table} data-testid="dead">
              <thead>
                <tr>
                  <th>Source / stream</th>
                  <th>External id</th>
                  <th>Attempts</th>
                  <th>Error</th>
                  <th>Fetched</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {snap.dead.map((e) => (
                  <tr key={e.id} data-testid={`dead-${e.id}`}>
                    <td className={css.mono}>
                      {e.source}/{e.stream}
                    </td>
                    <td className={css.mono}>{short(e.externalId, 40)}</td>
                    <td>{e.attempts}</td>
                    <td className={css.error} title={e.lastError ?? ''}>
                      {short(e.lastError)}
                    </td>
                    <td>{ago(e.fetchedAt, now)}</td>
                    <td>
                      <div className={css.row}>
                        <ActionForm action={requeueDeadAction}>
                          <input type="hidden" name="id" value={e.id} />
                          <SubmitButton testId="dead-requeue">Requeue</SubmitButton>
                        </ActionForm>
                        <ActionForm action={discardDeadAction}>
                          <input type="hidden" name="id" value={e.id} />
                          <SubmitButton testId="dead-discard">Discard</SubmitButton>
                        </ActionForm>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {snap.deadTotal > snap.dead.length && (
            <p className={css.muted}>
              Showing the latest {snap.dead.length} of {snap.deadTotal}.
            </p>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Doc-derived list
// ---------------------------------------------------------------------------------------------

export function DocDerivedCard({ items }: { items: readonly DocDerivedItem[] }) {
  const spec = items.filter((i) => (i.basis ?? 'doc') === 'spec').length;
  return (
    <section className={css.card} data-testid="doc-derived-card">
      <h2>Not yet confirmed against a recorded response ({items.length})</h2>
      <p className={css.muted}>
        spec = from the vendor's own published spec or docs, only a recording is missing ({spec});
        doc = still doc-derived: the docs are silent or contradict themselves ({items.length - spec}
        ). `pnpm connectors:record` against a sandbox removes entries.
      </p>
      <div className={css.tableWrap}>
        <table className={css.table} data-testid="doc-derived">
          <thead>
            <tr>
              <th>Source</th>
              <th>Basis</th>
              <th>What</th>
              <th>To confirm</th>
              <th>Where</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={`${i.source}|${i.what}`}>
                <td className={css.mono}>{i.source}</td>
                <td data-testid="doc-basis">
                  <Badge kind={(i.basis ?? 'doc') === 'spec' ? 'ok' : 'warn'}>
                    {i.basis ?? 'doc'}
                  </Badge>
                </td>
                <td className={css.mono}>{i.what}</td>
                <td>{i.confirm}</td>
                <td className={css.mono}>{i.file}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
