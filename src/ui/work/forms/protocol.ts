/**
 * Wire details the job forms and the field panel's Jobs tab share with their routes (job-forms,
 * docs/contracts-2a.md §7.3). Pure.
 *
 * The realtime adapter and the app's environment ride in two response headers of
 * GET/HEAD /api/v1/job-options, the same pair the History tab reads from its operations route
 * (src/ui/fields/operations.ts): field panel tabs get no config (src/ui/fields/tabs.ts), so this
 * is how the Jobs tab knows how to subscribe to `jobs`.
 */
export {
  OPERATIONS_APP_ENV_HEADER as JOB_FORMS_APP_ENV_HEADER,
  OPERATIONS_REALTIME_HEADER as JOB_FORMS_REALTIME_HEADER,
} from '../../fields/operations';
