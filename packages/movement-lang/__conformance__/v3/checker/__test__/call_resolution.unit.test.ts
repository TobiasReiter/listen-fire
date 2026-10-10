// Calls resolve by scope (language version 3): the program's own scopes, then
// the standard-library scope, which lists every built-in with its signature.
// Plan: plans/functional-extract-2026-10-02/2_one_grammar.md, step 3.
//
// What this pins, each against version 2 where the old behaviour holds:
//   - an unknown function name is an error with a did-you-mean;
//   - function names are case-insensitive, and two that differ only by case,
//     or one that is a built-in's name, collide;
//   - a built-in's arguments are checked against its signature, and its call
//     is typed by its return;
//   - a call the engine runs (a function's, MAP's) nests inside an
//     expression as the binding it means (checker/nested_calls.ts), and a
//     built-in that only computes a value is refused as a statement.

import { parseProgram } from '../../parser/parse';
import { checkProgram, DiagnosticCodes as C, type Diagnostic } from '../check';
import { mockCatalog, type InstanceSchema } from '../catalog';
import { TypedDiagnosticCodes as T } from '../typing';
import { lookupBuiltin, standardLibrary } from '../standard_library';
import { STDLIB_FAMILIES } from '../../expression/stdlib';
import type { LanguageVersion } from '../../language_version';

const chatSchema: InstanceSchema = {
  positions: {
    channel: {
      properties: { Name: 'text', Size: 'number' },
      edges: { Members: { target: 'person', readable: true } },
    },
    person: { properties: { Name: 'text', Age: 'number' }, edges: {} },
    note: { properties: { Body: 'text' }, edges: {} },
  },
  collections: { Channels: { target: 'channel' }, note: { target: 'note' } },
  writableRoots: {
    note: { fields: { Body: 'text', Count: 'number' }, resultShape: { Body: 'text' }, edges: {} },
  },
};

const catalog = mockCatalog({ adapters: { slack: { constructionArgs: [], schema: chatSchema } } });

const PRELUDE = `import { slack } from adapters
chat = slack()
`;

function all(body: string, languageVersion: LanguageVersion = 3, fileLevel = ''): Diagnostic[] {
  const source = `${PRELUDE}${fileLevel}
movement scan(c: <chat-[:channel]->>) {
${body}
}`;
  return checkProgram(parseProgram(source, { languageVersion }), catalog, { languageVersion }).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}
const codes = (body: string, languageVersion?: LanguageVersion, fileLevel?: string): string[] =>
  all(body, languageVersion, fileLevel).map((d) => d.code);
const messages = (body: string, languageVersion?: LanguageVersion, fileLevel?: string): string =>
  all(body, languageVersion, fileLevel).map((d) => d.message).join('\n');

describe('the standard-library scope', () => {
  it('lists every built-in with a signature, the namespaced families included', () => {
    for (const name of ['UPPER', 'COUNT', 'AI', 'KG_VALUE', 'FILE', 'READ', 'CHUNKS', 'EXISTS', 'MAP', 'MEMBERS', 'AT', 'SORT']) {
      expect(lookupBuiltin(name)).toBeDefined();
    }
    for (const family of STDLIB_FAMILIES) {
      for (const fn of family.functions) expect(lookupBuiltin(`${fn.namespace}.${fn.name}`)?.params).toBe(fn.params);
    }
    expect(standardLibrary().every((entry) => entry.params.length > 0)).toBe(true);
  });

  it('is looked up whatever the letter case', () => {
    expect(lookupBuiltin('upper')).toBe(lookupBuiltin('UPPER'));
    expect(lookupBuiltin('Date.Today')).toBe(lookupBuiltin('DATE.TODAY'));
  });

  it('declares an effect row: AI calls a model, DATE.TODAY reads the clock, READ reads a file', () => {
    expect(lookupBuiltin('AI')?.effects).toEqual({ ai: true });
    expect(lookupBuiltin('DATE.TODAY')?.effects).toEqual({ now: true });
    expect(lookupBuiltin('READ')?.effects).toEqual({ reads: ['files'] });
    expect(lookupBuiltin('UPPER')?.effects).toEqual({});
  });
});

describe('an unknown function name', () => {
  it('is an error with a did-you-mean, bound or inside an expression', () => {
    expect(codes('  x = UPPPER(c.`Name`)')).toEqual([C.FUNCTION_UNKNOWN]);
    expect(messages('  x = UPPPER(c.`Name`)')).toContain("did you mean 'UPPER'?");
    expect(codes('  x = COALESCE(uper(c.`Name`), "a")')).toEqual([C.FUNCTION_UNKNOWN]);
    expect(messages('  x = COALESCE(uper(c.`Name`), "a")')).toContain("did you mean 'UPPER'?");
  });

  it("suggests the program's own functions too", () => {
    const fileLevel = 'movement summarise(n: <text>) {\n  return n\n}\n';
    expect(messages('  x = sumarise(c.`Name`)', 3, fileLevel)).toContain("did you mean 'summarise'?");
  });

  it('inside a write field it may be the target field\'s own function, so it is not reported', () => {
    expect(codes('  write chat-[:note]-> { Body: SLACK_MESSAGE("brief", c.`Name`) }')).not.toContain(C.FUNCTION_UNKNOWN);
  });

  it('under version 2 stays the untyped call it was', () => {
    expect(codes('  x = COALESCE(FOO(c.`Name`), "a")', 2)).toEqual([]);
  });
});

describe('function names are case-insensitive', () => {
  const fileLevel = 'movement to_note(n: <chat-[:channel]->>) {\n  return n.`Name`\n}\n';

  it('a built-in answers in any case', () => {
    expect(codes('  x = upper(c.`Name`)\n  y = Upper(c.`Name`)')).toEqual([]);
  });

  it("a movement's call may spell its name in another case", () => {
    expect(codes('  x = TO_NOTE(c)', 3, fileLevel)).toEqual([]);
  });

  it('two functions whose names differ only by case collide', () => {
    const twice = `${fileLevel}movement To_Note(n: <chat-[:channel]->>) {\n  return n.\`Name\`\n}\n`;
    expect(codes('', 3, twice)).toEqual([C.FUNCTION_NAME_COLLISION]);
    expect(codes('', 2, twice)).toEqual([]);
  });

  it("a function may not take a built-in's name, in any case", () => {
    const shadow = 'movement upper(n: <chat-[:channel]->>) {\n  return n.`Name`\n}\n';
    expect(codes('', 3, shadow)).toEqual([C.FUNCTION_NAME_COLLISION]);
    expect(messages('', 3, shadow)).toContain('the built-in UPPER');
    expect(codes('', 2, shadow)).toEqual([]);
  });

  it('a variable is not a function, and its name keeps its case', () => {
    expect(codes('  upper = c.`Name`\n  x = upper(c.`Name`)')).toEqual([C.CALL_NOT_MOVEMENT]);
    expect(codes('  length = 3\n  x = LENGTH(c.`Name`)')).toEqual([]);
  });
});

describe("a built-in's arguments are checked against its signature", () => {
  it('a record where text is read is refused', () => {
    expect(codes('  x = UPPER(c)')).toEqual([T.RECORD_NOT_A_VALUE]);
    expect(codes('  x = UPPER(c-[p:Members]->)')).toEqual([T.RECORD_NOT_A_VALUE]);
    expect(codes('  x = UPPER(c)', 2)).toEqual([]);
  });

  it('a value of the wrong kind is refused, naming the parameter', () => {
    expect(codes('  x = ROUND(c.`Name`)')).toEqual([T.BUILTIN_ARG_TYPE]);
    expect(messages('  x = ROUND(c.`Name`)')).toContain("ROUND's 'number' takes a number");
    expect(codes('  x = ROUND(c.`Size`)')).toEqual([]);
    expect(codes('  x = ROUND(c.`Name`)', 2)).toEqual([]);
  });

  it('too many or too few arguments are refused', () => {
    expect(codes('  x = UPPER(c.`Name`, "b")')).toEqual([C.BUILTIN_ARGS]);
    expect(codes('  x = COALESCE(UPPER(c.`Name`, "b"), "a")')).toEqual([C.BUILTIN_ARGS]);
  });

  it('the call is typed by its return', () => {
    expect(codes('  write chat-[:note]-> { Count: UPPER(c.`Name`) }')).toEqual([C.WRITE_FIELD_TYPE]);
    expect(codes('  write chat-[:note]-> { Count: LENGTH(c.`Name`) }')).toEqual([]);
    expect(codes('  write chat-[:note]-> { Count: UPPER(c.`Name`) }', 2)).toEqual([]);
  });
});

describe('where a call is read', () => {
  const fileLevel = 'movement to_note(n: <text>) {\n  return n\n}\n';

  it("a function's call inside an expression is the value it returns", () => {
    expect(codes('  x = COALESCE(to_note(c.`Name`), "!")', 3, fileLevel)).toEqual([]);
    // Typed by what the function returns: text, which a number field refuses.
    expect(codes('  write chat-[:note]-> { Count: to_note(c.`Name`) }', 3, fileLevel)).toEqual([C.WRITE_FIELD_TYPE]);
  });

  it('a built-in that only computes a value is refused as a statement', () => {
    expect(codes('  UPPER(c.`Name`)')).toEqual([C.BUILTIN_UNUSED]);
  });

  it('MAP inside an expression is the list it builds', () => {
    expect(codes('  x = COUNT(MAP([1, 2], (n) => { return n }))')).toEqual([]);
    expect(codes('  write chat-[:note]-> { Count: COUNT(MAP([1, 2], (n) => { return n })) }')).toEqual([]);
  });

  it('a built-in as a function\'s argument is the value it computes', () => {
    expect(codes('  x = to_note(UPPER(c.`Name`))', 3, fileLevel)).toEqual([]);
    expect(codes('  x = to_note(UPPER(c))', 3, fileLevel)).toEqual([T.RECORD_NOT_A_VALUE]);
  });

  it('a function written in place is refused as a function\'s argument', () => {
    expect(codes('  x = to_note((n) => { return n })', 3, fileLevel)).toEqual([C.CALL_ARG_TYPE]);
  });
});
