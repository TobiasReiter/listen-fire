// Recursion (language version 3): a function may call itself, directly or
// through others, and a closure bound to a name may call itself by it.
// Plan: plans/functional-extract-2026-10-02/2_one_grammar.md, "Rulings
// (Henry, 2026-10-05): concurrency safety, recursion, cost".
//
// What is pinned here:
//   - `): <R>` declares what a function returns, after its parameters, as
//     TypeScript writes it — on a movement, a `function`, and a closure;
//   - every function in a call cycle declares it (`MOV_RECURSIVE_RETURN_TYPE`,
//     naming the loop), and nothing else has to;
//   - where it is declared, every `return` is checked against it
//     (`MOV_RETURN_TYPE`) and a call is typed by it;
//   - the functions of one cycle share one effect row;
//   - versions 1 and 2 have no return types, and recursion there stays the
//     run-time refusal it always was.

import { parseProgram, MovementParseError } from '../../parser/parse';
import { checkProgram, checkProgramWithLink, DiagnosticCodes as C, type Diagnostic } from '../check';
import { effectRowOf } from '../effects';
import { mockCatalog, type InstanceSchema } from '../catalog';
import { TypedDiagnosticCodes as T } from '../typing';
import type { LanguageVersion } from '../../language_version';

const chatSchema: InstanceSchema = {
  positions: {
    channel: {
      properties: { Name: 'text', Size: 'number' },
      edges: { Members: { target: 'person', readable: true } },
    },
    person: { properties: { Name: 'text', Age: 'number' }, edges: {} },
    note: { properties: { Body: 'text' }, edges: {} },
  },
  collections: { Channels: { target: 'channel' }, note: { target: 'note' } },
  writableRoots: {
    note: { fields: { Body: 'text', Count: 'number' }, resultShape: { Body: 'text' }, edges: {} },
  },
};

const catalog = mockCatalog({ adapters: { slack: { constructionArgs: [], schema: chatSchema } } });

const PRELUDE = `import { slack } from adapters
chat = slack()
`;

function source(fileLevel: string, body = '  x = 1'): string {
  return `${PRELUDE}${fileLevel}
movement scan(c: <chat-[:channel]->>) {
${body}
}
listen to chat fire scan`;
}

function check(fileLevel: string, body?: string, languageVersion: LanguageVersion = 3): Diagnostic[] {
  return checkProgram(parseProgram(source(fileLevel, body), { languageVersion }), catalog, { languageVersion }).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}
const codes = (fileLevel: string, body?: string, languageVersion?: LanguageVersion): string[] =>
  check(fileLevel, body, languageVersion).map((d) => d.code);

const FACT = `function fact(n: <number>): <number> {
  if n <= 1 {
    return 1
  }
  return n * fact(n - 1)
}
`;

const EVEN_ODD = `function is_even(n: <number>): <boolean> {
  if n == 0 {
    return true
  }
  return is_odd(n - 1)
}
function is_odd(n: <number>): <boolean> {
  if n == 0 {
    return false
  }
  return is_even(n - 1)
}
`;

describe('a recursive function that declares what it returns', () => {
  it('direct recursion checks clean, and its call is typed by the declaration', () => {
    expect(codes(FACT, '  x = fact(5) + 1')).toEqual([]);
    // fact returns a number, which UPPER refuses.
    expect(codes(FACT, '  x = UPPER(fact(3))')).toEqual([T.BUILTIN_ARG_TYPE]);
  });

  it('mutual recursion checks clean', () => {
    expect(codes(EVEN_ODD, '  if is_even(4) {\n    write chat-[:note]-> { Body: "even" }\n  }')).toEqual([]);
  });

  it('the movement spelling takes the same annotation', () => {
    const countdown = `movement countdown(n: <number>): <number> {
  if n <= 0 {
    return 0
  }
  return countdown(n - 1)
}
`;
    expect(codes(countdown, '  x = countdown(3)')).toEqual([]);
  });

  it('a record return type, and a tree walk over a local list', () => {
    const sum = `function total(xs: <number[]>, i: <number>): <{ sum: number, seen: number }> {
  if i >= COUNT(xs) {
    return { sum: 0, seen: i }
  }
  rest = total(xs, i + 1)
  return { sum: AT(xs, i) + rest.sum, seen: rest.seen }
}
`;
    expect(codes(sum, '  t = total([1, 2, 3], 0)\n  write chat-[:note]-> { Count: t.sum }')).toEqual([]);
  });

  it('a closure bound to a name calls itself when it declares what it returns', () => {
    expect(
      codes('', '  f = (n: <number>): <number> => {\n    if n <= 1 {\n      return 1\n    }\n    return n * f(n - 1)\n  }\n  y = f(4) + 1'),
    ).toEqual([]);
    // Concise body, too.
    expect(codes('', '  g = (n: <number>): <number> => IF n <= 0 THEN 0 ELSE g(n - 1) END\n  y = g(2)')).toEqual([]);
  });
});

describe('a function in a cycle with no declared return type', () => {
  it('direct recursion is refused at the declaration, naming the loop', () => {
    const diagnostics = check(`function fact(n: <number>) {
  if n <= 1 {
    return 1
  }
  return n * fact(n - 1)
}
`);
    expect(diagnostics.map((d) => d.code)).toEqual([C.RECURSIVE_RETURN_TYPE]);
    expect(diagnostics[0].message).toContain("'fact' calls itself (fact → fact)");
    expect(diagnostics[0].message).toContain('function fact(…): <number> { … }');
  });

  it('mutual recursion is refused on each member that leaves it out, naming the loop from there', () => {
    const diagnostics = check(`function ping(n: <number>) {
  if n == 0 {
    return 0
  }
  return pong(n - 1)
}
function pong(n: <number>): <number> {
  return ping(n)
}
function pang(n: <number>) {
  return pong(n)
}
`);
    // pang calls into the cycle but is not in it, so it needs nothing.
    expect(diagnostics.map((d) => d.code)).toEqual([C.RECURSIVE_RETURN_TYPE]);
    expect(diagnostics[0].message).toContain("'ping' calls itself through 'pong' (ping → pong → ping)");
  });

  it('a self-calling closure with no declared return type is refused at the call', () => {
    const diagnostics = check('', '  f = (n: <number>) => {\n    return f(n - 1)\n  }');
    expect(diagnostics.map((d) => d.code)).toEqual([C.RECURSIVE_RETURN_TYPE]);
    expect(diagnostics[0].message).toContain("f = (…): <number> => …");
  });

  it('a recursive function that returns no value has nothing to declare', () => {
    expect(
      codes(`function drain(n: <number>) {
  if n > 0 {
    write chat-[:note]-> { Body: "tick" }
    drain(n - 1)
  }
}
`, '  drain(3)'),
    ).toEqual([]);
    expect(codes('', '  tick = (n: <number>) => {\n    if n > 0 {\n      tick(n - 1)\n    }\n  }\n  tick(2)')).toEqual([]);
  });

  it('binding the call of a recursive function that returns no value is refused, as any such binding is', () => {
    const drain = (bind: string) => `function drain(n: <number>) {
  if n > 0 {
    write chat-[:note]-> { Body: "tick" }
    ${bind}
  }
}
`;
    expect(codes(drain('x = drain(n - 1)'), '  drain(3)')).toEqual([C.CALL_RETURNS_NOTHING]);
    expect(codes(drain('x = 1 + drain(n - 1)'), '  drain(3)')).toEqual([C.CALL_RETURNS_NOTHING]);
    expect(codes(drain('drain(n - 1)'), '  y = drain(3)')).toEqual([C.CALL_RETURNS_NOTHING]);
    expect(
      codes(`function ping(n: <number>) {
  if n > 0 {
    x = pong(n - 1)
  }
}
function pong(n: <number>) {
  if n > 0 {
    ping(n - 1)
  }
}
`, '  ping(3)'),
    ).toEqual([C.CALL_RETURNS_NOTHING]);
  });

  it('binding the call of a closure that returns no value is refused, calling itself or not', () => {
    const diagnostics = check('', '  tick = (n: <number>) => {\n    if n > 0 {\n      y = tick(n - 1)\n    }\n  }\n  tick(2)');
    expect(diagnostics.map((d) => d.code)).toEqual([C.CALL_RETURNS_NOTHING]);
    expect(diagnostics[0].message).toContain("'tick' returns nothing, so there is no value to bind");
    expect(codes('', '  tick = (n: <number>) => {\n    if n > 0 {\n      y = 1 + tick(n - 1)\n    }\n  }\n  tick(2)')).toEqual([
      C.CALL_RETURNS_NOTHING,
    ]);
    expect(codes('', '  f = (n: <number>) => {\n    write chat-[:note]-> { Body: "t" }\n  }\n  x = f(1)')).toEqual([
      C.CALL_RETURNS_NOTHING,
    ]);
    // One that returns a value binds as it always did.
    expect(codes('', '  g = (n: <number>) => {\n    return n + 1\n  }\n  x = g(1)')).toEqual([]);
  });

  it('a function that is not in a cycle needs no annotation', () => {
    expect(codes('function double(n: <number>) {\n  return n * 2\n}\n', '  x = double(2) + 1')).toEqual([]);
  });
});

describe('a declared return type is checked against the body', () => {
  it('a return of the wrong type', () => {
    const diagnostics = check('function label(n: <number>): <number> {\n  return "n"\n}\n');
    expect(diagnostics.map((d) => d.code)).toEqual([C.RETURN_TYPE]);
    expect(diagnostics[0].message).toContain("'label' declares it returns <number>, but this returns");
  });

  it('a body that never returns', () => {
    expect(codes('function noop(n: <number>): <number> {\n  x = n\n}\n')).toEqual([C.RETURN_TYPE]);
  });

  it('a value that may be absent against a type that may not be', () => {
    expect(codes('function pick(xs: <number[]>): <number> {\n  return FIRST(xs)\n}\n')).toEqual([C.RETURN_TYPE]);
  });

  it('a record return missing a key, and one with a key of the wrong type', () => {
    expect(codes('function r(n: <number>): <{ a: number, b: text }> {\n  return { a: n }\n}\n')).toEqual([C.RETURN_TYPE]);
    expect(codes('function r(n: <number>): <{ a: number }> {\n  return { a: "x" }\n}\n')).toEqual([C.RETURN_TYPE]);
  });

  it('a closure return of the wrong type', () => {
    expect(codes('', '  f = (n: <number>): <text> => n + 1')).toEqual([C.RETURN_TYPE]);
  });

  it('an annotation that names no type is reported where it is written', () => {
    expect(codes('function f(n: <number>): <nmber> {\n  return n\n}\n')).not.toEqual([]);
  });
});

describe('a cycle shares one effect row', () => {
  it("each member's row holds what every member's body does", () => {
    const program = parseProgram(
      source(`function ask_until(n: <number>): <text> {
  if n <= 0 {
    return "done"
  }
  return write_then(n)
}
function write_then(n: <number>): <text> {
  write chat-[:note]-> { Body: "tick" }
  return ask_until(n - 1)
}
function model_once(n: <number>): <text> {
  return AI("Say \${n}")
}
`, '  x = ask_until(2)'),
      { languageVersion: 3 },
    );
    const { recording, diagnostics } = checkProgramWithLink(program, catalog, {
      languageVersion: 3,
      recordAnalysis: true,
    });
    expect(diagnostics.filter((d) => (d.severity ?? 'error') === 'error')).toEqual([]);
    const file = recording?.frames.find((frame) => frame.kind === 'file');
    const row = (name: string) => {
      const symbol = file?.scope.symbols.get(name);
      return symbol !== undefined ? effectRowOf(symbol) : undefined;
    };
    const askUntil = row('ask_until');
    const writeThen = row('write_then');
    expect(askUntil?.write.map((w) => w.name)).toEqual(['chat']);
    expect(writeThen?.write.map((w) => w.name)).toEqual(['chat']);
    // Not a lower bound: the call back into the cycle is accounted for.
    expect(askUntil?.partial).toBe(false);
    expect(writeThen?.partial).toBe(false);
    // A function outside the cycle keeps its own row.
    expect(row('model_once')?.ai).toBe(true);
    expect(askUntil?.ai).toBe(false);
    // The caller of the cycle absorbs it.
    expect(row('scan')?.write.map((w) => w.name)).toEqual(['chat']);
  });
});

describe('a recursive function from another file', () => {
  const library = `export function fact(n: <number>): <number> {
  if n <= 1 {
    return 1
  }
  return n * fact(n - 1)
}
`;
  const undeclared = `export function fact(n: <number>) {
  if n <= 1 {
    return 1
  }
  return n * fact(n - 1)
}
`;
  const importer = (path: string, body: string): string => `import { fact } from "${path}"
${source('', body)}`;
  const check = (body: string): string[] =>
    checkProgram(parseProgram(importer('./math.mvmt', body), { languageVersion: 3 }), catalog, {
      languageVersion: 3,
      resolveFile: (path) => (path === './math.mvmt' ? { source: library } : path === './bad.mvmt' ? { source: undeclared } : undefined),
    })
      .filter((d) => (d.severity ?? 'error') === 'error')
      .map((d) => d.code);

  it('is called like any function, and typed by its declaration', () => {
    expect(check('  x = fact(4) + 1')).toEqual([]);
    expect(check('  x = UPPER(fact(4))')).toEqual([T.BUILTIN_ARG_TYPE]);
  });

  it("one that leaves its return type out is refused in its own file", () => {
    const diagnostics = checkProgram(parseProgram(importer('./bad.mvmt', '  x = fact(4)'), { languageVersion: 3 }), catalog, {
      languageVersion: 3,
      resolveFile: (path) => (path === './bad.mvmt' ? { source: undeclared } : undefined),
    }).filter((d) => (d.severity ?? 'error') === 'error');
    expect(diagnostics.map((d) => d.message).join('\n')).toContain("'fact' calls itself (fact → fact)");
  });
});

describe('versions 1 and 2', () => {
  it('have no return type syntax', () => {
    expect(() =>
      parseProgram(source('movement f(m: <chat-[:channel]->>): <number> {\n  return 1\n}\n'), { languageVersion: 2 }),
    ).toThrow(MovementParseError);
  });

  it('check a recursive movement as they always did — the ban is the run-time refusal', () => {
    const recursive = `movement again(m: <chat-[:channel]->>) {
  again(m: m)
}
`;
    expect(codes(recursive, '  again(m: c)', 2)).toEqual([]);
    expect(codes(recursive, '  again(m: c)', 1)).toEqual([]);
  });
});
