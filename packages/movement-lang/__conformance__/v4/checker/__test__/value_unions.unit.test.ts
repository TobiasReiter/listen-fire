// A tuple read as a list is a list of its members' UNION — TypeScript's
// `[string, number]` read as `(string | number)[]` — from language version 3.
// Versions 1 and 2 had no value unions: there such a tuple read as a list
// nobody could type, and stays that way under its pin.

import { parseProgram } from '../../parser/parse';
import { checkProgram, checkProgramWithLink, Diagnostic } from '../check';
import { describeFieldType, FieldType, InstanceSchema, mockCatalog } from '../catalog';
import { fieldAssignable, fieldTypeCompatible, fieldTypeEquals, valueUnion } from '../typing';
import type { LanguageVersion } from '../../language_version';

const mailSchema: InstanceSchema = {
  positions: {
    message: {
      properties: { Subject: 'text', Size: 'number', Payload: 'json' },
      edges: {},
    },
    log: { properties: { note: 'text' }, edges: {} },
  },
  collections: { messages: { target: 'message' }, log: { target: 'log' } },
  writableRoots: {
    log: {
      fields: {
        note: 'text',
        Tags: { kind: 'list', of: 'text' },
        Scores: { kind: 'list', of: 'number' },
      },
      requiredFields: [],
      resultShape: { externalId: 'text' },
    },
  },
};

const catalog = mockCatalog({
  adapters: { email: { constructionArgs: [], schema: mailSchema } },
});

function source(body: string): string {
  return `import { email } from adapters
inbox = email()

movement m(e: <inbox-[:message]->>) {
${body}
}`;
}

function check(body: string, languageVersion?: LanguageVersion): Diagnostic[] {
  const options = languageVersion !== undefined ? { languageVersion } : undefined;
  return checkProgram(parseProgram(source(body), options), catalog, options).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}
const codes = (body: string, languageVersion?: LanguageVersion): string[] =>
  check(body, languageVersion).map((d) => d.code);
const messages = (body: string): string => check(body).map((d) => d.message).join('\n');

function fieldTypeOf(body: string, name: string, languageVersion?: LanguageVersion): unknown {
  const options = languageVersion !== undefined ? { languageVersion } : {};
  const { recording } = checkProgramWithLink(parseProgram(source(body), options), catalog, {
    ...options,
    recordAnalysis: true,
  });
  const symbols = (recording?.frames ?? []).flatMap((f) => [...f.scope.symbols.values()]);
  return symbols.find((s) => s.name === name)?.fieldType;
}

const TEXT_OR_NUMBER: FieldType = { kind: 'union', of: ['number', 'text'] };

describe('a union is its member set', () => {
  it('one member is that member, and a member twice is there once', () => {
    expect(valueUnion(['text'])).toEqual('text');
    expect(valueUnion(['text', 'text'])).toEqual('text');
    expect(valueUnion(['text', 'number', 'text'])).toEqual(TEXT_OR_NUMBER);
  });

  it('order does not matter', () => {
    expect(valueUnion(['number', 'text'])).toEqual(valueUnion(['text', 'number']));
    expect(fieldTypeEquals({ kind: 'union', of: ['text', 'number'] }, TEXT_OR_NUMBER)).toBe(true);
  });

  it('nested unions flatten', () => {
    expect(valueUnion([TEXT_OR_NUMBER, 'date', 'text'])).toEqual({
      kind: 'union',
      of: ['date', 'number', 'text'],
    });
  });

  it('absence is hoisted outside the union, as every require-present site reads it', () => {
    expect(valueUnion(['text', { kind: 'maybeAbsent', of: 'number' }])).toEqual({
      kind: 'maybeAbsent',
      of: TEXT_OR_NUMBER,
    });
    expect(valueUnion(['text', 'absent'])).toEqual({ kind: 'maybeAbsent', of: 'text' });
    expect(valueUnion(['absent'])).toEqual('absent');
  });

  it('a member another member already accepts is absorbed', () => {
    expect(valueUnion(['json', 'text', 'number'])).toEqual('json');
    expect(valueUnion(['text', { kind: 'enum', options: ['a', 'b'] }])).toEqual('text');
    // A file is a handle, not data, so json does not take it.
    expect(valueUnion(['json', 'file'])).toEqual({ kind: 'union', of: ['file', 'json'] });
  });

  it('records and values have no union; records of different positions are one record', () => {
    expect(valueUnion([{ kind: 'record' }, 'text'])).toBeUndefined();
    expect(valueUnion([{ kind: 'record' }, { kind: 'record' }])).toEqual({ kind: 'record' });
  });

  it('reads in TypeScript notation, parenthesised inside another type', () => {
    expect(describeFieldType(TEXT_OR_NUMBER)).toBe('number | text');
    expect(describeFieldType({ kind: 'list', of: TEXT_OR_NUMBER })).toBe('list of (number | text)');
    expect(describeFieldType({ kind: 'maybeAbsent', of: TEXT_OR_NUMBER })).toBe('(number | text) (or absent)');
  });
});

describe('assigning to and from a union', () => {
  it('a union reads as X when every member does', () => {
    expect(fieldAssignable(TEXT_OR_NUMBER, 'text')).toBe(false);
    expect(fieldAssignable({ kind: 'union', of: ['date', 'datetime'] }, 'date')).toBe(true);
  });

  it('X reads as a union when it reads as some member', () => {
    expect(fieldAssignable('number', TEXT_OR_NUMBER)).toBe(true);
    expect(fieldAssignable('boolean', TEXT_OR_NUMBER)).toBe(false);
  });

  it('a union is written into a field when every member is', () => {
    expect(fieldTypeCompatible({ kind: 'list', of: TEXT_OR_NUMBER }, { kind: 'list', of: 'number' })).toBe(false);
    // Everything renders into text — the lenient write rule a number already
    // gets on its own.
    expect(fieldTypeCompatible({ kind: 'list', of: TEXT_OR_NUMBER }, { kind: 'list', of: 'text' })).toBe(true);
  });
});

describe('under version 3, a tuple read as a list is a list of its union', () => {
  it('[text, number] widens to a list of text | number', () => {
    const body = '  t = [e.`Subject`, e.`Size`]\n  u = MAP(t, (s) => { return s })';
    expect(codes(body)).toEqual([]);
    expect(fieldTypeOf(body, 'u')).toEqual({ kind: 'list', of: TEXT_OR_NUMBER });
  });

  it('a non-literal index reads any member — the union, possibly absent', () => {
    const body = '  t = [e.`Subject`, e.`Size`]\n  i = e.`Size`\n  a = AT(t, i)';
    expect(fieldTypeOf(body, 'a')).toEqual({ kind: 'maybeAbsent', of: TEXT_OR_NUMBER });
  });

  it('JOIN and interpolation take a mixed scalar tuple — they render every member into text', () => {
    expect(codes('  j = JOIN([e.`Subject`, e.`Size`], " ")')).toEqual([]);
    expect(codes('  t = [e.`Subject`, e.`Size`]\n  s = "${FIRST(t)}"')).toEqual([]);
  });

  it('equality asks whether any member could match', () => {
    expect(codes('  b = [e.`Subject`, e.`Size`] CONTAINS "x"')).toEqual([]);
  });

  it('writing text | number into a list of number is refused, naming the union', () => {
    const body = '  write inbox-[:log]-> { Scores: [e.`Subject`, e.`Size`] }';
    expect(codes(body)).toEqual(['MOV_WRITE_FIELD_TYPE']);
    expect(messages(body)).toContain('list of (number | text)');
  });

  it('writing text | number into a list of text keeps the lenient write rule', () => {
    expect(codes('  write inbox-[:log]-> { Tags: [e.`Subject`, e.`Size`] }')).toEqual([]);
  });

  it('arithmetic on a member that may be text is refused', () => {
    const body = '  t = [e.`Subject`, e.`Size`]\n  n = MAP(t, (x) => { return x + 1 })';
    expect(codes(body)).toContain('MOV_ARITH_NON_NUMERIC');
  });

  it('a json member absorbs the others, and json is opaque', () => {
    expect(codes('  j = JOIN([e.`Subject`, e.`Payload`], " ")')).toContain('MOV_JSON_OPAQUE');
  });

  it('a parallel receipt whose slots disagree reads as a list of their union', () => {
    const body = [
      '  r = await parallel([',
      '    () => { return e.`Subject` },',
      '    () => { return e.`Size` },',
      '  ])',
      '  u = MAP(r, (x) => { return x })',
    ].join('\n');
    expect(codes(body)).toEqual([]);
    expect(fieldTypeOf(body, 'u')).toEqual({ kind: 'list', of: TEXT_OR_NUMBER });
  });

  it('a race receipt is the same union, each member possibly absent', () => {
    const body = [
      '  r = await race([',
      '    () => { return e.`Subject` },',
      '    () => { return e.`Size` },',
      '  ])',
      '  u = MAP(r, (x) => { return x })',
    ].join('\n');
    expect(fieldTypeOf(body, 'u')).toEqual({
      kind: 'list',
      of: { kind: 'maybeAbsent', of: TEXT_OR_NUMBER },
    });
  });

  it('a record and a value still have no list — refused where read', () => {
    const body = '  one = node { name: "Acme" }\n  both = [one, e.`Subject`]\n  n = COUNT(both)';
    expect(codes(body)).toContain('MOV_LIST_MIXED');
  });
});

describe('under version 2, the same tuple reads as a list nobody can type', () => {
  const V2 = 2;

  it('the widened element is unknown', () => {
    const body = '  t = [e.`Subject`, e.`Size`]\n  u = MAP(t, (s) => { return s })';
    expect(codes(body, V2)).toEqual([]);
    expect(fieldTypeOf(body, 'u', V2)).toBeUndefined();
  });

  it('what version 3 refuses validates, as it always did', () => {
    expect(codes('  write inbox-[:log]-> { Scores: [e.`Subject`, e.`Size`] }', V2)).toEqual([]);
    expect(codes('  t = [e.`Subject`, e.`Size`]\n  n = MAP(t, (x) => { return x + 1 })', V2)).toEqual([]);
    expect(codes('  j = JOIN([e.`Subject`, e.`Payload`], " ")', V2)).toEqual([]);
  });

  it('a parallel receipt whose slots disagree is unknown read as a list', () => {
    const body = [
      '  r = await parallel([',
      '    () => { return e.`Subject` },',
      '    () => { return e.`Size` },',
      '  ])',
      '  u = MAP(r, (x) => { return x })',
    ].join('\n');
    expect(fieldTypeOf(body, 'u', V2)).toBeUndefined();
  });
});
