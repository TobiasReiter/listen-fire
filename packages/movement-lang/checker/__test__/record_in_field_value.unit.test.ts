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
import { fieldAssignable, fieldTypeCompatible, recordWithin } from '../typing';
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
});

const PRELUDE = [
  'import { attio, ledger } from adapters',
  'import { crm_cred, ledger_cred } from credentials',
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
    expect(recordWithin(dictHolding)?.steps).toEqual(['.a']);
    expect(recordWithin({ kind: 'tuple', of: ['text', record] })?.steps).toEqual(['[1]']);
    expect(recordWithin({ kind: 'list', of: record })?.steps).toEqual(['[…]']);
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
