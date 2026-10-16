// TEXT.SERIALISE(value, format) at save: the format is a written-down literal
// compared against the known formats, the call types as text that is always
// present, and any value is accepted — except a record the program does not
// hold the fields of (the same refusal TEXT.PAIRS makes for one).

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';

const schema: InstanceSchema = {
  positions: {
    message: {
      properties: { Subject: 'text', Seen: 'datetime', Count: 'number' },
      edges: { Parts: { target: 'note', readable: true } },
    },
    note: { properties: { Body: 'text' }, edges: {} },
  },
  collections: { messages: { target: 'message' }, note: { target: 'note' } },
  writableRoots: {
    note: { fields: { Body: 'text' }, resultShape: { Body: 'text' }, edges: {} },
  },
};

const catalog = mockCatalog({
  adapters: { email: { constructionArgs: [], schema } },
});

// From version 5 the call is `Json.stringify(value)`: there is no format argument
// to check, so what is checked about the format is a version 4 program.
function check(body: string, version: 4 | 5 = 5): Diagnostic[] {
  const source =
    version === 4
      ? `import { email } from adapters
inbox = email()

movement m(e: <inbox-[:message]->>) {
${body}
}`
      : `import { email } from adapters
inbox = connect email

function m(e: <inbox-[:message]->>) {
${body}
}`;
  return checkProgram(parseProgram(source, { languageVersion: version }), catalog, { languageVersion: version }).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}
const codes = (body: string, version: 4 | 5 = 5): string[] => check(body, version).map((d) => d.code);
const messages = (body: string, version: 4 | 5 = 5): string => check(body, version).map((d) => d.message).join('\n');

describe('TEXT.SERIALISE checks at save', () => {
  it('any value with a written "JSON" format is clean, and the result is text', () => {
    expect(
      codes(
        [
          '  d = { subject: e.`Subject`, seen: e.`Seen`, n: e.`Count`, tags: ["a", "b"] }',
          '  write inbox-[:note]-> { Body: Json.stringify(d) }',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('scalars, lists and dates serialise without a record in sight', () => {
    expect(
      codes(
        [
          '  write inbox-[:note]-> { Body: Json.stringify(e.`Seen`) }',
          '  write inbox-[:note]-> { Body: Json.stringify(["a", "b"]) }',
          '  write inbox-[:note]-> { Body: Json.stringify(e.`Count`) }',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('a node literal is a record whose fields the program holds', () => {
    expect(
      codes(
        [
          '  r = node { subject: e.`Subject`, sub: node { z: 1 } }',
          '  write inbox-[:note]-> { Body: Json.stringify(r) }',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('a record holding a lazy edge is refused — the walk has not run', () => {
    const body = [
      '  r = node { items: lazy e-[p:Parts]-> }',
      '  write inbox-[:note]-> { Body: Json.stringify(r) }',
    ].join('\n');
    expect(codes(body)).toEqual(['MOV_STDLIB_ARG_LAZY_EDGE']);
    expect(messages(body)).toContain("'items'");
  });

  it('a lazy edge inside a nested node is refused too', () => {
    const body = [
      '  r = node { inner: node { items: lazy e-[p:Parts]-> } }',
      '  write inbox-[:note]-> { Body: Json.stringify(r) }',
    ].join('\n');
    expect(codes(body)).toEqual(['MOV_STDLIB_ARG_LAZY_EDGE']);
  });

  it('an unknown literal format is refused, with the known formats (version 4)', () => {
    const body = '  write inbox-[:note]-> { Body: TEXT.SERIALISE(e.`Subject`, "YAML") }';
    expect(codes(body, 4)).toEqual(['MOV_STDLIB_ARG_INVALID']);
    expect(messages(body, 4)).toContain('"JSON"');
  });

  it('a near miss gets a did-you-mean (version 4)', () => {
    const body = '  write inbox-[:note]-> { Body: TEXT.SERIALISE(e.`Subject`, "json") }';
    expect(codes(body, 4)).toEqual(['MOV_STDLIB_ARG_INVALID']);
    expect(messages(body, 4)).toContain('did you mean "JSON"');
  });

  it('a computed format is refused — formats are compared, never parsed at run (version 4)', () => {
    const body =
      '  f = e.`Subject`\n  write inbox-[:note]-> { Body: TEXT.SERIALISE(e.`Subject`, f) }';
    expect(codes(body, 4)).toEqual(['MOV_STDLIB_ARG_NOT_LITERAL']);
    expect(messages(body, 4)).toContain('the format');
  });

  it('a record read live from a system is refused (no field list in hand)', () => {
    const body = '  write inbox-[:note]-> { Body: Json.stringify(e) }';
    expect(codes(body)).toEqual(['MOV_STDLIB_ARG_NOT_RECORD']);
    expect(messages(body)).toContain('Json.stringify');
  });

  it('the wrong number of arguments is refused', () => {
    expect(codes('  write inbox-[:note]-> { Body: TEXT.SERIALISE(e.`Subject`) }', 4).length).toBeGreaterThan(0);
    expect(codes('  write inbox-[:note]-> { Body: Json.stringify(e.`Subject`, "JSON") }').length).toBeGreaterThan(0);
  });
});
