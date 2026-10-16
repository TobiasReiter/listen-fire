// Language version 5's surface (plans/naming-rethink-2026-10-14/5_design.md):
// the everyday spelling checks as the old one did under version 4, every old
// spelling is refused with its rewrite (MOV_V5_SPELLING, a DiagnosticFix), and
// a message names built-ins as the program's own version spells them. The
// spelling table and the rewrite are the Rust parser's
// (crates/movement-parser/src/surface); this pins what the TypeScript checker
// makes of them.

import { parseProgram } from '../../parser/parse';
import { spellMessage, surfaceTable } from '../../parser/surface';
import { checkProgram, type Diagnostic } from '../check';
import { mockCatalog, type InstanceSchema } from '../catalog';
import { applyFix } from '../fixes';

const chatSchema: InstanceSchema = {
  positions: {
    channel: {
      properties: { Name: 'text' },
      edges: { Messages: { target: 'message', readable: true, sequenced: 'chronological' } },
    },
    message: { properties: { Text: 'text' }, edges: {} },
    note: { properties: { Body: 'text', Count: 'number' }, edges: {} },
  },
  collections: { Channels: { target: 'channel' }, note: { target: 'note' } },
  writableRoots: {
    note: { fields: { Body: 'text', Count: 'number' }, resultShape: { Body: 'text' }, edges: {} },
  },
};

const catalog = mockCatalog({ adapters: { slack: { constructionArgs: [], schema: chatSchema } } });

function check(source: string, languageVersion: number): Diagnostic[] {
  return checkProgram(parseProgram(source, { languageVersion }), catalog, { languageVersion }).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}

const V5 = `import { \`@lf/slack\` as slack } from adapters
chat = connect slack

function go(c: <chat-[:channel]->>) {
  names = map(c-[m:Messages]->, (m) => Text.upper(Text.trim(m.Text)))
  if (count(names) > 0 && !(first(names) == null)) {
    write chat-[:note]-> { Body: coalesce(first(names), "none"), Count: Number.round(count(names)) }
  }
  label = count(names) > 1 ? "many" : "one"
  write chat-[:note]-> { Body: label }
}`;

const V4 = `import { slack } from adapters
chat = slack()

movement go(c: <chat-[:channel]->>) {
  names = MAP(c-[m:Messages]->, (m) => UPPER(TRIM(m.Text)))
  if COUNT(names) > 0 AND NOT ISNULL(FIRST(names)) {
    write chat-[:note]-> { Body: COALESCE(FIRST(names), "none"), Count: ROUND(COUNT(names)) }
  }
  label = IF COUNT(names) > 1 THEN "many" ELSE "one" END
  write chat-[:note]-> { Body: label }
}`;

describe('language version 5 surface', () => {
  it('the everyday spelling checks clean under 5, as the old one does under 4', () => {
    expect(check(V4, 4)).toEqual([]);
    expect(check(V5, 5)).toEqual([]);
  });

  it('every old spelling under 5 is refused with a fix, and the fixes upgrade the program', () => {
    let source = V4;
    for (let round = 0; round < 6; round++) {
      const refused = check(source, 5).filter((d) => d.code === 'MOV_V5_SPELLING');
      if (refused.length === 0) break;
      expect(refused.every((d) => d.fix !== undefined)).toBe(true);
      // Outermost first; an overlapping fix comes round again.
      const taken: Diagnostic[] = [];
      for (const d of refused) {
        const overlaps = (a: Diagnostic, b: Diagnostic): boolean =>
          a.fix!.edits.some((x) => b.fix!.edits.some((y) => !(cmp(x.span.end, y.span.start) <= 0 || cmp(x.span.start, y.span.end) >= 0)));
        if (taken.every((t) => !overlaps(t, d))) taken.push(d);
      }
      source = applyFix(source, { edits: taken.flatMap((d) => d.fix!.edits) });
    }
    expect(check(source, 5)).toEqual([]);
  });

  it('a message names a built-in in the program\'s own spelling', () => {
    const wrong = (call: string, version: number): string[] =>
      check(
        `import { slack } from adapters\nchat = slack()\n\n${version >= 5 ? 'function' : 'movement'} m(c: <chat-[:channel]->>) {\n  x = ${call}\n}`,
        version,
      ).map((d) => d.message);
    expect(spellMessage('`UPPER` expects text', 5)).toBe('`Text.upper` expects text');
    expect(spellMessage('`UPPER` expects text', 4)).toBe('`UPPER` expects text');
    expect(wrong('UPPER(1, 2)', 4).join('\n')).not.toContain('Text.upper');
    expect(surfaceTable().spellings.find((s) => s.canonical === 'UPPER')?.v5).toBe('Text.upper');
  });
});

function cmp(a: { line: number; col: number }, b: { line: number; col: number }): number {
  return a.line - b.line || a.col - b.col;
}
