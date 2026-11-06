/**
 * The browser side of recording an agreement with its signed document (two-step upload,
 * docs/contracts-m1.md §9), framework-free so ./upload.test.ts drives it with fakes:
 *
 *   1. ask the server for a grant (`grant`: agreementUploadGrantAction, which checks the role
 *      and the file's type and size);
 *   2. PUT the file's bytes to the grant's URL with the grant's headers (straight to storage,
 *      never through a server action, whose body limit is far below a scanned PDF);
 *   3. record the agreement (`record`: recordAgreementAction) with the document's key in the
 *      form instead of the file.
 * Any step's failure is the answer (the notice line shows it); nothing is recorded then. A
 * form without a file records the agreement alone.
 */
import { type ActionResult, actionResult } from '../../../action-result';

export interface GrantAnswer extends ActionResult {
  data?: { url: string; headers: Record<string, string>; key: string };
}

export interface RecordWithDocumentDeps {
  partyId: string;
  grant(partyId: string, file: { name: string; size: number }): Promise<GrantAnswer>;
  record(prev: ActionResult | null, form: FormData): Promise<ActionResult>;
  fetch: typeof fetch;
}

/** The form's file, when one was chosen. */
function chosenFile(form: FormData): File | null {
  const f = form.get('document');
  return f && typeof f !== 'string' && f.size > 0 ? f : null;
}

export async function recordWithDocument(
  form: FormData,
  deps: RecordWithDocumentDeps,
): Promise<ActionResult> {
  const file = chosenFile(form);
  form.delete('document');
  form.delete('documentKey');
  if (file) {
    const g = await deps.grant(deps.partyId, { name: file.name, size: file.size });
    if (!g.ok || !g.data) return g.ok ? actionResult(false, 'no upload grant') : g;
    let res: Response;
    try {
      res = await deps.fetch(g.data.url, {
        method: 'PUT',
        headers: g.data.headers,
        body: file,
        credentials: 'same-origin',
      });
    } catch {
      return actionResult(false, 'the document upload failed: check the connection and try again');
    }
    if (!res.ok) {
      return actionResult(
        false,
        res.status === 413
          ? 'the document is too large'
          : `the document upload failed (HTTP ${res.status}): try again`,
      );
    }
    form.set('documentKey', g.data.key);
  }
  return deps.record(null, form);
}
