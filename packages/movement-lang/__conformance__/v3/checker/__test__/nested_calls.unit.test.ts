// Calls nested in expressions (language version 3; checker/nested_calls.ts).
// Plan: plans/functional-extract-2026-10-02/2_one_grammar.md, steps 4 and 5.
//
// Function arguments are ordinary expressions and movements are functions, so
// a function's call, a collection op, `MEMBERS` and `extract` are values inside
// any expression — checked as the binding they mean (`#call = f(x)`, then the
// expression reads `#call`). What is pinned here:
//   - each nesting form checks, and is typed by what the call gives back;
//   - its effects are the function's around it;
//   - a call that may WAIT is refused nested (`MOV_NESTED_CALL_SUSPENDS`) —
//     a wait parks at a statement — and allowed as a statement of its own or
//     the whole right-hand side of a binding (the run resumes inside it);
//   - a call in a walk's WHERE is still refused: it would run per landing;
//   - closures and shapes are values;
//   - the v3 consistency gaps: `fire` / `callback(…)` resolve a movement in any
//     letter case, a bare-walk aggregate's `.prop` reads in any letter case,
//     and calls in a block head's hops resolve by scope.

import { parseProgram } from '../../parser/parse';
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
type Thesis = <"Consumer" | "Infra">
node Company: "each company named" {
  name: <text> "its name"
  employees: <number> "its headcount"
}
movement double(n: <number>) {
  return n * 2
}
movement label(t: <text>) {
  return UPPER(t)
}
movement ask_model(t: <text>) {
  return AI("Summarise: \${t}")
}
movement waits(n: <number>) {
  await sleep(1h)
  return n
}
`;

/** Before version 3 a parameter is a position, never a value. */
const V2_PRELUDE = `import { slack } from adapters
chat = slack()
movement waits(m: <chat-[:channel]->>) {
  await sleep(1h)
}
`;

function source(body: string, fileLevel = '', languageVersion: LanguageVersion = 3): string {
  return `${languageVersion >= 3 ? PRELUDE : V2_PRELUDE}${fileLevel}
movement scan(c: <chat-[:channel]->>) {
${body}
}
listen to chat fire scan`;
}

function all(body: string, options: { languageVersion?: LanguageVersion; fileLevel?: string } = {}): Diagnostic[] {
  const languageVersion = options.languageVersion ?? 3;
  return checkProgram(parseProgram(source(body, options.fileLevel, languageVersion), { languageVersion }), catalog, {
    languageVersion,
  }).filter((d) => (d.severity ?? 'error') === 'error');
}
const codes = (body: string, options?: { languageVersion?: LanguageVersion; fileLevel?: string }): string[] =>
  all(body, options).map((d) => d.code);
const messages = (body: string): string => all(body).map((d) => d.message).join('\n');

describe('each nesting form checks', () => {
  it("a function's call inside arithmetic, typed by what it returns", () => {
    expect(codes('  x = double(c.Size) + 1')).toEqual([]);
    expect(codes('  write chat-[:note]-> { Count: double(c.Size) + 1 }')).toEqual([]);
    // label returns text: a number field refuses it, and arithmetic over it is refused.
    expect(codes('  write chat-[:note]-> { Count: label(c.Name) }')).toEqual([C.WRITE_FIELD_TYPE]);
  });

  it('a call nested in a call, and a call as a built-in argument', () => {
    expect(codes('  x = double(double(c.Size))')).toEqual([]);
    expect(codes('  x = UPPER(label(c.Name))')).toEqual([]);
    expect(codes('  x = ROUND(label(c.Name))')).toEqual([T.BUILTIN_ARG_TYPE]);
  });

  it('a collection op nested in a collection op, and inside an aggregate', () => {
    expect(codes('  x = MAP(MAP([1, 2], (v) => v + 1), (v) => v * 10)')).toEqual([]);
    expect(codes('  write chat-[:note]-> { Count: COUNT(MAP([1, 2], (v) => v)) }')).toEqual([]);
    expect(codes('  write chat-[:note]-> { Body: JOIN(MAP(["a"], (t) => UPPER(t)), ",") }')).toEqual([]);
    expect(codes('  write chat-[:note]-> { Count: JOIN(MAP(["a"], (t) => UPPER(t)), ",") }')).toEqual([
      C.WRITE_FIELD_TYPE,
    ]);
  });

  it('MEMBERS inside a collection op, and a collection op as a function argument', () => {
    expect(codes('  x = MAP(MEMBERS(<Thesis>), (t) => t)')).toEqual([]);
    expect(codes('  x = label(JOIN(MAP(["a"], (t) => t), ","))')).toEqual([]);
  });

  it('extract nested in an aggregate is the records of its shape', () => {
    expect(codes('  first = ONLY(extract([c.Name], Company))')).toEqual([]);
    // Typed by its shape: a Company's headcount is a number, which UPPER refuses.
    expect(codes('  n = UPPER(ONLY(MAP(extract([c.Name], Company), (r) => r.employees)))')).toEqual([
      T.BUILTIN_ARG_TYPE,
    ]);
    expect(codes('  n = UPPER(ONLY(MAP(extract([c.Name], Company), (r) => r.name)))')).toEqual([]);
  });

  it('a nested call in a condition', () => {
    expect(codes('  if double(c.Size) > 2 {\n    write chat-[:note]-> { Body: "big" }\n  }')).toEqual([]);
  });

  it('an unknown function nested is still unknown', () => {
    expect(codes('  x = dubble(c.Size) + 1')).toEqual([C.FUNCTION_UNKNOWN]);
  });
});

describe("a nested call's effects are the function's around it", () => {
  it('a model call inside a nested call marks the caller', () => {
    const { recording } = checkProgramWithLink(
      parseProgram(source('  x = CONCAT(ask_model(c.Name), "!")')),
      catalog,
      { recordAnalysis: true },
    );
    const file = recording?.frames.find((frame) => frame.kind === 'file');
    const row = file !== undefined ? effectRowOf(file.scope.symbols.get('scan')!) : undefined;
    expect(row?.ai).toBe(true);
  });
});

describe('a call that may wait', () => {
  it('nested, is refused — a wait has no place to come back to inside an expression', () => {
    expect(codes('  x = waits(c.Size) + 1')).toEqual([C.NESTED_CALL_SUSPENDS]);
    expect(messages('  x = waits(c.Size) + 1')).toContain('on its own line');
  });

  it('on its own line, or as the whole of a binding, is allowed — the run resumes inside it', () => {
    expect(codes('  waits(c.Size)')).toEqual([]);
    expect(codes('  y = waits(c.Size)')).toEqual([]);
    expect(codes('  y = waits(n: c.Size)')).toEqual([]);
  });

  it('before version 3 the call is not refused — unchanged', () => {
    expect(codes('  waits(m: c)', { languageVersion: 2 })).toEqual([]);
  });

  it('inside a callback body it is refused — a run cannot be resumed inside a fired callback', () => {
    expect(codes('  cb = callback((note: <text>) => {\n    y = waits(c.Size)\n  })')).toEqual([C.WAIT_NOT_RESUMABLE]);
    // Nor can a wait written there directly, nor a movement run as the callback.
    expect(codes('  cb = callback((note: <text>) => {\n    await sleep(1h)\n  })')).toEqual([C.WAIT_NOT_RESUMABLE]);
    expect(codes('  cb = callback(waits)')).toEqual([C.WAIT_NOT_RESUMABLE]);
    expect(messages('  cb = callback((note: <text>) => {\n    waits(c.Size)\n  })')).toContain('cannot be resumed there');
    // A callback body that does not wait is untouched.
    expect(codes('  cb = callback((note: <text>) => {\n    y = double(c.Size)\n  })')).toEqual([]);
  });

  it("inside an 'until' condition it is refused — a condition is re-run by the clock, never resumed", () => {
    const until = (body: string) => `  r = await until(() => {\n${body}\n  }, every: 5m)`;
    // Nested it is refused twice over: no expression can hold a wait either.
    expect(codes(until('    return waits(c.Size) > 0'))).toEqual([C.NESTED_CALL_SUSPENDS, C.WAIT_NOT_RESUMABLE]);
    expect(codes(until('    return waits(c.Size)'))).toEqual([C.WAIT_NOT_RESUMABLE]);
    expect(codes(until('    return double(c.Size) > 0'))).toEqual([]);
  });
});

describe('a call in a walk is read per landing, so it is still refused there', () => {
  it("a function's call in a hop WHERE inside an expression", () => {
    expect(codes('  x = COUNT(c-[m:Members WHERE double(m.Age) > 1]->)')).toEqual([C.CALL_NESTED]);
    expect(messages('  x = COUNT(c-[m:Members WHERE double(m.Age) > 1]->)')).toContain('once per landing');
  });

  it("a block head's hop WHERE: its calls resolve by scope", () => {
    const block = (where: string) => `  c-[m:Members WHERE ${where}]-> {\n    write chat-[:note]-> { Body: m.Name }\n  }`;
    expect(codes(block('double(m.Age) > 1'))).toEqual([C.CALL_NESTED]);
    expect(codes(block('dubble(m.Age) > 1'))).toEqual([C.FUNCTION_UNKNOWN]);
    expect(codes(block('UPPER(m.Name) == "A"'))).toEqual([]);
    expect(codes(block('dubble(m.Age) > 1'), { languageVersion: 2 })).toEqual([]);
  });
});

describe('closures and shapes are values', () => {
  it('a closure with an expression body, bound and passed', () => {
    expect(codes('  inc = (v: <number>) => v + 1\n  x = MAP([1, 2], inc)')).toEqual([]);
    expect(codes('  x = MAP([1, 2], (v) => (v * 2))')).toEqual([]);
  });

  it('an expression body is version 3 syntax; before it a closure body is a block', () => {
    expect(() =>
      parseProgram(source('  inc = (v: <number>) => v + 1'), { languageVersion: 2 }),
    ).toThrow(/closure body/);
  });

  it("a declaration's name read as a value is the shape, and extract takes it", () => {
    expect(codes('  S = Company\n  found = extract([c.Name], S)')).toEqual([]);
    expect(codes('  S = Company\n  n = UPPER(ONLY(MAP(extract([c.Name], S), (r) => r.employees)))')).toEqual([
      T.BUILTIN_ARG_TYPE,
    ]);
  });
});

describe('function names are case-insensitive everywhere a function is named', () => {
  it('`fire` names the movement in any letter case', () => {
    const fired = `${PRELUDE}
movement scan(c: <chat-[:channel]->>) {
  write chat-[:note]-> { Body: c.Name }
}
listen to chat fire SCAN`;
    const check = (languageVersion: LanguageVersion) =>
      checkProgram(parseProgram(fired, { languageVersion }), catalog, { languageVersion })
        .filter((d) => (d.severity ?? 'error') === 'error')
        .map((d) => d.code);
    expect(check(3)).toEqual([]);
    expect(check(2)).not.toEqual([]);
  });

  it('`callback(…)` names the movement in any letter case', () => {
    expect(codes('  cb = callback(DOUBLE(c.Size))')).not.toContain(C.CALLBACK_NOT_MOVEMENT);
    expect(codes('  cb = callback(dubble(c.Size))')).toContain(C.CALLBACK_NOT_MOVEMENT);
  });

  it("a bare-walk aggregate reads '.prop' after it in any letter case", () => {
    expect(codes('  x = only(c-[m:Members]->).Name')).toEqual([]);
    expect(codes('  x = ONLY(c-[m:Members]->).Name')).toEqual([]);
    // FIRST needs an order either way — the same answer in both spellings.
    expect(codes('  x = first(c-[m:Members]->).Name')).toEqual(codes('  x = FIRST(c-[m:Members]->).Name'));
  });
});

describe('a closure bound to a name is called like any function', () => {
  const inc = '  inc = (v: <number>) => v + 1\n';

  it('bound, nested, and on its own line', () => {
    expect(codes(`${inc}  x = inc(2)`)).toEqual([]);
    expect(codes(`${inc}  x = inc(v: 2)`)).toEqual([]);
    expect(codes(`${inc}  write chat-[:note]-> { Count: inc(c.Size) + 1 }`)).toEqual([]);
    expect(codes(`${inc}  x = double(inc(inc(1)))`)).toEqual([]);
    expect(codes('  note = (t: <text>) => {\n    write chat-[:note]-> { Body: t }\n  }\n  note(c.Name)')).toEqual([]);
  });

  it('its parameters type the arguments, and its body types the call', () => {
    expect(codes(`${inc}  x = inc(1, 2)`)).toEqual([C.CALL_ARITY]);
    expect(codes(`${inc}  x = inc(c.Name)`)).not.toEqual([]);
    expect(codes('  shout = (t: <text>) => UPPER(t)\n  write chat-[:note]-> { Count: shout(c.Name) }')).toEqual([
      C.WRITE_FIELD_TYPE,
    ]);
  });

  it('calling it does what its body does; binding it does not', () => {
    const aiOf = (body: string): boolean | undefined => {
      const { recording } = checkProgramWithLink(parseProgram(source(body)), catalog, { recordAnalysis: true });
      const file = recording?.frames.find((frame) => frame.kind === 'file');
      const scan = file?.scope.symbols.get('scan');
      return scan !== undefined ? effectRowOf(scan)?.ai : undefined;
    };
    const ask = '  ask = (t: <text>) => AI("Summarise: ${t}")\n';
    expect(aiOf(`${ask}  x = 1`)).not.toBe(true);
    expect(aiOf(`${ask}  x = ask(c.Name)`)).toBe(true);
    expect(aiOf(`${ask}  x = CONCAT(ask(c.Name), "!")`)).toBe(true);
  });

  it('its name is a function name: any letter case calls it, and it may not collide', () => {
    expect(codes(`${inc}  x = INC(2) + Inc(3)`)).toEqual([]);
    expect(codes('  upper = (t: <text>) => t')).toEqual([C.FUNCTION_NAME_COLLISION]);
    expect(codes('  Double = (n: <number>) => n')).toEqual([C.FUNCTION_NAME_COLLISION]);
  });

  it('a name holding a value is still not callable', () => {
    expect(codes('  f = 3\n  x = f(1)')).toEqual([C.CALL_NOT_MOVEMENT]);
  });

  it('a closure that may wait is called on its own line, never nested', () => {
    const w = '  w = (n: <number>) => {\n    await sleep(1h)\n    return n\n  }\n';
    expect(codes(`${w}  x = w(1)`)).toEqual([]);
    expect(codes(`${w}  w(1)`)).toEqual([]);
    expect(codes(`${w}  x = w(1) + 1`)).toEqual([C.NESTED_CALL_SUSPENDS]);
    // Passing it on is not calling it: a race arm still waits.
    expect(codes('  w = () => {\n    await sleep(1h)\n  }\n  await race([w])')).toEqual([]);
  });

  it("in a walk's WHERE it would run per landing, so it is refused there", () => {
    expect(codes(`${inc}  x = COUNT(c-[m:Members WHERE inc(m.Age) > 1]->)`)).toEqual([C.CALL_NESTED]);
  });

  it('before version 3 a closure is passed, never called — unchanged', () => {
    const body = '  inc = () => {\n    return 1\n  }\n';
    expect(codes(`${body}  inc()`, { languageVersion: 2 })).toEqual([C.CALL_NOT_MOVEMENT]);
    expect(codes(`${body}  x = inc()`, { languageVersion: 2 })).toEqual([C.CONSTRUCT_NOT_ADAPTER]);
    expect(codes('  upper = () => {\n    return 1\n  }', { languageVersion: 2 })).toEqual([]);
  });
});

describe('a call in a SORT key would run once, not once per member, so it is refused', () => {
  const people = '  people = c-[p:Members]-> { return p }\n';

  it("a function's call, a closure's", () => {
    expect(codes(`${people}  t = COUNT(SORT(people, double(Age)))`)).toEqual([C.CALL_NESTED]);
    expect(codes(`${people}  t = COUNT(SORT(people, double(Age), DESC))`)).toEqual([C.CALL_NESTED]);
    expect(codes(`${people}  inc = (v: <number>) => v + 1\n  t = COUNT(SORT(people, inc(Age)))`)).toEqual([
      C.CALL_NESTED,
    ]);
    expect(messages(`${people}  t = COUNT(SORT(people, double(Age)))`)).toContain('once per member');
  });

  it('a value built-in in the key is read per member, and a call in the collection runs once — both fine', () => {
    expect(codes(`${people}  t = COUNT(SORT(people, LENGTH(Name)))`)).toEqual([]);
    expect(codes('  t = COUNT(SORT(MAP([3, 1], (v) => v + 1)))')).toEqual([]);
    expect(codes('  t = COUNT(SORT(MAP([3, 1], (v) => v + 1), DESC))')).toEqual([]);
  });

  it('before version 3 nothing nests, and nothing is said — unchanged', () => {
    expect(codes(`${people}  t = COUNT(SORT(people, waits(Name)))`, { languageVersion: 2 })).toEqual([]);
  });
});
