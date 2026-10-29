'use server';
/**
 * Server actions behind the field panel's History tab (src/ui/fields/tabs/history.tsx): the
 * full crop history (with the seasons of the fields it was split from or merged out of) and
 * edits of one season. Reading needs a viewer session (field data is private); editing needs
 * ROLE_FOR.editFieldData (manager). Seasons typed here get source 'app'.
 */
import { getPool } from '@/db/client';
import { FieldDataError } from '@/db/queries/boundaries-sql';
import { deleteSeason, type FieldHistory, fieldHistory, saveSeason } from '@/db/queries/seasons';
import { isUuid } from '@/domain/ids';
import { ROLE_FOR } from '@/platform/auth/types';
import { localParts } from '@/sim/time';
import { validateSeason } from '../../../../../tools/import/seasons-csv';
import { actorOf, type DataResult, runAction } from './access';

/** The form's raw values (the same names as the CSV columns). */
export interface SeasonFormValues {
  crop_year: string;
  crop: string;
  variety: string;
  planted_on: string;
  harvested_on: string;
  yield_bu_ac: string;
}

function fieldIdOf(id: unknown): string {
  if (!isUuid(id)) throw new FieldDataError('unknown field', 'not_found');
  return id;
}

export async function loadFieldHistoryAction(fieldId: string): Promise<DataResult<FieldHistory>> {
  return runAction<FieldHistory>(ROLE_FOR.viewPrivate, async () => {
    const h = await fieldHistory(getPool(), fieldIdOf(fieldId));
    if (!h) throw new FieldDataError('field not found', 'not_found');
    return { message: 'ok', data: h };
  });
}

export async function saveSeasonAction(args: {
  fieldId: string;
  originalCropYear: number | null;
  values: SeasonFormValues;
}): Promise<DataResult<{ action: string }>> {
  return runAction(ROLE_FOR.editFieldData, async (session) => {
    const v = validateSeason(args.values ?? {}, localParts(Date.now()).y);
    if (!v.ok) throw new FieldDataError(v.errors.join('; '));
    const original =
      args.originalCropYear === null || args.originalCropYear === undefined
        ? null
        : Number(args.originalCropYear);
    if (original !== null && !Number.isInteger(original))
      throw new FieldDataError('unknown season');
    const r = await saveSeason(getPool(), {
      fieldId: fieldIdOf(args.fieldId),
      season: v.value,
      originalCropYear: original,
      actor: actorOf(session),
    });
    const note = v.warnings.length ? ` (note: ${v.warnings.join('; ')})` : '';
    return {
      message:
        r.action === 'unchanged'
          ? `${v.value.cropYear}: nothing changed`
          : `${v.value.cropYear} saved${note}`,
      data: { action: r.action },
    };
  });
}

export async function deleteSeasonAction(args: {
  fieldId: string;
  cropYear: number;
}): Promise<DataResult<undefined>> {
  return runAction(ROLE_FOR.editFieldData, async (session) => {
    const year = Number(args.cropYear);
    if (!Number.isInteger(year)) throw new FieldDataError('unknown season');
    await deleteSeason(getPool(), {
      fieldId: fieldIdOf(args.fieldId),
      cropYear: year,
      actor: actorOf(session),
    });
    return { message: `${year} removed` };
  });
}
