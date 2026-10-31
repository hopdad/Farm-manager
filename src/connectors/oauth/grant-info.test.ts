/** Which required scopes a stored grant lacks (the /admin/connectors scope warning). */
import { expect, test } from 'vitest';
import { DEERE_SCOPES } from '../deere/schemas';
import { missingScopes } from './grant-info';

test('missingScopes: a pre-Oct-31 grant lacks ag2; an unreported scope list lacks nothing', () => {
  expect(missingScopes(['offline_access', 'ag1', 'eq1', 'org1'], DEERE_SCOPES)).toEqual(['ag2']);
  expect(missingScopes(['offline_access', 'ag1', 'ag2', 'eq1'], DEERE_SCOPES)).toEqual([]);
  expect(missingScopes([], DEERE_SCOPES)).toEqual([]);
});
