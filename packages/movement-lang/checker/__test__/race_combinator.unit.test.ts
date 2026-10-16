// Checker coverage for `race(…)` / `all(…)` — the concurrency combinators
// (core calculus v2 R5), as language version 5 spells them.
//
// The arms are the call's ARGUMENTS: FUNCTION values the combinator calls — a
// closure written in place, or a function's name. A closure is not data, so
// there is no list of them to pass. The value is POSITIONAL — one slot per
// arm, in the order written — so it types as a TUPLE and a literal-index read
// (`AT(r, 0)`) types the slot exactly. `race` makes every slot `T | null` (the
// winner's is filled, the rest are not); `all` fills them all. Neither is
// awaited: `await` marks only where the run itself parks, and the arms do
// that. Before 5 the spelling is `await race([…])` / `await parallel([…])`.

import { parseProgram } from '../../parser/parse';
import { checkProgram, checkProgramWithLink, Diagnostic } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';
import { spelledFor } from './surface_spelling';
import type { LanguageVersion } from '../../language_version';

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

function source(body: string, languageVersion: LanguageVersion = 5): string {
  return spelledFor(languageVersion, `import { email } from adapters
inbox = email()

movement m(e: <inbox-[:message]->>) {
${body}
}`, catalog);
}

function check(body: string, languageVersion?: LanguageVersion): Diagnostic[] {
  const options = languageVersion !== undefined ? { languageVersion } : undefined;
  return checkProgram(parseProgram(source(body, languageVersion), options), catalog, options).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}
const codes = (body: string, languageVersion?: LanguageVersion): string[] => check(body, languageVersion).map((d) => d.code);

function fieldTypeOf(body: string, name: string, languageVersion?: LanguageVersion): unknown {
  const options = languageVersion !== undefined ? { languageVersion } : {};
  const { recording } = checkProgramWithLink(parseProgram(source(body, languageVersion), options), catalog, {
    recordAnalysis: true,
    ...options,
  });
  const symbols = (recording?.frames ?? []).flatMap((f) => [...f.scope.symbols.values()]);
  return symbols.find((s) => s.name === name)?.fieldType;
}

const TIMEOUT_RACE =
  '  r = race(\n'
  + '    () => { return "answered" },\n'
  + '    () => { await sleep(1d) },\n'
  + '  )\n';

describe('race — the first arm to settle wins', () => {
  it('its arms type as a tuple, one slot per arm', () => {
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
  r = race(poll, () => { await sleep(1d) })
}`;
    const diagnostics = checkProgram(parseProgram(spelledFor(5, program, catalog)), catalog).filter(
      (d) => (d.severity ?? 'error') === 'error',
    );
    expect(diagnostics.map((d) => d.code)).toEqual([]);
  });

  it('takes no settings', () => {
    expect(codes('  r = race(() => { return "x" }, { concurrency: 2 })')).toEqual(['MOV_COLLECTION_OP_CONFIG']);
  });
});

// `parallel` is retired under Dancing Wren (5) — parallel_retired.unit.test.ts
// — so its own rules are pinned under Luminous Owl (4), each beside the `all`
// that replaces it under 5, which answers the same.
describe('all — every arm joins (and await parallel under version 4)', () => {
  const ALL =
    '  r = all(\n'
    + '    () => { return e.`Subject` },\n'
    + '    () => { return 2 },\n'
    + '  )\n';
  const BOTH =
    '  r = await parallel([\n'
    + '    () => { return e.`Subject` },\n'
    + '    () => { return 2 },\n'
    + '  ])\n';

  it('every slot is present — a join introduces no nulls', () => {
    expect(codes(BOTH, 4)).toEqual([]);
    expect(fieldTypeOf(BOTH, 'r', 4)).toEqual({ kind: 'tuple', of: ['text', 'number'] });
    expect(codes(ALL)).toEqual([]);
    expect(fieldTypeOf(ALL, 'r')).toEqual({ kind: 'tuple', of: ['text', 'number'] });
  });

  it('a present slot flows into a strict site with nothing to discharge', () => {
    expect(codes(BOTH + '  write inbox-[:log]-> { note: AT(r, 0) }', 4)).toEqual([]);
    expect(codes(ALL + '  write inbox-[:log]-> { note: AT(r, 0) }')).toEqual([]);
  });

  it('an arm that only acts is an always-null slot', () => {
    const body = '  r = await parallel([() => { await sleep(1d) }, () => { return "x" }])\n';
    expect(fieldTypeOf(body, 'r', 4)).toEqual({ kind: 'tuple', of: ['absent', 'text'] });
    expect(fieldTypeOf('  r = all(() => { await sleep(1d) }, () => { return "x" })\n', 'r')).toEqual({ kind: 'tuple', of: ['absent', 'text'] });
  });

  it('effects-only concurrency needs no binding at all', () => {
    expect(
      codes('  await parallel([() => { write inbox-[:log]-> { note: "a" } }, () => { await sleep(1d) }])', 4),
    ).toEqual([]);
    expect(codes('  all(() => { write inbox-[:log]-> { note: "a" } }, () => { await sleep(1d) })')).toEqual([]);
  });

  it('takes MAP\'s settings that mean something for a join: concurrency and onError', () => {
    expect(codes(ALL.replace('  )\n', '  { concurrency: 1, onError: "error" })\n'))).toEqual([]);
    expect(codes('  r = all(() => { return 1 }, { initialConcurrency: 1 })')).toEqual(['MOV_COLLECTION_OP_CONFIG']);
    expect(codes('  r = all(() => { return 1 }, { concurrency: 0 })')).toEqual(['MOV_COLLECTION_OP_CONFIG']);
  });

  it('an arm whose failure is forgiven leaves its slot null', () => {
    const forgiving = ALL.replace('  )\n', '  { onError: "warn" })\n');
    expect(fieldTypeOf(forgiving, 'r')).toEqual({
      kind: 'tuple',
      of: [{ kind: 'maybeAbsent', of: 'text' }, { kind: 'maybeAbsent', of: 'number' }],
    });
  });
});

describe('an arm is a function, and the combinator is what calls it', () => {
  it('a name that is not a function is refused', () => {
    expect(codes('  x = "hello"\n  r = race(x, () => { await sleep(1d) })')).toContain(
      'MOV_COMBINATOR_ARM_NOT_FUNCTION',
    );
  });

  it('a list of functions is not an arm — a closure is not data', () => {
    expect(codes('  arms = [1, 2]\n  r = race(arms)\n')).toEqual(['MOV_COMBINATOR_ARM_NOT_FUNCTION']);
  });

  it('an arm that declares a parameter is refused — nothing supplies one', () => {
    expect(
      codes('  r = race((d: <date>) => { return d }, () => { await sleep(1d) })'),
    ).toContain('MOV_COMBINATOR_ARM_TAKES_NOTHING');
  });

  it("an arm's `return` is an ordinary closure return", () => {
    expect(codes('  r = race(() => { return "x" }, () => { return "y" })')).toEqual([]);
  });

  it('arms built at run time type as unknown rather than as a tuple (version 4)', () => {
    const body = '  arms = [1, 2]\n  r = await parallel(arms)\n';
    expect(fieldTypeOf(body, 'r', 4)).toBeUndefined();
  });
});

describe('the spelling of each version', () => {
  it('before 5 the statement form without await is refused with the rewrite', () => {
    expect(codes('  race([() => { return "x" }, () => { return "y" }])', 4)).toContain(
      'MOV_COMBINATOR_NEEDS_AWAIT',
    );
  });

  it('before 5 the bound form is refused too, and still TYPES for recovery', () => {
    const out = codes(
      '  r = race([() => { return "x" }, () => { return "y" }])\n  q = AT(r, 0) == null',
      4,
    );
    expect(out).toContain('MOV_COMBINATOR_NEEDS_AWAIT');
    expect(out.filter((c) => c !== 'MOV_COMBINATOR_NEEDS_AWAIT')).toEqual([]);
  });

  it.each(['race', 'all'])('from 5 an awaited %s is refused, with the await removed', (kind) => {
    const errors = check(`  r = await ${kind}(() => { return "x" }, () => { await sleep(1d) })`);
    expect(errors.map((d) => d.code)).toEqual(['MOV_COMBINATOR_NO_AWAIT']);
    expect(errors[0]!.fix?.edits).toHaveLength(1);
    expect(errors[0]!.fix?.edits[0]!.text).toBe('');
  });

  it.each(['race', 'all'])('from 5 a list of arms given to %s is refused, with the brackets removed', (kind) => {
    const errors = check(`  r = ${kind}([() => { return "x" }, () => { await sleep(1d) }])`);
    expect(errors.map((d) => d.code)).toEqual(['MOV_COMBINATOR_ARMS_ARE_ARGUMENTS']);
    expect(errors[0]!.fix?.edits).toHaveLength(2);
  });

  it('from 5 the old spelling takes both fixes', () => {
    const errors = check('  r = await race([() => { return "x" }, () => { await sleep(1d) }])');
    expect(errors.map((d) => d.code).sort()).toEqual(['MOV_COMBINATOR_ARMS_ARE_ARGUMENTS', 'MOV_COMBINATOR_NO_AWAIT']);
  });
});
