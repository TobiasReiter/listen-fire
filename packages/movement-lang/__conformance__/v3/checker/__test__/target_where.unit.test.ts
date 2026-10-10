// A WHERE on a `match` or `write` target's final hop says which existing
// records the find may take. It used to be accepted and never read; the checker
// now types it where it applies — at the record the hop lands on, with the hop's
// alias naming that record — and refuses it where it cannot apply.
//
// Two shapes so a hardcode cannot pass: a root collection (`reg-[:entities]->`)
// and a record edge off a found handle (`co-[:Branches]->`).

import { parseProgram } from '../../parser/parse';
import { parseMovementExpression } from '../../expression/bridge';
import { checkProgram, Diagnostic, DiagnosticCodes as C } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';

const registrySchema: InstanceSchema = {
  positions: {
    entity: {
      properties: { Name: 'text', City: 'text', Updated: 'date' },
      edges: { Holdings: { target: 'holding' }, Branches: { target: 'entity', writable: true } },
    },
    holding: { properties: { Amount: 'number' }, edges: {} },
  },
  collections: { entities: { target: 'entity' } },
  writableRoots: {
    entity: {
      fields: { Name: 'text', City: 'text', Updated: 'date' },
      resultShape: { externalId: 'text', Name: 'text', City: 'text', Updated: 'date' },
      fuzzyResolution: ['Name'],
    },
  },
};

const catalog = mockCatalog({
  adapters: {
    registry: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: registrySchema,
    },
  },
  credentials: { public_registry: { adapter: 'registry' } },
});

const inMovement = (...body: string[]) =>
  [
    'import { registry } from adapters',
    'import { public_registry } from credentials',
    'reg = registry(credentials: public_registry)',
    'node Entry {',
    '  Name: <text>',
    '}',
    'movement main() {',
    '  wanted = "Example Holdings"',
    ...body,
    '}',
  ].join('\n');

const errors = (source: string): Diagnostic[] =>
  checkProgram(parseProgram(source), catalog).filter((d) => (d.severity ?? 'error') === 'error');
const codes = (source: string): string[] => errors(source).map((d) => d.code);
const expectClean = (source: string): void =>
  expect(errors(source).map((d) => `${d.code}: ${d.message}`)).toEqual([]);

describe('the final hop of a target takes a WHERE', () => {
  it('parses, and the WHERE lands on the final hop', () => {
    const source = inMovement(
      '  match reg-[e:entities WHERE EXISTS(e-[:Holdings]->)]-> { unique by (FUZZY `Name`), Name: wanted }',
    );
    const program = parseProgram(source);
    expect(program).toBeDefined();
    const probe = parseMovementExpression('reg-[e:entities WHERE EXISTS(e-[:Holdings]->)]->.`__probe`');
    const step = probe.type === 'traverse' ? probe.steps[0] : undefined;
    expect(step?.type === 'edge' && step.alias === 'e' && step.expressionFilter !== undefined).toBe(true);
  });

  it('a match narrowed by a hop read is clean', () => {
    expectClean(
      inMovement(
        '  match reg-[e:entities WHERE EXISTS(e-[:Holdings]->)]-> { unique by (FUZZY `Name`), Name: wanted }',
      ),
    );
  });

  it('a write narrowed by a field of the record is clean — alias-qualified or bare', () => {
    expectClean(
      inMovement(
        '  write reg-[e:entities WHERE e.`City` == "Berlin"]-> { unique by (FUZZY `Name`), Name: wanted }',
      ),
    );
    expectClean(
      inMovement('  write reg-[:entities WHERE `City` == "Berlin"]-> { unique by (FUZZY `Name`), Name: wanted }'),
    );
  });

  it('a record edge off a found handle takes one too (second shape)', () => {
    expectClean(
      inMovement(
        '  co = match reg-[:entities]-> { unique by (FUZZY `Name`), Name: wanted }',
        '  match co-[b:Branches WHERE b.`City` == "Berlin" AND COUNT(b-[:Holdings]->) > 1]-> { unique by (FUZZY `Name`), Name: wanted }',
      ),
    );
  });
});

describe('the unique by forms the handbook documents beside it', () => {
  it('a component pinned to a value, and a non-equality component, check clean', () => {
    expectClean(inMovement('  match reg-[:entities]-> { unique by (`Name`, `City` == "Berlin"), Name: wanted }'));
    expectClean(inMovement('  match reg-[:entities]-> { unique by (`Name`, `Updated` WITHIN 30d), Name: wanted }'));
  });
});

describe('the WHERE is typed against the type the target lands on', () => {
  it('an unknown field, alias-qualified, is an error naming the landing type', () => {
    const found = errors(
      inMovement(
        '  match reg-[e:entities WHERE e.`Ghost` == "x"]-> { unique by (FUZZY `Name`), Name: wanted }',
      ),
    );
    expect(found.map((d) => d.code)).toEqual([C.UNKNOWN_PROPERTY]);
    expect(found[0].message).toContain("no field 'Ghost'");
  });

  it('an unknown field, bare, is the same error', () => {
    expect(
      codes(inMovement('  write reg-[:entities WHERE `Ghost` == "x"]-> { unique by (FUZZY `Name`), Name: wanted }')),
    ).toEqual([C.UNKNOWN_PROPERTY]);
  });

  it('an unknown edge inside the WHERE is an error', () => {
    expect(
      codes(
        inMovement(
          '  match reg-[e:entities WHERE EXISTS(e-[:Nowhere]->)]-> { unique by (FUZZY `Name`), Name: wanted }',
        ),
      ),
    ).toEqual([C.TRAVERSE_UNKNOWN_EDGE]);
  });

  it('on the handle-edge shape, the landing is the edge target', () => {
    expect(
      codes(
        inMovement(
          '  co = match reg-[:entities]-> { unique by (FUZZY `Name`), Name: wanted }',
          '  match co-[b:Branches WHERE b.`Amount` > 1]-> { unique by (FUZZY `Name`), Name: wanted }',
        ),
      ),
    ).toEqual([C.UNKNOWN_PROPERTY]);
  });
});

describe('where a target WHERE is refused', () => {
  it('on a hop other than the last', () => {
    const found = errors(
      inMovement(
        '  write reg-[p:entities WHERE p.`City` == "Berlin"]->-[:Branches]-> { unique by (FUZZY `Name`), Name: wanted }',
      ),
    );
    expect(found.map((d) => d.code)).toContain(C.TARGET_WHERE_NOT_FINAL);
    expect(found.find((d) => d.code === C.TARGET_WHERE_NOT_FINAL)?.message).toContain('final hop');
  });

  it('a write inside the WHERE does not parse — the filter is read-only by construction', () => {
    expect(
      codes(
        inMovement(
          '  match reg-[e:entities WHERE write reg-[:entities]-> { Name: "x" }]-> { unique by (FUZZY `Name`), Name: wanted }',
        ),
      ),
    ).toEqual([C.EXPR_PARSE]);
  });

  it('an ask inside the WHERE does not parse either', () => {
    expect(
      codes(
        inMovement(
          '  match reg-[e:entities WHERE await e-[:Holdings]->]-> { unique by (FUZZY `Name`), Name: wanted }',
        ),
      ),
    ).toEqual([C.EXPR_PARSE]);
  });

  it("on a 'bind' write — the binding is the identity, so there is nothing to narrow", () => {
    const found = errors(
      inMovement(
        '  co = match reg-[:entities]-> { unique by (FUZZY `Name`), Name: wanted }',
        '  write reg-[e:entities WHERE e.`City` == "Berlin"]-> bind co { Name: wanted }',
      ),
    );
    expect(found.map((d) => d.code)).toContain(C.TARGET_WHERE_BIND);
  });

  it('on an edge of a node this run built', () => {
    expect(
      codes(
        inMovement(
          '  seen = node { entries: <Entry> }',
          '  write seen-[:entries]-> { unique by (`Name`), Name: wanted }',
          '  match seen-[x:entries WHERE x.`Name` == "y"]-> { unique by (`Name`), Name: wanted }',
        ),
      ),
    ).toEqual([C.TARGET_WHERE_LOCAL]);
  });
});
