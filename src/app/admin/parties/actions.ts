'use server';
/**
 * Server actions behind /admin/parties (plan 1c "landlords, customers and crew through admin
 * forms and CSV import"): add, edit and delete parties, link a field's landlord and a farm's
 * customer, and the contacts CSV (preview, then apply). Every one checks the session first
 * (ROLE_FOR.editFieldData = manager).
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getPool } from '@/db/client';
import { FieldDataError } from '@/db/queries/boundaries-sql';
import {
  createParty,
  deleteParty,
  importParties,
  type PartyInput,
  setFarmClient,
  setFieldLandlord,
  updateParty,
  validateParty,
} from '@/db/queries/parties';
import { isUuid } from '@/domain/ids';
import { ROLE_FOR } from '@/platform/auth/types';
import { CsvError } from '../../../../tools/import/csv';
import { parsePartiesCsv } from '../../../../tools/import/parties-csv';
import type { ActionResult } from '../action-result';
import { actorOf, type DataResult, formText, runAction } from '../fields/_lib/access';
import { type ImportView, partyView, problemView } from '../fields/_lib/import-view';

const EDIT = ROLE_FOR.editFieldData;
const PATH = '/admin/parties';

const idOf = (v: string, what: string): string => {
  if (!isUuid(v)) throw new FieldDataError(`unknown ${what}`);
  return v;
};

function partyFrom(form: FormData): PartyInput {
  const org = formText(form, 'orgId');
  const v = validateParty({
    displayName: formText(form, 'displayName'),
    kind: formText(form, 'kind'),
    roles: form.getAll('roles').filter((r): r is string => typeof r === 'string'),
    phone: formText(form, 'phone'),
    email: formText(form, 'email'),
    address: formText(form, 'address'),
    notes: formText(form, 'notes'),
    orgId: org ? idOf(org, 'organization') : null,
  });
  if (!v.ok) throw new FieldDataError(v.errors.join('; '));
  return v.value;
}

export async function createPartyAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  return runAction(EDIT, async (session) => {
    const input = partyFrom(form);
    await createParty(getPool(), input, actorOf(session));
    revalidatePath(PATH);
    return { message: `Added ${input.displayName}` };
  });
}

export async function updatePartyAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  return runAction(EDIT, async (session) => {
    const id = idOf(formText(form, 'id'), 'party');
    const input = partyFrom(form);
    await updateParty(getPool(), {
      id,
      input,
      version: formText(form, 'version') || null,
      actor: actorOf(session),
    });
    revalidatePath(`${PATH}/${id}`);
    return { message: `Saved ${input.displayName}` };
  });
}

export async function deletePartyAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const r = await runAction(EDIT, async (session) => {
    await deleteParty(getPool(), idOf(formText(form, 'id'), 'party'), actorOf(session));
    revalidatePath(PATH);
    return { message: 'Deleted' };
  });
  // Outside runAction: redirect() works by throwing.
  if (r.ok) redirect(PATH);
  return r;
}

export async function setLandlordAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  return runAction(EDIT, async (session) => {
    const partyId = formText(form, 'partyId');
    const fieldId = idOf(formText(form, 'fieldId'), 'field');
    const clear = formText(form, 'clear') === 'true';
    await setFieldLandlord(getPool(), {
      fieldId,
      partyId: clear ? null : idOf(partyId, 'party'),
      actor: actorOf(session),
    });
    if (partyId && isUuid(partyId)) revalidatePath(`${PATH}/${partyId}`);
    return { message: clear ? 'Landlord removed from the field' : 'Landlord set' };
  });
}

export async function setClientAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  return runAction(EDIT, async (session) => {
    const partyId = formText(form, 'partyId');
    const farmId = idOf(formText(form, 'farmId'), 'farm');
    const clear = formText(form, 'clear') === 'true';
    await setFarmClient(getPool(), {
      farmId,
      partyId: clear ? null : idOf(partyId, 'party'),
      actor: actorOf(session),
    });
    if (partyId && isUuid(partyId)) revalidatePath(`${PATH}/${partyId}`);
    return {
      message: clear
        ? 'The farm is your own operation again'
        : "Linked: the farm's fields are this customer's custom work",
    };
  });
}

async function partyImport(form: FormData, dryRun: boolean): Promise<DataResult<ImportView>> {
  return runAction<ImportView>(EDIT, async () => {
    const file = form.getAll('files').find((f): f is File => typeof f !== 'string' && f.size > 0);
    if (!file) throw new FieldDataError('choose a .csv file');
    let parsed: ReturnType<typeof parsePartiesCsv>;
    try {
      parsed = parsePartiesCsv(new TextDecoder().decode(await file.arrayBuffer()));
    } catch (e) {
      if (e instanceof CsvError)
        return { ok: false, message: e.message, data: problemView(e.message, []) };
      throw e;
    }
    const notes = parsed.warnings.map((w) => `line ${w.line}: ${w.message}`);
    if (parsed.errors.length) {
      const summary = `${parsed.errors.length} problem(s); nothing was written`;
      return {
        ok: false,
        message: summary,
        data: problemView(summary, [
          ...parsed.errors.map((e) => `line ${e.line}: ${e.message}`),
          ...notes,
        ]),
      };
    }
    const report = await importParties(getPool(), parsed.rows, { dryRun });
    const view = partyView(report);
    view.problems.push(...notes);
    if (!dryRun) revalidatePath(PATH);
    return { ok: report.counts.error === 0, message: view.summary, data: view };
  });
}

export async function previewPartyImportAction(form: FormData): Promise<DataResult<ImportView>> {
  return partyImport(form, true);
}

export async function applyPartyImportAction(form: FormData): Promise<DataResult<ImportView>> {
  return partyImport(form, false);
}
