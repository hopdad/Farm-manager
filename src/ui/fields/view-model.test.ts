import { describe, expect, test } from 'vitest';
import { makeFieldDetail } from './fixtures';
import {
  DASH,
  fieldPanelView,
  formatAcres,
  formatCrop,
  formatSeasonDate,
  formatWhen,
  formatYield,
  openJobsText,
  partyView,
} from './view-model';

const NOW = Date.parse('2026-10-29T14:00:00.000Z');

describe('formatting', () => {
  test('acres: one decimal, thousands separator, null stays null', () => {
    expect(formatAcres(78.42)).toBe('78.4 ac');
    expect(formatAcres(160)).toBe('160.0 ac');
    expect(formatAcres(1234.56)).toBe('1,234.6 ac');
    expect(formatAcres(null)).toBeNull();
    expect(formatAcres(Number.NaN)).toBeNull();
  });

  test('crops are capitalized; missing values are a dash', () => {
    expect(formatCrop('soybeans')).toBe('Soybeans');
    expect(formatCrop('winter_wheat')).toBe('Winter wheat');
    expect(formatCrop('  ')).toBe(DASH);
    expect(formatCrop(null)).toBe(DASH);
  });

  test('season dates are calendar dates: no time-zone shift, year only when it differs', () => {
    expect(formatSeasonDate('2025-05-08', 2025)).toBe('May 8');
    // A harvest that ran into January of the next year.
    expect(formatSeasonDate('2023-01-04', 2022)).toBe('Jan 4, 2023');
    expect(formatSeasonDate('2025-12-31')).toBe('Dec 31, 2025');
    expect(formatSeasonDate(null, 2025)).toBe(DASH);
    expect(formatSeasonDate('garbage', 2025)).toBe('garbage');
  });

  test('yield in bu/ac with one decimal', () => {
    expect(formatYield(197.94)).toBe('197.9 bu/ac');
    expect(formatYield(56)).toBe('56.0 bu/ac');
    expect(formatYield(null)).toBe(DASH);
  });

  test('when: relative within two days, then a Detroit calendar date', () => {
    expect(formatWhen('2026-10-29T13:59:40.000Z', NOW)).toBe('just now');
    expect(formatWhen('2026-10-29T13:55:00.000Z', NOW)).toBe('5 min ago');
    expect(formatWhen('2026-10-28T14:00:00.000Z', NOW)).toBe('24 h ago');
    // 02:00 UTC on Oct 12 is still Oct 11 in Michigan.
    expect(formatWhen('2026-10-12T02:00:00.000Z', NOW)).toBe('Oct 11, 2026');
    expect(formatWhen('not a date', NOW)).toBe('at an unknown time');
  });
});

describe('who the panel names', () => {
  test('a rented field names its landlord with contact details', () => {
    const p = partyView(makeFieldDetail().field);
    expect(p).toMatchObject({
      role: 'Landlord',
      name: 'Ivan Abernath',
      phone: '(517) 555-0109',
      email: 'ivan.abernath@example.com',
      missing: false,
    });
  });

  test('a customer field names the customer, even when it also has a landlord', () => {
    const d = makeFieldDetail({
      field: {
        tenure: 'custom',
        customer: {
          id: 'c1',
          displayName: 'Halvorsen Bros. Farms',
          kind: 'org',
          phone: null,
          email: null,
        },
      },
    });
    expect(partyView(d.field)).toMatchObject({ role: 'Customer', name: 'Halvorsen Bros. Farms' });
  });

  test('owned ground is your operation; rented ground without a landlord says so', () => {
    expect(
      partyView(makeFieldDetail({ field: { tenure: 'owned', landlord: null } }).field),
    ).toEqual(
      expect.objectContaining({
        role: 'Owner',
        name: 'Your operation',
        party: null,
        missing: false,
      }),
    );
    expect(
      partyView(makeFieldDetail({ field: { tenure: 'share', landlord: null } }).field),
    ).toEqual(expect.objectContaining({ role: 'Landlord', missing: true, party: null }));
    expect(
      partyView(makeFieldDetail({ field: { tenure: 'custom', landlord: null } }).field),
    ).toEqual(expect.objectContaining({ role: 'Customer', missing: true }));
  });
});

describe('fieldPanelView', () => {
  test('header, boundary and the five seasons newest first', () => {
    const v = fieldPanelView(makeFieldDetail(), 'viewer', NOW);
    expect(v).toMatchObject({
      title: 'Abernath East 80',
      acres: '78.4 ac',
      tenure: { key: 'cash_rent', label: 'Cash rent' },
      farm: 'Adrian',
      client: null,
      county: 'Lenawee County',
      inactive: false,
    });
    expect(v.boundary).toMatchObject({
      acres: '78.4 ac',
      source: 'John Deere Operations Center',
      since: 'Mar 1, 2024',
      editable: false,
      openRequests: null,
    });
    expect(v.boundary?.readOnlyReason).toMatch(/Operations Center/);
    expect(v.seasons.map((s) => s.cropYear)).toEqual([2025, 2024, 2023, 2022, 2021]);
    expect(v.seasons[0]).toEqual({
      cropYear: 2025,
      crop: 'Soybeans',
      variety: 'NF 2.2E9',
      planted: 'May 8',
      harvested: 'Oct 3',
      yield: '58.5 bu/ac',
      yieldValue: '58.5',
      source: 'Deere',
    });
    expect(v.seasons[3]).toMatchObject({ variety: DASH, harvested: 'Jan 4, 2023' });
    expect(v.seasons[4]).toMatchObject({
      planted: DASH,
      harvested: DASH,
      yield: DASH,
      yieldValue: DASH,
    });
    expect(v.openJobs).toBe('No open jobs on the job board');
  });

  test("open jobs: the count of the field's open jobs on the board (slice 2a)", () => {
    const view = (count: number) =>
      fieldPanelView(makeFieldDetail({ openJobs: { count } }), 'viewer', NOW).openJobs;
    expect(view(0)).toBe('No open jobs on the job board');
    expect(view(1)).toBe('1 open job on the job board');
    expect(view(3)).toBe('3 open jobs on the job board');
    expect(view(1200)).toBe('1,200 open jobs on the job board');
    expect(openJobsText(-1)).toBe('No open jobs on the job board');
  });

  test('notes: who edited and when; only manager and owner may edit', () => {
    const d = makeFieldDetail();
    expect(fieldPanelView(d, 'viewer', NOW).notes).toEqual({
      text: d.notes.text,
      edited: 'Edited 5 min ago by Dana Ruiz',
      canEdit: false,
      version: d.notes.version,
    });
    expect(fieldPanelView(d, 'driver', NOW).notes.canEdit).toBe(false);
    expect(fieldPanelView(d, 'operator', NOW).notes.canEdit).toBe(false);
    expect(fieldPanelView(d, 'manager', NOW).notes.canEdit).toBe(true);
    expect(fieldPanelView(d, 'owner', NOW).notes.canEdit).toBe(true);
    const never = makeFieldDetail({
      notes: { text: null, updatedAt: null, updatedByName: null, version: d.notes.version },
    });
    expect(fieldPanelView(never, 'owner', NOW).notes).toMatchObject({ text: null, edited: null });
    const anonymous = makeFieldDetail({ notes: { ...d.notes, updatedByName: null } });
    expect(fieldPanelView(anonymous, 'owner', NOW).notes.edited).toBe('Edited 5 min ago');
  });

  test('no boundary, other counties, open change requests, inactive fields', () => {
    const none = fieldPanelView(
      makeFieldDetail({ boundary: null, field: { acres: null, countyFips: null } }),
      'viewer',
      NOW,
    );
    expect(none).toMatchObject({ acres: null, boundary: null, county: null });

    const v = fieldPanelView(
      makeFieldDetail({ openBoundaryRequests: 2, field: { countyFips: '26115', active: false } }),
      'viewer',
      NOW,
    );
    expect(v.county).toBe('Monroe County');
    expect(v.boundary?.openRequests).toBe('2 change requests open in Operations Center');
    expect(v.inactive).toBe(true);
    expect(
      fieldPanelView(makeFieldDetail({ field: { countyFips: '26001' } }), 'viewer', NOW).county,
    ).toBe('County 26001');
  });

  test("the boundary's start date is the farm's date, not UTC's (an evening change)", () => {
    const d = makeFieldDetail();
    const at = (validFrom: string) =>
      fieldPanelView(
        makeFieldDetail({ boundary: d.boundary && { ...d.boundary, validFrom } }),
        'viewer',
        NOW,
      ).boundary?.since;
    // Dec 31, 2026 at 8 PM EST is Jan 1 in UTC.
    expect(at('2027-01-01T01:00:00.000Z')).toBe('Dec 31, 2026');
    // A July evening at 9 PM EDT.
    expect(at('2026-07-15T01:00:00.000Z')).toBe('Jul 14, 2026');
  });

  test('an editable (non-Deere) boundary has no read-only reason', () => {
    const d = makeFieldDetail();
    const editable = makeFieldDetail({
      field: { deereFieldId: null },
      boundary: d.boundary && {
        ...d.boundary,
        source: 'drawn',
        editable: true,
        readOnlyReason: null,
      },
    });
    expect(fieldPanelView(editable, 'viewer', NOW).boundary).toMatchObject({
      source: 'Drawn in the app',
      editable: true,
      readOnlyReason: null,
    });
  });
});
