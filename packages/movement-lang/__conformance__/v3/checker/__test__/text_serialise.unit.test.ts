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

function check(body: string): Diagnostic[] {
  const source = `import { email } from adapters
inbox = email()

movement m(e: <inbox-[:message]->>) {
${body}
}`;
  return checkProgram(parseProgram(source), catalog).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}
const codes = (body: string): string[] => check(body).map((d) => d.code);
const messages = (body: string): string => check(body).map((d) => d.message).join('\n');

describe('TEXT.SERIALISE checks at save', () => {
  it('any value with a written "JSON" format is clean, and the result is text', () => {
    expect(
      codes(
        [
          '  d = { subject: e.`Subject`, seen: e.`Seen`, n: e.`Count`, tags: ["a", "b"] }',
          '  write inbox-[:note]-> { Body: TEXT.SERIALISE(d, "JSON") }',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('scalars, lists and dates serialise without a record in sight', () => {
    expect(
      codes(
        [
          '  write inbox-[:note]-> { Body: TEXT.SERIALISE(e.`Seen`, "JSON") }',
          '  write inbox-[:note]-> { Body: TEXT.SERIALISE(["a", "b"], "JSON") }',
          '  write inbox-[:note]-> { Body: TEXT.SERIALISE(e.`Count`, "JSON") }',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('a node literal is a record whose fields the program holds', () => {
    expect(
      codes(
        [
          '  r = node { subject: e.`Subject`, sub: node { z: 1 } }',
          '  write inbox-[:note]-> { Body: TEXT.SERIALISE(r, "JSON") }',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('a record holding a lazy edge is refused — the walk has not run', () => {
    const body = [
      '  r = node { items: lazy e-[p:Parts]-> }',
      '  write inbox-[:note]-> { Body: TEXT.SERIALISE(r, "JSON") }',
    ].join('\n');
    expect(codes(body)).toEqual(['MOV_STDLIB_ARG_LAZY_EDGE']);
    expect(messages(body)).toContain("'items'");
  });

  it('a lazy edge inside a nested node is refused too', () => {
    const body = [
      '  r = node { inner: node { items: lazy e-[p:Parts]-> } }',
      '  write inbox-[:note]-> { Body: TEXT.SERIALISE(r, "JSON") }',
    ].join('\n');
    expect(codes(body)).toEqual(['MOV_STDLIB_ARG_LAZY_EDGE']);
  });

  it('an unknown literal format is refused, with the known formats', () => {
    const body = '  write inbox-[:note]-> { Body: TEXT.SERIALISE(e.`Subject`, "YAML") }';
    expect(codes(body)).toEqual(['MOV_STDLIB_ARG_INVALID']);
    expect(messages(body)).toContain('"JSON"');
  });

  it('a near miss gets a did-you-mean', () => {
    const body = '  write inbox-[:note]-> { Body: TEXT.SERIALISE(e.`Subject`, "json") }';
    expect(codes(body)).toEqual(['MOV_STDLIB_ARG_INVALID']);
    expect(messages(body)).toContain('did you mean "JSON"');
  });

  it('a computed format is refused — formats are compared, never parsed at run', () => {
    const body =
      '  f = e.`Subject`\n  write inbox-[:note]-> { Body: TEXT.SERIALISE(e.`Subject`, f) }';
    expect(codes(body)).toEqual(['MOV_STDLIB_ARG_NOT_LITERAL']);
    expect(messages(body)).toContain('the format');
  });

  it('a record read live from a system is refused (no field list in hand)', () => {
    const body = '  write inbox-[:note]-> { Body: TEXT.SERIALISE(e, "JSON") }';
    expect(codes(body)).toEqual(['MOV_STDLIB_ARG_NOT_RECORD']);
    expect(messages(body)).toContain('TEXT.SERIALISE');
  });

  it('the wrong number of arguments is refused', () => {
    expect(codes('  write inbox-[:note]-> { Body: TEXT.SERIALISE(e.`Subject`) }').length).toBeGreaterThan(0);
  });
});
