// Checker coverage for `write e { … }` where `e` is a record the RUN built — a
// landing on a run-local node's edge.
//
// The run's own graph is the system that holds such a record, and it updates
// by id: so every spelling that reaches one — the saved write result, the alias
// of a block head, a collection op's parameter — is an in-place update, checked
// field by field against the landing type exactly as the write that created it
// was. A value the run merely synthesised (`graph<Shape> { … }`) is on no edge
// and stays refused.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic, DiagnosticCodes as C } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';

const inboxSchema: InstanceSchema = {
  positions: {
    message: { properties: { Subject: 'text' }, edges: {} },
  },
  collections: { messages: { target: 'message' } },
  writableRoots: {},
};

// A system that updates in place, so a collection op's parameter over ITS
// records has a write the checker can check field by field.
const crmSchema: InstanceSchema = {
  positions: { company: { properties: { name: 'text' }, edges: {} } },
  collections: { companies: { target: 'company' } },
  supportsInPlaceUpdate: true,
  writableRoots: { company: { fields: { name: 'text' }, resultShape: { externalId: 'text' } } },
};

const catalog = mockCatalog({
  adapters: {
    email: { constructionArgs: [], schema: inboxSchema },
    crm: { constructionArgs: [], schema: crmSchema },
  },
});

const PRELUDE = `import { email, crm } from adapters
inbox = email()
sys = crm()

node Company {
  name: <text>
  thesis: <text | null>
  website: <text | null>
}
`;

const SEED = `  deduped = node { companies: <Company> order by arrival }
  h = write deduped-[:companies]-> { unique by (FUZZY name)
    name: "Acme"
  }`;

function check(body: string): Diagnostic[] {
  const source = `${PRELUDE}
movement m(msg: <inbox-[:message]->>) {
${SEED}
${body}
}`;
  return checkProgram(parseProgram(source), catalog).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}

const codes = (body: string): string[] => check(body).map((d) => d.code);

describe('an in-place write to a record the run built is accepted', () => {
  it('the saved write result', () => {
    expect(codes('  write h { thesis: "x" }')).toEqual([]);
  });

  it('the alias of a block head', () => {
    expect(
      codes(['  deduped-[e:companies]-> {', '    write e { thesis: "x" }', '  }'].join('\n')),
    ).toEqual([]);
  });

  it("MAP's parameter, over the hop", () => {
    expect(
      codes(['  MAP(deduped-[:companies]->, (e) => {', '    write e { thesis: "x" }', '  })'].join('\n')),
    ).toEqual([]);
  });

  it("MAP's parameter, over a name bound to the hop", () => {
    expect(
      codes(
        [
          '  all = deduped-[:companies]->',
          '  MAP(all, (e) => {',
          '    write e { thesis: "x" }',
          '  })',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it("MAP's parameter, over FILTER's answer", () => {
    expect(
      codes(
        [
          '  MAP(FILTER(deduped-[:companies]->, (e) => e.name == "Acme"), (e) => {',
          '    write e { thesis: "x" }',
          '  })',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('a set-if-empty field', () => {
    expect(codes('  write h { thesis ?: "x" }')).toEqual([]);
  });

  it('the production shape: settings, COALESCE, a guarded second write', () => {
    expect(
      codes(
        [
          '  MAP(deduped-[:companies]->, { concurrency: 6, onError: "warn" }, (e) => {',
          '    write e {',
          '      name: COALESCE(e.thesis, e.name)',
          '      thesis: COALESCE(e.website, "none")',
          '    }',
          '    new_website = e.website',
          '    if new_website != null { write e { website: new_website } }',
          '  })',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('a record nested under one the run built', () => {
    const nested = `node Startup {
  name: <text>
  node founders {
    name: <text>
  }
}
`;
    const source = `${PRELUDE}${nested}
movement m(msg: <inbox-[:message]->>) {
  found = node { startups: <Startup> order by arrival }
  s = write found-[:startups]-> { name: "Acme" }
  f = write s-[:founders]-> { name: "Jane" }
  write f { name: "Jane Doe" }
  s-[g:founders]-> {
    write g { name: "J. Doe" }
  }
}`;
    const errors = checkProgram(parseProgram(source), catalog).filter((d) => (d.severity ?? 'error') === 'error');
    expect(errors.map((d) => d.code)).toEqual([]);
  });
});

describe('an in-place write to a record the run built is checked against its landing type', () => {
  const forms: Array<[string, (line: string) => string]> = [
    ['the saved write result', (line) => `  write h ${line}`],
    ['the alias of a block head', (line) => ['  deduped-[e:companies]-> {', `    write e ${line}`, '  }'].join('\n')],
    ["MAP's parameter", (line) => ['  MAP(deduped-[:companies]->, (e) => {', `    write e ${line}`, '  })'].join('\n')],
  ];

  it.each(forms)('%s: a field the landing type does not have is refused', (_form, write) => {
    const diagnostics = check(write('{ nope: "x" }'));
    expect(diagnostics.map((d) => d.code)).toEqual([C.WRITE_UNKNOWN_FIELD]);
    expect(diagnostics[0].message).toContain('thesis');
  });

  it.each(forms)('%s: a value of the wrong type is refused', (_form, write) => {
    expect(codes(write('{ thesis: 42 }'))).toEqual([C.WRITE_FIELD_TYPE]);
  });

  it.each(forms)("%s: 'unique by' is refused — the record is already identified", (_form, write) => {
    expect(codes(write('{ unique by (name)\n      name: "x" }'))).toEqual([C.WRITE_POSITION_UNIQUE]);
  });
});

describe('a value the run synthesised is not a record to update', () => {
  it('a graph<Shape> value', () => {
    expect(codes('  g = graph<Company> { name: "Acme" }\n  write g { thesis: "x" }')).toEqual([
      C.WRITE_POSITION_NOT_RECORD,
    ]);
  });

  it('a node literal', () => {
    expect(codes('  d = node { name: "Acme" }\n  write d { name: "x" }')).toEqual([
      C.WRITE_POSITION_NOT_RECORD,
    ]);
  });
});

describe("a system that cannot update by id still refuses", () => {
  it("the alias of one of its records", () => {
    expect(
      codes(['  inbox-[x:messages]-> {', '    write x { Subject: "x" }', '  }'].join('\n')),
    ).toEqual([C.WRITE_POSITION_NO_UPDATE]);
  });
});

describe("a collection op's parameter is typed as the record it is", () => {
  it('reading a field it does not have is refused', () => {
    expect(
      codes(
        [
          '  MAP(deduped-[:companies]->, (e) => {',
          '    return e.nope',
          '  })',
        ].join('\n'),
      ),
    ).toContain(C.UNKNOWN_PROPERTY);
  });
});

describe("a collection op's parameter over a system's records writes like the hop's alias", () => {
  const over = (field: string) =>
    ['  MAP(sys-[:companies]->, (c) => {', `    write c { ${field}: "x" }`, '  })'].join('\n');

  it('a field the record has is accepted', () => {
    expect(codes(over('name'))).toEqual([]);
  });

  it('a field it does not have is refused, as it is for the alias', () => {
    const alias = ['  sys-[c:companies]-> {', '    write c { nope: "x" }', '  }'].join('\n');
    expect(codes(over('nope'))).toEqual(codes(alias));
    expect(codes(over('nope'))).toEqual([C.WRITE_UNKNOWN_FIELD]);
  });
});

describe("a graph<Shape>'s nested records are records the run built", () => {
  const SHAPED = `node Found {
  node companies {
    name: <text>
    thesis: <text | null>
  }
}
`;
  const shaped = (body: string): string[] =>
    checkProgram(
      parseProgram(`${PRELUDE}${SHAPED}
movement m(msg: <inbox-[:message]->>) {
  found = graph<Found> { companies: [{ name: "Acme" }] }
${body}
}`),
      catalog,
    )
      .filter((d) => (d.severity ?? 'error') === 'error')
      .map((d) => d.code);

  it('the alias of a block head over its nested node updates in place', () => {
    expect(shaped(['  found-[c:companies]-> {', '    write c { thesis: "x" }', '  }'].join('\n'))).toEqual([]);
  });

  it('…checked against the nested node', () => {
    expect(shaped(['  found-[c:companies]-> {', '    write c { nope: "x" }', '  }'].join('\n'))).toEqual([
      C.WRITE_UNKNOWN_FIELD,
    ]);
  });

  it('the graph value itself is still not a record', () => {
    expect(shaped('  write found { thesis: "x" }')).toEqual([C.WRITE_POSITION_NOT_RECORD]);
  });
});
