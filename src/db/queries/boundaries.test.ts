import { describe, expect, test } from 'vitest';
import { decideMatch, importMayUpdate, type MatchCandidate } from './boundaries';

const opts = { minNameOverlap: 0.5, minShapeOverlap: 0.8 };

const cand = (over: Partial<MatchCandidate>): MatchCandidate => ({
  fieldId: 'f',
  name: 'North 80',
  farmId: 'farm',
  farmName: 'Home',
  deereFieldId: null,
  active: true,
  boundaryId: 'b',
  boundarySource: 'import',
  acres: 80,
  overlap: 0,
  idMatch: false,
  nameMatch: false,
  farmMatch: true,
  ...over,
});

describe('decideMatch', () => {
  test('the Deere id wins over names and shapes', () => {
    const d = decideMatch(
      { name: 'X', deereFieldId: 'jd' },
      [
        cand({ fieldId: 'a', nameMatch: true, overlap: 1 }),
        cand({ fieldId: 'b', idMatch: true, deereFieldId: 'jd', overlap: 0.1, name: 'Other' }),
      ],
      opts,
    );
    expect(d).toMatchObject({ kind: 'match', by: 'deere_id', candidate: { fieldId: 'b' } });
    if (d.kind !== 'match') throw new Error();
    expect(d.warnings).toEqual(["overlaps 'North 80' (Home) by 100%"]);
  });

  test('two fields with one Deere id is a skip', () => {
    const d = decideMatch(
      { name: 'X', deereFieldId: 'jd' },
      [cand({ fieldId: 'a', idMatch: true }), cand({ fieldId: 'b', idMatch: true })],
      opts,
    );
    expect(d).toMatchObject({ kind: 'skip', reason: '2 fields share Deere id jd' });
  });

  test('same name: the best overlapping one, or the only one without a boundary', () => {
    expect(
      decideMatch(
        { name: 'North 80', deereFieldId: null },
        [
          cand({ fieldId: 'a', nameMatch: true, overlap: 0.6 }),
          cand({ fieldId: 'b', nameMatch: true, overlap: 0.9 }),
        ],
        opts,
      ),
    ).toMatchObject({ kind: 'match', by: 'name', candidate: { fieldId: 'b' } });
    expect(
      decideMatch(
        { name: 'North 80', deereFieldId: null },
        [cand({ fieldId: 'a', nameMatch: true, overlap: null, boundaryId: null })],
        opts,
      ),
    ).toMatchObject({ kind: 'match', by: 'name', candidate: { fieldId: 'a' } });
  });

  test('same name far away, or in another farm', () => {
    const far = decideMatch(
      { name: 'North 80', deereFieldId: null },
      [cand({ nameMatch: true, overlap: 0.1 })],
      opts,
    );
    expect(far).toMatchObject({ kind: 'skip' });
    if (far.kind !== 'skip') throw new Error();
    expect(far.reason).toMatch(/overlaps this one by only 10%/);
    // A same-name field in another farm is not a candidate: a new field in the file's farm.
    expect(
      decideMatch(
        { name: 'North 80', deereFieldId: null },
        [cand({ nameMatch: true, farmMatch: false, overlap: 0 })],
        opts,
      ),
    ).toMatchObject({ kind: 'create' });
  });

  test('a renamed field is found by its shape; a field with another Deere id never is', () => {
    expect(
      decideMatch({ name: 'New name', deereFieldId: null }, [cand({ overlap: 0.85 })], opts),
    ).toMatchObject({ kind: 'match', by: 'shape' });
    expect(
      decideMatch(
        { name: 'North 80', deereFieldId: 'jd-new' },
        [cand({ nameMatch: true, overlap: 1, deereFieldId: 'jd-old' })],
        opts,
      ),
    ).toMatchObject({ kind: 'create' });
    expect(
      decideMatch(
        { name: 'X', deereFieldId: null },
        [cand({ overlap: 0.85, active: false })],
        opts,
      ),
    ).toMatchObject({ kind: 'create' });
  });
});

describe('importMayUpdate (D6)', () => {
  test('Deere-synced and demo boundaries are read-only; imported and drawn ones are not', () => {
    expect(importMayUpdate({ deereFieldId: null, boundarySource: 'demo' }).ok).toBe(true);
    expect(importMayUpdate({ deereFieldId: 'jd', boundarySource: null }).ok).toBe(true);
    expect(importMayUpdate({ deereFieldId: 'jd', boundarySource: 'import' }).ok).toBe(true);
    expect(importMayUpdate({ deereFieldId: 'jd', boundarySource: 'deere' })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/Operations Center/),
    });
    expect(importMayUpdate({ deereFieldId: 'jd', boundarySource: 'demo' }).ok).toBe(false);
  });
});
