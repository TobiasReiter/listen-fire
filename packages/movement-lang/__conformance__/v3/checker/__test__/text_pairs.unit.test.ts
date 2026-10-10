// TEXT.PAIRS's first argument has to be KEYED — a dict literal, or a typed
// record — which the stdlib registry has no way to say on its own (arity is
// a count, `literalArgs` is about parsed strings). `recordArg` is the
// smallest addition that lets the checker refuse `<json>` (a system's
// opaque data looks keyed at the write layer, but the checker cannot see
// its keys) while accepting the two shapes that ARE keyed.
//
// A record clearing that bar can still be refused: the engine's `recordArg`
// dereference (`recordFields`) reads a record's fields off what its BINDING
// holds, never off a live system (an adapter hands back one field at a time,
// with no "every field" to ask for) — see `text_pairs_record_arg.unit.test.ts`
// for that half of the rule.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic } from '../check';
import { mockCatalog, InstanceSchema } from '../catalog';

const CODE = 'MOV_STDLIB_ARG_NOT_RECORD';

const crmSchema: InstanceSchema = {
  positions: {
    deal: {
      properties: {
        Name: 'text',
        Amount: 'number',
        Payload: 'json',
      },
      edges: {},
    },
  },
  collections: { deals: { target: 'deal' } },
  writableRoots: {
    deal: {
      fields: { Name: 'text', Amount: 'number' },
      resultShape: { externalId: 'text', Url: 'text' },
    },
  },
};

const catalog = mockCatalog({
  adapters: {
    crm: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: crmSchema,
    },
  },
  credentials: { crm_cred: { adapter: 'crm' } },
});

const PRELUDE = [
  'import { crm } from adapters',
  'import { crm_cred } from credentials',
  '',
  'c = crm(credentials: crm_cred)',
].join('\n');

const onDeal = (body: string): string =>
  `${PRELUDE}\nmovement m(d: <c-[:deal]->>) {\n${body}\n}`;

const errors = (source: string): Diagnostic[] =>
  checkProgram(parseProgram(source), catalog).filter(d => (d.severity ?? 'error') === 'error');
const codes = (source: string): string[] => errors(source).map(d => d.code);

function expectClean(source: string): void {
  expect(errors(source).map(d => `${d.code}: ${d.message}`)).toEqual([]);
}

describe('TEXT.PAIRS argument typing', () => {
  it('a dict literal is accepted', () => {
    expectClean(onDeal('  write c-[:deals]-> { Name: TEXT.PAIRS({ a: "1", b: "2" }) }'));
  });

  it("the movement's own record parameter is refused: it is a live system read, not a spelled record", () => {
    const source = onDeal('  write c-[:deals]-> { Name: TEXT.PAIRS(d) }');
    expect(codes(source)).toContain(CODE);
    expect(errors(source).find(e => e.code === CODE)?.message).toBe(
      '`TEXT.PAIRS` takes a record whose fields the program spells out — a dict literal, a '
        + '`node { … }` literal, an extracted record or a declared one; build a dict of the '
        + 'fields you want from this record',
    );
  });

  it('<json> is refused, naming what it takes', () => {
    const source = onDeal('  write c-[:deals]-> { Name: TEXT.PAIRS(d.`Payload`) }');
    expect(codes(source)).toContain(CODE);
    expect(errors(source).find(e => e.code === CODE)?.message).toContain(
      'TEXT.PAIRS(record, separator?) takes a record or a dict',
    );
  });

  it('an ordinary scalar is refused too', () => {
    expect(codes(onDeal('  write c-[:deals]-> { Name: TEXT.PAIRS(d.`Name`) }'))).toContain(CODE);
  });

  it('an operand this layer cannot see stays silent', () => {
    expectClean(onDeal('  write c-[:deals]-> { Name: TEXT.PAIRS(AI("a record")) }'));
  });
});
