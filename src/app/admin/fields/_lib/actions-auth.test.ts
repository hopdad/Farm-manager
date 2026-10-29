/**
 * Every field-data server action checks the session on the server before it reads its input
 * or touches the database (contracts-m1 §2): a signed-out request gets "Sign in first", a role
 * below the action's minimum is refused. Refusals happen before any database access, so this
 * runs without one.
 */
import { describe, expect, test } from 'vitest';
import { makeSession, runWithSession } from '@/platform/auth/testing';
import type { Role } from '@/platform/auth/types';
import * as parties from '../../parties/actions';
import * as fields from '../actions';
import * as history from './history-actions';

const ID = '4b7f1c52-8e0a-5d3b-9a61-2f0c8d4e7a19';
const form = () => {
  const f = new FormData();
  f.set('fieldId', ID);
  f.set('id', ID);
  f.set('displayName', 'X');
  return f;
};

/** Each action with arguments that would be valid enough to reach the database. */
const EDITS: [string, () => Promise<{ ok: boolean; message: string }>][] = [
  ['previewBoundaryImport', () => fields.previewBoundaryImportAction(form())],
  ['applyBoundaryImport', () => fields.applyBoundaryImportAction(form())],
  ['previewSeasonImport', () => fields.previewSeasonImportAction(form())],
  ['applySeasonImport', () => fields.applySeasonImportAction(form())],
  ['saveIdentity', () => fields.saveIdentityAction(null, form())],
  ['setDemoVisible', () => fields.setDemoVisibleAction(null, form())],
  ['requestChange', () => fields.requestChangeAction(null, form())],
  ['resolveRequest', () => fields.resolveRequestAction(null, form())],
  [
    'saveBoundary',
    () =>
      fields.saveBoundaryAction({
        fieldId: ID,
        geometry: { type: 'MultiPolygon', coordinates: [] },
        expectedBoundaryId: null,
      }),
  ],
  [
    'createField',
    () =>
      fields.createFieldAction({
        geometry: { type: 'MultiPolygon', coordinates: [] },
        name: 'x',
        farmId: null,
        newFarmName: 'x',
        tenure: 'owned',
        landlordPartyId: null,
        countyFips: null,
      }),
  ],
  [
    'previewSplit',
    () => fields.previewSplitAction({ fieldId: ID, line: { type: 'LineString', coordinates: [] } }),
  ],
  [
    'split',
    () =>
      fields.splitAction({
        fieldId: ID,
        line: { type: 'LineString', coordinates: [] },
        names: [],
        effectiveOn: '2026-01-01',
      }),
  ],
  ['previewMerge', () => fields.previewMergeAction({ fieldId: ID, otherId: ID })],
  [
    'merge',
    () => fields.mergeAction({ fieldId: ID, otherId: ID, name: 'x', effectiveOn: '2026-01-01' }),
  ],
  ['createParty', () => parties.createPartyAction(null, form())],
  ['updateParty', () => parties.updatePartyAction(null, form())],
  ['deleteParty', () => parties.deletePartyAction(null, form())],
  ['setLandlord', () => parties.setLandlordAction(null, form())],
  ['setClient', () => parties.setClientAction(null, form())],
  ['previewPartyImport', () => parties.previewPartyImportAction(form())],
  ['applyPartyImport', () => parties.applyPartyImportAction(form())],
  [
    'saveSeason',
    () =>
      history.saveSeasonAction({
        fieldId: ID,
        originalCropYear: null,
        values: {
          crop_year: '2025',
          crop: '',
          variety: '',
          planted_on: '',
          harvested_on: '',
          yield_bu_ac: '',
        },
      }),
  ],
  ['deleteSeason', () => history.deleteSeasonAction({ fieldId: ID, cropYear: 2025 })],
];

describe('field-data actions refuse on the server', () => {
  test.each(EDITS)('%s: signed out and below manager are refused', async (_name, call) => {
    const out = await runWithSession(null, call);
    expect(out).toMatchObject({ ok: false, message: 'Sign in first.' });
    for (const role of ['viewer', 'driver', 'operator'] as Role[]) {
      const r = await runWithSession(makeSession({ role }), call);
      expect(r.ok, role).toBe(false);
      expect(r.message).toBe('This needs the manager role (or above).');
    }
  });

  test('reading a field history needs a session (any role)', async () => {
    const r = await runWithSession(null, () => history.loadFieldHistoryAction(ID));
    expect(r).toMatchObject({ ok: false, message: 'Sign in first.' });
  });
});
