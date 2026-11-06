'use client';
/**
 * The field panel's Jobs tab (slice 2a; docs/contracts-2a.md §7.3): the field's open jobs with
 * their status (GET /api/v1/jobs?fieldId=, refetched on `jobs`/`updated` naming this field and
 * in onResync), and "New job here" (managers) opening the job form with the field filled in.
 * The tab itself: ./jobs/JobsTab.tsx (list, form), ./jobs/loader.ts (data and refresh).
 *
 * Owned by job-forms. Shown for every field (viewer and up), right after Overview
 * (TAB_ORDER.jobs).
 */
import type { FieldPanelTab } from '../tabs';
import { TAB_ORDER } from '../tabs';
import { JobsTab } from './jobs/JobsTab';

export const jobsTab: FieldPanelTab = {
  id: 'jobs',
  label: 'Jobs',
  order: TAB_ORDER.jobs,
  Component: JobsTab,
};
