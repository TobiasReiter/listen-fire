// A woken `await sleep(…)` binds `true`. Since language version 3 the checker
// says so (boolean), so `x == true` compares; v1 and v2 left it untyped and
// keep refusing that comparison.

import { parseProgram } from '../../parser/parse';
import { checkProgram, DiagnosticCodes as C, type Diagnostic } from '../check';
import { mockCatalog } from '../catalog';
import type { LanguageVersion } from '../../language_version';

const catalog = mockCatalog({ adapters: {} });

const errorCodes = (body: string, languageVersion: LanguageVersion): string[] =>
  checkProgram(parseProgram(`movement m() {\n${body}\n}`), catalog, { languageVersion })
    .filter((d: Diagnostic) => (d.severity ?? 'error') === 'error')
    .map((d) => d.code);

const COMPARE = '  x = await sleep(1h)\n  y = x == true';

describe('await sleep(…) binding', () => {
  it('is boolean under v3: comparing it to true checks clean', () => {
    expect(errorCodes(COMPARE, 3)).toEqual([]);
  });

  it('is boolean under v3: it works as a condition', () => {
    expect(errorCodes('  x = await sleep(1h)\n  if x {\n    return 1\n  }', 3)).toEqual([]);
  });

  it('stays untyped under v2: the comparison is still refused', () => {
    expect(errorCodes(COMPARE, 2)).toEqual([C.COMPARE_TYPE_MISMATCH]);
  });
});
