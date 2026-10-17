// Google Sheets cell-value construction — a pure helper (no API/auth deps) so
// it's unit-testable in isolation. Builds a `userEnteredValue` that keeps a
// value TYPED to its column rather than stringifying everything (the old path
// turned a date into "Thu Jun 18 2026…").

/** Google Sheets serial-date epoch (1899-12-30); a date is `days since` it. */
const SHEETS_EPOCH_MS = Date.UTC(1899, 11, 30);

function coerceBooleanCell(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === '') return false;
  return null;
}

/**
 * Build a Sheets `userEnteredValue` cell typed to the column. Dates become a
 * serial number (the column's own DATE format then renders it as a date — and
 * it stays sortable / formula-able); numeric and boolean columns get the native
 * cell type; everything else is a string. An unparseable value for a typed
 * column falls back to a string so a write never fails on a stray value.
 */
export function sheetCellValue(
  value: unknown,
  columnType?: string,
): { stringValue?: string; numberValue?: number; boolValue?: boolean } {
  switch (columnType) {
    case 'DATE':
    case 'TIME':
    case 'DATE_TIME': {
      const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
      if (Number.isFinite(ms)) return { numberValue: (ms - SHEETS_EPOCH_MS) / 86_400_000 };
      return { stringValue: String(value) };
    }
    case 'DOUBLE':
    case 'PERCENT':
    case 'CURRENCY': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? { numberValue: n } : { stringValue: String(value) };
    }
    case 'BOOLEAN': {
      const b = coerceBooleanCell(value);
      return b === null ? { stringValue: String(value) } : { boolValue: b };
    }
    default:
      // TEXT / unknown — honor a native JS primitive, else stringify.
      if (typeof value === 'number') return { numberValue: value };
      if (typeof value === 'boolean') return { boolValue: value };
      return { stringValue: String(value) };
  }
}

/** Parse an A1 cell reference — "B2" or "Dashboard!B2" (quoted sheet names
 *  accepted: 'My Tab'!C3) — into 0-based grid coords + the optional sheet
 *  title. Returns null on anything that isn't a SINGLE cell. */
export function parseA1Cell(
  ref: string,
): { sheetTitle?: string; rowIndex: number; columnIndex: number } | null {
  const trimmed = ref.trim();
  const bang = trimmed.lastIndexOf('!');
  const sheetPart = bang >= 0 ? trimmed.slice(0, bang) : undefined;
  const cellPart = bang >= 0 ? trimmed.slice(bang + 1) : trimmed;
  const m = /^([A-Za-z]{1,3})([1-9][0-9]*)$/.exec(cellPart);
  if (!m) return null;
  const letters = m[1].toUpperCase();
  let col = 0;
  for (const ch of letters) col = col * 26 + (ch.charCodeAt(0) - 64);
  const sheetTitle = sheetPart?.replace(/^'(.*)'$/, '$1');
  return {
    ...(sheetTitle !== undefined && sheetTitle !== '' ? { sheetTitle } : {}),
    rowIndex: Number(m[2]) - 1,
    columnIndex: col - 1,
  };
}
