// The extraction keyword's own checks under version 5 run beside its
// retirement (MOV_EXTRACT_KEYWORD_RETIRED, pinned in
// extract_keyword_retired.unit.test.ts): a suite that pins those checks on a
// program written with the keyword reads them without the retirement.

export function notKeywordRetirement(diagnostic: { code: string }): boolean {
  return diagnostic.code !== 'MOV_EXTRACT_KEYWORD_RETIRED';
}
