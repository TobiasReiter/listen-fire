// A `unique by` conjunct that is not part of the key (`WITHIN`, `!=`, a range)
// narrows the candidates the lookup found, testing each candidate's own
// fields. One that reads anything else (a hop, a value bound elsewhere in the
// run) could not be honoured and was dropped without a word; it is refused,
// pointing at the target's WHERE, which reads the candidate with the whole run
// in scope.
//
// Two shapes so a hardcode cannot pass: a root collection (`reg-[:entities]->`)
// and a record edge off a found handle (`co-[:Branches]->`).

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic, DiagnosticCodes as C } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';

const registrySchema: InstanceSchema = {
  positions: {
    entity: {
      properties: { Name: 'text', City: 'text', Updated: 'datetime' },
      edges: { Holdings: { target: 'holding' }, Branches: { target: 'entity', writable: true } },
    },
    holding: { properties: { Amount: 'number' }, edges: {} },
  },
  collections: { entities: { target: 'entity' } },
  writableRoots: {
    entity: {
      fields: { Name: 'text', City: 'text', Updated: 'datetime' },
      resultShape: { externalId: 'text', Name: 'text', City: 'text', Updated: 'datetime' },
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
    'movement main() {',
    '  wanted = "Example Holdings"',
    '  home = "Lisbon"',
    '  co = match reg-[:entities]-> { unique by (`Name`), Name: wanted }',
    ...body,
    '}',
  ].join('\n');

const errors = (source: string): Diagnostic[] =>
  checkProgram(parseProgram(source), catalog).filter((d) => (d.severity ?? 'error') === 'error');
const codes = (source: string): string[] => errors(source).map((d) => d.code);
const expectClean = (source: string): void =>
  expect(errors(source).map((d) => `${d.code}: ${d.message}`)).toEqual([]);

describe('a unique by conjunct that is not a key tests the candidate itself', () => {
  it('WITHIN, != and a range over the record\'s own fields are clean — in every clause', () => {
    expectClean(
      inMovement(
        '  write reg-[:entities]-> {',
        '    unique by (`Name`)',
        '    unique by (`City`, `Updated` WITHIN 30d, `Name` != "Placeholder")',
        '    Name: wanted',
        '    City: "Lisbon"',
        '  }',
      ),
    );
  });

  it('a pinned value and a parent handle are keys, not narrowings', () => {
    expectClean(inMovement('  write co-[:Branches]-> { unique by (co, `City` == "Oslo"), Name: wanted }'));
  });

  it('a hop is refused, pointing at the target WHERE — on a root collection', () => {
    const found = errors(
      inMovement('  write reg-[:entities]-> { unique by (`Name`, EXISTS(co-[:Holdings]->)), Name: wanted }'),
    );
    expect(found.map((d) => d.code)).toEqual([C.UNIQUE_CONJUNCT_NEEDS_WHERE]);
    expect(found[0]?.message).toContain('use a WHERE on the target instead');
  });

  it('a hop is refused on a record edge too, and in a match', () => {
    expect(
      codes(inMovement('  write co-[:Branches]-> { unique by (`Name`, COUNT(co-[:Holdings]->) > 1), Name: wanted }')),
    ).toEqual([C.UNIQUE_CONJUNCT_NEEDS_WHERE]);
    expect(
      codes(inMovement('  x = match reg-[:entities]-> { unique by (`Name`, EXISTS(co-[:Holdings]->)), Name: wanted }')),
    ).toEqual([C.UNIQUE_CONJUNCT_NEEDS_WHERE]);
  });

  it('a value bound elsewhere in the run is refused — the conjunct tests only the candidate', () => {
    expect(
      codes(inMovement('  write reg-[:entities]-> { unique by (`Name`, `City` != home), Name: wanted }')),
    ).toEqual([C.UNIQUE_CONJUNCT_NEEDS_WHERE]);
    expect(
      codes(inMovement('  write reg-[:entities]-> { unique by (`Name`, `City` != co.`City`), Name: wanted }')),
    ).toEqual([C.UNIQUE_CONJUNCT_NEEDS_WHERE]);
  });

  it('the same test on the target WHERE is clean', () => {
    expectClean(
      inMovement(
        '  write reg-[e:entities WHERE EXISTS(e-[:Holdings]->) AND e.`City` != home]-> { unique by (`Name`), Name: wanted }',
      ),
    );
  });

  it('a clause with no key is refused — nothing finds the candidates its test would narrow', () => {
    const found = errors(
      inMovement('  write reg-[:entities]-> { unique by (`Updated` WITHIN 30d), Name: wanted }'),
    );
    expect(found.map((d) => d.code)).toEqual([C.UNIQUE_CONJUNCT_NEEDS_WHERE]);
    expect(found[0]?.message).toContain('nothing to find the record by');
  });
});
