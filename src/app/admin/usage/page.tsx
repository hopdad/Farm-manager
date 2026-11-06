/**
 * /admin/usage (slice 2a, decision 2a-11; docs/contracts-2a.md §7.6): the Phase 2 gate report
 * from app.usage_events: the last USAGE_REPORT_DAYS farm days, newest first, each with the daily
 * active crew (names), board time per device, job actions, morning-mode runs ("starts in 2b"),
 * and the gate line ("crew used the board every day": at least PHASE2_MIN_DAILY_CREW active crew,
 * Sundays not counted). Demo and test people have a line of their own and never count: under
 * the demo every crew member is a demo person, so every day reads 0 active crew and fails, and
 * the page says why. Manager or owner (ROLE_FOR.admin). The day math is
 * src/platform/usage/report.ts (pure, tested); the rows src/db/queries/usage.ts.
 */
import { getPool } from '@/db/client';
import { loadUsageReportRows } from '@/db/queries/usage';
import { farmDate } from '@/domain/farm';
import {
  CREW_APP_ROLES,
  PHASE2_MIN_DAILY_CREW,
  USAGE_BUCKET_MINUTES,
  USAGE_REPORT_DAYS,
} from '@/domain/work-jobs';
import { requireRole } from '@/platform/auth/server';
import { AuthError, ROLE_FOR } from '@/platform/auth/types';
import {
  buildUsageReport,
  formatMinutes,
  type GateState,
  type ReportPerson,
  reportDays,
  type UsageReport,
  type UsageReportDay,
} from '@/platform/usage/report';
import css from '../admin.module.css';
import { NoAccess } from '../fields/_components/NoAccess';
import u from './usage.module.css';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Usage · Farm Ops' };

const DAY_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});

/** 'Fri, Nov 6' for a farm day (a calendar date: formatted at UTC noon, no zone shift). */
function dayLabel(day: string): string {
  return DAY_FMT.format(new Date(`${day}T12:00:00Z`));
}

const GATE_TEXT: Record<GateState, string> = {
  pass: 'pass',
  fail: 'fail',
  skip: 'Sunday: not counted',
};
const GATE_KIND: Record<GateState, string | undefined> = {
  pass: css.ok,
  fail: css.bad,
  skip: css.idle,
};

const names = (people: readonly ReportPerson[]) => people.map((p) => p.name).join(', ');

function DayRows({ day }: { day: UsageReportDay }) {
  return (
    <>
      <tr
        data-testid="usage-day"
        data-farm-day={day.farmDay}
        data-gate={day.gate}
        data-crew={day.crew.length}
        className={day.isToday ? u.today : undefined}
      >
        <td className={u.day}>
          {dayLabel(day.farmDay)}
          {day.isToday && <div className={css.muted}>today, so far</div>}
        </td>
        <td data-testid="usage-crew">
          <strong>{day.crew.length}</strong>
          {day.crew.length > 0 && <div>{names(day.crew)}</div>}
          {day.notCrew.length > 0 && (
            <div className={css.muted} data-testid="usage-not-crew">
              not crew: {day.notCrew.map((p) => `${p.name} (${p.role})`).join(', ')}
            </div>
          )}
        </td>
        <td data-testid="usage-board-time">
          {day.boardTime.length === 0 ? (
            <span className={css.muted}>none</span>
          ) : (
            <ul className={u.devices}>
              {day.boardTime.map((d, i) => (
                // Labels can repeat (two deleted devices, two people of one name); the list
                // is rendered once per request, so its position is a stable key.
                // biome-ignore lint/suspicious/noArrayIndexKey: static, server-rendered list
                <li key={`${i}:${d.label}`}>
                  {d.label} <span className={css.muted}>{formatMinutes(d.minutes)}</span>
                </li>
              ))}
            </ul>
          )}
        </td>
        <td data-testid="usage-job-actions">{day.counts.job_action}</td>
        <td data-testid="usage-morning-runs">
          {day.counts.morning_run > 0 ? (
            day.counts.morning_run
          ) : (
            <span className={css.muted}>starts in 2b</span>
          )}
        </td>
        <td>
          <span className={`${css.badge} ${GATE_KIND[day.gate] ?? ''}`}>{GATE_TEXT[day.gate]}</span>
        </td>
      </tr>
      {day.demoAndTest.length > 0 && (
        <tr className={u.demoRow} data-testid="usage-demo-people" data-farm-day={day.farmDay}>
          <td />
          <td colSpan={5} className={css.muted}>
            demo and test people (not counted): {names(day.demoAndTest)}
          </td>
        </tr>
      )}
    </>
  );
}

function GateLine({ report }: { report: UsageReport }) {
  const demoOnly = report.days.some((d) => d.crew.length === 0 && d.demoAndTest.length > 0);
  return (
    <section
      className={css.card}
      data-testid="usage-gate"
      data-today={report.todayGate}
      data-passed={report.passed}
      data-counted={report.counted}
    >
      <h2>Crew used the board every day</h2>
      <p>
        <strong>
          {report.passed} of {report.counted}
        </strong>{' '}
        finished days passed in the last {report.days.length} (Sundays not counted). Today so far:{' '}
        <span className={`${css.badge} ${GATE_KIND[report.todayGate] ?? ''}`}>
          {GATE_TEXT[report.todayGate]}
        </span>
      </p>
      <p className={css.muted}>
        A day passes with at least {report.minCrew} active crew: different people signed in as{' '}
        {CREW_APP_ROLES.join(', ')} who opened the board, had it open, signed in with a PIN or
        changed a job that day. The owner, demo people and test people never count.
      </p>
      {demoOnly && (
        <p className={css.muted} data-testid="usage-demo-note">
          Days with only demo or test people read 0 active crew and fail: that is right under the
          demo (every crew member there is a demo person). Real crew count once they sign in with
          their own accounts.
        </p>
      )}
    </section>
  );
}

export default async function UsageAdminPage() {
  try {
    await requireRole(ROLE_FOR.admin);
  } catch (e) {
    if (e instanceof AuthError) return <NoAccess status={e.status} required={ROLE_FOR.admin} />;
    throw e;
  }
  const today = farmDate(new Date());
  const from = reportDays(today).at(-1) ?? today;
  let report: UsageReport | null = null;
  let dbError: string | null = null;
  try {
    report = buildUsageReport(await loadUsageReportRows(getPool(), from, today), today);
  } catch (e) {
    dbError = (e as Error).message;
  }

  return (
    <>
      <div className={css.pageHead}>
        <h1>Usage</h1>
        <span className={css.muted}>
          the last {USAGE_REPORT_DAYS} farm days (Michigan time), newest first
        </span>
      </div>
      {dbError && <div className={css.banner}>Database not reachable: {dbError}</div>}
      {report && (
        <>
          <GateLine report={report} />
          <div style={{ height: 16 }} />
          <section className={css.card}>
            <div className={css.tableWrap}>
              <table className={css.table} data-testid="usage-report">
                <thead>
                  <tr>
                    <th>Day</th>
                    <th>Active crew</th>
                    <th>Board time per device</th>
                    <th>Job actions</th>
                    <th>Morning mode</th>
                    <th>Gate (≥ {PHASE2_MIN_DAILY_CREW} crew)</th>
                  </tr>
                </thead>
                <tbody>
                  {report.days.map((d) => (
                    <DayRows key={d.farmDay} day={d} />
                  ))}
                </tbody>
              </table>
            </div>
            <p className={css.muted}>
              Board time counts the {USAGE_BUCKET_MINUTES}-minute stretches a board or phone map was
              open with someone signed in on it (an unattended wall logs none). Job actions count
              job changes, at most one per person, screen and kind of change per{' '}
              {USAGE_BUCKET_MINUTES} minutes.
            </p>
          </section>
        </>
      )}
    </>
  );
}
