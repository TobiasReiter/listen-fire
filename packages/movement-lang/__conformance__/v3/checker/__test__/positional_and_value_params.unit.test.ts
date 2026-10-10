// Checker coverage for POSITIONAL calls and VALUE parameters — what TypeScript
// does: `f(a, b)` binds its arguments to the declared parameters in order, and
// a parameter may take a value (`<text>`, `<text[]>`, a refinement) or a config
// record spelled as an object type (`<{ mode: text, owner?: text }>`), with the
// excess-property check on a record literal.
//
// Named calls keep their meaning; a call is all positional or all named.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic, DiagnosticCodes as C } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';

const inboxSchema: InstanceSchema = {
  positions: {
    message: {
      properties: {
        Subject: 'text',
        Count: 'number',
        Snoozed: { kind: 'maybeAbsent', of: 'number' },
      },
      edges: {},
    },
  },
  collections: { messages: { target: 'message' } },
  writableRoots: {},
};

const chatSchema: InstanceSchema = {
  positions: {
    note: { properties: { Body: 'text' }, edges: {} },
  },
  collections: { note: { target: 'note' } },
  writableRoots: {
    note: { fields: { Body: 'text' }, resultShape: { Body: 'text' }, edges: {} },
  },
};

const catalog = mockCatalog({
  adapters: {
    email: { constructionArgs: [], schema: inboxSchema },
    slack: { constructionArgs: [], schema: chatSchema },
  },
  plugins: {
    fetch_url: {
      args: ['url', 'mode'],
      effects: { reads: ['the web'] },
      output: { kind: 'value', type: 'text' },
    },
  },
});

const PRELUDE = `import { email, slack } from adapters
import { fetch_url } from plugins
inbox = email()
chat = slack()
type Tone = <"brisk" | "warm">

movement log_two(m: <inbox-[:message]->>, n: <inbox-[:message]->>) {
}

movement say(m: <inbox-[:message]->>, text: <text>, count: <number>) {
  write chat-[:note]-> { Body: text }
}

movement tag_all(tags: <text[]>) {
  t = AT(tags, 0)
}

movement toned(tone: <Tone>) {
  write chat-[:note]-> { Body: tone }
}

movement configured(m: <inbox-[:message]->>, cfg: <{ mode: text, owner?: text }>) {
  write chat-[:note]-> { Body: AT(cfg, "mode") }
}

movement pick(m: <inbox-[:message]->>) {
  return node { s: m.\`Subject\` }
}
`;

function check(body: string, extra = ''): Diagnostic[] {
  const source = `${PRELUDE}${extra}
movement main(e: <inbox-[:message]->>) {
${body}
}`;
  return checkProgram(parseProgram(source), catalog).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}
const codes = (body: string, extra = ''): string[] => check(body, extra).map(d => d.code);
const messages = (body: string, extra = ''): string => check(body, extra).map(d => d.message).join('\n');

describe('positional binding — arguments bind in declared order', () => {
  it('a positional call checks clean, statement and bound', () => {
    expect(codes('  log_two(e, e)')).toEqual([]);
    expect(codes('  v = pick(e)')).toEqual([]);
  });

  it('a positional call passed as an argument is a call', () => {
    expect(codes('  log_two(e, e)\n  x = pick(pick_arg(e))', '\nmovement pick_arg(m: <inbox-[:message]->>) {\n  return m\n}\n')).toEqual([]);
  });

  it('too many or too few positional arguments is the arity error, naming what is missing', () => {
    expect(codes('  log_two(e)')).toEqual(expect.arrayContaining([C.CALL_ARITY, C.CALL_ARG_MISSING]));
    expect(messages('  log_two(e)')).toContain("'n'");
    expect(messages('  log_two(e)')).toContain('in order: log_two(m, n)');
    expect(codes('  log_two(e, e, e)')).toEqual([C.CALL_ARITY]);
  });

  it('a type mismatch by position names the parameter it binds', () => {
    const found = check('  say(e, "hi", "three")');
    expect(found.map(d => d.code)).toEqual([C.CALL_ARG_TYPE]);
    expect(found[0].message).toContain("for 'count' (argument 3)");
    expect(found[0].message).toContain('number');
  });

  it('existing named calls are unchanged — order-free, same diagnostics', () => {
    expect(codes('  log_two(n: e, m: e)')).toEqual([]);
    expect(codes('  log_two(m: e)')).toEqual(expect.arrayContaining([C.CALL_ARITY, C.CALL_ARG_MISSING]));
    expect(messages('  log_two(m: e)')).toContain('supply every parameter by name');
    expect(codes('  log_two(m: e, x: e)')).toContain(C.CALL_ARG_UNKNOWN);
  });

  it('a plugin takes named arguments only', () => {
    expect(codes('  page = fetch_url("https://x.test")')).toEqual([C.PLUGIN_ARGS_NAMED]);
    expect(codes('  page = fetch_url(url: "https://x.test")')).not.toContain(C.PLUGIN_ARGS_NAMED);
  });

  it('a built-in function call stays an expression', () => {
    expect(codes('  s = UPPER(e.`Subject`)')).toEqual([]);
  });
});

describe('value parameters', () => {
  it('a scalar parameter takes a value of its type, and refuses another', () => {
    expect(codes('  say(e, "hi", 3)')).toEqual([]);
    expect(codes('  say(e, e.`Subject`, e.`Count`)')).toEqual([]);
    expect(messages('  say(m: e, text: "hi", count: "3")')).toContain("'say' expects number, but this argument is text");
  });

  it('a value that may be absent does not fill a parameter that requires one', () => {
    expect(messages('  say(e, "hi", e.`Snoozed`)')).toContain('may be absent');
  });

  it('a list parameter takes a list of its member', () => {
    expect(codes('  tag_all(["a", "b"])')).toEqual([]);
    expect(codes('  tag_all([1, 2])')).toEqual([C.CALL_ARG_TYPE]);
  });

  it('a refinement parameter takes one of its values, and names a typo', () => {
    expect(codes('  toned("warm")')).toEqual([]);
    expect(messages('  toned("wram")')).toContain('warm');
    expect(codes('  toned("wram")')).toEqual([C.ENUM_UNKNOWN_VALUE]);
  });

  it('a record key typed by a refinement takes one of its values', () => {
    const extra = '\nmovement styled(cfg: <{ tone: Tone }>) {\n}\n';
    expect(codes('  styled({ tone: "brisk" })', extra)).toEqual([]);
    expect(codes('  styled({ tone: "brusk" })', extra)).toEqual([C.ENUM_UNKNOWN_VALUE]);
  });

  it('a scalar parameter reads as its type inside the movement', () => {
    expect(
      codes('', '\nmovement total(n: <number>) {\n  x = n + 1\n  write chat-[:note]-> { Body: n }\n}\n'),
    ).toEqual([]);
  });

  it('a value passed to a POSITION parameter is still refused', () => {
    const found = check('  log_two(e, "hello")');
    expect(found.map(d => d.code)).toEqual([C.CALL_ARG_TYPE]);
    expect(found[0].message).toContain("for 'n' (argument 2)");
  });

  it('a callback still refuses a list or record parameter left for the platform', () => {
    expect(codes('  cb = callback((tags: <text[]>) => { })')).toContain(C.CALLBACK_PARAM_NOT_VALUE);
  });

  it('a listen cannot fire a movement that takes a value', () => {
    expect(codes('', '\nlisten to inbox {} fire tag_all\n')).toContain(C.LISTEN_PARAM_MISMATCH);
  });
});

describe('record (config) parameters — TypeScript object types', () => {
  it('a literal with the required keys checks clean, optional key given or not', () => {
    expect(codes('  configured(e, { mode: "fast" })')).toEqual([]);
    expect(codes('  configured(e, { mode: "fast", owner: "sam" })')).toEqual([]);
  });

  it('a missing required key is refused', () => {
    expect(messages('  configured(e, { owner: "sam" })')).toContain("missing the key 'mode'");
  });

  it('an excess key on a literal is refused, with a did-you-mean', () => {
    const message = messages('  configured(e, { mode: "fast", ownr: "sam" })');
    expect(message).toContain("no key 'ownr'");
    expect(message).toContain('owner');
  });

  it('a key of the wrong type is refused', () => {
    expect(messages('  configured(e, { mode: 3 })')).toContain("its key 'mode' takes text");
  });

  it('an optional key reads as possibly absent inside the movement', () => {
    const extra = '\nmovement owned(cfg: <{ mode: text, owner?: text }>) {\n  write chat-[:note]-> { Body: AT(cfg, "owner") }\n}\n';
    expect(codes('', extra)).not.toEqual([]);
    const filled = '\nmovement owned(cfg: <{ mode: text, owner?: text }>) {\n  write chat-[:note]-> { Body ?: AT(cfg, "owner") }\n}\n';
    expect(codes('', filled)).toEqual([]);
  });

  it('an unknown member type is named', () => {
    expect(codes('', '\nmovement bad(cfg: <{ mode: txt }>) {\n}\n')).toContain(C.UNKNOWN_TYPE_NAME);
  });
});

describe('value parameters arrived with language version 3', () => {
  const source = 'movement total(n: <number>) {\n}\n';
  const errors = (languageVersion: number) =>
    checkProgram(parseProgram(source, { languageVersion }), catalog, { languageVersion })
      .filter((d) => (d.severity ?? 'error') === 'error')
      .map((d) => d.code);

  it('under version 2 a scalar-typed movement parameter is still the name it failed to resolve as', () => {
    expect(errors(2)).not.toEqual([]);
    expect(errors(3)).toEqual([]);
  });
});
