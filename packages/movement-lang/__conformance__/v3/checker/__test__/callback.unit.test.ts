// `callback(…)` — the checker (callback-primitive chunk 1).
//
// A callback binds a CHECKER-LOCAL node: `.id` / `.url` reads plus a `Called`
// edge whose landing is derived from the callback's own signature at the
// construction site — `At`, plus one field per fire-time parameter. Nothing is
// grafted and nothing is resolved against a schema: a callback belongs to no
// system, which is exactly why the derivation has to be visible.
//
// TWO FIXTURE SHAPES on purpose: a fixture matching one signature cannot tell
// derived from hardcoded, so every landing assertion runs against two
// signatures with different parameter names and types.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic } from '../check';
import { mockCatalog, type InstanceSchema } from '../catalog';

const schema: InstanceSchema = {
  positions: {
    message: { properties: { subject: 'text', sender: 'text' }, edges: {} },
    note: { properties: { text: 'text' }, edges: {} },
  },
  collections: { message: { target: 'message' }, note: { target: 'note' } },
  writableRoots: {
    note: {
      fields: { text: 'text', due: 'date', at: 'datetime' },
      resultShape: { text: 'text' },
      edges: {},
    },
  },
};

const catalog = mockCatalog({
  adapters: {
    email: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      triggerConfig: ['key'],
      schema,
    },
  },
  credentials: { dealflow_inbox: { adapter: 'email' } },
});

const PRELUDE = `import { email } from adapters
import { dealflow_inbox } from credentials
inbox = email(credentials: dealflow_inbox)
`;

/** `body` inside the entry movement; `extra` holds any helper declarations. */
function check(body: string, extra = ''): Diagnostic[] {
  const source = `${PRELUDE}
${extra}
movement m(msg: <inbox-[:message]->>) {
${body}
}`;
  return checkProgram(parseProgram(source), catalog).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}

const codes = (body: string, extra = ''): string[] => check(body, extra).map((d) => d.code);
const messages = (body: string, extra = ''): string => check(body, extra).map((d) => d.message).join('\n');

describe('the binding: .id and .url read as text; nothing else does', () => {
  it('`.id` and `.url` check clean and type as text (written into a text field)', () => {
    expect(codes([
      '  cb = callback({ write inbox-[:note]-> { text: "done" } })',
      '  write inbox-[:note]-> { text: cb.`id` }',
      '  write inbox-[:note]-> { text: cb.`url` }',
    ].join('\n'))).toEqual([]);
  });

  it('an unknown read is loud and lists what a callback carries', () => {
    const body = '  cb = callback({ write inbox-[:note]-> { text: "x" } })\n  write inbox-[:note]-> { text: cb.`token` }';
    expect(codes(body)).toContain('MOV_UNKNOWN_PROPERTY');
    expect(messages(body)).toMatch(/a callback has no 'token'.*id, url/s);
  });

  it('reading `Called` with a dot points at the traversal', () => {
    const body = '  cb = callback({ write inbox-[:note]-> { text: "x" } })\n  write inbox-[:note]-> { text: cb.`Called` }';
    expect(messages(body)).toMatch(/'Called' is an edge of a callback — traverse it/);
  });

  it('an edge a callback does not have names the one it does', () => {
    const body = '  cb = callback({ write inbox-[:note]-> { text: "x" } })\n  await FIRST(cb-[:Answered]->)';
    expect(codes(body)).toContain('MOV_TRAVERSE_UNKNOWN_EDGE');
    expect(messages(body)).toMatch(/a callback has no edge 'Answered' — it has: Called/);
  });
});

describe('the Called landing is DERIVED from the callback signature', () => {
  it('a zero-parameter callback lands `At` only', () => {
    expect(codes([
      '  cb = callback({ write inbox-[:note]-> { text: "x" } })',
      '  c = await FIRST(cb-[:Called]->)',
      '  write inbox-[:note]-> { at ?: c.`At` }',
    ].join('\n'))).toEqual([]);

    const body = [
      '  cb = callback({ write inbox-[:note]-> { text: "x" } })',
      '  c = await FIRST(cb-[:Called]->)',
      '  write inbox-[:note]-> { text ?: c.`whatever` }',
    ].join('\n');
    expect(messages(body)).toMatch(/a callback's call has no 'whatever' — it carries: At/);
  });

  it("shape 1: a (picked: <date>, note: <text>) signature lands At + picked + note", () => {
    expect(codes([
      '  cb = callback((picked: <date>, note: <text>) => { write inbox-[:note]-> { text: note } })',
      '  c = await FIRST(cb-[:Called]->)',
      '  write inbox-[:note]-> { due ?: c.`picked`, text ?: c.`note` }',
    ].join('\n'))).toEqual([]);
  });

  it('shape 2: a different signature lands DIFFERENT fields (and shape 1\'s names are unknown here)', () => {
    expect(codes([
      '  cb = callback((amount: <number>) => { write inbox-[:note]-> { text: "x" } })',
      '  c = await FIRST(cb-[:Called]->)',
      '  write inbox-[:note]-> { at ?: c.`At` }',
    ].join('\n'))).toEqual([]);

    const body = [
      '  cb = callback((amount: <number>) => { write inbox-[:note]-> { text: "x" } })',
      '  c = await FIRST(cb-[:Called]->)',
      '  write inbox-[:note]-> { due ?: c.`picked` }',
    ].join('\n');
    expect(messages(body)).toMatch(/has no 'picked' — it carries: At, amount/);
  });

  it('a landing field carries its DECLARED type — same name, two declarations, two answers', () => {
    const withType = (type: string) => [
      `  cb = callback((stamp: ${type}) => { write inbox-[:note]-> { text: "x" } })`,
      '  c = await FIRST(cb-[:Called]->)',
      '  write inbox-[:note]-> { due ?: c.`stamp` }',
    ].join('\n');
    expect(codes(withType('<date>'))).toEqual([]);
    expect(codes(withType('<datetime>'))).toContain('MOV_WRITE_FIELD_TYPE');
  });

  it('`At` is a datetime whatever the signature (a date field rejects it)', () => {
    const body = [
      '  cb = callback()',
      '  c = await FIRST(cb-[:Called]->)',
      '  write inbox-[:note]-> { due ?: c.`At` }',
    ].join('\n');
    expect(codes(body)).toContain('MOV_WRITE_FIELD_TYPE');
  });

  it('a body-less callback is a full participant — signature, landing and all', () => {
    expect(codes([
      '  cb = callback((picked: <date>))',
      '  c = await FIRST(cb-[:Called]->)',
      '  write inbox-[:note]-> { due ?: c.`picked` }',
    ].join('\n'))).toEqual([]);
  });
});

describe('Called is awaitable AND readable — the read that waits, and the read that does not', () => {
  it('`await` binds the landing, whose fields are `T | absent` (it may never fire)', () => {
    // A plain (non-`?:`) write field REQUIRES a present value, so the absence
    // shows up here rather than at the read.
    const body = [
      '  cb = callback((picked: <date>))',
      '  c = await FIRST(cb-[:Called]->)',
      '  write inbox-[:note]-> { due: c.`picked` }',
    ].join('\n');
    expect(codes(body)).toContain('MOV_ABSENT_REQUIRED');
  });

  it('a BARE traversal reads the calls so far — no await required, no diagnostics', () => {
    expect(codes([
      '  cb = callback((picked: <date>))',
      '  cb-[c:Called]-> {',
      '    write inbox-[:note]-> { due: c.`picked` }',
      '  }',
    ].join('\n'))).toEqual([]);
  });

  it('a repeatable callback types identically — traversals are many-valued already', () => {
    expect(codes([
      '  cb = callback((picked: <date>), { once: FALSE })',
      '  cb-[c:Called]-> {',
      '    write inbox-[:note]-> { due: c.`picked` }',
      '  }',
    ].join('\n'))).toEqual([]);
  });
});

describe('the body is checked, in the enclosing scope', () => {
  it('an error INSIDE the body surfaces', () => {
    expect(codes('  cb = callback({ write inbox-[:note]-> { text: nonexistent } })')).toContain(
      'MOV_NAME_UNRESOLVED',
    );
  });

  it('an unknown field inside the body surfaces', () => {
    expect(codes('  cb = callback({ write inbox-[:note]-> { nope: "x" } })')).toContain(
      'MOV_WRITE_UNKNOWN_FIELD',
    );
  });

  it('the body CAPTURES the enclosing scope (a handle bound before it reads clean)', () => {
    expect(codes([
      '  n = write inbox-[:note]-> { text: "first" }',
      '  cb = callback({ write inbox-[:note]-> { text: n.`text` } })',
    ].join('\n'))).toEqual([]);
  });

  it('the capture rule is the park\'s: a name bound LATER is use-before-bind, not a capture', () => {
    expect(codes([
      '  cb = callback({ write inbox-[:note]-> { text: later.`text` } })',
      '  later = write inbox-[:note]-> { text: "second" }',
    ].join('\n'))).toContain('MOV_USE_BEFORE_BIND');
  });

  it("a combinator ARM captures what IT can see, and nothing a sibling arm bound", () => {
    // Arms are separate closures, so an arm cannot read a name another arm
    // bound — structurally, with no sibling rule to write down.
    expect(codes([
      '  await parallel([',
      '    () => { a = write inbox-[:note]-> { text: "a" } },',
      '    () => { cb = callback({ write inbox-[:note]-> { text: a.`text` } }) },',
      '  ])',
    ].join('\n'))).toContain('MOV_NAME_UNRESOLVED');
  });

  it('parameters are in scope inside the body, and only there', () => {
    expect(codes('  cb = callback((note: <text>) => { write inbox-[:note]-> { text: note } })')).toEqual([]);
    expect(codes([
      '  cb = callback((note: <text>) => { write inbox-[:note]-> { text: note } })',
      '  write inbox-[:note]-> { text: note }',
    ].join('\n'))).toContain('MOV_NAME_UNRESOLVED');
  });

  it('a duplicate parameter is loud', () => {
    expect(codes('  cb = callback((n: <text>, n: <text>) => { write inbox-[:note]-> { text: n } })')).toContain(
      'MOV_DUPLICATE_DECL',
    );
  });

  it('a parameter typed as a RECORD position is refused — no platform can send one', () => {
    const body = '  cb = callback((rec: <inbox-[:message]->>) => { write inbox-[:note]-> { text: rec.`subject` } })';
    expect(codes(body)).toContain('MOV_CALLBACK_PARAM_NOT_VALUE');
    expect(messages(body)).toMatch(/value the platform sends.*scalar type/s);
  });
});

describe('the named form types against the movement signature', () => {
  const HELPER = [
    'movement send_reminder(subject: <inbox-[:message]->>) {',
    '  write inbox-[:note]-> { text: subject.`subject` }',
    '}',
  ].join('\n');

  it('a movement by name, with its fixed arguments, checks clean', () => {
    expect(codes('  cb = callback(send_reminder(subject: msg))', HELPER)).toEqual([]);
  });

  it('every parameter supplied ⇒ the landing carries `At` alone', () => {
    expect(codes([
      '  cb = callback(send_reminder(subject: msg))',
      '  c = await FIRST(cb-[:Called]->)',
      '  write inbox-[:note]-> { at ?: c.`At` }',
    ].join('\n'), HELPER)).toEqual([]);
    // …and a SUPPLIED parameter is not on the landing: it was fixed at mint time.
    expect(messages([
      '  cb = callback(send_reminder(subject: msg))',
      '  c = await FIRST(cb-[:Called]->)',
      '  write inbox-[:note]-> { text ?: c.`subject` }',
    ].join('\n'), HELPER)).toMatch(/has no 'subject' — it carries: At/);
  });

  it('a parameter left unsupplied that a platform CANNOT send is refused, pointing at the fix', () => {
    const body = '  cb = callback(send_reminder)';
    expect(codes(body, HELPER)).toContain('MOV_CALLBACK_PARAM_NOT_VALUE');
    expect(messages(body, HELPER)).toMatch(/Supply it as a fixed argument instead/);
  });

  it('an argument that is not a parameter is the ordinary named-argument error', () => {
    expect(codes('  cb = callback(send_reminder(subjectt: msg))', HELPER)).toContain('MOV_CALL_ARG_UNKNOWN');
  });

  it('a repeated argument is the ordinary duplicate error', () => {
    expect(codes('  cb = callback(send_reminder(subject: msg, subject: msg))', HELPER)).toContain(
      'MOV_CALL_ARG_DUPLICATE',
    );
  });

  it('an argument of the wrong POSITION type mirrors the call-site fit error', () => {
    const helper = [
      'movement file_it(rec: <inbox-[:note]->>) {',
      '  write inbox-[:note]-> { text: rec.`text` }',
      '}',
    ].join('\n');
    expect(codes('  cb = callback(file_it(rec: msg))', helper)).toContain('MOV_CALL_ARG_TYPE');
  });

  it('an unknown movement name is loud, with a did-you-mean over the file\'s movements', () => {
    const body = '  cb = callback(send_remindr(subject: msg))';
    expect(codes(body, HELPER)).toContain('MOV_CALLBACK_NOT_MOVEMENT');
    expect(messages(body, HELPER)).toMatch(/did you mean 'send_reminder'/);
  });

  it('a name that is not a movement says what it is instead', () => {
    const body = '  cb = callback(inbox)';
    expect(codes(body)).toContain('MOV_CALLBACK_NOT_MOVEMENT');
    expect(messages(body)).toMatch(/'inbox' is .*not a movement/);
  });

  it('a `function`-spelled movement is deferrable exactly like a `movement`-spelled one', () => {
    const helper = HELPER.replace('movement ', 'function ');
    expect(codes('  cb = callback(send_reminder(subject: msg))', helper)).toEqual([]);
  });
});

describe('config is a closed vocabulary', () => {
  it('`once` and `ttl` check clean', () => {
    expect(codes('  cb = callback({ write inbox-[:note]-> { text: "x" } }, { once: FALSE, ttl: 2d })')).toEqual([]);
  });

  it('an unknown key is loud with a did-you-mean', () => {
    const body = '  cb = callback({ write inbox-[:note]-> { text: "x" } }, { onces: FALSE })';
    expect(codes(body)).toContain('MOV_CALLBACK_BAD_CONFIG');
    expect(messages(body)).toMatch(/'onces' is not a callback setting — did you mean 'once'\?.*once, ttl/s);
  });

  it('a non-boolean `once` is loud', () => {
    expect(codes('  cb = callback({ write inbox-[:note]-> { text: "x" } }, { once: "yes" })')).toContain(
      'MOV_CALLBACK_BAD_CONFIG',
    );
  });

  it('a malformed `ttl` is loud, naming the duration form', () => {
    const body = '  cb = callback({ write inbox-[:note]-> { text: "x" } }, { ttl: 2x })';
    expect(codes(body)).toContain('MOV_CALLBACK_BAD_CONFIG');
    expect(messages(body)).toMatch(/not a valid ttl.*4h, 2d, 90m, 1h30m/s);
  });

  it('a repeated setting is loud', () => {
    expect(codes('  cb = callback({ write inbox-[:note]-> { text: "x" } }, { once: FALSE, once: TRUE })')).toContain(
      'MOV_CALLBACK_BAD_CONFIG',
    );
  });
});
