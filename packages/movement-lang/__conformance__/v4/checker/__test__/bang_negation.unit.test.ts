// `!` is NOT (TypeScript's spelling). It used to be dropped by the formula
// tokenizer, so `if !EXISTS(…)` checked — and ran — as `if EXISTS(…)`. Pinned
// here through the checker's own reading of a condition: presence narrowing is
// where a negation shows in the types, since `EXISTS(x)` proves `x` inside its
// arm and `NOT EXISTS(x)` proves nothing there.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic } from '../check';
import { mockCatalog, type InstanceSchema } from '../catalog';

const chatSchema: InstanceSchema = {
  positions: {
    channel: {
      properties: { Name: 'text' },
      edges: { Messages: { target: 'message', readable: true, sequenced: 'chronological' } },
    },
    message: { properties: { Text: 'text' }, edges: {} },
    note: { properties: { Body: 'text' }, edges: {} },
  },
  collections: { Channels: { target: 'channel' }, note: { target: 'note' } },
  writableRoots: {
    note: { fields: { Body: 'text', Count: 'number' }, resultShape: { Body: 'text' }, edges: {} },
  },
};

const catalog = mockCatalog({ adapters: { slack: { constructionArgs: [], schema: chatSchema } } });

function errors(body: string): Diagnostic[] {
  const source = `import { slack } from adapters
chat = slack()

movement m(c: <chat-[:channel]->>) {
${body}
}`;
  // Errors carry no explicit severity, so a filter on 'error' alone is vacuous.
  return checkProgram(parseProgram(source), catalog).filter((d) => (d.severity ?? 'error') === 'error');
}
const codes = (body: string): string[] => errors(body).map((d) => d.code);

const EXTRACT = ['  r = extract from [c.`Name`] {', '    size: <number> "how many"', '  }', ''].join('\n');
const WRITE_SIZE = 'write chat-[:note]-> { Count: r.size }';

describe('! types as boolean negation', () => {
  it('if !EXISTS(path) checks clean, as NOT EXISTS(path) does', () => {
    const quiet = 'write chat-[:note]-> { Body: "quiet" }';
    expect(codes(`  if !EXISTS(c-[m:Messages]->) { ${quiet} }`)).toEqual([]);
    expect(codes(`  if NOT EXISTS(c-[m:Messages]->) { ${quiet} }`)).toEqual([]);
  });

  it('EXISTS(x) proves x inside its arm; !EXISTS(x) does not — the negation is seen', () => {
    expect(codes(`${EXTRACT}  if EXISTS(r.size) { ${WRITE_SIZE} }`)).toEqual([]);
    expect(codes(`${EXTRACT}  if !EXISTS(r.size) { ${WRITE_SIZE} }`)).toEqual(['MOV_ABSENT_REQUIRED']);
    expect(codes(`${EXTRACT}  if NOT EXISTS(r.size) { ${WRITE_SIZE} }`)).toEqual(['MOV_ABSENT_REQUIRED']);
  });

  it('!ISNULL(x) proves x inside its arm, as NOT ISNULL(x) does', () => {
    expect(codes(`${EXTRACT}  if !ISNULL(r.size) { ${WRITE_SIZE} }`)).toEqual([]);
    expect(codes(`${EXTRACT}  if ISNULL(r.size) { ${WRITE_SIZE} }`)).toEqual(['MOV_ABSENT_REQUIRED']);
  });

  it('!!x is double negation: !!EXISTS(x) proves x again', () => {
    expect(codes(`${EXTRACT}  if !!EXISTS(r.size) { ${WRITE_SIZE} }`)).toEqual([]);
  });
});

describe('an unrecognised character in a condition is a parse diagnostic', () => {
  it.each([
    ['&&', "'&'"],
    ['||', "'|'"],
  ])('if a %s b names the character', (op, named) => {
    const found = errors(`  if EXISTS(c.\`Name\`) ${op} EXISTS(c.\`Name\`) { write chat-[:note]-> { Body: "y" } }`);
    expect(found.map((d) => d.code)).toContain('MOV_EXPR_PARSE');
    expect(found.map((d) => d.message).join('\n')).toContain(`Unrecognised character ${named}`);
  });
});
