// Checker coverage for `await race([…])` / `await parallel([…])` — the two
// concurrency combinators (core calculus v2 R5).
//
// Both take ONE ordinary argument: the arms, a collection of FUNCTION values
// the combinator calls. The value is POSITIONAL — one slot per arm, in the
// order written — so a literal arms list types as a TUPLE and a literal-index
// read (`AT(r, 0)`) types the slot exactly. `race` makes every slot `T | null`
// (the winner's is filled, the rest are not); `parallel` fills them all.

import { parseProgram } from '../../parser/parse';
import { checkProgram, checkProgramWithLink, Diagnostic } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';

const askSchema: InstanceSchema = {
  positions: {
    message: {
      properties: { Subject: 'text' },
      edges: { Checks: { target: 'check', readable: true } },
    },
    check: {
      properties: { Label: 'text' },
      edges: { Answer: { target: 'answer', readable: true, awaitable: true, watchable: true } },
    },
    answer: { properties: { Text: 'text' }, edges: {} },
    log: { properties: { note: 'text' }, edges: {} },
  },
  collections: { messages: { target: 'message' }, log: { target: 'log' } },
  writableRoots: {
    log: { fields: { note: 'text' }, requiredFields: [], resultShape: { externalId: 'text' } },
  },
};

const catalog = mockCatalog({
  adapters: { email: { constructionArgs: [], schema: askSchema } },
});

function source(body: string): string {
  return `import { email } from adapters
inbox = email()

movement m(e: <inbox-[:message]->>) {
${body}
}`;
}

function check(body: string): Diagnostic[] {
  return checkProgram(parseProgram(source(body)), catalog).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}
const codes = (body: string): string[] => check(body).map((d) => d.code);

function fieldTypeOf(body: string, name: string): unknown {
  const { recording } = checkProgramWithLink(parseProgram(source(body)), catalog, {
    recordAnalysis: true,
  });
  const symbols = (recording?.frames ?? []).flatMap((f) => [...f.scope.symbols.values()]);
  return symbols.find((s) => s.name === name)?.fieldType;
}

const TIMEOUT_RACE =
  '  r = await race([\n'
  + '    () => { return "answered" },\n'
  + '    () => { await sleep(1d) },\n'
  + '  ])\n';

describe('await race — the first arm to settle wins', () => {
  it('a literal arms list types as a tuple, one slot per arm', () => {
    expect(codes(TIMEOUT_RACE)).toEqual([]);
    expect(fieldTypeOf(TIMEOUT_RACE, 'r')).toEqual({
      kind: 'tuple',
      // The value arm may or may not have won; the sleep arm never had a value
      // to hand back, so its slot is null whatever happens.
      of: [{ kind: 'maybeAbsent', of: 'text' }, 'absent'],
    });
  });

  it('a literal index reads its own slot, and only that slot', () => {
    expect(fieldTypeOf(TIMEOUT_RACE + '  a = AT(r, 0)', 'a')).toEqual({
      kind: 'maybeAbsent',
      of: 'text',
    });
    expect(fieldTypeOf(TIMEOUT_RACE + '  b = AT(r, 1)', 'b')).toEqual('absent');
  });

  it('the timeout branch is one null check on a slot', () => {
    expect(codes(TIMEOUT_RACE + '  timed_out = AT(r, 0) == null')).toEqual([]);
  });

  it("a slot the race may not have filled is refused where a value is REQUIRED", () => {
    const out = codes(TIMEOUT_RACE + '  write inbox-[:log]-> { note: AT(r, 0) }');
    expect(out).toContain('MOV_ABSENT_REQUIRED');
  });

  it('an index past the end is knowably null — a fixed length is a fact', () => {
    expect(fieldTypeOf(TIMEOUT_RACE + '  b = AT(r, 7)', 'b')).toEqual('absent');
    // Same answer as writing `null`: the value that is never there, not a
    // value that might not be.
    expect(codes(TIMEOUT_RACE + '  q = AT(r, 7) == null')).toEqual([]);
  });

  it('a movement is an arm by name', () => {
    const program = `import { email } from adapters
inbox = email()

function poll() {
  return "done"
}

movement m(e: <inbox-[:message]->>) {
  r = await race([poll, () => { await sleep(1d) }])
}`;
    const diagnostics = checkProgram(parseProgram(program), catalog).filter(
      (d) => (d.severity ?? 'error') === 'error',
    );
    expect(diagnostics.map((d) => d.code)).toEqual([]);
  });
});

describe('await parallel — every arm joins', () => {
  const BOTH =
    '  r = await parallel([\n'
    + '    () => { return e.`Subject` },\n'
    + '    () => { return 2 },\n'
    + '  ])\n';

  it('every slot is present — parallel introduces no nulls', () => {
    expect(codes(BOTH)).toEqual([]);
    expect(fieldTypeOf(BOTH, 'r')).toEqual({ kind: 'tuple', of: ['text', 'number'] });
  });

  it('a present slot flows into a strict site with nothing to discharge', () => {
    expect(codes(BOTH + '  write inbox-[:log]-> { note: AT(r, 0) }')).toEqual([]);
  });

  it('an arm that only acts is an always-null slot', () => {
    const body = '  r = await parallel([() => { await sleep(1d) }, () => { return "x" }])\n';
    expect(fieldTypeOf(body, 'r')).toEqual({ kind: 'tuple', of: ['absent', 'text'] });
  });

  it('effects-only concurrency needs no binding at all', () => {
    expect(
      codes('  await parallel([() => { write inbox-[:log]-> { note: "a" } }, () => { await sleep(1d) }])'),
    ).toEqual([]);
  });
});

describe('an arm is a function, and the combinator is what calls it', () => {
  it('a name that is not a function is refused', () => {
    expect(codes('  x = "hello"\n  r = await race([x, () => { await sleep(1d) }])')).toContain(
      'MOV_COMBINATOR_ARM_NOT_FUNCTION',
    );
  });

  it('an arm that declares a parameter is refused — nothing supplies one', () => {
    expect(
      codes('  r = await race([(d: <date>) => { return d }, () => { await sleep(1d) }])'),
    ).toContain('MOV_COMBINATOR_ARM_TAKES_NOTHING');
  });

  it("an arm's `return` is an ordinary closure return", () => {
    expect(codes('  r = await race([() => { return "x" }, () => { return "y" }])')).toEqual([]);
  });

  it('arms built at run time type as unknown rather than as a tuple', () => {
    const body = '  arms = [1, 2]\n  r = await parallel(arms)\n';
    expect(fieldTypeOf(body, 'r')).toBeUndefined();
  });
});

describe('the unawaited spellings are retired', () => {
  it('the statement form is refused with the rewrite', () => {
    expect(codes('  race([() => { return "x" }, () => { return "y" }])')).toContain(
      'MOV_COMBINATOR_NEEDS_AWAIT',
    );
  });

  it('the bound form is refused too, and still TYPES for recovery', () => {
    const out = codes(
      '  r = race([() => { return "x" }, () => { return "y" }])\n  q = AT(r, 0) == null',
    );
    expect(out).toContain('MOV_COMBINATOR_NEEDS_AWAIT');
    expect(out.filter((c) => c !== 'MOV_COMBINATOR_NEEDS_AWAIT')).toEqual([]);
  });
});
