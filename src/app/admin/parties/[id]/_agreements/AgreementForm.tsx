'use client';
/**
 * "Record a signed agreement" on a customer's page (D17): signed on, permitted uses, notes and
 * the signed document (a PDF or a photo, at most 4 MB), uploaded through the two-step storage
 * grant before the agreement is recorded (./upload.ts). The answer goes to the page's notice
 * line like every admin form; the server checks the role again on every step.
 */
import { MAX_AGREEMENT_NOTES_CHARS } from '@/domain/data-rights';
import { PERMITTED_USE_LABELS, PERMITTED_USES } from '@/domain/work-jobs';
import { ActionForm, SubmitButton } from '../../../_components/controls';
import adminCss from '../../../admin.module.css';
import css from '../../../fields/field-data.module.css';
import { agreementUploadGrantAction, recordAgreementAction } from './actions';
import { recordWithDocument } from './upload';

export function AgreementForm({ partyId, today }: { partyId: string; today: string }) {
  const submit = (_prev: unknown, form: FormData) =>
    recordWithDocument(form, {
      partyId,
      grant: agreementUploadGrantAction,
      record: recordAgreementAction,
      fetch: (input, init) => globalThis.fetch(input, init),
    });
  return (
    <ActionForm action={submit} className={css.form} testId="agreement-new">
      <input type="hidden" name="partyId" value={partyId} />
      <div className={css.formGrid}>
        <label className={css.label}>
          Signed on
          <input
            name="signedOn"
            type="date"
            required
            max={today}
            defaultValue={today}
            className={css.input}
            data-testid="agreement-signed-on"
          />
        </label>
        <label className={css.label}>
          Signed document (PDF or photo, up to 4 MB)
          <input
            name="document"
            type="file"
            accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp"
            className={css.input}
            data-testid="agreement-document"
          />
        </label>
      </div>
      <fieldset className={css.checks} data-testid="agreement-uses">
        <legend className={css.label}>The customer allows us to use their data for</legend>
        {PERMITTED_USES.map((use) => (
          <label key={use} className={css.check}>
            <input type="checkbox" name="uses" value={use} data-testid={`agreement-use-${use}`} />
            {PERMITTED_USE_LABELS[use]}
          </label>
        ))}
      </fieldset>
      <label className={css.label}>
        Notes
        <textarea
          name="notes"
          maxLength={MAX_AGREEMENT_NOTES_CHARS}
          className={css.textarea}
          data-testid="agreement-notes"
          placeholder="Who signed it, where the paper copy is"
        />
      </label>
      <SubmitButton className={`${adminCss.button} ${adminCss.primary}`} testId="agreement-save">
        Record agreement
      </SubmitButton>
    </ActionForm>
  );
}
