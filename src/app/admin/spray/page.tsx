/**
 * /admin/spray (plan 1b; D4): the spray go/no-go thresholds, ADVISORY and "defaults pending
 * Derrick's values" until he saves his own; the simulated weather (the NWS stand-in's wind
 * slider and pattern, the spray demo); and what every field is told for the current hour, with
 * the reasons. Manager and above (ROLE_FOR.editSprayThresholds), checked here and again in
 * every action. Re-renders on spray/weather realtime events (LiveRefresh).
 */
import { getConfig } from '@/config';
import { getPool } from '@/db/client';
import { readSprayThresholds } from '@/db/queries/weather';
import { sprayTargets, verdictsForHour } from '@/db/queries/weather-spray';
import {
  SPRAY_ADVISORY_DEFAULTS_TEXT,
  SPRAY_ADVISORY_TEXT,
  SPRAY_VERDICT_LABELS,
  withStaleness,
} from '@/domain/spray';
import { sprayAssessmentHours, sprayRulesVersion } from '@/domain/weather';
import { requireRole } from '@/platform/auth/server';
import { isAuthError, ROLE_FOR, type Session } from '@/platform/auth/types';
import {
  NWS_MAX_SIM_WIND_MPH,
  NWS_WEATHER_PATTERN_LABELS,
  NWS_WEATHER_PATTERNS,
  type NwsSimWeatherStatus,
} from '@/sim/vendors/nws/control-types';
import { ActionForm, NoticeProvider, SubmitButton } from '../_components/controls';
import { LiveRefresh } from '../_components/LiveRefresh';
import css from '../admin.module.css';
import { ago, detroitTime } from '../format';
import { resetThresholdsAction, saveThresholdsAction, simWeatherAction } from './actions';
import { THRESHOLD_FIELDS } from './form';
import { getSimWeather } from './sim-weather';
import sc from './spray.module.css';
import { WindSlider } from './WindSlider';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Spray go/no-go · Farm Ops' };

function Refused({ message }: { message: string }) {
  return (
    <main className={css.banner} data-testid="spray-admin-refused">
      <h1>Spray thresholds</h1>
      <p>
        {message}. Changing the spray thresholds needs a manager or the owner (sign in on this
        browser, or open the Admin link <code>pnpm dev</code> printed on the PC).
      </p>
    </main>
  );
}

function SimWeatherCard({
  status,
  error,
}: {
  status: NwsSimWeatherStatus | null;
  error: string | null;
}) {
  return (
    <section className={css.card} data-testid="sim-weather-card">
      <h2>Simulated weather</h2>
      {error && <p className={css.muted}>{error}</p>}
      {status && (
        <p className={css.muted} data-testid="sim-weather-status">
          Scenario {status.scenario}: {NWS_WEATHER_PATTERN_LABELS[status.effectivePattern]}
          {status.pattern ? ' (chosen here)' : ''}. Now at {status.sample.stationId}: wind{' '}
          {status.sample.windMph} mph gusting {status.sample.gustMph},{' '}
          {Math.round(status.sample.tempF)}°F
          {status.windMph !== null ? `; wind pinned at ${status.windMph} mph` : ''}. Forecast issued{' '}
          {detroitTime(status.issuedAt)}.
        </p>
      )}
      <ActionForm action={simWeatherAction} className={css.stack}>
        <input type="hidden" name="pinWind" value="true" />
        <WindSlider
          initial={Math.round(status?.windMph ?? status?.sample.windMph ?? 6)}
          max={NWS_MAX_SIM_WIND_MPH}
        />
        <label className={sc.field}>
          Weather pattern
          <select
            name="pattern"
            className={css.select}
            defaultValue={status?.pattern ?? ''}
            data-testid="sim-pattern"
          >
            <option value="">
              The scenario&apos;s (
              {status ? NWS_WEATHER_PATTERN_LABELS[status.defaultPattern] : '…'})
            </option>
            {NWS_WEATHER_PATTERNS.map((p) => (
              <option key={p} value={p}>
                {NWS_WEATHER_PATTERN_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
        <SubmitButton className={`${css.button} ${css.primary}`} testId="sim-weather-apply">
          Apply to the simulated forecast
        </SubmitButton>
      </ActionForm>
      <ActionForm action={simWeatherAction}>
        <input type="hidden" name="clear" value="true" />
        <SubmitButton className={css.button} testId="sim-weather-clear">
          Back to the scenario&apos;s weather
        </SubmitButton>
      </ActionForm>
    </section>
  );
}

export default async function SprayAdminPage() {
  let session: Session;
  try {
    session = await requireRole(ROLE_FOR.editSprayThresholds);
  } catch (e) {
    if (isAuthError(e)) return <Refused message={e.status === 401 ? 'Sign in first' : e.message} />;
    throw e;
  }
  const cfg = getConfig();
  const now = new Date();
  const forHour = sprayAssessmentHours(now, 0)[0] as string;
  const pool = getPool();
  const [setting, targets, verdicts] = await Promise.all([
    readSprayThresholds(pool),
    sprayTargets(pool),
    verdictsForHour(pool, forHour),
  ]);
  let sim: NwsSimWeatherStatus | null = null;
  let simError: string | null = null;
  const showSim = !cfg.isProduction;
  if (showSim) {
    try {
      sim = await getSimWeather(cfg.VENDOR_SIM_URL);
    } catch (e) {
      simError = (e as Error).message;
    }
  }
  const t = setting.thresholds;
  const rows = targets.map((f) => {
    const v = verdicts.get(f.fieldId);
    return { field: f, view: v ? withStaleness(v, now) : null };
  });

  return (
    <NoticeProvider>
      <div className={css.pageHead}>
        <h1>Spray go/no-go</h1>
        <span className={css.muted}>
          {session.displayName} · rules {sprayRulesVersion(t)} · weather {cfg.CONNECTOR_WEATHER}
        </span>
      </div>
      <p
        className={`${sc.advisory} ${setting.isDefault ? '' : sc.advisorySaved}`}
        data-testid="spray-advisory"
      >
        {setting.isDefault
          ? `${SPRAY_ADVISORY_DEFAULTS_TEXT}. The values below are common label starting points, not yours yet.`
          : `${SPRAY_ADVISORY_TEXT}. Saved by ${setting.updatedBy ?? 'someone'} ${ago(setting.updatedAt, now)}.`}
      </p>
      {cfg.CONNECTOR_WEATHER !== 'live' && (
        <p className={css.muted} data-testid="weather-mode-hint">
          Weather comes from{' '}
          {cfg.CONNECTOR_WEATHER === 'sim' ? 'the simulated NWS' : cfg.CONNECTOR_WEATHER}. For the
          real NWS forecast of your grid cells put <code>CONNECTOR_WEATHER=live</code> and{' '}
          <code>NWS_USER_AGENT=&quot;farm-manager (you@example.com)&quot;</code> in{' '}
          <code>.env.local</code>, then restart <code>pnpm dev</code>. The forecast then refreshes
          every 30 minutes.
        </p>
      )}
      <div className={css.grid}>
        <section className={css.card} data-testid="spray-thresholds">
          <h2>Thresholds</h2>
          <ActionForm action={saveThresholdsAction}>
            <div className={sc.fields}>
              {THRESHOLD_FIELDS.map((f) => (
                <div key={f.key} className={sc.field}>
                  <label htmlFor={`threshold-${f.key}`}>{f.label}</label>
                  {f.kind === 'verdict' ? (
                    <select
                      id={`threshold-${f.key}`}
                      name={f.key}
                      className={css.select}
                      defaultValue={String(t[f.key])}
                      data-testid={`threshold-${f.key}`}
                    >
                      <option value="caution">Caution</option>
                      <option value="no_go">No-go</option>
                    </select>
                  ) : (
                    <span className={sc.unit}>
                      <input
                        id={`threshold-${f.key}`}
                        name={f.key}
                        type="number"
                        inputMode="decimal"
                        step={f.step}
                        min={0}
                        className={sc.input}
                        defaultValue={String(t[f.key])}
                        data-testid={`threshold-${f.key}`}
                        required
                      />
                      {f.unit}
                    </span>
                  )}
                  <small>{f.help}</small>
                </div>
              ))}
            </div>
            <SubmitButton className={`${css.button} ${css.primary}`} testId="thresholds-save">
              Save thresholds
            </SubmitButton>
          </ActionForm>
          <h3>Defaults</h3>
          <ActionForm action={resetThresholdsAction}>
            <SubmitButton className={css.button} testId="thresholds-reset">
              Restore the shipped defaults
            </SubmitButton>
          </ActionForm>
        </section>
        {showSim && <SimWeatherCard status={sim} error={simError} />}
      </div>
      <section className={css.card} data-testid="spray-verdicts">
        <h2>
          This hour ({detroitTime(forHour)}): {rows.filter((r) => r.view?.verdict === 'go').length}{' '}
          go · {rows.filter((r) => r.view?.verdict === 'caution').length} caution ·{' '}
          {rows.filter((r) => r.view?.verdict === 'no_go').length} no-go
        </h2>
        <div className={css.tableWrap}>
          <table className={css.table}>
            <thead>
              <tr>
                <th>Field</th>
                <th>Verdict</th>
                <th>Why</th>
                <th>Forecast</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ field, view }) => (
                <tr
                  key={field.fieldId}
                  data-testid="spray-verdict-row"
                  data-field-id={field.fieldId}
                >
                  <td>{field.name}</td>
                  <td>
                    {view ? (
                      <span className={sc[view.verdict]} data-testid="spray-verdict">
                        {SPRAY_VERDICT_LABELS[view.verdict]}
                      </span>
                    ) : (
                      <span className={css.muted}>not assessed yet</span>
                    )}
                  </td>
                  <td>
                    {view && view.reasons.length > 0 ? (
                      <ul className={sc.reasons}>
                        {view.reasons.map((r) => (
                          <li key={r.code}>{r.message}</li>
                        ))}
                      </ul>
                    ) : view ? (
                      <span className={css.muted}>within every threshold</span>
                    ) : null}
                  </td>
                  <td className={css.muted}>
                    {view?.forecastIssuedAt
                      ? `issued ${detroitTime(view.forecastIssuedAt)}${
                          view.forecastCheckedAt
                            ? `, checked ${detroitTime(view.forecastCheckedAt)}`
                            : ''
                        }`
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <LiveRefresh topics={['spray', 'weather']} realtime={cfg.NEXT_PUBLIC_REALTIME} />
    </NoticeProvider>
  );
}
