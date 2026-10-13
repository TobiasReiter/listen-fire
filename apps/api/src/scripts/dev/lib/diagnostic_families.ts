// The failure families authoring evals bucket checker diagnostics into, shared
// by every eval that re-validates an agent's final source (mvt_eval in-process,
// automation_eval over the MCP tools) so the two report the same families.
// Codes from packages/movement-lang/checker/check.ts.

const INVENTED_NAME_CODES = new Set([
  'MOV_IMPORT_UNKNOWN',
  'MOV_NAME_UNRESOLVED',
  'MOV_WRITE_UNKNOWN_ROOT',
  'MOV_WRITE_UNKNOWN_FIELD',
  'MOV_UNIQUE_UNKNOWN_FIELD',
  'MOV_TRAVERSE_UNKNOWN_EDGE',
  'MOV_LINKED_UNKNOWN_EDGE',
  'MOV_BORROW_UNKNOWN_GRAPH',
  'MOV_BORROW_UNKNOWN_ROOT',
  'MOV_BORROW_UNKNOWN_FIELD',
  'MOV_UNKNOWN_POSITION',
  'MOV_UNKNOWN_PROPERTY',
  'MOV_EXTRACT_UNKNOWN_FIELD',
]);
const MISSING_REQUIRED_CODES = new Set([
  'MOV_WRITE_MISSING_REQUIRED_FIELD',
  'MOV_WRITE_MISSING_REQUIRED_EDGE',
]);
const TYPE_ERROR_CODES = new Set([
  'MOV_WRITE_FIELD_TYPE',
  'MOV_WRITE_TUPLE_MISMATCH',
  'MOV_LINKED_TYPE_MISMATCH',
  'MOV_EXTRACT_TYPE_CONFLICT',
  'MOV_CALL_ARG_TYPE',
  'MOV_CALL_ARG_MAYBE_RECORD',
]);
const ENGINE_UNSUPPORTED_CODES = new Set(['MOV_ENGINE_UNSUPPORTED']);

interface ValidationLike {
  ok: boolean;
  diagnostics: Array<{ code: string; severity: 'error' | 'warning' | 'info' }>;
}

interface DiagnosticBuckets {
  errorCount: number;
  invented: number;
  missingRequired: number;
  typeErrors: number;
  engineUnsupported: number;
}

function bucketDiagnostics(v: ValidationLike): DiagnosticBuckets {
  const errors = v.diagnostics.filter((d) => d.severity === 'error');
  const inFamily = (set: Set<string>) => errors.filter((d) => set.has(d.code)).length;
  return {
    errorCount: errors.length,
    invented: inFamily(INVENTED_NAME_CODES),
    missingRequired: inFamily(MISSING_REQUIRED_CODES),
    typeErrors: inFamily(TYPE_ERROR_CODES),
    engineUnsupported: inFamily(ENGINE_UNSUPPORTED_CODES),
  };
}

export { bucketDiagnostics };
export type { ValidationLike, DiagnosticBuckets };
