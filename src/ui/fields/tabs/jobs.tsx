'use client';
/**
 * The field panel's Jobs tab (slice 2a; docs/contracts-2a.md §7.3): the field's open jobs with
 * their status (GET /api/v1/jobs?fieldId=, refetched on `jobs`/`updated` naming this field and
 * in onResync), and "New job here" (managers) opening the job form with the field filled in.
 *
 * FOUNDATION STUB, owned by the job-forms builder: hidden (`visible` returns false) until the
 * tab is built, so the panel looks as it did. Keep the export name, the id 'jobs' and
 * TAB_ORDER.jobs.
 */
import type { FieldPanelTab, FieldPanelTabProps } from '../tabs';
import { TAB_ORDER } from '../tabs';

function JobsTab(_props: FieldPanelTabProps) {
  return <div data-testid="field-jobs">The field&apos;s jobs arrive with slice 2a.</div>;
}

export const jobsTab: FieldPanelTab = {
  id: 'jobs',
  label: 'Jobs',
  order: TAB_ORDER.jobs,
  Component: JobsTab,
  visible: () => false,
};
