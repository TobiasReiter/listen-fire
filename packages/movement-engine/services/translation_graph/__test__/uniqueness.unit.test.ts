// `constraintsHaveFuzzyEntry` — the predicate `arbitrateEntityCandidates`
// uses to decide whether a lone, not-provably-exact candidate is still safe
// to auto-match (every branch's search was exact) or must reach the judge
// (some branch could have matched approximately).

import { constraintsHaveFuzzyEntry, type UniquenessConstraints } from '../uniqueness';

const exactOn = (field: string): UniquenessConstraints => ({
  any: [{ all: [{ field }] }],
});

const fuzzyOn = (field: string): UniquenessConstraints => ({
  any: [{ all: [{ field, fuzzy: true }] }],
});

describe('constraintsHaveFuzzyEntry', () => {
  it('is false for no constraints at all', () => {
    expect(constraintsHaveFuzzyEntry({ any: [] })).toBe(false);
  });

  it('is false when every entry in the only branch is exact', () => {
    expect(constraintsHaveFuzzyEntry(exactOn('domain'))).toBe(false);
  });

  it('is true when the only branch has a fuzzy entry', () => {
    expect(constraintsHaveFuzzyEntry(fuzzyOn('name'))).toBe(true);
  });

  it('is true when a fuzzy entry sits alongside an exact one in the same branch', () => {
    expect(
      constraintsHaveFuzzyEntry({
        any: [{ all: [{ field: 'domain' }, { field: 'name', fuzzy: true }] }],
      }),
    ).toBe(true);
  });

  it('is true when ANY OR-ed branch has a fuzzy entry, even if another branch is all-exact', () => {
    expect(
      constraintsHaveFuzzyEntry({
        any: [{ all: [{ field: 'domain' }] }, { all: [{ field: 'name', fuzzy: true }] }],
      }),
    ).toBe(true);
  });

  it('is false for a branch with no entries at all', () => {
    expect(constraintsHaveFuzzyEntry({ any: [{ all: [] }] })).toBe(false);
  });
});
