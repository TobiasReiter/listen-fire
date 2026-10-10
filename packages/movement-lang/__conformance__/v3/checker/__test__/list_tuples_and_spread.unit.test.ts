// List literals are TUPLES, and `...xs` splices a collection into one.
//
// `[m.Subject, 2]` is `[text, number]`: its slots were written down, so a
// literal index (`AT(t, 0)`) reads exactly one. Everywhere else a tuple is read
// as the list it widens to — TypeScript's tuple-to-array assignability — with
// the members' unified type as its element, which is the very type a list
// literal had before it was a tuple. A spread of a list makes the tuple
// VARIADIC (`[text, ...file[]]`); a spread of a tuple splices its slots.

import { parseProgram } from '../../parser/parse';
import { parseMovementExpression } from '../../expression/bridge';
import { checkProgram, checkProgramWithLink, Diagnostic } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';
import type { LanguageVersion } from '../../language_version';

const mailSchema: InstanceSchema = {
  positions: {
    message: {
      properties: {
        Subject: 'text',
        Files: { kind: 'list', of: 'file' },
        Tags: { kind: 'list', of: 'text' },
      },
      edges: { Attachments: { target: 'attachment', readable: true } },
    },
    attachment: {
      properties: {
        Type: 'text',
        File: 'file',
        Labels: { kind: 'list', of: 'text' },
        Meta: 'json',
      },
      edges: {},
    },
    log: { properties: { note: 'text' }, edges: {} },
  },
  collections: { messages: { target: 'message' }, log: { target: 'log' } },
  writableRoots: {
    log: {
      fields: { note: 'text', Tags: { kind: 'list', of: 'text' } },
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

describe('a spread parses inside a list literal, and only there', () => {
  const name = (n: string) => ({ type: 'property', propertyTypeId: n });

  it('at the start, in the middle and at the end', () => {
    expect(parseMovementExpression('[...xs, a]')).toEqual({
      type: 'list',
      elements: [{ type: 'spread', expression: name('xs') }, name('a')],
    });
    expect(parseMovementExpression('[a, ...xs, b]')).toEqual({
      type: 'list',
      elements: [name('a'), { type: 'spread', expression: name('xs') }, name('b')],
    });
    expect(parseMovementExpression('[a, ...xs]')).toEqual({
      type: 'list',
      elements: [name('a'), { type: 'spread', expression: name('xs') }],
    });
  });

  it('spreads any expression, not only a name', () => {
    expect(parseMovementExpression('[...COLLECT(xs)]')).toMatchObject({
      type: 'list',
      elements: [{ type: 'spread', expression: { type: 'aggregate', fn: 'collect' } }],
    });
  });

  it('a spread outside a list literal is refused, saying where it belongs', () => {
    const body = '  xs = [1, 2]\n  y = ...xs';
    expect(codes(body)).toContain('MOV_EXPR_PARSE');
    expect(messages(body)).toContain("only inside '[ … ]'");
  });
});

describe('a list literal is a tuple', () => {
  it('one slot per member, as written', () => {
    expect(fieldTypeOf('  t = [e.`Subject`, 2]', 't')).toEqual({ kind: 'tuple', of: ['text', 'number'] });
  });

  it('a literal index reads its own slot — present, because a fixed length has it', () => {
    const body = '  t = [e.`Subject`, 2]\n  a = AT(t, 0)\n  b = AT(t, 1)\n  c = AT(t, -1)\n  d = AT(t, 7)';
    expect(codes(body)).toEqual([]);
    expect(fieldTypeOf(body, 'a')).toEqual('text');
    expect(fieldTypeOf(body, 'b')).toEqual('number');
    expect(fieldTypeOf(body, 'c')).toEqual('number');
    expect(fieldTypeOf(body, 'd')).toEqual('absent');
  });

  it('a slot read off the literal directly is typed the same', () => {
    const body = '  a = AT([e.`Subject`, 2], 1)';
    expect(fieldTypeOf(body, 'a')).toEqual('number');
  });
});

describe('a spread splices into the tuple', () => {
  it('a list spread at the end makes a variadic tuple', () => {
    const body = '  t = [e.`Subject`, ...e.`Files`]';
    expect(codes(body)).toEqual([]);
    expect(fieldTypeOf(body, 't')).toEqual({ kind: 'tuple', of: ['text'], rest: { at: 1, of: 'file' } });
  });

  it('at the start', () => {
    expect(fieldTypeOf('  t = [...e.`Files`, e.`Subject`]', 't')).toEqual({
      kind: 'tuple',
      of: ['text'],
      rest: { at: 0, of: 'file' },
    });
  });

  it('in the middle', () => {
    expect(fieldTypeOf('  t = [e.`Subject`, ...e.`Files`, 3]', 't')).toEqual({
      kind: 'tuple',
      of: ['text', 'number'],
      rest: { at: 1, of: 'file' },
    });
  });

  it('a variadic tuple fixes only the slots on the near side of its run', () => {
    const body = [
      '  t = [e.`Subject`, ...e.`Files`, 3]',
      '  first = AT(t, 0)',
      '  second = AT(t, 1)',
      '  last = AT(t, -1)',
    ].join('\n');
    expect(fieldTypeOf(body, 'first')).toEqual('text');
    expect(fieldTypeOf(body, 'last')).toEqual('number');
    // Past the run's start a member may be a file, the 3, or nothing.
    expect(fieldTypeOf(body, 'second')).toEqual({
      kind: 'maybeAbsent',
      of: { kind: 'union', of: ['file', 'number'] },
    });
    expect(fieldTypeOf('  t = [e.`Subject`, ...e.`Files`]\n  s = AT(t, 1)', 's')).toEqual({
      kind: 'maybeAbsent',
      of: 'file',
    });
  });

  it("a tuple spread splices the tuple's own slots", () => {
    const body = '  p = [1, "a"]\n  t = [...p, TRUE]';
    expect(fieldTypeOf(body, 't')).toEqual({ kind: 'tuple', of: ['number', 'text', 'boolean'] });
  });

  it('a second run folds everything from the first onward into one, as TypeScript does', () => {
    expect(fieldTypeOf('  t = [e.`Subject`, ...e.`Files`, ...e.`Files`]', 't')).toEqual({
      kind: 'tuple',
      of: ['text'],
      rest: { at: 1, of: 'file' },
    });
  });

  it('a spread of one thing is refused — it has no members to splice', () => {
    const body = '  t = [1, ...e.`Subject`]';
    expect(codes(body)).toContain('MOV_LIST_SPREAD_NOT_A_LIST');
    expect(messages(body)).toContain('this is text');
  });

  it('a spread of a record is refused the same way', () => {
    expect(codes('  one = node { name: "Acme" }\n  t = [...one]')).toContain('MOV_LIST_SPREAD_NOT_A_LIST');
  });

  it('a spread that may be absent is refused — there would be nothing to splice', () => {
    const body = [
      '  d = { files: e.`Files` }',
      '  k = e.`Subject`',
      '  t = [...AT(d, k)]',
    ].join('\n');
    expect(codes(body)).toContain('MOV_ABSENT_REQUIRED');
  });
});

// A walk read for a field — `e-[a:Attachments]->.\`File\`` — is one value
// per landing, typed as the field's own type (the walk chooses the values, the
// field says what each is). Read as one value it collapses, which is what a
// write field still sees; a spread reads it as the values, exactly as a fold
// does — inline, or through a name bound to it.
describe('a spread of a walk read for a field splices one value per landing', () => {
  const PDFS = "e-[a:Attachments WHERE a.Type = 'application/pdf']->.`File`";

  it('bound to a name first — the plan\'s idiom', () => {
    const body = `  pdfs = ${PDFS}\n  content = [e.\`Subject\`, ...pdfs]`;
    expect(codes(body)).toEqual([]);
    expect(fieldTypeOf(body, 'content')).toEqual({ kind: 'tuple', of: ['text'], rest: { at: 1, of: 'file' } });
  });

  it('written inline', () => {
    const body = `  content = [e.\`Subject\`, ...${PDFS}]`;
    expect(codes(body)).toEqual([]);
    expect(fieldTypeOf(body, 'content')).toEqual({ kind: 'tuple', of: ['text'], rest: { at: 1, of: 'file' } });
  });

  it('through a second name for the first', () => {
    const body = `  pdfs = ${PDFS}\n  docs = pdfs\n  content = [e.\`Subject\`, ...docs]`;
    expect(codes(body)).toEqual([]);
  });

  it('the name keeps the field\'s own type everywhere else — a write reads it as one value, as before', () => {
    const body = "  first = e-[a:Attachments]->.`Type`\n  write inbox-[:log]-> { note: first }";
    expect(codes(body)).toEqual([]);
    expect(fieldTypeOf(body, 'first')).toEqual('text');
  });

  it('under every language version', () => {
    for (const version of [1, 2, 3] as const) {
      expect(codes(`  pdfs = ${PDFS}\n  t = [e.\`Subject\`, ...pdfs]`, version)).toEqual([]);
    }
  });

  it('a field that itself holds a list keeps the reading it had — its members', () => {
    const body = '  t = [e.`Subject`, ...e-[a:Attachments]->.`Labels`]';
    expect(codes(body)).toEqual([]);
    expect(fieldTypeOf(body, 't')).toEqual({ kind: 'tuple', of: ['text'], rest: { at: 1, of: 'text' } });
  });

  it('a json field is still refused — one landing\'s list would read as several landings', () => {
    expect(codes('  t = [...e-[a:Attachments]->.`Meta`]')).toContain('MOV_LIST_SPREAD_NOT_A_LIST');
  });

  it('a value bound from one landing\'s field is still one value', () => {
    expect(codes('  s = e.`Subject`\n  t = [...s]')).toContain('MOV_LIST_SPREAD_NOT_A_LIST');
  });
});

describe('a tuple read as a list is the list it widens to', () => {
  it('MAP reads the members as their unified type', () => {
    const body = '  t = [e.`Subject`, "x"]\n  u = MAP(t, (s) => { return s })';
    expect(codes(body)).toEqual([]);
    expect(fieldTypeOf(body, 'u')).toEqual({ kind: 'list', of: 'text' });
  });

  it('a variadic tuple widens through its run', () => {
    const body = '  t = [e.`Subject`, ...e.`Tags`]\n  u = MAP(t, (s) => { return s })';
    expect(codes(body)).toEqual([]);
    expect(fieldTypeOf(body, 'u')).toEqual({ kind: 'list', of: 'text' });
  });

  it('a tuple writes into a list field', () => {
    expect(codes('  write inbox-[:log]-> { Tags: [e.`Subject`, ...e.`Tags`] }')).toEqual([]);
    expect(codes('  t = [e.`Subject`, "x"]\n  write inbox-[:log]-> { Tags: t }')).toEqual([]);
  });

  it('nested literals widen at every depth, as a list of lists always typed', () => {
    const body = '  t = [[1, 2], [3]]\n  u = MAP(t, (row) => { return row })';
    expect(codes(body)).toEqual([]);
    expect(fieldTypeOf(body, 'u')).toEqual({ kind: 'list', of: { kind: 'list', of: 'number' } });
  });

  it('values that share no type read as a list nobody can type — silent, as before', () => {
    // `[1, "a"]` was an untyped list before it was a tuple; reading it as a
    // list stays exactly that, so nothing that validated stops validating.
    expect(codes('  j = JOIN([1, e.`Subject`], ", ")')).toEqual([]);
    expect(codes('  write inbox-[:log]-> { note: [1, e.`Subject`] }')).toEqual([]);
  });
});

describe('a record and a value in one literal', () => {
  const MIXED = '  one = node { name: "Acme" }\n  both = [one, e.`Subject`]';

  it('is a tuple, and accepted', () => {
    expect(codes(MIXED)).toEqual([]);
    expect(codes(`${MIXED}\n  s = AT(both, 1)`)).toEqual([]);
    expect(fieldTypeOf(`${MIXED}\n  s = AT(both, 1)`, 's')).toEqual('text');
  });

  it('is refused where it is read as a list — written into a list field', () => {
    const body = `${MIXED}\n  write inbox-[:log]-> { Tags: both }`;
    expect(codes(body)).toContain('MOV_LIST_MIXED');
    expect(messages(body)).toContain('one kind of thing');
  });

  it('is refused where it is read as a list — handed to MAP', () => {
    expect(codes(`${MIXED}\n  u = MAP(both, (b) => { return b })`)).toContain('MOV_LIST_MIXED');
  });

  it('is refused when written in place where a list is read', () => {
    expect(codes('  one = node { name: "Acme" }\n  n = COUNT([one, "label"])')).toContain('MOV_LIST_MIXED');
  });
});

// Versions 1 and 2 typed a list literal as the list it reads as, so an index
// read off one was `T | absent` for whatever the members share: a walk off a
// slot of records was never checked against the slot's own record. Version 3
// reads the slot exactly, which refuses programs those versions accepted — so
// a movement pinned to either keeps the list typing.
const TWO = [
  '  one = node { label: "A", tag: node { name: "A" } }',
  '  two = node { label: "B", tag: node { name: "B" } }',
  '  both = [one, two]',
].join('\n');
const walk = (root: string) => `  ${root}-[t:missing]-> {\n    write inbox-[:log]-> { note: t.name }\n  }`;

describe('under version 2, a list literal is the list it reads as', () => {
  const V2 = 2;

  it('a slot reads the record the members unify to, maybe absent, as an index read of a list does', () => {
    expect(fieldTypeOf(`${TWO}\n  s = AT(both, 1)`, 's', V2)).toEqual({ kind: 'maybeAbsent', of: { kind: 'record' } });
  });

  it('walking an edge the slot has not got validates — the walk runs zero times', () => {
    expect(codes(`${TWO}\n${walk('AT(both, 1)')}`, V2)).toEqual([]);
  });

  it('the same walk off the slot bound to a name first', () => {
    expect(codes(`${TWO}\n  s = AT(both, 1)\n${walk('s')}`, V2)).toEqual([]);
  });

  it('the same walk off a list of records held in a dict', () => {
    expect(codes(`${TWO}\n  d = { k: both }\n${walk('AT(AT(d, "k"), 0)')}`, V2)).toEqual([]);
  });

  it('a null alongside the records leaves the slot unknown', () => {
    expect(codes(`${TWO}\n  some = [one, null]\n${walk('AT(some, 0)')}`, V2)).toEqual([]);
  });

  it('a slot of values reads what the values share', () => {
    expect(fieldTypeOf('  t = ["a", "b"]\n  s = AT(t, 0)', 's', V2)).toEqual({ kind: 'maybeAbsent', of: 'text' });
    expect(codes('  t = ["a", 1]\n  n = AT(t, 0) * 2', V2)).toEqual([]);
  });

  it('a key off a dict slot is not checked against that dict', () => {
    expect(codes('  d = [{ a: 1 }, { b: 2 }]\n  x = AT(AT(d, 0), "b")', V2)).toEqual([]);
  });

  it('a record beside a value is refused where the literal is written', () => {
    expect(codes(`${TWO}\n  mixed = [one, e.\`Subject\`]`, V2)).toEqual(['MOV_LIST_MIXED']);
  });
});

describe('under version 3, a literal index reads its slot exactly', () => {
  it('a slot of records is that record', () => {
    expect(codes(`${TWO}\n  s = AT(both, 1)`)).toEqual([]);
    expect(fieldTypeOf(`${TWO}\n  s = AT(both, 1)`, 's')).toMatchObject({ kind: 'record' });
  });

  it('walking an edge the slot has not got is refused', () => {
    expect(codes(`${TWO}\n${walk('AT(both, 1)')}`)).toEqual(['MOV_TRAVERSE_UNKNOWN_EDGE']);
    expect(codes(`${TWO}\n  d = { k: both }\n${walk('AT(AT(d, "k"), 0)')}`)).toEqual(['MOV_TRAVERSE_UNKNOWN_EDGE']);
  });

  it('arithmetic on a text slot is refused', () => {
    expect(codes('  t = ["a", 1]\n  n = AT(t, 0) * 2')).toEqual(['MOV_ARITH_NON_NUMERIC']);
  });

  it('a key the dict slot was not written with is refused', () => {
    expect(codes('  d = [{ a: 1 }, { b: 2 }]\n  x = AT(AT(d, 0), "b")')).toEqual(['MOV_DICT_UNKNOWN_KEY']);
  });

  it('a record beside a value is a tuple, and its slot reads exactly', () => {
    const body = `${TWO}\n  mixed = [one, e.\`Subject\`]\n${walk('AT(mixed, 0)')}`;
    expect(codes(body)).toEqual(['MOV_TRAVERSE_UNKNOWN_EDGE']);
  });
});
