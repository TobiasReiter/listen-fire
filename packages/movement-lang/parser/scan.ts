// The ONE definition of "what is a name" in the movement language.
//
// A NAME is the verbatim name the adapter / ontology exposes: a bare identifier
// (`companies`) when the exposed name is identifier-safe, or backtick-quoted
// (`` `Funding Round` ``) when it carries spaces or punctuation. The two are the
// SAME name token. The language service's completion cursor-context and the
// checker source their name recognition from here; the parser's own copy
// (crates/movement-parser/src/scan.rs) is held to it by scan.unit.test.ts.

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_]/;

export interface ScannedName {
  /** The name verbatim — backticks stripped from a quoted name. */
  name: string;
  /** Index just past the scanned name (the closing backtick, for a quoted name). */
  end: number;
}

/**
 * Scan a bare identifier starting at `pos`. Returns the identifier and the index
 * just past it, or `null` when `src[pos]` is not an identifier start.
 */
export function scanIdent(src: string, pos: number): ScannedName | null {
  const c = src[pos];
  if (c === undefined || !IDENT_START.test(c)) return null;
  let end = pos + 1;
  while (end < src.length && IDENT_CHAR.test(src[end])) end++;
  return { name: src.slice(pos, end), end };
}

/**
 * Scan a backtick-quoted name starting at `pos` (which must be the opening
 * backtick). A quoted name is single-line. Returns the interior (backticks
 * stripped) and the index of the CLOSING backtick — callers advance past it.
 * Returns `null` when the name is unterminated (no closing backtick before EOF
 * or newline), leaving the specific error to the caller.
 */
export function scanBacktickName(src: string, pos: number): ScannedName | null {
  if (src[pos] !== '`') return null;
  let end = pos + 1;
  while (end < src.length && src[end] !== '`' && src[end] !== '\n') end++;
  if (end >= src.length || src[end] === '\n') return null;
  return { name: src.slice(pos + 1, end), end };
}

/**
 * Scan a NAME starting at `pos` — a backtick-quoted name when `src[pos]` is a
 * backtick, otherwise a bare identifier. Returns the name verbatim (backticks
 * stripped) and the index just past the token (the closing backtick for a quoted
 * name; one past the last identifier char for a bare one). `null` when no name
 * is present (or a quoted name is unterminated).
 */
export function scanName(src: string, pos: number): ScannedName | null {
  if (src[pos] === '`') {
    const quoted = scanBacktickName(src, pos);
    if (quoted === null) return null;
    // Report `end` one past the closing backtick so it is the index just past
    // the whole token, consistent with the bare-ident case.
    return { name: quoted.name, end: quoted.end + 1 };
  }
  return scanIdent(src, pos);
}

/**
 * Unwrap a raw credential argument value to its catalog-side name.
 *
 * A construction's credential argument is always a reference to an imported
 * credential — either a bare identifier (`cred`) or a backtick-quoted name
 * (`` `Dev-loop Attio` ``). Both forms denote the SAME catalog key (the
 * verbatim credential name with backticks stripped).
 *
 * Returns:
 *   - the unwrapped name for a bare identifier or a complete backtick name;
 *   - `null` for anything else (a real expression, a partial/malformed
 *     backtick, …) — the checker already diagnoses those, so callers treat
 *     null as "no credential name available".
 *
 * This is the ONE shared unwrap used everywhere a credential arg value is
 * read as a catalog key — provision, run, checker, IDE extractors — so the
 * sites can never drift from each other.
 */
export function unwrapCredentialArg(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith('`')) {
    const scanned = scanBacktickName(trimmed, 0);
    // Require the closing backtick to be the very last character — anything
    // left over means it is not a plain name token.
    if (scanned === null || scanned.end !== trimmed.length - 1) return null;
    return scanned.name;
  }
  // Accept a bare identifier that spans the whole trimmed value.
  const ident = scanIdent(trimmed, 0);
  if (ident && ident.end === trimmed.length) return ident.name;
  return null;
}
