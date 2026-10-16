// Language version 5's semantics the spelling rewrite alone cannot carry
// (plans/naming-rethink-2026-10-14/5_design.md; the spine report's item (e)):
// each changes what a text means, or needs the checker's knowledge to write
// its fix. Under 4 nothing changes; under 5 the old text is refused with a
// fix, and the fixed program checks clean and means what the old one did.

import { parseProgram } from '../../parser/parse';
import { checkProgram, type Diagnostic } from '../check';
import { mockCatalog, type InstanceSchema } from '../catalog';
import { applyFix } from '../fixes';

const chatSchema: InstanceSchema = {
  positions: {
    channel: {
      properties: { Name: 'text' },
      edges: { Messages: { target: 'message', readable: true, sequenced: 'chronological' } },
    },
    message: { properties: { Text: 'text', Tags: { kind: 'list', of: 'text' } }, edges: {} },
  },
  collections: { Channels: { target: 'channel' } },
};

const catalog = mockCatalog({ adapters: { slack: { constructionArgs: [], schema: chatSchema } } });

function check(source: string, languageVersion: number): Diagnostic[] {
  return checkProgram(parseProgram(source, { languageVersion }), catalog, { languageVersion }).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}

function codes(source: string, languageVersion: number): string[] {
  return check(source, languageVersion).map((d) => d.code);
}

/** Applies every MOV_V5_SPELLING fix, outermost first, until none is left. */
function upgraded(source: string): string {
  for (let round = 0; round < 8; round++) {
    const refused = check(source, 5).filter((d) => d.code === 'MOV_V5_SPELLING');
    if (refused.length === 0) return source;
    const taken: Diagnostic[] = [];
    for (const d of refused) {
      if (d.fix === undefined) throw new Error(`no fix: ${d.message}`);
      const overlaps = (a: Diagnostic): boolean =>
        a.fix!.edits.some((x) => d.fix!.edits.some((y) => !(cmp(x.span.end, y.span.start) <= 0 || cmp(x.span.start, y.span.end) >= 0)));
      if (taken.every((t) => !overlaps(t))) taken.push(d);
    }
    source = applyFix(source, { edits: taken.flatMap((d) => d.fix!.edits) });
  }
  throw new Error(`fixes did not settle:\n${source}`);
}

function cmp(a: { line: number; col: number }, b: { line: number; col: number }): number {
  return a.line - b.line || a.col - b.col;
}

const HEAD4 = 'import { slack } from adapters\nchat = slack()\n\n';
const HEAD5 = 'import { `@lf/slack` as slack } from adapters\nchat = connect slack\n\n';

describe('`!` binds as TypeScript\'s unary operator from version 5', () => {
  const v4 = `${HEAD4}movement go(a: <boolean>, b: <boolean>) {\n  if !a == b {\n    x = 1\n  }\n}`;
  const v5 = `${HEAD5}function go(a: <boolean>, b: <boolean>) {\n  if (!a == b) {\n    x = 1\n  }\n}`;

  it('under 4 the text reads as before', () => {
    expect(codes(v4, 4)).toEqual([]);
  });

  it('under 5 the text whose reading changed is refused; the fix writes out the old reading', () => {
    const refused = check(v5, 5).filter((d) => d.code === 'MOV_V5_SPELLING');
    expect(refused).toHaveLength(1);
    expect(refused[0].fix?.edits[0].text).toBe('!(a == b)');
    const fixed = upgraded(v5);
    expect(fixed).toContain('if (!(a == b)) {');
    expect(codes(fixed, 5)).toEqual([]);
    expect(codes(`${HEAD5}function go(a: <boolean>, b: <boolean>) {\n  if ((!a) == b) {\n    x = 1\n  }\n}`, 5)).toEqual([]);
  });
});
