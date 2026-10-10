// Explicit returns and anonymous closures — the spine of the core calculus.
//
// `return` is the ONE way a value leaves a body, so what is worth pinning is
// where a `return` belongs (a movement, a block, a closure — an `if` arm is
// transparent), where it does not, and that a closure is an ordinary value:
// bound, typed by its signature, opaque to reads and traversals.
//
// Same-scope rebinding rides here too: it is the other half of "a binding never
// changes", whose cross-scope half is MOV_SHADOWED_NAME.

import { parseProgram } from '../../parser/parse';
import { checkProgram, checkProgramWithLink, Diagnostic, DiagnosticCodes as C } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';

const inboxSchema: InstanceSchema = {
  positions: {
    message: {
      properties: { Subject: 'text', Count: 'number' },
      edges: { Attachments: { target: 'attachment', readable: true } },
    },
    attachment: { properties: { Name: 'text' }, edges: {} },
  },
  collections: { messages: { target: 'message' } },
  writableRoots: {},
};

const catalog = mockCatalog({
  adapters: { email: { constructionArgs: [], schema: inboxSchema } },
});

const HEADER = `import { email } from adapters
inbox = email()
`;

function check(source: string): Diagnostic[] {
  return checkProgram(parseProgram(source), catalog).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}
const codes = (source: string): string[] => check(source).map((d) => d.code);
const messages = (source: string): string => check(source).map((d) => d.message).join('\n');

const inMovement = (body: string): string =>
  `${HEADER}
movement m(e: <inbox-[:message]->>) {
${body}
}`;

describe('a `return` belongs to the nearest enclosing body', () => {
  it('at file scope there is no body to return from', () => {
    expect(codes(`${HEADER}return "x"`)).toContain(C.RETURN_OUTSIDE_BODY);
  });

  it('an `if` arm is transparent — its return is the movement\'s', () => {
    const source = `${HEADER}
movement subject(e: <inbox-[:message]->>) {
  if e.\`Count\` > 1 {
    return e.\`Subject\`
  }
  return "none"
}
movement main(e: <inbox-[:message]->>) {
  s = subject(e: e)
  bad = s > 3
}`;
    expect(codes(source)).toContain(C.COMPARE_TYPE_MISMATCH);
  });

  it("a combinator ARM returns like any other body — an arm IS a closure", () => {
    const source = inMovement(
      '  r = await parallel([() => { return e.`Subject` }, () => { await sleep(2d) }])',
    );
    expect(codes(source)).not.toContain(C.RETURN_OUTSIDE_BODY);
  });

  it('a race arm returns the same way, and its value lands in its own slot', () => {
    const source = inMovement(
      '  r = await race([() => { return e.`Subject` }, () => { await sleep(2d) }])',
    );
    expect(codes(source)).not.toContain(C.RETURN_OUTSIDE_BODY);
  });

  it("a block's return is the BLOCK's, not the movement's", () => {
    // The movement itself returns nothing, so binding a call of it is refused
    // even though a `return` is written inside it.
    const source = `${HEADER}
movement lists(e: <inbox-[:message]->>) {
  names = e-[a:Attachments]-> {
    return a.\`Name\`
  }
}
movement main(e: <inbox-[:message]->>) {
  x = lists(e: e)
}`;
    expect(codes(source)).toContain(C.CALL_RETURNS_NOTHING);
  });
});

describe('a binding never changes', () => {
  it('rebinding a name in the SAME scope is refused, naming the first', () => {
    const source = inMovement('  x = 1\n  x = 2');
    expect(codes(source)).toContain(C.REBOUND_NAME);
    expect(messages(source)).toContain('line 5');
  });

  it('and the refusal says why, not just that', () => {
    expect(messages(inMovement('  x = 1\n  x = 2'))).toContain('a binding never changes');
  });

  it('a name used once is fine', () => {
    expect(codes(inMovement('  x = 1\n  y = 2'))).toEqual([]);
  });

  it('an inner scope reusing an enclosing name is the SHADOWING half, not this one', () => {
    const source = inMovement('  x = 1\n  e-[a:Attachments]-> {\n    x = 2\n  }');
    expect(codes(source)).toContain(C.SHADOWED_NAME);
    expect(codes(source)).not.toContain(C.REBOUND_NAME);
  });

  it('a guard narrowing re-declares the SAME name and is not a rebinding', () => {
    const source = `${HEADER}
movement m(e: <inbox-[:message]->>) {
  c = FIRST(inbox-[x:messages]->)
  if c != null {
    t = c.\`Subject\`
  }
}`;
    expect(codes(source)).not.toContain(C.REBOUND_NAME);
  });
});

describe("the engine's own names are off limits", () => {
  it('a binding named with the reserved prefix is refused', () => {
    const source = inMovement('  `#return` = 1');
    expect(codes(source)).toContain(C.RESERVED_NAME);
    expect(messages(source)).toContain("the engine's own names");
  });
});

describe('a closure is an ordinary value', () => {
  it('binds, and its body is a scope over the enclosing one', () => {
    expect(codes(inMovement('  f = () => {\n    return e.`Subject`\n  }'))).toEqual([]);
  });

  it('its parameters are in scope inside the body', () => {
    expect(codes(inMovement('  f = (n: <number>) => {\n    return n > 1\n  }'))).toEqual([]);
  });

  it('and its bindings do not leak out', () => {
    const source = inMovement('  f = () => {\n    inner = 1\n    return inner\n  }\n  x = inner');
    expect(codes(source)).toContain(C.NAME_UNRESOLVED);
  });

  it('reading a field off a closure is refused — call it first', () => {
    const source = inMovement('  f = () => {\n    return 1\n  }\n  x = f.n');
    expect(codes(source)).toContain(C.UNKNOWN_PROPERTY);
    expect(messages(source)).toContain('closure');
  });

  it('traversing off a closure is refused the same way', () => {
    const source = inMovement('  f = () => {\n    return 1\n  }\n  f-[v:n]-> {\n    y = 1\n  }');
    expect(codes(source)).toContain(C.TRAVERSE_UNKNOWN_EDGE);
    expect(messages(source)).toContain('closure');
  });

  it('a closure body returning nothing is legal — it is effects only', () => {
    expect(codes(inMovement('  f = () => {\n    t = e.`Subject`\n  }'))).toEqual([]);
  });

  it('its return type rides on the binding', () => {
    const { recording } = checkProgramWithLink(
      parseProgram(inMovement('  f = (n: <number>) => {\n    return n > 1\n  }')),
      catalog,
      { recordAnalysis: true },
    );
    const symbols = (recording?.frames ?? []).flatMap((f) => [...f.scope.symbols.values()]);
    const f = symbols.find((s) => s.name === 'f');
    expect(f?.posType?.kind).toBe('closure');
    if (f?.posType?.kind !== 'closure') throw new Error('unreachable');
    expect(f.posType.params.map((p) => p.name)).toEqual(['n']);
    expect(f.posType.returns.returns).toBe(true);
  });
});

describe('MOV_EXPR_CLOSURE_POSITION never fires at a legal closure position', () => {
  // bridge.ts rejects a bare `=>` wherever the FORMULA grammar (not the
  // statement parser) is handed the raw text — a call argument, a write
  // field, a hop WHERE. Every position below is read by the statement
  // parser's own `atClosure`/`parseClosure`, so the raw closure text never
  // reaches the bridge; this pins that structural split against regression.
  it('an assignment RHS is clean', () => {
    expect(codes(inMovement('  pick = (n: <number>) => { return n }'))).not.toContain(
      C.EXPR_CLOSURE_POSITION,
    );
  });

  it('a MAP function slot is clean', () => {
    const source = inMovement(
      '  names = COLLECT(inbox-[:messages]->.`Subject`)\n  loud = MAP(names, (t) => { return t })',
    );
    expect(codes(source)).not.toContain(C.EXPR_CLOSURE_POSITION);
  });

  it('a race arm is clean', () => {
    const source = inMovement(
      '  r = await race([() => { return e.`Subject` }, () => { await sleep(2d) }])',
    );
    expect(codes(source)).not.toContain(C.EXPR_CLOSURE_POSITION);
  });

  it("a callback's subject is clean", () => {
    const source = inMovement('  cb = callback((n: <number>) => { return n })');
    expect(codes(source)).not.toContain(C.EXPR_CLOSURE_POSITION);
  });
});

describe('the retired inline block names its replacement', () => {
  it('`{ … }.name` is refused, pointing at return and closures', () => {
    const source = inMovement('  x = { t = e.`Subject` }.t');
    expect(codes(source)).toContain(C.INLINE_BLOCK_RETIRED);
    expect(messages(source)).toContain('return');
  });
});
