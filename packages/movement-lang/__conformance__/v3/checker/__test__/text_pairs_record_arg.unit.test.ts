// `checkStdlibRecordArg`'s refinement (see `text_pairs.unit.test.ts` for the
// dict/scalar/json half of the rule): a value can be typed `record` and
// still be one `TEXT.PAIRS` can't read. The engine's one dereference for a
// `recordArg` (`recordFields` in apps/api's movement_engine/expression.ts)
// reads a record's fields off what its BINDING holds — a `node {…}`
// literal's entries, an extraction's exported fields, a write's own result —
// and throws `MOVENG_UNSUPPORTED` for the three shapes it has no field list
// for: a record read live from a connected system, the movement's own
// trigger/parameter record, and a many-record collection (a traversal
// block's whole return, not the one member a hop alias lands). The checker
// refuses all three so a saved movement can never reach those throws.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic } from '../check';
import { mockCatalog, InstanceSchema } from '../catalog';

const CODE = 'MOV_STDLIB_ARG_NOT_RECORD';

const REFUSAL =
  '`TEXT.PAIRS` takes a record whose fields the program spells out — a dict literal, a '
  + '`node { … }` literal, an extracted record or a declared one; build a dict of the fields '
  + 'you want from this record';

const crmSchema: InstanceSchema = {
  positions: {
    deal: { properties: { Name: 'text' }, edges: {} },
  },
  collections: { deals: { target: 'deal' } },
  writableRoots: {
    deal: { fields: { Name: 'text' }, resultShape: {} },
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
  'node Entry {',
  '  name: <text>',
  '}',
  '',
  'c = crm(credentials: crm_cred)',
].join('\n');

const onDeal = (body: string): string =>
  `${PRELUDE}\nmovement m(d: <c-[:deal]->>) {\n${body}\n}`;

const errors = (source: string): Diagnostic[] =>
  checkProgram(parseProgram(source), catalog).filter(d => (d.severity ?? 'error') === 'error');
const codes = (source: string): string[] => errors(source).map(d => d.code);
const messageFor = (source: string): string | undefined =>
  errors(source).find(e => e.code === CODE)?.message;

function expectClean(source: string): void {
  expect(errors(source).map(d => `${d.code}: ${d.message}`)).toEqual([]);
}

describe('TEXT.PAIRS refuses a record with no field list in hand', () => {
  it('the movement\'s own trigger/parameter record is refused', () => {
    const source = onDeal('  write c-[:deals]-> { Name: TEXT.PAIRS(d) }');
    expect(codes(source)).toContain(CODE);
    expect(messageFor(source)).toBe(REFUSAL);
  });

  it('a record traversed live off an adapter is refused', () => {
    const source = onDeal([
      '  c-[x:deals]-> {',
      '    write c-[:deals]-> { Name: TEXT.PAIRS(x) }',
      '  }',
    ].join('\n'));
    expect(codes(source)).toContain(CODE);
    expect(messageFor(source)).toBe(REFUSAL);
  });

  it("a many-record collection — a traversal block's whole return — is refused", () => {
    const source = onDeal([
      '  deduped = node { entries: <Entry> }',
      '  write deduped-[:entries]-> { unique by (`name`), name: "Acme" }',
      '  all = deduped-[e:entries]-> { return e }',
      '  write c-[:deals]-> { Name: TEXT.PAIRS(all) }',
    ].join('\n'));
    expect(codes(source)).toContain(CODE);
    expect(messageFor(source)).toBe(REFUSAL);
  });

  it('the same collection, one member at a time inside the hop, is accepted', () => {
    expectClean(onDeal([
      '  deduped = node { entries: <Entry> }',
      '  write deduped-[:entries]-> { unique by (`name`), name: "Acme" }',
      '  deduped-[e:entries]-> {',
      '    write c-[:deals]-> { Name: TEXT.PAIRS(e) }',
      '  }',
    ].join('\n')));
  });

  it('FIRST(…) over the collection narrows it back to one, and is accepted', () => {
    expectClean(onDeal([
      '  deduped = node { entries: <Entry> }',
      '  write deduped-[:entries]-> { unique by (`name`), name: "Acme" }',
      '  all = deduped-[e:entries]-> { return e }',
      '  top = FIRST(all)',
      '  write c-[:deals]-> { Name: TEXT.PAIRS(top) }',
    ].join('\n')));
  });

  it('a `node { … }` literal is accepted', () => {
    expectClean(onDeal([
      '  lit = node { a: "x", b: 2 }',
      '  write c-[:deals]-> { Name: TEXT.PAIRS(lit) }',
    ].join('\n')));
  });

  it('an extracted record is accepted', () => {
    expectClean(onDeal([
      '  x = extract from [d.`Name`] {',
      '    node company: "each company" {',
      '      name: "the company\'s name"',
      '    }',
      '  }',
      '  x-[co:company]-> {',
      '    write c-[:deals]-> { Name: TEXT.PAIRS(co) }',
      '  }',
    ].join('\n')));
  });
});
