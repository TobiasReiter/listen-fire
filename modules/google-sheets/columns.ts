// A bare sheet tab's column vocabulary — the ONE definition the describe and
// the write both resolve through.
//
// A tab addresses its columns two ways at once, and both are real:
//   - by LETTER (`A`, `B`, … `AA`), which every grid column always has;
//   - by HEADER NAME, when row 1 carries one.
//
// The union is the writable surface. Offering only headers made a sheet with a
// blank row 1 unwritable — which is every brand-new spreadsheet, so the first
// thing anyone tries to append to was a dead end, and the checker reported it
// as "read-only" (a promise the adapter had actually made). Letters are always
// available; headers ride alongside them when they exist.
//
// Both vocabularies land on the same cell. `resolveColumnIndex` is what keeps
// them from disagreeing: one function, so a name and a letter cannot resolve
// differently in describe than they do in the append.

/** Google Sheets' default grid width for a new sheet. Used when the sheet's
 *  metadata doesn't report `gridProperties.columnCount`. */
export const DEFAULT_COLUMN_COUNT = 26;

/** 0 → `A`, 25 → `Z`, 26 → `AA`. */
export function columnLetter(index: number): string {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/**
 * `A` → 0, `AA` → 26. A pure base-26 parse of an alphabetic word.
 *
 * It cannot tell a column letter from a header word — `AB` is legitimately
 * both, so no shape check could. What makes an index VALID is the grid bound,
 * which `resolveColumnIndex` applies (after matching headers first). Undefined
 * here only means "not shaped like letters at all" (`A1`, `1`, `A B`).
 */
export function columnIndexOfLetter(name: string): number | undefined {
  const t = name.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(t)) return undefined;
  let n = 0;
  for (const ch of t) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** One tab's column layout, as read from the sheet. `headers` is POSITIONAL —
 *  index i is column i, `''` where that column has no header. */
export interface SheetLayout {
  headers: string[];
  columnCount: number;
}

/**
 * Every name a write to this tab may use: each column's letter, plus the
 * non-blank header names.
 *
 * A header whose text IS a column letter shadows that letter rather than
 * appearing twice — two writable fields sharing one name could not be told
 * apart, and the header is the more deliberate of the two. (A sheet with a
 * column literally headed "A" is rare; a surface with two fields called "A"
 * is incoherent.)
 */
export function writableColumnNames(layout: SheetLayout): string[] {
  const headers = layout.headers.map((h) => h.trim()).filter((h) => h.length > 0);
  const taken = new Set(headers.map((h) => h.toUpperCase()));
  const letters: string[] = [];
  for (let i = 0; i < layout.columnCount; i++) {
    const letter = columnLetter(i);
    if (!taken.has(letter)) letters.push(letter);
  }
  return [...letters, ...headers];
}

/**
 * Which column a written field name addresses — a header name at its own
 * position, or a column letter. Undefined means the name belongs to neither
 * vocabulary, which is drift rather than a column.
 *
 * Header names are matched FIRST and case-sensitively at their real position,
 * so a header called "A" sitting in column C writes to C, mirroring
 * `writableColumnNames`' shadowing rule.
 */
export function resolveColumnIndex(layout: SheetLayout, name: string): number | undefined {
  const headerIndex = layout.headers.findIndex((h) => h.trim() === name.trim());
  if (headerIndex >= 0) return headerIndex;
  const letterIndex = columnIndexOfLetter(name);
  if (letterIndex !== undefined && letterIndex < layout.columnCount) return letterIndex;
  return undefined;
}
