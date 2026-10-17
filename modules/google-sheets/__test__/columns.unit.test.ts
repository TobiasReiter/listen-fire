// A bare tab's column vocabulary — letters always, headers when row 1 has them.
//
// Offering only headers made a sheet with a blank row 1 unwritable, which is
// every brand-new spreadsheet: the first thing anyone tries to append to was a
// dead end, reported as "read-only" because the write shape came out empty and
// the meta edge lost its writable promise on the way through the projection.

import {
  columnIndexOfLetter,
  columnLetter,
  resolveColumnIndex,
  writableColumnNames,
} from '../columns';

describe('columnLetter / columnIndexOfLetter', () => {
  it('is ZERO-based, matching the API\'s own grid indices', () => {
    // The base matters more than it looks: this replaced a 1-based helper of
    // the same name, and the two disagree by exactly one column — which in an
    // A1 range is a silently wrong read, not an error.
    expect(columnLetter(0)).toBe('A');
    expect(columnLetter(25)).toBe('Z');
    expect(columnLetter(26)).toBe('AA');
    expect(columnLetter(51)).toBe('AZ');
    expect(columnLetter(52)).toBe('BA');
  });

  it('round-trips', () => {
    for (const i of [0, 1, 25, 26, 27, 51, 52, 700]) {
      expect(columnIndexOfLetter(columnLetter(i))).toBe(i);
    }
  });

  it('rejects anything that is not SHAPED like a column letter', () => {
    for (const bad of ['', ' ', 'A1', '1', 'A B']) {
      expect(columnIndexOfLetter(bad)).toBeUndefined();
    }
  });

  it('parses any alphabetic word — the GRID BOUND is what makes it valid', () => {
    // 'Name' uppercases to all A–Z, so base-26 happily reads it. There is no
    // shape that separates a column letter from an alphabetic header word:
    // 'AB' is both. So this stays a pure parse, and `resolveColumnIndex`
    // rejects it by bound (and matches headers first).
    expect(columnIndexOfLetter('Name')).toBe(247082);
    expect(resolveColumnIndex({ headers: [], columnCount: 26 }, 'Name')).toBeUndefined();
  });
});

describe('writableColumnNames', () => {
  it('offers every column by letter when row 1 is blank', () => {
    const names = writableColumnNames({ headers: [], columnCount: 26 });
    expect(names).toHaveLength(26);
    expect(names[0]).toBe('A');
    expect(names[25]).toBe('Z');
  });

  it('offers letters AND headers together — the union, not one or the other', () => {
    const names = writableColumnNames({ headers: ['Name', 'Email'], columnCount: 3 });
    expect(names).toEqual(['A', 'B', 'C', 'Name', 'Email']);
  });

  it('drops blank header cells but keeps their columns addressable by letter', () => {
    const names = writableColumnNames({ headers: ['Name', '', 'Stage'], columnCount: 3 });
    expect(names).toEqual(['A', 'B', 'C', 'Name', 'Stage']);
  });

  it('a header whose text IS a letter shadows that letter, never duplicating a name', () => {
    // Two writable fields called "A" could not be told apart at the write.
    const names = writableColumnNames({ headers: ['A', 'Stage'], columnCount: 3 });
    expect(names.filter((n) => n === 'A')).toHaveLength(1);
    expect(names).toEqual(['B', 'C', 'A', 'Stage']);
  });
});

describe('resolveColumnIndex', () => {
  const layout = { headers: ['Name', '', 'Stage'], columnCount: 5 };

  it('places a header at ITS OWN position, not at its rank among headers', () => {
    // `Stage` is the second non-blank header but the THIRD column. A compacted
    // header list would have written it to B.
    expect(resolveColumnIndex(layout, 'Name')).toBe(0);
    expect(resolveColumnIndex(layout, 'Stage')).toBe(2);
  });

  it('places a column letter at its own column', () => {
    expect(resolveColumnIndex(layout, 'A')).toBe(0);
    expect(resolveColumnIndex(layout, 'E')).toBe(4);
  });

  it('a header named like a letter wins over the letter, at its real column', () => {
    expect(resolveColumnIndex({ headers: ['x', 'A'], columnCount: 5 }, 'A')).toBe(1);
  });

  it('is undefined past the grid, and for a name in neither vocabulary', () => {
    expect(resolveColumnIndex(layout, 'F')).toBeUndefined();
    expect(resolveColumnIndex(layout, 'Nope')).toBeUndefined();
  });
});
