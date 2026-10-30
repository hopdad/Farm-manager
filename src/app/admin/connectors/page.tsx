/**
 * /admin/connectors: sync health and the demo controls (plan §3 layout; M0 done-when step 3).
 *  - Job clock: pause/resume (app.settings 'clock.paused' + admin/clock publish).
 *  - Simulation (not in production): pause/resume/speed/scenario/reset and fault toggles incl.
 *    "trucks API down", through the stand-in's control API (server actions; it is loopback-only).
 *  - Per connector stream: mode, last OK, last error, lease, raw-event counts, counters.
 *  - Per job: schedule, running, last run, last OK/failure, runs and failures (1 h / 24 h).
 *  - Dead-lettered raw events.
 *  - Configuration: every connection's mode (1f.2: one key per vendor) and the warning while the
 *    deprecated CONNECTOR_ELD / ELD_VENDOR are set (sync-health adds the capability matrix).
 * Re-renders on admin realtime events and every 10 s (LiveRefresh).
 */
import { Fragment, type ReactNode } from 'react';
import { getConfig, publicConfig } from '@/config';
import { capabilityMatrix } from '@/connectors/vendors';
import { getPool } from '@/db/client';
import { registry } from '@/jobs/registry';
import { SCENARIO_NAMES, type SimStatus } from '@/sim/types';
import { ActionForm, NoticeProvider, SubmitButton } from '../_components/controls';
import { LiveRefresh } from '../_components/LiveRefresh';
import { Locked } from '../_components/Locked';
import { adminUnlocked } from '../_lib/guard';
import css from '../admin.module.css';
import { ago, detroitTime, short } from '../format';
import {
  setClockPausedAction,
  simClockAction,
  simFaultAction,
  simResetAction,
  simScenarioAction,
} from './actions';
import {
  type ConnectorsSnapshot,
  type JobRow,
  loadConnectorsSnapshot,
  type StreamRow,
} from './data';
import { faultPresets, getSimStatus, SPEED_PRESETS } from './sim-control';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Connectors · Farm Ops' };

function Badge({ kind, children }: { kind: 'ok' | 'bad' | 'warn' | 'idle'; children: ReactNode }) {
  return <span className={`${css.badge} ${css[kind]}`}>{children}</span>;
}

function streamHealth(
  s: StreamRow,
  now: Date,
): { kind: 'ok' | 'bad' | 'warn' | 'idle'; text: string } {
  if (s.mode === 'off') return { kind: 'idle', text: 'off' };
  const okAt = s.lastOkAt?.getTime() ?? 0;
  const errAt = s.lastErrorAt?.getTime() ?? 0;
  if (errAt > okAt) return { kind: 'bad', text: 'failing' };
  if (!okAt) return { kind: 'idle', text: 'not run yet' };
  if (now.getTime() - okAt > 10 * 60_000) return { kind: 'warn', text: 'stale' };
  return { kind: 'ok', text: 'ok' };
}

function jobHealth(j: JobRow): { kind: 'ok' | 'bad' | 'warn' | 'idle'; text: string } {
  if (!j.registered) return { kind: 'idle', text: 'not registered' };
  if (j.running) return { kind: 'warn', text: 'running' };
  if (!j.lastRun) return { kind: 'idle', text: 'never ran' };
  return j.lastRun.ok ? { kind: 'ok', text: 'ok' } : { kind: 'bad', text: 'failed' };
}

function ClockCard({ paused, clock, hosts }: { paused: boolean; clock: string; hosts: string[] }) {
  return (
    <section className={css.card} data-testid="clock-card">
      <h2>Job clock</h2>
      <p>
        {paused ? <Badge kind="warn">paused</Badge> : <Badge kind="ok">running</Badge>}{' '}
        <span className={css.muted}>
          {paused
            ? 'No syncs run; machines go stale.'
            : `Fires the registry's jobs (${clock === 'pgcron' ? 'pg_cron' : `tools/clock, hosts ${hosts.join(',')}`}).`}
        </span>
      </p>
      <ActionForm action={setClockPausedAction}>
        <input type="hidden" name="paused" value={paused ? 'false' : 'true'} />
        <SubmitButton
          className={`${css.button} ${css.big} ${paused ? css.primary : css.danger}`}
          testId="clock-toggle"
        >
          {paused ? 'Resume job clock' : 'Pause job clock'}
        </SubmitButton>
      </ActionForm>
      <p className={css.muted}>
        Pausing the simulation (below) is different: it freezes machines but keeps them fresh.
      </p>
    </section>
  );
}

function SimCard({
  sim,
  error,
  baseUrl,
}: {
  sim: SimStatus | null;
  error: string | null;
  baseUrl: string;
}) {
  const presets = faultPresets();
  const on = new Set(sim?.faults.rules.map((r) => r.id) ?? []);
  const presetIds = new Set(presets.map((p) => p.id));
  const otherRules = [
    ...(sim?.faults.rules
      .filter((r) => !presetIds.has(r.id))
      .map((r) => ({ r, scenario: false })) ?? []),
    ...(sim?.faults.scenarioRules.map((r) => ({ r, scenario: true })) ?? []),
  ];
  return (
    <section className={css.card} data-testid="sim-card">
      <h2>Simulation</h2>
      {!sim ? (
        <div className={css.banner}>
          {error ?? 'The vendor stand-in is not reachable.'} ({baseUrl})
        </div>
      ) : (
        <>
          <dl className={css.kv}>
            <dt>Scenario</dt>
            <dd>
              {sim.scenario.scenario} <span className={css.muted}>seed {sim.scenario.seed}</span>
            </dd>
            <dt>Sim time</dt>
            <dd>
              {detroitTime(sim.clock.simNow)}{' '}
              {sim.clock.paused ? (
                <Badge kind="warn">paused</Badge>
              ) : (
                <Badge kind="ok">{`${sim.clock.speed}x`}</Badge>
              )}
            </dd>
            <dt>Stand-in</dt>
            <dd className={css.mono}>{baseUrl}</dd>
          </dl>

          <h3>Clock</h3>
          <ActionForm action={simClockAction} className={css.row}>
            {sim.clock.paused ? (
              <SubmitButton
                name="action"
                value="resume"
                className={`${css.button} ${css.primary}`}
                testId="sim-resume"
              >
                Resume simulation
              </SubmitButton>
            ) : (
              <SubmitButton name="action" value="pause" className={css.button} testId="sim-pause">
                Pause simulation
              </SubmitButton>
            )}
          </ActionForm>
          <div className={css.row} style={{ marginTop: 10 }}>
            {SPEED_PRESETS.map((s) => (
              <ActionForm key={s} action={simClockAction}>
                <input type="hidden" name="action" value="speed" />
                <SubmitButton
                  name="speed"
                  value={String(s)}
                  className={`${css.button} ${sim.clock.speed === s ? css.active : ''}`}
                  pressed={sim.clock.speed === s}
                >
                  {s}x
                </SubmitButton>
              </ActionForm>
            ))}
          </div>

          <h3>Scenario</h3>
          <ActionForm action={simScenarioAction} className={css.row}>
            <label className={css.muted} htmlFor="scenario-select">
              Scenario
            </label>
            <select
              key={sim.scenario.scenario}
              id="scenario-select"
              name="scenario"
              defaultValue={sim.scenario.scenario}
              className={css.select}
            >
              {SCENARIO_NAMES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <SubmitButton>Start scenario</SubmitButton>
          </ActionForm>
          <p className={css.muted}>
            Weather: the simulated NWS wind slider and the spray thresholds are on{' '}
            <a href="/admin/spray" data-testid="spray-link">
              Spray
            </a>
            .
          </p>

          <h3>Faults</h3>
          <div className={css.toggleGrid}>
            {presets.map((p) => {
              const active = on.has(p.id);
              return (
                <ActionForm key={p.key} action={simFaultAction}>
                  <input type="hidden" name="op" value={active ? 'off' : 'on'} />
                  <input type="hidden" name="preset" value={p.key} />
                  <SubmitButton
                    className={`${css.toggle} ${active ? css.toggleOn : ''}`}
                    pressed={active}
                    testId={`fault-${p.key}`}
                  >
                    <span>
                      {active ? 'ON · ' : ''}
                      {p.title}
                    </span>
                    <small>{p.description}</small>
                  </SubmitButton>
                </ActionForm>
              );
            })}
          </div>
          {otherRules.length > 0 && (
            <>
              <h3>Other active rules</h3>
              <ul className={css.events}>
                {otherRules.map(({ r, scenario }) => (
                  <li key={`${scenario ? 's' : 'c'}-${r.id}`} className={css.row}>
                    <span className={css.mono}>
                      {r.vendor} {r.kind}
                      {r.pathPrefix ? ` ${r.pathPrefix}` : ''}
                    </span>
                    {r.label && <span>{r.label}</span>}
                    {scenario ? (
                      <Badge kind="idle">scenario</Badge>
                    ) : (
                      <ActionForm action={simFaultAction}>
                        <input type="hidden" name="op" value="remove" />
                        <input type="hidden" name="id" value={r.id} />
                        <SubmitButton>Remove</SubmitButton>
                      </ActionForm>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className={css.row} style={{ marginTop: 12 }}>
            <ActionForm action={simFaultAction}>
              <input type="hidden" name="op" value="clear" />
              <SubmitButton>Clear all faults</SubmitButton>
            </ActionForm>
            <ActionForm action={simResetAction}>
              <SubmitButton
                className={`${css.button} ${css.danger}`}
                title="tokens, cursors, webhooks and faults back to clean; speed 1x"
              >
                Reset stand-in
              </SubmitButton>
            </ActionForm>
          </div>
        </>
      )}
    </section>
  );
}

function StreamsCard({ snap, now }: { snap: ConnectorsSnapshot; now: Date }) {
  return (
    <section className={css.card}>
      <h2>Connector streams</h2>
      {snap.streams.length === 0 ? (
        <p className={css.muted}>No connector has run yet (ingest.sync_state is empty).</p>
      ) : (
        <div className={css.tableWrap}>
          <table className={css.table} data-testid="streams">
            <thead>
              <tr>
                <th>Source / stream</th>
                <th>Mode</th>
                <th>State</th>
                <th>Last OK</th>
                <th>Last error</th>
                <th>Raw events</th>
                <th>Counters</th>
              </tr>
            </thead>
            <tbody>
              {snap.streams.map((s) => {
                const h = streamHealth(s, now);
                const leased = s.leaseUntil && s.leaseUntil > now;
                return (
                  <tr key={`${s.source}|${s.stream}`}>
                    <td className={css.mono}>
                      {s.source}/{s.stream}
                    </td>
                    <td>
                      <Badge kind={s.mode === 'live' ? 'ok' : s.mode === 'off' ? 'idle' : 'warn'}>
                        {s.mode}
                      </Badge>
                    </td>
                    <td>
                      <Badge kind={h.kind}>{h.text}</Badge>
                      <div className={css.muted}>
                        {leased
                          ? `syncing (lease ${ago(s.leaseUntil, now)})`
                          : `last run ${ago(s.lastRunAt, now)}`}
                        {s.nextRunAt && s.nextRunAt > now ? ` · next ${ago(s.nextRunAt, now)}` : ''}
                      </div>
                    </td>
                    <td title={detroitTime(s.lastOkAt)}>{ago(s.lastOkAt, now)}</td>
                    <td>
                      {s.lastError ? (
                        <>
                          <div className={css.error} title={s.lastError}>
                            {short(s.lastError)}
                          </div>
                          <div className={css.muted}>{ago(s.lastErrorAt, now)}</div>
                        </>
                      ) : (
                        '-'
                      )}
                    </td>
                    <td>
                      <div>{s.raw.landed24h} landed (24 h)</div>
                      <div className={css.muted}>
                        {s.raw.pending} pending ·{' '}
                        <span className={s.raw.dead ? css.error : undefined}>
                          {s.raw.dead} dead
                        </span>
                      </div>
                    </td>
                    <td className={css.mono}>
                      {Object.entries(s.counters)
                        .map(([k, v]) => `${k} ${v}`)
                        .join(' · ') || '-'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function JobsCard({ snap, now }: { snap: ConnectorsSnapshot; now: Date }) {
  return (
    <section className={css.card}>
      <h2>Jobs</h2>
      {snap.registryError && <div className={css.banner}>{snap.registryError}</div>}
      {snap.jobs.length === 0 ? (
        <p className={css.muted}>No jobs registered yet (src/jobs/registry.ts is empty).</p>
      ) : (
        <div className={css.tableWrap}>
          <table className={css.table} data-testid="jobs">
            <thead>
              <tr>
                <th>Job</th>
                <th>Schedule</th>
                <th>State</th>
                <th>Last run</th>
                <th>Last OK</th>
                <th>Last failure</th>
                <th>Calls 1 h / 24 h</th>
              </tr>
            </thead>
            <tbody>
              {snap.jobs.map((j) => {
                const h = jobHealth(j);
                return (
                  <tr key={j.name}>
                    <td className={css.mono}>{j.name}</td>
                    <td>
                      {j.schedule ?? '-'}
                      {j.host && <div className={css.muted}>host {j.host}</div>}
                    </td>
                    <td>
                      <Badge kind={h.kind}>{h.text}</Badge>
                    </td>
                    <td>
                      {j.lastRun ? (
                        <>
                          <div title={detroitTime(j.lastRun.startedAt)}>
                            {ago(j.lastRun.startedAt, now)}
                          </div>
                          <div className={css.muted}>
                            {j.lastRun.items ?? 0} items
                            {j.lastRun.note ? ` · ${short(j.lastRun.note, 60)}` : ''}
                          </div>
                        </>
                      ) : (
                        '-'
                      )}
                    </td>
                    <td>{ago(j.lastOkAt, now)}</td>
                    <td>
                      {j.lastFailure ? (
                        <>
                          <div className={css.error} title={j.lastFailure.error ?? ''}>
                            {short(j.lastFailure.error) || 'failed'}
                          </div>
                          <div className={css.muted}>{ago(j.lastFailure.at, now)}</div>
                        </>
                      ) : (
                        '-'
                      )}
                    </td>
                    <td>
                      {j.runs1h} / {j.runs24h}
                      <div className={j.failed24h ? css.error : css.muted}>
                        {j.failed24h} failed (24 h)
                      </div>
                      <div className={css.muted}>{j.items24h} items (24 h)</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function DeadCard({ snap, now }: { snap: ConnectorsSnapshot; now: Date }) {
  return (
    <section className={css.card}>
      <h2>Dead-lettered events</h2>
      {snap.dead.length === 0 ? (
        <p className={css.muted}>None. Events go here after 5 failed attempts.</p>
      ) : (
        <div className={css.tableWrap}>
          <table className={css.table} data-testid="dead">
            <thead>
              <tr>
                <th>Source / stream</th>
                <th>External id</th>
                <th>Attempts</th>
                <th>Error</th>
                <th>Fetched</th>
              </tr>
            </thead>
            <tbody>
              {snap.dead.map((e) => (
                <tr key={e.id}>
                  <td className={css.mono}>
                    {e.source}/{e.stream}
                  </td>
                  <td className={css.mono}>{short(e.externalId, 40)}</td>
                  <td>{e.attempts}</td>
                  <td className={css.error} title={e.lastError ?? ''}>
                    {short(e.lastError)}
                  </td>
                  <td>{ago(e.fetchedAt, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default async function ConnectorsPage() {
  if (!(await adminUnlocked())) return <Locked />;
  const cfg = getConfig();
  const now = new Date();
  let snap: ConnectorsSnapshot | null = null;
  let dbError: string | null = null;
  try {
    snap = await loadConnectorsSnapshot(getPool(), registry, {
      demoCadence: cfg.JOBS_DEMO_CADENCE,
      modes: cfg,
    });
  } catch (e) {
    dbError = (e as Error).message;
  }
  let sim: SimStatus | null = null;
  let simError: string | null = null;
  if (!cfg.isProduction) {
    try {
      sim = await getSimStatus(cfg.VENDOR_SIM_URL);
    } catch (e) {
      simError = (e as Error).message;
    }
  }

  return (
    <NoticeProvider>
      <main>
        <div className={css.pageHead}>
          <h1>Connectors</h1>
          <span className={css.row}>
            <LiveRefresh topics={['admin']} realtime={publicConfig(cfg).realtime} />
            <span className={css.muted}>updated {detroitTime(now)}</span>
          </span>
        </div>
        {dbError && <div className={css.banner}>Database not reachable: {dbError}</div>}
        <div className={css.grid}>
          <ClockCard
            paused={snap?.clockPaused ?? false}
            clock={cfg.CLOCK}
            hosts={cfg.CLOCK_HOSTS}
          />
          {!cfg.isProduction && <SimCard sim={sim} error={simError} baseUrl={cfg.VENDOR_SIM_URL} />}
        </div>
        {snap && (
          <>
            <StreamsCard snap={snap} now={now} />
            <div style={{ height: 16 }} />
            <JobsCard snap={snap} now={now} />
            <div style={{ height: 16 }} />
            <DeadCard snap={snap} now={now} />
          </>
        )}
        <div style={{ height: 16 }} />
        <section className={css.card}>
          <h2>Configuration</h2>
          {cfg.connectorAliasNotes.map((n) => (
            <div key={n.message} className={css.banner} data-testid="connector-alias-warning">
              {n.message}
            </div>
          ))}
          <dl className={css.kv}>
            {capabilityMatrix(cfg).map((row) => (
              <Fragment key={row.connection}>
                <dt>{row.label}</dt>
                <dd data-testid={`connector-mode-${row.connection}`}>
                  {row.mode}{' '}
                  <span className={css.muted}>
                    ({row.modeKey}
                    {row.build === 'built' ? '' : ', client not built yet'})
                  </span>
                </dd>
              </Fragment>
            ))}
            <dt>Weather</dt>
            <dd>{cfg.CONNECTOR_WEATHER}</dd>
            <dt>Deere write-back</dt>
            <dd>{cfg.WRITEBACK_DEERE ? 'on' : 'off'}</dd>
            <dt>Clock</dt>
            <dd>
              {cfg.CLOCK} (hosts {cfg.CLOCK_HOSTS.join(',')})
            </dd>
            <dt>Demo cadence</dt>
            <dd>{cfg.JOBS_DEMO_CADENCE ? 'on (JOBS_DEMO_CADENCE)' : 'off'}</dd>
            <dt>Stale after</dt>
            <dd>
              {cfg.FLEET_STALE_SECONDS} s (Deere {cfg.FLEET_STALE_SECONDS_DEERE} s)
            </dd>
            <dt>App env</dt>
            <dd>{cfg.APP_ENV}</dd>
          </dl>
        </section>
      </main>
    </NoticeProvider>
  );
}
