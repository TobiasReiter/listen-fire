// Language version 5's semantics the spelling rewrite alone cannot carry
// (plans/naming-rethink-2026-10-14/5_design.md; the spine report's item (e)):
// each changes what a text means, or needs the checker's knowledge to write
// its fix. Under 4 nothing changes; under 5 the old text is refused with a
// fix, and the fixed program checks clean and means what the old one did.

import { parseProgram } from '../../parser/parse';
import { checkProgram, type Diagnostic } from '../check';
import { mockCatalog, type InstanceSchema } from '../catalog';
import { applyFix } from '../fixes';

const chatSchema: InstanceSchema = {
  positions: {
    channel: {
      properties: { Name: 'text' },
      edges: { Messages: { target: 'message', readable: true, sequenced: 'chronological' } },
    },
    message: { properties: { Text: 'text', Tags: { kind: 'list', of: 'text' } }, edges: {} },
  },
  collections: { Channels: { target: 'channel' } },
};

const catalog = mockCatalog({ adapters: { slack: { constructionArgs: [], schema: chatSchema } } });

function check(source: string, languageVersion: number): Diagnostic[] {
  return checkProgram(parseProgram(source, { languageVersion }), catalog, { languageVersion }).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}

function codes(source: string, languageVersion: number): string[] {
  return check(source, languageVersion).map((d) => d.code);
}

/** Applies every MOV_V5_SPELLING fix, outermost first, until none is left. */
function upgraded(source: string): string {
  for (let round = 0; round < 8; round++) {
    const refused = check(source, 5).filter((d) => d.code === 'MOV_V5_SPELLING');
    if (refused.length === 0) return source;
    const taken: Diagnostic[] = [];
    for (const d of refused) {
      if (d.fix === undefined) throw new Error(`no fix: ${d.message}`);
      const overlaps = (a: Diagnostic): boolean =>
        a.fix!.edits.some((x) => d.fix!.edits.some((y) => !(cmp(x.span.end, y.span.start) <= 0 || cmp(x.span.start, y.span.end) >= 0)));
      if (taken.every((t) => !overlaps(t))) taken.push(d);
    }
    source = applyFix(source, { edits: taken.flatMap((d) => d.fix!.edits) });
  }
  throw new Error(`fixes did not settle:\n${source}`);
}

function cmp(a: { line: number; col: number }, b: { line: number; col: number }): number {
  return a.line - b.line || a.col - b.col;
}

const HEAD4 = 'import { slack } from adapters\nchat = slack()\n\n';
const HEAD5 = 'import { `@lf/slack` as slack } from adapters\nchat = connect slack\n\n';

describe('`!` binds as TypeScript\'s unary operator from version 5', () => {
  const v4 = `${HEAD4}movement go(a: <boolean>, b: <boolean>) {\n  if !a == b {\n    x = 1\n  }\n}`;
  const v5 = `${HEAD5}function go(a: <boolean>, b: <boolean>) {\n  if (!a == b) {\n    x = 1\n  }\n}`;

  it('under 4 the text reads as before', () => {
    expect(codes(v4, 4)).toEqual([]);
  });

  it('under 5 the text whose reading changed is refused; the fix writes out the old reading', () => {
    const refused = check(v5, 5).filter((d) => d.code === 'MOV_V5_SPELLING');
    expect(refused).toHaveLength(1);
    expect(refused[0].fix?.edits[0].text).toBe('!(a == b)');
    const fixed = upgraded(v5);
    expect(fixed).toContain('if (!(a == b)) {');
    expect(codes(fixed, 5)).toEqual([]);
    expect(codes(`${HEAD5}function go(a: <boolean>, b: <boolean>) {\n  if ((!a) == b) {\n    x = 1\n  }\n}`, 5)).toEqual([]);
  });
});

describe('narrowing on `!= null` and `== null { fail(…) }` is what EXISTS and ISNULL gave', () => {
  const crmSchema: InstanceSchema = {
    positions: {
      Channel: { properties: { Name: 'text', Topic: 'text' }, edges: { Messages: { target: 'Message', writable: true } } },
      Message: { properties: { Message: 'text' }, edges: {} },
    },
    collections: { Channels: { target: 'Channel' } },
    writableRoots: {
      Channel: { fields: { Name: 'text' }, resultShape: { externalId: 'text' } },
      Message: { fields: { Message: 'text' }, resultShape: { externalId: 'text' } },
    },
  };
  const chatCatalog = mockCatalog({ adapters: { chat: { constructionArgs: [], schema: crmSchema } } });
  const run = (body: string, languageVersion: number): string[] => {
    const source =
      languageVersion >= 5
        ? `import { \`@lf/chat\` as chat } from adapters\nc = connect chat\n\nfunction go() {\n${body}\n}`
        : `import { chat } from adapters\nc = chat()\n\nmovement go() {\n${body}\n}`;
    return checkProgram(parseProgram(source, { languageVersion }), chatCatalog, { languageVersion })
      .filter((d) => (d.severity ?? 'error') === 'error')
      .map((d) => d.code);
  };
  const SELECT4 = '  channel = ONLY(c-[h:Channels WHERE h.Name == "alerts"]->)';
  const SELECT5 = '  channel = only(c-[h:Channels WHERE h.Name == "alerts"]->)';
  const NAME4 = '  n = ONLY(c-[h:Channels]->.Name)';
  const NAME5 = '  n = only(c-[h:Channels]->.Name)';
  const WRITE = '  write channel-[:Messages]-> { Message: "hi" }';
  const WRITE_N = '  write c-[:Channels]-> { Name: n }';
  const WRITE_TOPIC = '  write c-[:Channels]-> { Name: channel.Topic }';

  const pairs: Array<[string, string, string]> = [
    ['nothing proves the record present', `${SELECT4}\n${WRITE}`, `${SELECT5}\n${WRITE}`],
    ['a record, in the arm', `${SELECT4}\n  if EXISTS(channel) {\n${WRITE}\n  }`, `${SELECT5}\n  if (channel != null) {\n${WRITE}\n  }`],
    ['a value, in the arm', `${NAME4}\n  if EXISTS(n) {\n${WRITE_N}\n  }`, `${NAME5}\n  if (n != null) {\n${WRITE_N}\n  }`],
    ['a field off the record it came off, in the arm', `${SELECT4}\n  if EXISTS(channel.Topic) {\n${WRITE_TOPIC}\n  }`, `${SELECT5}\n  if (channel.Topic != null) {\n${WRITE_TOPIC}\n  }`],
    ['the narrowing ends with the arm', `${SELECT4}\n  if EXISTS(channel) {\n  }\n${WRITE}`, `${SELECT5}\n  if (channel != null) {\n  }\n${WRITE}`],
    ['a guard clause, below the if', `${NAME4}\n  if ISNULL(n) {\n    ERROR("no name")\n  }\n${WRITE_N}`, `${NAME5}\n  if (n == null) {\n    fail("no name")\n  }\n${WRITE_N}`],
    ['a guard clause on a record', `${SELECT4}\n  if NOT EXISTS(channel) {\n    ERROR("none")\n  }\n${WRITE}`, `${SELECT5}\n  if (channel == null) {\n    fail("none")\n  }\n${WRITE}`],
    ['a guard clause on a field', `${SELECT4}\n  if ISNULL(channel.Topic) {\n    ERROR("no topic")\n  }\n${WRITE_TOPIC}`, `${SELECT5}\n  if (channel.Topic == null) {\n    fail("no topic")\n  }\n${WRITE_TOPIC}`],
    ['an arm that does not end proves nothing below it', `${NAME4}\n  if ISNULL(n) {\n  }\n${WRITE_N}`, `${NAME5}\n  if (n == null) {\n  }\n${WRITE_N}`],
    ['under || nothing is proved', `${NAME4}\n  if EXISTS(n) OR 1 == 1 {\n${WRITE_N}\n  }`, `${NAME5}\n  if (n != null || 1 == 1) {\n${WRITE_N}\n  }`],
  ];

  it.each(pairs)('%s', (_, v4, v5) => {
    expect(run(v5, 5)).toEqual(run(v4, 4));
  });

  it('the pairs are not vacuous: an unproved read is refused', () => {
    expect(run(`${SELECT5}\n${WRITE}`, 5)).toEqual(['MOV_ABSENT_REQUIRED']);
    expect(run(`${NAME5}\n  if (n == null) {\n  }\n${WRITE_N}`, 5)).toEqual(['MOV_ABSENT_REQUIRED']);
  });

  it('the old forms under 5 upgrade to the new ones, which check the same', () => {
    const old = `import { chat } from adapters\nc = chat()\n\nmovement go() {\n${NAME4}\n  if ISNULL(n) {\n    ERROR("no name")\n  }\n  if EXISTS(n) {\n${WRITE_N}\n  }\n}`;
    const fixedCheck = (source: string): string[] =>
      checkProgram(parseProgram(source, { languageVersion: 5 }), chatCatalog, { languageVersion: 5 })
        .filter((d) => (d.severity ?? 'error') === 'error')
        .map((d) => d.code);
    let source = old;
    for (let round = 0; round < 8; round++) {
      const refused = checkProgram(parseProgram(source, { languageVersion: 5 }), chatCatalog, { languageVersion: 5 }).filter(
        (d) => d.code === 'MOV_V5_SPELLING',
      );
      if (refused.length === 0) break;
      const d = refused[refused.length - 1];
      source = applyFix(source, d.fix!);
    }
    expect(source).toContain('if (n == null) {\n    fail("no name")');
    expect(source).toContain('if (n != null) {');
    expect(fixedCheck(source)).toEqual([]);
  });
});
