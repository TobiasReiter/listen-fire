// Language version 5 spells the combinators `race(f, g)` / `all(f, g)`: the
// arms are the call's arguments (a closure is not data, so there is no list of
// them), there is no `await` (a combinator does not park by itself), and
// `parallel` is `all`. A test written once for every version checks the
// version-5 program as the checker's own fixes rewrite it — so the fixes are
// exercised too, and the two spellings must answer the same.

import type { Diagnostic } from '../check';
import { applyFix } from '../fixes';
import type { LanguageVersion } from '../../language_version';

const SPELLING_FIXES = new Set(['MOV_PARALLEL_RETIRED', 'MOV_COMBINATOR_ARMS_ARE_ARGUMENTS', 'MOV_COMBINATOR_NO_AWAIT']);

/** `source` as version `version` spells its combinators. */
export function combinatorsSpelledFor(
  version: LanguageVersion,
  source: string,
  check: (source: string) => Diagnostic[],
): string {
  if (version < 5) return source;
  let current = source;
  for (let guard = 0; guard < 50; guard++) {
    const spelling = check(current).find(d => SPELLING_FIXES.has(d.code) && d.fix !== undefined);
    if (spelling?.fix === undefined) return current;
    current = applyFix(current, spelling.fix);
  }
  return current;
}
