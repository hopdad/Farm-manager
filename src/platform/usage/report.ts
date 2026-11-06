/**
 * The Phase 2 gate report (decision 2a-11; docs/contracts-2a.md §7.6), pure: the rows of
 * src/db/queries/usage.ts `loadUsageReportRows` -> the /admin/usage page's days.
 *
 *  - Days are FARM days (America/Detroit, `farm_day` written at insert time), listed newest
 *    first: today and the USAGE_REPORT_DAYS - 1 before it. Day arithmetic is on calendar dates
 *    ('YYYY-MM-DD' through Date.UTC), never on 24-hour steps, so the DST changes neither skip
 *    nor repeat a day.
 *  - Active crew: distinct people with any usage event that day whose app role is in
 *    CREW_APP_ROLES (driver, operator, manager: never the owner), excluding demo and test
 *    people (source demo, sim or e2e). Demo and test people are listed on a line of their own
 *    and never counted; anyone else signed in (the owner, a viewer) is listed as "not crew".
 *  - Board time per device: the 5-minute buckets with at least one heartbeat × 5 minutes.
 *  - The gate line: a day passes with at least PHASE2_MIN_DAILY_CREW active crew; Sundays
 *    (GATE_SKIPPED_WEEKDAYS) are skipped. Today is shown "so far" and kept out of the summary
 *    until it is over.
 */
import {
  CREW_APP_ROLES,
  GATE_SKIPPED_WEEKDAYS,
  PHASE2_MIN_DAILY_CREW,
  USAGE_BUCKET_MINUTES,
  USAGE_KINDS,
  USAGE_REPORT_DAYS,
  type UsageKind,
} from '../../domain/work-jobs';

/** The rows the report is built from (src/db/queries/usage.ts `UsageReportRows`). */
export interface UsageReportInput {
  people: readonly {
    farmDay: string;
    appUserId: string;
    name: string;
    role: string;
    demoOrTest: boolean;
  }[];
  boardTime: readonly {
    farmDay: string;
    deviceKey: string;
    deviceName: string | null;
    personName: string | null;
    buckets: number;
  }[];
  counts: readonly { farmDay: string; kind: UsageKind; events: number }[];
}

export type GateState = 'pass' | 'fail' | 'skip';

export interface ReportPerson {
  appUserId: string;
  name: string;
  role: string;
}

export interface ReportDevice {
  /** 'Shop wall', "Dale Mercer's browser", 'a deleted device'. */
  label: string;
  minutes: number;
}

export interface UsageReportDay {
  farmDay: string;
  /** 0 = Sunday … 6 = Saturday (the farm day's own weekday). */
  weekday: number;
  isToday: boolean;
  gate: GateState;
  /** Counted toward the gate. */
  crew: ReportPerson[];
  /** Demo and test people (never counted). */
  demoAndTest: ReportPerson[];
  /** Signed in but not crew (the owner, viewers): never counted. */
  notCrew: ReportPerson[];
  boardTime: ReportDevice[];
  boardMinutes: number;
  /** Events per kind (bucketed rows: at most one per person, device and route per 5 minutes). */
  counts: Record<UsageKind, number>;
}

export interface UsageReport {
  today: string;
  /** Newest first, USAGE_REPORT_DAYS of them. */
  days: UsageReportDay[];
  /** Completed days in the window that count for the gate (Sundays and today left out). */
  counted: number;
  passed: number;
  /** Today's state so far. */
  todayGate: GateState;
  minCrew: number;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function dayParts(day: string): [number, number, number] {
  const m = DAY_RE.exec(day);
  if (!m) throw new RangeError(`not a day: ${day}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** `day` plus `n` calendar days ('YYYY-MM-DD'). */
export function addFarmDays(day: string, n: number): string {
  const [y, m, d] = dayParts(day);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The weekday of a calendar date (0 = Sunday). */
export function weekdayOf(day: string): number {
  const [y, m, d] = dayParts(day);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** The report's days, newest first: `today` and the `count - 1` days before it. */
export function reportDays(today: string, count: number = USAGE_REPORT_DAYS): string[] {
  return Array.from({ length: count }, (_, i) => addFarmDays(today, -i));
}

/** The gate state of one day with `crew` active crew (Sundays skipped). */
export function gateFor(day: string, crew: number, min: number = PHASE2_MIN_DAILY_CREW): GateState {
  if (GATE_SKIPPED_WEEKDAYS.includes(weekdayOf(day))) return 'skip';
  return crew >= min ? 'pass' : 'fail';
}

const isCrewRole = (role: string) => (CREW_APP_ROLES as readonly string[]).includes(role);

function deviceLabel(row: UsageReportInput['boardTime'][number]): string {
  if (row.deviceKey === '-') return row.personName ? `${row.personName}'s browser` : 'a browser';
  return row.deviceName ?? 'a deleted device';
}

function emptyCounts(): Record<UsageKind, number> {
  return Object.fromEntries(USAGE_KINDS.map((k) => [k, 0])) as Record<UsageKind, number>;
}

export function buildUsageReport(
  input: UsageReportInput,
  today: string,
  opts: { days?: number; minCrew?: number } = {},
): UsageReport {
  const minCrew = opts.minCrew ?? PHASE2_MIN_DAILY_CREW;
  const days = reportDays(today, opts.days ?? USAGE_REPORT_DAYS);
  const byDay = new Map<string, UsageReportDay>();
  for (const day of days) {
    byDay.set(day, {
      farmDay: day,
      weekday: weekdayOf(day),
      isToday: day === today,
      gate: 'fail',
      crew: [],
      demoAndTest: [],
      notCrew: [],
      boardTime: [],
      boardMinutes: 0,
      counts: emptyCounts(),
    });
  }
  const seen = new Set<string>();
  for (const p of input.people) {
    const d = byDay.get(p.farmDay);
    const key = `${p.farmDay}|${p.appUserId}`;
    if (!d || seen.has(key)) continue;
    seen.add(key);
    const person = { appUserId: p.appUserId, name: p.name, role: p.role };
    if (p.demoOrTest) d.demoAndTest.push(person);
    else if (isCrewRole(p.role)) d.crew.push(person);
    else d.notCrew.push(person);
  }
  for (const b of input.boardTime) {
    const d = byDay.get(b.farmDay);
    if (!d || b.buckets <= 0) continue;
    const minutes = b.buckets * USAGE_BUCKET_MINUTES;
    d.boardTime.push({ label: deviceLabel(b), minutes });
    d.boardMinutes += minutes;
  }
  for (const c of input.counts) {
    const d = byDay.get(c.farmDay);
    if (d) d.counts[c.kind] += c.events;
  }
  const byName = (a: ReportPerson, b: ReportPerson) =>
    a.name.localeCompare(b.name) || a.appUserId.localeCompare(b.appUserId);
  let counted = 0;
  let passed = 0;
  for (const d of byDay.values()) {
    d.crew.sort(byName);
    d.demoAndTest.sort(byName);
    d.notCrew.sort(byName);
    d.boardTime.sort((a, b) => b.minutes - a.minutes || a.label.localeCompare(b.label));
    d.gate = gateFor(d.farmDay, d.crew.length, minCrew);
    if (!d.isToday && d.gate !== 'skip') {
      counted++;
      if (d.gate === 'pass') passed++;
    }
  }
  const list = days.map((day) => byDay.get(day) as UsageReportDay);
  return {
    today,
    days: list,
    counted,
    passed,
    todayGate: list[0]?.gate ?? 'fail',
    minCrew,
  };
}

/** '2 h 35 min', '15 min', '0 min'. */
export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
