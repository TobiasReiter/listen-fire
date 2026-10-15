// An empty identity key is no key — since language version 2. A run pinned to
// version 1 ("Quiet Heron") matches "" like any other value, as v0.6.0 did.
// The pin is the caller's to pass: the engine passes its run's, and the
// knowledge pipeline's own matcher (no run) passes the current version.

import { CURRENT_LANGUAGE_VERSION } from 'movement-lang';

import { candidateIsAllExact, isBlankIdentityValue, type UniquenessConstraints } from 'movement-engine/services/translation_graph/uniqueness';

const byName: UniquenessConstraints = { any: [{ all: [{ field: 'name' }] }] };

const exact = (languageVersion: number, asserted: string, candidate: string) =>
  candidateIsAllExact(byName, { asserted: { name: asserted }, candidate: { name: candidate }, languageVersion });

describe('a blank identity key', () => {
  it('is no key in a version-2 run: it never matches, not even another blank', () => {
    expect(isBlankIdentityValue('', 2)).toBe(true);
    expect(isBlankIdentityValue('  ', 2)).toBe(true);
    expect(exact(2, '', '')).toBe(false);
  });

  it('is a value like any other in a version-1 run: "" matches ""', () => {
    expect(isBlankIdentityValue('', 1)).toBe(false);
    expect(isBlankIdentityValue(null, 1)).toBe(true);
    expect(exact(1, '', '')).toBe(true);
    expect(exact(1, 'Acme', '')).toBe(false);
  });

  it('under the current version (outside a run), is no key', () => {
    expect(isBlankIdentityValue('', CURRENT_LANGUAGE_VERSION)).toBe(true);
  });
});
