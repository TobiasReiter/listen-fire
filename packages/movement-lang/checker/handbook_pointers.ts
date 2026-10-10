// Where the automations handbook explains the fix for a diagnostic.
//
// The commonest diagnostics end with a pointer an authoring agent can read
// straight back (`readHandbook` serves every anchor here), so a refusal names
// both what is wrong and where the right form is shown. The anchors are the
// handbook's, held in the API; its tests fail if one stops resolving.

export const HANDBOOK_POINTERS = {
  /** A value that may be absent, used where one is required. */
  maybeAbsent: 'front#maybe-absent',
  /** A call to a name nothing declares — usually a TypeScript method or a guessed built-in. */
  functions: 'front#functions-not-methods',
  /** An extraction call written where a value is read many times. */
  extraction: 'front#extraction',
  /** A write or find that cannot say which record it means. */
  identity: 'front#identity',
  /** A system named before it is imported and constructed. */
  systems: 'front#systems',
  /** A match whose miss is absent: name it and test the name. */
  match: 'writes#match',
  /** What a write did — created, matched, changed — asked of its `@old`. */
  writeOutcome: 'writes#what-the-write-did',
} as const;

export type HandbookPointer = (typeof HANDBOOK_POINTERS)[keyof typeof HANDBOOK_POINTERS];

/** The suffix a diagnostic message carries: ` (see handbook: front#identity)`. */
export function seeHandbook(anchor: HandbookPointer): string {
  return ` (see handbook: ${anchor})`;
}

/** The diagnostics whose fix one handbook entry shows, by code — every site
 *  that reports the code points at the same place. */
export const HANDBOOK_POINTER_BY_CODE: Readonly<Record<string, HandbookPointer>> = {
  MOV_ABSENT_REQUIRED: HANDBOOK_POINTERS.maybeAbsent,
  MOV_FUNCTION_UNKNOWN: HANDBOOK_POINTERS.functions,
  MOV_EXTRACT_CALL_NESTED: HANDBOOK_POINTERS.extraction,
  MOV_MATCH_NO_IDENTITY: HANDBOOK_POINTERS.identity,
  MOV_UNIQUE_UNKNOWN_FIELD: HANDBOOK_POINTERS.identity,
  MOV_LINKED_HOP_RETIRED: HANDBOOK_POINTERS.identity,
  MOV_PARENT_READ_RETIRED: HANDBOOK_POINTERS.identity,
  MOV_MATCH_UNNAMED: HANDBOOK_POINTERS.match,
  MOV_MATCH_MISS_CONTINUES: HANDBOOK_POINTERS.match,
  MOV_LINK_MATCH_BODY_RETIRED: HANDBOOK_POINTERS.match,
  MOV_HANDLE_FIELD_RETIRED: HANDBOOK_POINTERS.writeOutcome,
  MOV_OLD_EDGE_NOT_A_WRITE: HANDBOOK_POINTERS.writeOutcome,
  MOV_ARTIFICIAL_EDGE_UNKNOWN: HANDBOOK_POINTERS.writeOutcome,
};

/** `diagnostic`, its message ending in the handbook pointer its code has (if any). */
export function withHandbookPointer<D extends { code: string; message: string }>(diagnostic: D): D {
  const anchor = HANDBOOK_POINTER_BY_CODE[diagnostic.code];
  if (anchor === undefined) return diagnostic;
  const suffix = seeHandbook(anchor);
  if (diagnostic.message.endsWith(suffix)) return diagnostic;
  return { ...diagnostic, message: `${diagnostic.message}${suffix}` };
}
