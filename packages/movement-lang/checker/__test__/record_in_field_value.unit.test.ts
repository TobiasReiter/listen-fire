// A RECORD inside a field's value — under a map's key, as a list's member, in
// one arm of a conditional — is refused where it is written, with the words
// the direct form (`company: org`) already gets. A field holds values all the
// way down: before this, the checker accepted `company: { a: org }` into a
// json field, and the connector received the engine's own description of the
// record (its handle, provenance, the connector's schema). A spread of a
// record (`{ ...org }`) copies its FIELDS, which are values, and stays legal.
//
// A bug fix, so under every supported version. Two adapter shapes, per the
// fixture rule: a CRM note with a json `company`, and a ledger entry with a
// json properties bag.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic } from '../check';
import { InstanceSchema, mockCatalog, type FieldType } from '../catalog';
import { fieldAssignable, fieldTypeCompatible, recordWithin, spellHeldSteps } from '../typing';
import { SUPPORTED_LANGUAGE_VERSIONS, type LanguageVersion } from '../../language_version';

const crmSchema: InstanceSchema = {
  positions: {
    company: { properties: { name: 'text' }, edges: {} },
    note: { properties: { title: 'text', company: 'json' }, edges: {} },
  },
  collections: { companies: { target: 'company' }, notes: { target: 'note' } },
  writableRoots: {
    company: { fields: { name: 'text' }, resultShape: { externalId: 'text', name: 'text' } },
    note: { fields: { title: 'text', company: 'json' }, resultShape: { externalId: 'text' } },
  },
};

const ledgerSchema: InstanceSchema = {
  positions: { entry: { properties: { Amount: 'number', Meta: 'json' }, edges: {} } },
  collections: { entries: { target: 'entry' } },
  writableRoots: {
    entry: { fields: { Amount: 'number', Meta: 'json' }, resultShape: { externalId: 'text' } },
  },
};

const catalog = mockCatalog({
  adapters: {
    attio: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: crmSchema,
    },
    ledger: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: ledgerSchema,
    },
  },
  credentials: { crm_cred: { adapter: 'attio' }, ledger_cred: { adapter: 'ledger' } },
  plugins: {
    // A plugin handed structured data, and one whose argument declares no type.
    summarise: {
      args: ['data'],
      argTypes: { data: 'json' },
      requiredArgs: ['data'],
      effects: { ai: true },
      output: { kind: 'value', type: 'text' },
    },
    relay: { args: ['data'], requiredArgs: ['data'], effects: { ai: true }, output: { kind: 'value', type: 'text' } },
  },
});

const PRELUDE = [
  'import { attio, ledger } from adapters',
  'import { crm_cred, ledger_cred } from credentials',
  'import { summarise, relay } from plugins',
  '',
  'crm = attio(credentials: crm_cred)',
  'l = ledger(credentials: ledger_cred)',
].join('\n');

const ORG = '  org = write crm-[:companies]-> { name: "Acme Inc." }';

const program = (body: string[]): string => `${PRELUDE}\nmovement m() {\n${[ORG, ...body].join('\n')}\n}`;

const errorsUnder = (version: LanguageVersion, body: string[]): Diagnostic[] =>
  checkProgram(parseProgram(program(body), { languageVersion: version }), catalog, { languageVersion: version }).filter(
    d => (d.severity ?? 'error') === 'error',
  );

const note = (company: string): string[] => [`  write crm-[:notes]-> { title: "hello", company: ${company} }`];

const RECORD_NOT_A_VALUE = 'a record, not a value';

const VERSIONS = [...SUPPORTED_LANGUAGE_VERSIONS];

describe.each(VERSIONS)('under language version %i, a record inside a field\'s value is refused', version => {
  const refused = (body: string[], where: string): void => {
    const errors = errorsUnder(version, body);
    expect(errors.map(d => d.code)).toEqual(['MOV_WRITE_FIELD_TYPE']);
    expect(errors[0]!.message).toContain(where);
    expect(errors[0]!.message).toContain(RECORD_NOT_A_VALUE);
  };

  it('the direct form, unchanged', () => {
    refused(note('org'), "'company' on crm.note is json, and this is ");
  });

  it('under a map key', () => {
    refused(note('{ a: org }'), "and 'company.a' is ");
  });

  it('as a list member', () => {
    refused(note('[org]'), "and 'company[0]' is ");
  });

  it('under a key of a map under a key', () => {
    refused(note('{ a: { b: org } }'), "and 'company.a.b' is ");
  });

  it('as a member of a list under a key', () => {
    refused(note('{ a: [org] }'), "and 'company.a[0]' is ");
  });

  it('beside a value under another key — where version 1 typed the map as json', () => {
    refused(note('{ a: org, b: "x" }'), "and 'company.a' is ");
  });

  it('in one arm of a conditional', () => {
    refused(note('IF 1 > 0 THEN org ELSE "none" END'), "'company' on crm.note is json, and this may be ");
  });

  it('under a key in one arm of a conditional', () => {
    refused(note('IF 1 > 0 THEN { a: org } ELSE { a: "none" } END'), "and 'company.a' may be ");
  });

  it('held by a name the map was bound to', () => {
    // Version 1 types a map literal by its values alone, so its keys are not
    // known past the name — the record is under some key.
    refused(['  held = { a: org }', ...note('held')], version === 1 ? "and 'company[…]' is " : "and 'company.a' is ");
  });

  it('into the second shape: a ledger entry\'s json properties bag', () => {
    refused(['  write l-[:entries]-> { Amount: 1, Meta: { owner: org } }'], "'Meta' on l.entry is json, and 'Meta.owner' is ");
  });

  it('in a match field — what the match finds by is a value too', () => {
    const errors = errorsUnder(version, [
      '  found = match crm-[:notes]-> { unique by (`title`), title: "hello", company: { a: org } }',
    ]).filter(d => d.code === 'MOV_WRITE_FIELD_TYPE');
    expect(errors.map(d => d.message)).toEqual([expect.stringContaining("and 'company.a' is ")]);
  });

  it('a field off the record in its place is a value, and is written', () => {
    expect(errorsUnder(version, note('{ a: org.name }'))).toEqual([]);
    expect(errorsUnder(version, note('[org.name]'))).toEqual([]);
  });
});

describe('a spread of a record copies its fields, which are values', () => {
  it.each(VERSIONS.filter(v => v >= 2))('under language version %i', version => {
    expect(errorsUnder(version, note('{ ...org }'))).toEqual([]);
  });
});

describe('the type rule, as pure functions', () => {
  const record: FieldType = { kind: 'record' };
  const dictHolding: FieldType = { kind: 'dict', of: 'json', shape: { a: record, b: 'text' } };

  it('json takes no value that holds a record at any depth', () => {
    for (const value of [
      dictHolding,
      { kind: 'list', of: dictHolding },
      { kind: 'tuple', of: ['text', record] },
      { kind: 'dict', of: { kind: 'list', of: record } },
    ] satisfies FieldType[]) {
      expect(fieldTypeCompatible(value, 'json')).toBe(false);
      expect(fieldAssignable(value, 'json')).toBe(false);
    }
  });

  it('a map of values is still json', () => {
    const values: FieldType = { kind: 'dict', of: 'json', shape: { a: 'number', b: 'text' } };
    expect(fieldTypeCompatible(values, 'json')).toBe(true);
    expect(fieldAssignable(values, 'json')).toBe(true);
  });

  it('names where the record sits', () => {
    expect(recordWithin(dictHolding)?.steps).toEqual([{ kind: 'key', key: 'a' }]);
    expect(recordWithin({ kind: 'tuple', of: ['text', record] })?.steps).toEqual([{ kind: 'slot', index: 1 }]);
    expect(recordWithin({ kind: 'list', of: record })?.steps).toEqual([{ kind: 'member' }]);
    expect(spellHeldSteps(recordWithin({ kind: 'dict', of: 'json', shape: { 'a b': { kind: 'list', of: record } } })!.steps)).toBe('.`a b`[…]');
    expect(recordWithin('json')).toBeUndefined();
  });
});

describe('a receipt nobody can type is not a record', () => {
  // Arms built at run time: nothing can see what they return, so the receipt
  // is untyped — a value, as the un-awaited combinator binds it, never "a
  // record nobody can name", which the field rule above would refuse.
  it.each(VERSIONS.filter(v => v >= 3))('under language version %i, an awaited one writes under a key', version => {
    expect(
      errorsUnder(version, [
        '  arms = MAP([1, 2], (n) => { return () => { return n * 5 } })',
        '  r = await parallel(arms)',
        ...note('{ r: r }'),
      ]),
    ).toEqual([]);
  });
});

describe.each(VERSIONS)('under language version %i, a record inside a plugin argument\'s value is refused', version => {
  const refused = (body: string[], where: string): void => {
    const errors = errorsUnder(version, body);
    expect(errors.map(d => d.code)).toEqual(['MOV_CALL_ARG_TYPE']);
    expect(errors[0]!.message).toContain(where);
    expect(errors[0]!.message).toContain(RECORD_NOT_A_VALUE);
  };

  it('a write handle under a map key', () => {
    refused(['  s = summarise(data: { a: org })'], "'summarise' takes structured data for 'data', and 'data.a' is ");
  });

  it("a system record under a map key", () => {
    refused(['  crm-[c:companies]-> {', '    s = summarise(data: { a: c })', '  }'], "and 'data.a' is ");
  });

  it('a list member', () => {
    refused(['  s = summarise(data: [org])'], "and 'data[0]' is ");
  });

  it('under a key in one arm of a conditional', () => {
    refused(['  s = summarise(data: IF 1 > 0 THEN { a: org } ELSE { a: "x" } END)'], "and 'data.a' may be ");
  });

  it('an argument that declares no type, the same way', () => {
    refused(['  s = relay(data: { a: org })'], "'relay' takes structured data for 'data', and 'data.a' is ");
  });

  it('the whole argument a record the program holds is still handed its fields', () => {
    expect(errorsUnder(version, ['  s = summarise(data: org)'])).toEqual([]);
  });
});

describe('a spread that may be a record copies its fields either way', () => {
  it.each(VERSIONS.filter(v => v >= 3))('under language version %i, a conditional of a record and a map', version => {
    expect(errorsUnder(version, note('{ ...(IF 1 > 0 THEN org ELSE { name: "x" } END) }'))).toEqual([]);
  });
});

describe('KNOWN GAP: a combinator receipt holding records is not typed from its arms', () => {
  // The receipt is a list of what the arms returned (the engine's `parallel`),
  // so arms returning a record put the engine's object into the field. The
  // checker types a receipt over arms built at run time as untyped — a value
  // it cannot see into — and a literal arm returning a record as an untyped
  // slot. Both are accepted TODAY; the fix is to type a receipt from what its
  // arms return, after which these become refusals.
  it.each(VERSIONS.filter(v => v >= 3))('under language version %i, arms built at run time: accepted today', version => {
    expect(
      errorsUnder(version, [
        '  arms = MAP([1, 2], (n) => { return () => { return org } })',
        '  r = await parallel(arms)',
        ...note('r'),
      ]),
    ).toEqual([]);
  });

  it.each(VERSIONS.filter(v => v >= 3))('under language version %i, a literal arm: accepted today', version => {
    expect(errorsUnder(version, ['  r = await parallel([() => { return org }])', ...note('r')])).toEqual([]);
  });
});
