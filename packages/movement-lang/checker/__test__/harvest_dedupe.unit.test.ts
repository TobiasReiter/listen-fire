const { beats } = jest.requireActual<{ beats: (a: object, b: object) => boolean }>('../harvest/dedupe.cjs');

describe('harvest dedupe', () => {
  const plain = { source: 'x', diagnostics: [] };
  const noteA = { source: 'x', diagnostics: [], note: 'a', file: 'f' };
  const noteB = { source: 'x', diagnostics: [], note: 'b', file: 'f' };

  it('a noted record beats an unnoted one, in either order', () => {
    expect(beats(noteA, plain)).toBe(true);
    expect(beats(plain, noteA)).toBe(false);
  });

  it('between two noted records the lowest canonical JSON wins, in either order', () => {
    expect(beats(noteA, noteB)).toBe(true);
    expect(beats(noteB, noteA)).toBe(false);
  });

  it('is independent of key order', () => {
    expect(beats({ b: 1, a: 2 }, { a: 2, b: 1 })).toBe(false);
  });
});
