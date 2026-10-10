// A read hop's WHERE is typed at the record the hop lands on, and the hop's own
// alias names that record INSIDE the filter — `reg-[e:entities WHERE e.X]->`
// reads `X` off each landed entity, exactly as the bare `WHERE \`X\`` does. The
// alias used to be bound only after the filter was typed, so `e.<anything>`
// was never checked.
//
// Two shapes so a hardcode cannot pass: a root collection (`reg-[:entities]->`)
// and a record edge off a found record (`-[:Holdings]->`).

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic, DiagnosticCodes as C } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';

const registrySchema: InstanceSchema = {
  positions: {
    entity: {
      properties: { Name: 'text', City: 'text', Ghost: 'boolean' },
      edges: { Holdings: { target: 'holding' } },
    },
    holding: { properties: { Amount: 'number' }, edges: {} },
  },
  collections: { entities: { target: 'entity' } },
  writableRoots: {},
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
    ...body,
    '}',
  ].join('\n');

const errors = (source: string): Diagnostic[] =>
  checkProgram(parseProgram(source), catalog).filter((d) => (d.severity ?? 'error') === 'error');
const expectClean = (source: string): void =>
  expect(errors(source).map((d) => `${d.code}: ${d.message}`)).toEqual([]);

describe("a read hop's WHERE binds the hop's own alias", () => {
  it('an alias-qualified field of the landing type is clean', () => {
    expectClean(inMovement('  rows = reg-[e:entities WHERE e.`Ghost` == true]->'));
    expectClean(inMovement('  rows = reg-[:entities]->-[h:Holdings WHERE h.`Amount` > 10]->'));
  });

  it('the bare form still types', () => {
    expectClean(inMovement('  rows = reg-[e:entities WHERE `Ghost` == true]->'));
  });

  it('an unknown alias-qualified field is MOV_UNKNOWN_PROPERTY — on a root collection', () => {
    const found = errors(inMovement('  rows = reg-[e:entities WHERE e.`NoSuchField` == true]->'));
    expect(found.map((d) => d.code)).toEqual([C.UNKNOWN_PROPERTY]);
    expect(found[0]?.message).toContain('NoSuchField');
  });

  it('an unknown alias-qualified field is MOV_UNKNOWN_PROPERTY — on a record edge', () => {
    const found = errors(
      inMovement('  rows = reg-[:entities]->-[h:Holdings WHERE h.`NoSuchField` > 10]->'),
    );
    expect(found.map((d) => d.code)).toEqual([C.UNKNOWN_PROPERTY]);
  });

  it('the alias names the landed record, so a hop walked from it types too', () => {
    expectClean(inMovement('  rows = reg-[e:entities WHERE EXISTS(e-[:Holdings]->)]->'));
  });
});
