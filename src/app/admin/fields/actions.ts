'use server';
/**
 * Server actions behind /admin/fields (plan 1c): boundary and crop-history imports (preview,
 * then apply), the identity form, drawing and editing boundaries (D6: a Deere field's edit
 * becomes a "change this in Ops Center" request), splits and merges, and the demo switch.
 *
 * Every action checks the session on the server first (`runAction`, ROLE_FOR.editFieldData =
 * manager): the browser's word counts for nothing (contracts-m1 §2). Uploads arrive as
 * FormData (Next caps an action's body at 1 MB; bigger files go through the CLIs).
 */
import type { LineString, MultiPolygon } from 'geojson';
import { revalidatePath } from 'next/cache';
import { getPool } from '@/db/client';
import {
  importBoundaries,
  requestBoundaryChange,
  resolveChangeRequest,
  saveDrawnBoundary,
} from '@/db/queries/boundaries';
import {
  createDrawnField,
  type FieldIdentityInput,
  setDemoFieldsVisible,
  updateFieldIdentity,
} from '@/db/queries/boundaries-fields';
import { FieldDataError } from '@/db/queries/boundaries-sql';
import {
  mergeFields,
  type Piece,
  previewMerge,
  previewSplit,
  splitField,
} from '@/db/queries/lineage';
import { importSeasons } from '@/db/queries/seasons';
import { TENURES, type Tenure } from '@/domain/farm';
import { isUuid } from '@/domain/ids';
import { ROLE_FOR } from '@/platform/auth/types';
import { localParts } from '@/sim/time';
import {
  type AttributeOptions,
  BoundaryFileError,
  type InputFile,
  parseBoundaryFiles,
} from '../../../../tools/import/boundary-file';
import { CsvError } from '../../../../tools/import/csv';
import { detroitMidnight, parseDate } from '../../../../tools/import/dates';
import { parseSeasonsCsv } from '../../../../tools/import/seasons-csv';
import type { ActionResult } from '../action-result';
import { actorOf, type DataResult, formText, runAction } from './_lib/access';
import { boundaryView, type ImportView, problemView, seasonView } from './_lib/import-view';

const EDIT = ROLE_FOR.editFieldData;
const PATH = '/admin/fields';

async function filesOf(form: FormData): Promise<InputFile[]> {
  const out: InputFile[] = [];
  for (const v of form.getAll('files')) {
    if (typeof v === 'string' || v.size === 0) continue;
    out.push({ name: v.name, bytes: new Uint8Array(await v.arrayBuffer()) });
  }
  return out;
}

function checkId(id: unknown, what = 'field'): string {
  if (!isUuid(id)) throw new FieldDataError(`unknown ${what}`);
  return id;
}

// ---------------------------------------------------------------------------------------------
// Boundary import
// ---------------------------------------------------------------------------------------------

async function boundaryImport(form: FormData, dryRun: boolean): Promise<DataResult<ImportView>> {
  return runAction<ImportView>(EDIT, async () => {
    const files = await filesOf(form);
    if (!files.length)
      throw new FieldDataError('choose a .zip, a .shp with its .dbf/.prj, or a .geojson file');
    const attributes: AttributeOptions = {
      nameAttr: formText(form, 'nameAttr').trim() || undefined,
    };
    let parsed: Awaited<ReturnType<typeof parseBoundaryFiles>>;
    try {
      parsed = await parseBoundaryFiles(files, attributes);
    } catch (e) {
      if (e instanceof BoundaryFileError)
        return { ok: false, message: e.message, data: problemView(e.message, []) };
      throw e;
    }
    if (parsed.errors.length || !parsed.boundaries.length) {
      const summary = parsed.errors.length
        ? `${parsed.errors.length} problem(s) in the file; nothing was written`
        : 'the file holds no field boundaries';
      return {
        ok: false,
        message: summary,
        data: problemView(summary, [
          ...parsed.errors,
          ...(parsed.attributes.length
            ? [`Columns in the file: ${parsed.attributes.join(', ')}`]
            : []),
        ]),
      };
    }
    const effective = formText(form, 'effective').trim();
    let effectiveAt: Date | null = null;
    if (effective) {
      const d = parseDate(effective);
      if (!d.ok) throw new FieldDataError(`effective date: ${d.error}`);
      effectiveAt = detroitMidnight(d.value);
      if (effectiveAt.getTime() > Date.now())
        throw new FieldDataError('the effective date is in the future');
    }
    const farm = formText(form, 'farm').trim() || null;
    const report = await importBoundaries(getPool(), parsed.boundaries, {
      dryRun,
      effectiveAt,
      farm,
      hideDemo: formText(form, 'hideDemo') === 'on',
    });
    const view = boundaryView(report);
    view.problems.unshift(...parsed.warnings);
    if (!dryRun) revalidatePath(PATH);
    return { message: view.summary, data: view };
  });
}

export async function previewBoundaryImportAction(form: FormData): Promise<DataResult<ImportView>> {
  return boundaryImport(form, true);
}

export async function applyBoundaryImportAction(form: FormData): Promise<DataResult<ImportView>> {
  return boundaryImport(form, false);
}

// ---------------------------------------------------------------------------------------------
// Seasons import
// ---------------------------------------------------------------------------------------------

async function seasonImport(form: FormData, dryRun: boolean): Promise<DataResult<ImportView>> {
  return runAction<ImportView>(EDIT, async () => {
    const files = await filesOf(form);
    const file = files[0];
    if (!file) throw new FieldDataError('choose a .csv file');
    let parsed: ReturnType<typeof parseSeasonsCsv>;
    try {
      parsed = parseSeasonsCsv(new TextDecoder().decode(file.bytes), localParts(Date.now()).y);
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
    const report = await importSeasons(getPool(), parsed.rows, {
      dryRun,
      replaceDeere: formText(form, 'replaceDeere') === 'on',
    });
    const view = seasonView(report);
    view.problems.push(...notes);
    if (!dryRun) revalidatePath(PATH);
    return { ok: report.counts.error === 0, message: view.summary, data: view };
  });
}

export async function previewSeasonImportAction(form: FormData): Promise<DataResult<ImportView>> {
  return seasonImport(form, true);
}

export async function applySeasonImportAction(form: FormData): Promise<DataResult<ImportView>> {
  return seasonImport(form, false);
}

// ---------------------------------------------------------------------------------------------
// Identity, demo switch, change requests (forms: useActionState)
// ---------------------------------------------------------------------------------------------

function identityFrom(form: FormData): FieldIdentityInput {
  const tenure = formText(form, 'tenure');
  if (!(TENURES as readonly string[]).includes(tenure)) throw new FieldDataError('pick a tenure');
  const farmId = formText(form, 'farmId');
  const landlord = formText(form, 'landlordPartyId');
  return {
    name: formText(form, 'name'),
    farmId: farmId && farmId !== 'new' ? checkId(farmId, 'farm') : null,
    newFarmName: farmId === 'new' ? formText(form, 'newFarmName') : null,
    tenure: tenure as Tenure,
    landlordPartyId: landlord ? checkId(landlord, 'landlord') : null,
    countyFips: formText(form, 'countyFips').trim() || null,
  };
}

export async function saveIdentityAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  return runAction(EDIT, async (session) => {
    const fieldId = checkId(formText(form, 'fieldId'));
    await updateFieldIdentity(getPool(), {
      fieldId,
      identity: identityFrom(form),
      active: formText(form, 'active') === 'on',
      version: formText(form, 'version') || null,
      actor: actorOf(session),
    });
    revalidatePath(`${PATH}/${fieldId}`);
    return { message: 'Field saved' };
  });
}

export async function setDemoVisibleAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  return runAction(EDIT, async () => {
    const visible = formText(form, 'visible') === 'true';
    const n = await setDemoFieldsVisible(getPool(), visible);
    revalidatePath(PATH);
    return { message: `${n} demo field(s) ${visible ? 'shown' : 'hidden'}` };
  });
}

export async function requestChangeAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  return runAction(EDIT, async (session) => {
    const fieldId = checkId(formText(form, 'fieldId'));
    await requestBoundaryChange(getPool(), {
      fieldId,
      note: formText(form, 'note'),
      actor: actorOf(session),
    });
    revalidatePath(`${PATH}/${fieldId}`);
    return { message: 'Noted: make the change in Operations Center, then mark it done here' };
  });
}

export async function resolveRequestAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  return runAction(EDIT, async (session) => {
    const fieldId = checkId(formText(form, 'fieldId'));
    await resolveChangeRequest(getPool(), {
      requestId: checkId(formText(form, 'requestId'), 'request'),
      resolution: formText(form, 'resolution'),
      actor: actorOf(session),
    });
    revalidatePath(`${PATH}/${fieldId}`);
    return { message: 'Marked done' };
  });
}

// ---------------------------------------------------------------------------------------------
// The map editor (called directly from the client component)
// ---------------------------------------------------------------------------------------------

function checkMultiPolygon(g: unknown): MultiPolygon {
  const m = g as MultiPolygon;
  if (m?.type !== 'MultiPolygon' || !Array.isArray(m.coordinates) || m.coordinates.length === 0) {
    throw new FieldDataError('draw a shape first');
  }
  const points = m.coordinates.flat(2).length;
  if (points > 20_000) throw new FieldDataError('the shape has too many points');
  return m;
}

function checkLine(g: unknown): LineString {
  const l = g as LineString;
  if (l?.type !== 'LineString' || !Array.isArray(l.coordinates)) {
    throw new FieldDataError('draw a line across the field');
  }
  return l;
}

type SavedBoundary = { kind: 'version' | 'change_request'; acres?: number; warnings?: string[] };

export async function saveBoundaryAction(args: {
  fieldId: string;
  geometry: MultiPolygon;
  expectedBoundaryId: string | null;
  note?: string;
}): Promise<
  DataResult<{ kind: 'version' | 'change_request'; acres?: number; warnings?: string[] }>
> {
  return runAction<SavedBoundary>(EDIT, async (session) => {
    const fieldId = checkId(args.fieldId);
    const r = await saveDrawnBoundary(getPool(), {
      fieldId,
      geometry: checkMultiPolygon(args.geometry),
      actor: actorOf(session),
      expectedBoundaryId: args.expectedBoundaryId
        ? checkId(args.expectedBoundaryId, 'boundary')
        : null,
      note: args.note ?? null,
    });
    revalidatePath(`${PATH}/${fieldId}`);
    if (r.kind === 'change_request') return { message: r.message, data: { kind: r.kind } };
    const delta = r.previousAcres === null ? '' : ` (was ${r.previousAcres.toFixed(1)} ac)`;
    return {
      message: `Boundary saved: ${r.acres.toFixed(1)} ac${delta}${r.warnings.length ? `. Note: ${r.warnings.join('; ')}` : ''}`,
      data: { kind: r.kind, acres: r.acres, warnings: r.warnings },
    };
  });
}

export async function createFieldAction(args: {
  geometry: MultiPolygon;
  name: string;
  farmId: string | null;
  newFarmName: string | null;
  tenure: string;
  landlordPartyId: string | null;
  countyFips: string | null;
}): Promise<DataResult<{ fieldId: string }>> {
  return runAction(EDIT, async (session) => {
    if (!(TENURES as readonly string[]).includes(args.tenure))
      throw new FieldDataError('pick a tenure');
    const r = await createDrawnField(getPool(), {
      identity: {
        name: args.name,
        farmId: args.farmId ? checkId(args.farmId, 'farm') : null,
        newFarmName: args.newFarmName,
        tenure: args.tenure as Tenure,
        landlordPartyId: args.landlordPartyId ? checkId(args.landlordPartyId, 'landlord') : null,
        countyFips: args.countyFips?.trim() || null,
      },
      geometry: checkMultiPolygon(args.geometry),
      actor: actorOf(session),
    });
    revalidatePath(PATH);
    return { message: `Field created: ${r.acres.toFixed(1)} ac`, data: { fieldId: r.fieldId } };
  });
}

export async function previewSplitAction(args: {
  fieldId: string;
  line: LineString;
}): Promise<DataResult<Piece[]>> {
  return runAction(EDIT, async () => {
    const pieces = await previewSplit(getPool(), checkId(args.fieldId), checkLine(args.line));
    return { message: `${pieces.length} pieces: name them, then split`, data: pieces };
  });
}

export async function splitAction(args: {
  fieldId: string;
  line: LineString;
  names: string[];
  effectiveOn: string;
}): Promise<DataResult<{ childIds: string[] }>> {
  return runAction(EDIT, async (session) => {
    const r = await splitField(getPool(), {
      fieldId: checkId(args.fieldId),
      line: checkLine(args.line),
      names: Array.isArray(args.names) ? args.names.map(String) : [],
      effectiveOn: String(args.effectiveOn),
      actor: actorOf(session),
    });
    revalidatePath(PATH);
    return { message: `Split into ${r.childIds.length} fields`, data: { childIds: r.childIds } };
  });
}

export async function previewMergeAction(args: {
  fieldId: string;
  otherId: string;
}): Promise<DataResult<Piece>> {
  return runAction(EDIT, async () => {
    const shape = await previewMerge(getPool(), checkId(args.fieldId), checkId(args.otherId));
    return { message: `Together: ${shape.acres.toFixed(1)} ac`, data: shape };
  });
}

export async function mergeAction(args: {
  fieldId: string;
  otherId: string;
  name: string;
  effectiveOn: string;
}): Promise<DataResult<{ childId: string }>> {
  return runAction(EDIT, async (session) => {
    const r = await mergeFields(getPool(), {
      fieldIds: [checkId(args.fieldId), checkId(args.otherId)],
      name: String(args.name),
      effectiveOn: String(args.effectiveOn),
      actor: actorOf(session),
    });
    revalidatePath(PATH);
    return { message: `Merged: ${r.acres.toFixed(1)} ac`, data: { childId: r.childId } };
  });
}
