/**
 * The Phase 2 gate report's day math (decision 2a-11; docs/contracts-2a.md §7.6, done-when
 * §11.4): farm days across both DST changes, Sundays skipped, the owner and demo / e2e people
 * never counted (demo and test people on a line of their own), board time = the buckets with a
 * heartbeat × 5 minutes, today "so far" and out of the summary.
 */
import { describe, expect, test } from 'vitest';
import { PHASE2_MIN_DAILY_CREW, USAGE_REPORT_DAYS } from '../../domain/work-jobs';
import {
  addFarmDays,
  buildUsageReport,
  formatMinutes,
  gateFor,
  reportDays,
  type UsageReportInput,
  weekdayOf,
} from './report';

const empty: UsageReportInput = { people: [], boardTime: [], counts: [] };
const person = (
  farmDay: string,
  appUserId: string,
  name: string,
  role = 'operator',
  demoOrTest = false,
) => ({ farmDay, appUserId, name, role, demoOrTest });

describe('days', () => {
  test('calendar steps, never 24-hour ones: both DST changes keep one row per day', () => {
    // Spring forward: Mar 8, 2026 (a 23-hour day in Michigan).
    expect(reportDays('2026-03-10', 4)).toEqual([
      '2026-03-10',
      '2026-03-09',
      '2026-03-08',
      '2026-03-07',
    ]);
    // Fall back: Nov 1, 2026 (a 25-hour day).
    expect(reportDays('2026-11-02', 3)).toEqual(['2026-11-02', '2026-11-01', '2026-10-31']);
    const month = reportDays('2026-11-06');
    expect(month).toHaveLength(USAGE_REPORT_DAYS);
    expect(new Set(month).size).toBe(USAGE_REPORT_DAYS);
    expect(month.at(-1)).toBe('2026-10-08');
  });

  test('day arithmetic over months, years and leap days', () => {
    expect(addFarmDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addFarmDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(addFarmDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  test('weekdays of the farm date itself', () => {
    expect(weekdayOf('2026-11-08')).toBe(0); // Sunday
    expect(weekdayOf('2026-11-06')).toBe(5); // Friday
    expect(weekdayOf('2026-03-08')).toBe(0); // the spring-forward Sunday
    expect(weekdayOf('2026-11-01')).toBe(0); // the fall-back Sunday
  });
});

describe('the gate line', () => {
  test(`a day passes with at least ${PHASE2_MIN_DAILY_CREW} active crew; Sundays are skipped`, () => {
    expect(gateFor('2026-11-06', PHASE2_MIN_DAILY_CREW)).toBe('pass');
    expect(gateFor('2026-11-06', PHASE2_MIN_DAILY_CREW - 1)).toBe('fail');
    expect(gateFor('2026-11-06', 0)).toBe('fail');
    expect(gateFor('2026-11-08', 0)).toBe('skip');
    expect(gateFor('2026-11-08', 9)).toBe('skip');
    expect(gateFor('2026-11-06', 1, 1)).toBe('pass');
  });

  test('the owner, viewers and demo / e2e people are never counted; demo and test people listed', () => {
    const day = '2026-11-05'; // a Thursday
    const r = buildUsageReport(
      {
        ...empty,
        people: [
          person(day, 'u-owner', 'Derrick', 'owner'),
          person(day, 'u-viewer', 'Shop guest', 'viewer'),
          person(day, 'u-amy', 'Amy Kovach', 'manager', true),
          person(day, 'u-dale', 'Dale Mercer', 'operator', true),
          person(day, 'u-e2e', 'E2E Manager', 'manager', true),
          person(day, 'u-real', 'Rita Real', 'driver'),
        ],
      },
      '2026-11-06',
    );
    const d = r.days.find((x) => x.farmDay === day);
    expect(d?.crew.map((p) => p.name)).toEqual(['Rita Real']);
    expect(d?.demoAndTest.map((p) => p.name)).toEqual(['Amy Kovach', 'Dale Mercer', 'E2E Manager']);
    expect(d?.notCrew.map((p) => p.name)).toEqual(['Derrick', 'Shop guest']);
    expect(d?.gate).toBe('fail');
  });

  test('two real crew pass the day; a person seen twice that day counts once', () => {
    const day = '2026-11-05';
    const r = buildUsageReport(
      {
        ...empty,
        people: [
          person(day, 'u-1', 'Rita Real', 'driver'),
          person(day, 'u-1', 'Rita Real', 'driver'),
          person(day, 'u-2', 'Mo Manager', 'manager'),
        ],
      },
      '2026-11-06',
    );
    const d = r.days.find((x) => x.farmDay === day);
    expect(d?.crew).toHaveLength(2);
    expect(d?.gate).toBe('pass');
    expect(r.passed).toBe(1);
  });

  test('today shows so far and stays out of the summary; Sundays out of it too', () => {
    const today = '2026-11-09'; // a Monday
    const crew = (day: string) => [person(day, `a-${day}`, 'Ann'), person(day, `b-${day}`, 'Bo')];
    const r = buildUsageReport(
      {
        ...empty,
        people: [...crew(today), ...crew('2026-11-07'), ...crew('2026-11-08')],
      },
      today,
      { days: 4 },
    );
    expect(r.days.map((d) => [d.farmDay, d.gate, d.isToday])).toEqual([
      ['2026-11-09', 'pass', true],
      ['2026-11-08', 'skip', false],
      ['2026-11-07', 'pass', false],
      ['2026-11-06', 'fail', false],
    ]);
    expect(r.todayGate).toBe('pass');
    expect({ passed: r.passed, counted: r.counted }).toEqual({ passed: 1, counted: 2 });
  });

  test('under the demo every day reads 0 active crew and fails', () => {
    const today = '2026-11-06';
    const r = buildUsageReport(
      {
        ...empty,
        people: reportDays(today, 7).map((d) => person(d, 'u-amy', 'Amy Kovach', 'manager', true)),
      },
      today,
      { days: 7 },
    );
    for (const d of r.days) {
      expect(d.crew).toHaveLength(0);
      expect(d.demoAndTest.map((p) => p.name)).toEqual(['Amy Kovach']);
      expect(d.gate).toBe(d.weekday === 0 ? 'skip' : 'fail');
    }
    expect(r.passed).toBe(0);
    expect(r.counted).toBe(5);
  });

  test('rows outside the window are ignored', () => {
    const r = buildUsageReport(
      { ...empty, people: [person('2026-01-01', 'u', 'Old Timer')] },
      '2026-11-06',
    );
    expect(r.days.every((d) => d.crew.length === 0)).toBe(true);
  });
});

describe('board time and counts', () => {
  test('board time = the buckets with a heartbeat × 5 minutes, per device, largest first', () => {
    const day = '2026-11-06';
    const r = buildUsageReport(
      {
        ...empty,
        boardTime: [
          {
            farmDay: day,
            deviceKey: 'd-1',
            deviceName: 'Shop wall',
            personName: null,
            buckets: 31,
          },
          { farmDay: day, deviceKey: '-', deviceName: null, personName: 'Dale', buckets: 3 },
          { farmDay: day, deviceKey: 'd-2', deviceName: null, personName: null, buckets: 2 },
          { farmDay: day, deviceKey: 'd-3', deviceName: 'Zero', personName: null, buckets: 0 },
        ],
      },
      day,
    );
    const d = r.days[0];
    expect(d?.boardTime).toEqual([
      { label: 'Shop wall', minutes: 155 },
      { label: "Dale's browser", minutes: 15 },
      { label: 'a deleted device', minutes: 10 },
    ]);
    expect(d?.boardMinutes).toBe(180);
  });

  test('job actions and morning runs per day', () => {
    const day = '2026-11-06';
    const r = buildUsageReport(
      {
        ...empty,
        counts: [
          { farmDay: day, kind: 'job_action', events: 7 },
          { farmDay: day, kind: 'page_view', events: 3 },
          { farmDay: '2026-11-05', kind: 'job_action', events: 2 },
        ],
      },
      day,
    );
    expect(r.days[0]?.counts).toEqual({
      page_view: 3,
      board_heartbeat: 0,
      pin_sign_in: 0,
      job_action: 7,
      morning_run: 0,
    });
    expect(r.days[1]?.counts.job_action).toBe(2);
  });

  test('minutes read as hours and minutes', () => {
    expect(formatMinutes(0)).toBe('0 min');
    expect(formatMinutes(15)).toBe('15 min');
    expect(formatMinutes(60)).toBe('1 h');
    expect(formatMinutes(155)).toBe('2 h 35 min');
  });
});
