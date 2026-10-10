// Shadowing is a save error (core calculus v2, §Bindings). Rebinding a name in
// the SAME scope already died as MOV_DUPLICATE_DECL; an inner scope reusing an
// enclosing scope's name used to resolve silently, which is the last place one
// name could mean two things. Both halves now refuse.
//
// The carve-out is the whole reason this needs its own file: a guard clause
// NARROWS its subject by re-declaring the same symbol with a sharper type, into
// the arm or into the guard's continuation. That is the same name on purpose,
// so it must stay clean — and it is told apart STRUCTURALLY (narrowing calls
// `Scope.declare`; only authored bindings go through `declareAuthored`), never
// by inspecting the name.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic, DiagnosticCodes as C } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';

const crmSchema: InstanceSchema = {
  positions: {
    company: {
      properties: { Name: 'text', Note: { kind: 'maybeAbsent', of: 'text' } },
      edges: { people: { target: 'person', readable: true } },
    },
    person: { properties: { Email: 'text' }, edges: {} },
  },
  collections: { company: { target: 'company' } },
  writableRoots: {},
};

const catalog = mockCatalog({
  adapters: {
    attio: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: crmSchema,
    },
  },
  credentials: { probe: { adapter: 'attio' } },
});

const PRELUDE = ['import { attio } from adapters', 'import { probe } from credentials', 'crm = attio(credentials: probe)'].join('\n');

const diagnostics = (source: string): Diagnostic[] =>
  checkProgram(parseProgram(`${PRELUDE}\n${source}`), catalog).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );

const codes = (source: string): string[] => diagnostics(source).map((d) => d.code);
const messages = (source: string): string => diagnostics(source).map((d) => d.message).join('\n');

const inMovement = (body: string): string =>
  `movement main(c: <crm-[:company]->>) {\n${body}\n}`;

describe('an inner scope may not reuse an enclosing name', () => {
  it('a binding inside a traversal block shadowing an outer binding is MOV_SHADOWED_NAME', () => {
    expect(
      codes(inMovement(['  label = c.`Name`', '  crm-[co:company]-> {', '    label = co.`Name`', '  }'].join('\n'))),
    ).toContain(C.SHADOWED_NAME);
  });

  it('the message names what the outer binding is, and where', () => {
    expect(
      messages(inMovement(['  label = c.`Name`', '  crm-[co:company]-> {', '    label = co.`Name`', '  }'].join('\n'))),
    ).toMatch(/'label' is already a binding at line \d+/);
  });

  it('a traversal ALIAS shadowing an outer binding is MOV_SHADOWED_NAME', () => {
    expect(
      codes(inMovement(['  co = c.`Name`', '  crm-[co:company]-> {', '  }'].join('\n'))),
    ).toContain(C.SHADOWED_NAME);
  });

  it('a nested block reusing the enclosing block’s alias is MOV_SHADOWED_NAME', () => {
    expect(
      codes(
        inMovement(
          ['  crm-[co:company]-> {', '    co-[co:people]-> {', '    }', '  }'].join('\n'),
        ),
      ),
    ).toContain(C.SHADOWED_NAME);
  });

  it('a movement PARAMETER shadowing a file-level import is MOV_SHADOWED_NAME', () => {
    // TypeScript would allow a parameter to shadow an outer const; this
    // language refuses shadowing uniformly, and a parameter is no exception.
    expect(codes('movement main(crm: <crm-[:company]->>) {\n}')).toContain(C.SHADOWED_NAME);
  });

  it('a body binding shadowing its own movement’s name is MOV_SHADOWED_NAME', () => {
    expect(codes(inMovement('  main = c.`Name`'))).toContain(C.SHADOWED_NAME);
  });

  it('sibling scopes reusing a name are NOT shadowing — neither encloses the other', () => {
    expect(
      codes(
        inMovement(
          [
            '  crm-[a:company]-> {',
            '    label = a.`Name`',
            '  }',
            '  crm-[b:company]-> {',
            '    label = b.`Name`',
            '  }',
          ].join('\n'),
        ),
      ),
    ).not.toContain(C.SHADOWED_NAME);
  });

  it("a combinator arm's own bindings live in the arm, so they shadow nothing", () => {
    expect(
      codes(
        inMovement(
          [
            '  one = c.`Name`',
            '  r = await parallel([() => { return c.`Name` }, () => { return c.`Name` }])',
          ].join('\n'),
        ),
      ),
    ).not.toContain(C.SHADOWED_NAME);
  });
});

describe('a guard-clause narrowing re-declares its subject on purpose', () => {
  it('narrowing a maybe-absent binding into the guard’s continuation is clean', () => {
    expect(
      codes(
        inMovement(
          ['  note = c.`Note`', '  if note == null { ERROR("no note") }', '  kept = note'].join('\n'),
        ),
      ),
    ).not.toContain(C.SHADOWED_NAME);
  });

  it('narrowing inside the arm is clean too', () => {
    expect(
      codes(
        inMovement(
          ['  note = c.`Note`', '  if note != null {', '    kept = note', '  }'].join('\n'),
        ),
      ),
    ).not.toContain(C.SHADOWED_NAME);
  });

  it('and the narrowing still WORKS — the continuation reads the present value', () => {
    expect(
      codes(
        inMovement(
          ['  note = c.`Note`', '  if note == null { ERROR("no note") }', '  kept = note'].join('\n'),
        ),
      ),
    ).toEqual([]);
  });
});
