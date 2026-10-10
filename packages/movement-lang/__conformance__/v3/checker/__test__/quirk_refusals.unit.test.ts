// Silent quirks refused at save (language version 3). Each was a place the
// expression grammar quietly dropped or invented something:
//   - an aggregate handed more arguments than it reads kept only the first
//     (and a second, as JOIN's separator, only when it was text in place);
//   - `IF … THEN … END` with no ELSE was `""` where the condition failed;
//   - a knowledge-graph query that was not text in place became `''`.
// Under version 3 each is a diagnostic; before it, each is kept exactly.
// Plan: plans/functional-extract-2026-10-02/2_one_grammar.md, "Rulings (after
// steps 4–5)".

import { parseProgram } from '../../parser/parse';
import { checkProgram, DiagnosticCodes as C } from '../check';
import { mockCatalog, type InstanceSchema } from '../catalog';
import type { LanguageVersion } from '../../language_version';

const chatSchema: InstanceSchema = {
  positions: {
    channel: { properties: { Name: 'text', Size: 'number' }, edges: {} },
    note: { properties: { Body: 'text' }, edges: {} },
  },
  collections: { Channels: { target: 'channel' }, note: { target: 'note' } },
  writableRoots: {
    note: { fields: { Body: 'text', Count: 'number' }, resultShape: { Body: 'text' }, edges: {} },
  },
};

const catalog = mockCatalog({ adapters: { slack: { constructionArgs: [], schema: chatSchema } } });

function codes(body: string, languageVersion: LanguageVersion = 3): string[] {
  const source = `import { slack } from adapters
chat = slack()
movement scan(c: <chat-[:channel]->>) {
${body}
}
listen to chat fire scan`;
  return checkProgram(parseProgram(source, { languageVersion }), catalog, { languageVersion })
    .filter((d) => (d.severity ?? 'error') === 'error')
    .map((d) => d.code);
}

function messages(body: string): string {
  const source = `import { slack } from adapters
chat = slack()
movement scan(c: <chat-[:channel]->>) {
${body}
}
listen to chat fire scan`;
  return checkProgram(parseProgram(source, { languageVersion: 3 }), catalog, { languageVersion: 3 })
    .map((d) => d.message)
    .join('\n');
}

describe('an aggregate takes exactly the arguments its signature lists', () => {
  it('an extra argument is refused wherever the call is written', () => {
    expect(codes('  x = COUNT([1, 2], 3)')).toEqual([C.BUILTIN_ARGS]);
    expect(codes('  write chat-[:note]-> { Count: SUM([1, 2], 3) }')).toEqual([C.BUILTIN_ARGS]);
    expect(codes('  if COUNT([1], 2) > 0 {\n    write chat-[:note]-> { Body: "a" }\n  }')).toEqual([C.BUILTIN_ARGS]);
    expect(codes('  x = JOIN(["a"], ",", 3)')).toEqual([C.BUILTIN_ARGS]);
    expect(codes('  x = COUNT([1, 2])')).toEqual([]);
  });

  it("JOIN reads its separator only as text in place — a computed one is refused, not dropped", () => {
    expect(codes('  x = JOIN(["a", "b"], ", ")')).toEqual([]);
    expect(codes('  x = JOIN(["a", "b"], c.Name)')).toEqual([C.BUILTIN_ARGS]);
    expect(codes('  x = JOIN(["a", "b"], "${c.Name}")')).toEqual([C.BUILTIN_ARGS]);
    expect(messages('  x = JOIN(["a", "b"], c.Name)')).toContain('written in place');
  });

  it('before version 3 the extra argument and the computed separator are dropped — unchanged', () => {
    expect(codes('  x = COUNT([1, 2], 3)', 2)).toEqual([]);
    expect(codes('  x = JOIN(["a", "b"], c.Name)', 2)).toEqual([]);
  });
});

describe('an IF says what it is where its condition fails', () => {
  it('no ELSE is refused, with the fix', () => {
    expect(codes('  x = IF c.Size > 1 THEN 3 END')).toEqual([C.IF_WITHOUT_ELSE]);
    expect(codes('  write chat-[:note]-> { Body: IF c.Size > 1 THEN "big" END }')).toEqual([C.IF_WITHOUT_ELSE]);
    expect(codes('  x = MAP([1], (v) => IF v > 1 THEN v END)')).toEqual([C.IF_WITHOUT_ELSE]);
    expect(messages('  x = IF c.Size > 1 THEN 3 END')).toContain('ELSE');
  });

  it('with an ELSE it is fine', () => {
    expect(codes('  x = IF c.Size > 1 THEN 3 ELSE 4 END')).toEqual([]);
    expect(codes('  write chat-[:note]-> { Body: IF c.Size > 1 THEN "big" ELSE "" END }')).toEqual([]);
  });

  it('before version 3 the missing arm is "" — unchanged', () => {
    expect(codes('  x = IF c.Size > 1 THEN 3 END', 2)).toEqual([]);
  });
});

describe('a knowledge-graph query is text written in place', () => {
  it('a computed query is refused rather than read as empty', () => {
    expect(codes('  x = KG_EXISTS(c.Name)')).toEqual([C.BUILTIN_ARGS]);
    expect(codes('  x = KG_VALUE(CONCAT("MATCH ", c.Name))')).toEqual([C.BUILTIN_ARGS]);
    expect(codes('  x = KG_EXISTS("MATCH (n {name: ${c.Name}}) RETURN n")')).toEqual([C.BUILTIN_ARGS]);
    expect(messages('  x = KG_EXISTS(c.Name)')).toContain('parameters');
  });

  it('a query written out, given its values as parameters, is fine', () => {
    expect(codes('  x = KG_EXISTS("MATCH (n {name: $0}) RETURN n", c.Name)')).toEqual([]);
  });

  it('before version 3 a computed query is read as empty — unchanged', () => {
    expect(codes('  x = KG_EXISTS(c.Name)', 2)).toEqual([]);
  });
});
