/**
 * The field panel's Jobs tab rendered to HTML (react-dom/server): registered right after
 * Overview and shown for every field; each open job with its status colour (the board's
 * palette), window, who, products and flags; "New job here" and Edit for managers only. The
 * live refresh is ./loader.test.ts; taps and the form are e2e/m2a-forms.spec.ts.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { ROLES, type Role } from '../../../../platform/auth/types';
import { FIXTURE_IDS, makeJobView } from '../../../work/forms/fixtures';
import { JOB_STATUS_COLORS } from '../../../work/style';
import { FIXTURE_FIELD_ID, makeFieldDetail } from '../../fixtures';
import { FIELD_PANEL_TABS } from '../../tab-registry';
import { TAB_ORDER } from '../../tabs';
import { visibleTabs } from '../../visible-tabs';
import { jobsTab } from '../jobs';
import { FieldJobsView, type FieldJobsViewProps } from './JobsTab';
import type { FieldJobsState } from './loader';
import { assignmentsText, jobRowText, productsText, splitJobs, windowText } from './row-text';

const ready = (jobs = [makeJobView()]): FieldJobsState => ({
  fieldId: FIXTURE_FIELD_ID,
  status: 'ready',
  jobs,
  viewer: { role: 'viewer', partyId: null, canPlan: false },
  error: null,
});

function view(role: Role, over: Partial<FieldJobsViewProps> = {}): string {
  return renderToStaticMarkup(
    createElement(FieldJobsView, {
      fieldId: FIXTURE_FIELD_ID,
      variant: 'wall',
      role,
      state: ready(),
      editing: null,
      saved: null,
      form: null,
      onNew: () => {},
      onEdit: () => {},
      onRetry: () => {},
      ...over,
    }),
  );
}

describe('the Jobs tab', () => {
  test('is registered right after Overview and shown for every field', () => {
    expect(FIELD_PANEL_TABS).toContain(jobsTab);
    expect(jobsTab).toMatchObject({ id: 'jobs', label: 'Jobs', order: TAB_ORDER.jobs });
    const d = makeFieldDetail();
    for (const role of ROLES) {
      expect(
        visibleTabs(FIELD_PANEL_TABS, role, d)
          .map((t) => t.id)
          .slice(0, 2),
      ).toEqual(['overview', 'jobs']);
    }
  });

  test('its component renders the loading list for the panel’s field', () => {
    const html = renderToStaticMarkup(
      createElement(jobsTab.Component, {
        fieldId: FIXTURE_FIELD_ID,
        detail: makeFieldDetail(),
        variant: 'phone',
        role: 'manager',
        onChanged: () => {},
      }),
    );
    expect(html).toContain('data-testid="field-jobs" data-state="loading"');
    expect(html).toContain('data-testid="field-new-job"');
  });

  test('each open job with its status colour, window, who and products', () => {
    const job = makeJobView({
      status: 'assigned',
      assignments: [
        {
          id: FIXTURE_IDS.assignment,
          role: 'operator',
          machine: {
            id: FIXTURE_IDS.machine,
            unitNo: 'SP2',
            kind: 'sprayer',
            status: 'down',
            workPlanCapable: false,
          },
          person: { partyId: FIXTURE_IDS.crew, name: 'Dale Mercer', initials: 'DM' },
          plannedFor: null,
          alsoOn: [],
        },
      ],
      flags: ['machine_down'],
    });
    const html = view('viewer', { state: ready([job]) });
    expect(html).toContain(
      `data-testid="field-job-row" data-job-id="${job.id}" data-status="assigned"`,
    );
    expect(html).toContain(`background:${JOB_STATUS_COLORS.assigned.fill}`);
    expect(html).toContain('>Assigned<');
    expect(html).toContain('SP2 · Dale Mercer');
    expect(html).toContain('Glyphosate 5.5 32 fl oz/ac');
    expect(html).toContain('Mon, Nov 9 8:00 AM – 5:00 PM');
    expect(html).toContain('data-testid="job-flag" data-flag="machine_down"');
    expect(html).toContain('1 open job');
  });

  test('done jobs leave the list (counted), closed ones never show', () => {
    const done = makeJobView({ id: crypto.randomUUID(), status: 'done' });
    const html = view('viewer', { state: ready([done]) });
    expect(html).toContain('0 open jobs · 1 done today');
    expect(html).toContain('data-testid="field-jobs-empty"');
    expect(html).not.toContain('data-testid="field-job-row"');
  });

  test('"New job here" and Edit for managers and owners only', () => {
    for (const role of ['viewer', 'driver', 'operator'] as const) {
      const html = view(role);
      expect(html, role).not.toContain('field-new-job');
      expect(html, role).not.toContain('field-job-edit');
    }
    for (const role of ['manager', 'owner'] as const) {
      const html = view(role);
      expect(html, role).toContain('data-testid="field-new-job"');
      expect(html, role).toContain('data-testid="field-job-edit"');
    }
  });

  test('the form opens inline; failures say so', () => {
    expect(
      view('manager', { editing: { mode: 'new' }, form: createElement('p', null, 'THE FORM') }),
    ).toContain('THE FORM');
    expect(
      view('viewer', {
        state: { ...ready(), status: 'error', jobs: null, error: 'the server answered 501' },
      }),
    ).toContain('Couldn’t load the jobs (the server answered 501).');
    expect(view('viewer', { state: { ...ready(), status: 'denied', jobs: null } })).toContain(
      'Sign in',
    );
  });
});

describe('row text', () => {
  test('windows in farm time', () => {
    expect(windowText(null)).toBe('no window yet');
    expect(windowText({ from: '2026-11-09T13:00:00Z', to: '2026-11-10T22:00:00Z' })).toBe(
      'Mon, Nov 9 8:00 AM – Tue, Nov 10 5:00 PM',
    );
    expect(windowText({ from: '2026-11-09T13:00:00Z', to: null })).toBe('from Mon, Nov 9 8:00 AM');
    expect(windowText({ from: null, to: '2026-11-10T22:00:00Z' })).toBe('by Tue, Nov 10 5:00 PM');
  });

  test('who, products, acres or amount', () => {
    expect(assignmentsText(makeJobView())).toBe('');
    expect(productsText(makeJobView({ products: [] }))).toBe('');
    const t = jobRowText(makeJobView({ plannedAcres: null, plannedQty: 12, plannedUnit: 'loads' }));
    expect(t.acres).toBe('12 loads');
    expect(jobRowText(makeJobView()).acres).toBe('78.4 ac');
    expect(splitJobs([makeJobView({ status: 'cancelled' })])).toEqual({ open: [], doneToday: 0 });
  });
});
