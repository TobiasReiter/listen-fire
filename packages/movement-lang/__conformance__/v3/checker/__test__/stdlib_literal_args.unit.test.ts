// A stdlib argument the function PARSES is checked where it is written.
//
// `DATE.FORMAT(d, "MMMM D, YYYY")`'s second argument is a little language, not
// a value passed through — so a typo in it prints wrong output rather than
// failing, and nobody finds out. Two rules, both at save: the pattern has to be
// written down (a computed one cannot be read here), and it has to be made of
// tokens.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';

const schema: InstanceSchema = {
  positions: {
    message: { properties: { Subject: 'text', Seen: 'datetime' }, edges: {} },
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

describe('DATE.FORMAT checks its pattern at save', () => {
  it('a written pattern of tokens is clean, and the call types as text', () => {
    expect(
      codes('  write inbox-[:note]-> { Body: DATE.FORMAT(e.`Seen`, "MMMM D, YYYY") }'),
    ).toEqual([]);
  });

  it('an unknown token is refused, with the vocabulary and a did-you-mean', () => {
    const body = '  write inbox-[:note]-> { Body: DATE.FORMAT(e.`Seen`, "Day D") }';
    expect(codes(body)).toContain('MOV_STDLIB_ARG_INVALID');
    expect(messages(body)).toContain("Did you mean 'DD'?");
    expect(messages(body)).toContain('YYYY');
  });

  it('a computed pattern is refused — nothing here could check it', () => {
    const body =
      '  p = e.`Subject`\n  write inbox-[:note]-> { Body: DATE.FORMAT(e.`Seen`, p) }';
    expect(codes(body)).toContain('MOV_STDLIB_ARG_NOT_LITERAL');
    expect(messages(body)).toContain('the format pattern');
  });

  it('a function with no parsed argument is untouched', () => {
    expect(
      codes('  write inbox-[:note]-> { Body: TEXT.SLUG(e.`Subject`) }'),
    ).toEqual([]);
  });
});

describe('NUMBER.FORMAT checks its style at save', () => {
  // NUMBER.FORMAT is maybeAbsent (like DATE.PARSE / URL.HOST), so a write
  // into the required `Body` field needs COALESCE — same as every other
  // maybeAbsent helper's tests elsewhere in this file.
  const write = (value: string) => `  write inbox-[:note]-> { Body: COALESCE(${value}, "") }`;

  it('a written "compact" or "grouped" style is clean', () => {
    expect(codes(write('NUMBER.FORMAT(3, "compact")'))).toEqual([]);
    expect(codes(write('NUMBER.FORMAT(3, "grouped")'))).toEqual([]);
  });

  it('an unknown style is refused, naming the two', () => {
    const body = write('NUMBER.FORMAT(3, "percent")');
    expect(codes(body)).toContain('MOV_STDLIB_ARG_INVALID');
    expect(messages(body)).toContain('compact');
    expect(messages(body)).toContain('grouped');
  });

  it('a computed style is refused — nothing here could check it', () => {
    const body = '  p = e.`Subject`\n' + write('NUMBER.FORMAT(3, p)');
    expect(codes(body)).toContain('MOV_STDLIB_ARG_NOT_LITERAL');
    expect(messages(body)).toContain('the format style');
  });
});

describe('DATE.TODAY and DATETIME.AT check their zone and time at save', () => {
  const write = (value: string) => `  write inbox-[:note]-> { Body: ${value} }`;

  it('a written zone and a written time are clean', () => {
    expect(codes(write('DATE.TODAY("Europe/Berlin")'))).toEqual([]);
    expect(
      codes(write('DATETIME.AT(DATE.TODAY("Europe/Berlin"), "07:00", "Europe/Berlin")')),
    ).toEqual([]);
  });

  it('an unrecognised zone is refused with an example', () => {
    const body = write('DATE.TODAY("Europe/Berln")');
    expect(codes(body)).toContain('MOV_STDLIB_ARG_INVALID');
    expect(messages(body)).toContain('not a recognised IANA time zone');
  });

  it('a time that is not 24-hour HH:mm is refused', () => {
    const body = write('DATETIME.AT(e.`Seen`, "7am", "UTC")');
    expect(codes(body)).toContain('MOV_STDLIB_ARG_INVALID');
    expect(messages(body)).toContain('24-hour HH:mm');
    expect(codes(write('DATETIME.AT(e.`Seen`, "25:00", "UTC")'))).toContain(
      'MOV_STDLIB_ARG_INVALID',
    );
  });

  it('a computed zone or time is refused — nothing here could check it', () => {
    const zone = '  z = e.`Subject`\n' + write('DATE.TODAY(z)');
    expect(codes(zone)).toContain('MOV_STDLIB_ARG_NOT_LITERAL');
    expect(messages(zone)).toContain('the time zone');

    const time = '  t = e.`Subject`\n' + write('DATETIME.AT(e.`Seen`, t, "UTC")');
    expect(codes(time)).toContain('MOV_STDLIB_ARG_NOT_LITERAL');
    expect(messages(time)).toContain('the time of day');
  });
});
