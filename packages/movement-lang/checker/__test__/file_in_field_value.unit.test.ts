// A FILE inside a field's value — under a map's key, as a list's member, in
// one arm of a conditional, under a key a spread copies, or handed back by a
// closure — is refused where it is written, as a record is
// (record_in_field_value.unit.test.ts): a file is the engine's own object, a
// byte channel the adapter pulls, not data. Before, only a file written
// straight into a json field was refused; one nested inside the value
// validated, and the connector received the file's internal descriptor. A
// file goes only to a field that holds files.
//
// The same rule as the record's, so under every supported version, with the
// same known gap (versions 1 and 2 type no call inside an expression). Two
// adapter shapes, per the fixture rule: a CRM note with a json `company` and a
// file `upload`, and a ledger entry with a json properties bag and a file
// `Receipt`.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic } from '../check';
import { InstanceSchema, mockCatalog, type FieldType } from '../catalog';
import { fieldAssignable, fieldTypeCompatible, handleWithin } from '../typing';
import { SUPPORTED_LANGUAGE_VERSIONS, type LanguageVersion } from '../../language_version';

const crmSchema: InstanceSchema = {
  positions: {
    company: {
      properties: { name: 'text', logo: 'file' },
      edges: { notes: { target: 'note', writable: true } },
    },
    note: {
      properties: { title: 'text', company: 'json', upload: 'file', uploads: { kind: 'list', of: 'file' }, pages: 'number' },
      edges: {},
    },
  },
  collections: { companies: { target: 'company' }, notes: { target: 'note' } },
  writableRoots: {
    company: { fields: { name: 'text', logo: 'file' }, resultShape: { externalId: 'text', name: 'text' } },
    note: {
      fields: { title: 'text', company: 'json', upload: 'file', uploads: { kind: 'list', of: 'file' }, pages: 'number' },
      resultShape: { externalId: 'text' },
    },
  },
};

const ledgerSchema: InstanceSchema = {
  positions: { entry: { properties: { Amount: 'number', Meta: 'json', Receipt: 'file' }, edges: {} } },
  collections: { entries: { target: 'entry' } },
  writableRoots: {
    entry: { fields: { Amount: 'number', Meta: 'json', Receipt: 'file' }, resultShape: { externalId: 'text' } },
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
    // A plugin handed structured data, one whose argument declares no type,
    // and one that takes a file.
    summarise: {
      args: ['data'],
      argTypes: { data: 'json' },
      requiredArgs: ['data'],
      effects: { ai: true },
      output: { kind: 'value', type: 'text' },
    },
    relay: { args: ['data'], requiredArgs: ['data'], effects: { ai: true }, output: { kind: 'value', type: 'text' } },
    tag: {
      args: ['label'],
      argTypes: { label: 'text' },
      requiredArgs: ['label'],
      effects: { ai: true },
      output: { kind: 'value', type: 'text' },
    },
    ocr: {
      args: ['doc'],
      argTypes: { doc: 'file' },
      requiredArgs: ['doc'],
      effects: { ai: true },
      output: { kind: 'value', type: 'text' },
    },
  },
});

const PRELUDE = [
  'import { attio, ledger } from adapters',
  'import { crm_cred, ledger_cred } from credentials',
  'import { summarise, relay, tag, ocr } from plugins',
  '',
  'crm = attio(credentials: crm_cred)',
  'l = ledger(credentials: ledger_cred)',
].join('\n');

const F = '  f = FILE("contents", "pdf")';

const program = (body: string[]): string => `${PRELUDE}\nmovement m() {\n${[F, ...body].join('\n')}\n}`;

const errorsUnder = (version: LanguageVersion, body: string[]): Diagnostic[] =>
  checkProgram(parseProgram(program(body), { languageVersion: version }), catalog, { languageVersion: version }).filter(
    d => (d.severity ?? 'error') === 'error',
  );

const note = (company: string): string[] => [`  write crm-[:notes]-> { title: "hello", company: ${company} }`];

const FILE_NOT_A_VALUE = 'a file, not a value';
const GOES_TO_A_FILE_FIELD = 'A file goes only into a field that holds files';

const VERSIONS = [...SUPPORTED_LANGUAGE_VERSIONS];

describe.each(VERSIONS)('under language version %i, a file inside a field\'s value is refused', version => {
  const refused = (body: string[], where: string): void => {
    const errors = errorsUnder(version, body);
    expect(errors.map(d => d.code)).toEqual(['MOV_WRITE_FIELD_TYPE']);
    expect(errors[0]!.message).toContain(where);
    expect(errors[0]!.message).toContain(FILE_NOT_A_VALUE);
    expect(errors[0]!.message).toContain(GOES_TO_A_FILE_FIELD);
  };

  it('the direct form, in the same words', () => {
    refused(note('f'), "'company' on crm.note is json, and this is file — a file, not a value.");
  });

  it('straight into a text field, with its text — present — offered in its place', () => {
    refused(['  write crm-[:notes]-> { title: f }'], "'title' on crm.note is text, and this is file — a file, not a value. A file goes only into a field that holds files; put its text in its place ('title: COALESCE(READ(f), \"\")').");
  });

  it('the offered text, in its place, is written', () => {
    expect(errorsUnder(version, ['  write crm-[:notes]-> { title: COALESCE(READ(f), "") }'])).toEqual([]);
  });

  it('into a number field: what the expression produces, as for any mismatch', () => {
    const errors = errorsUnder(version, ['  write crm-[:notes]-> { title: "hello", pages: f }']);
    expect(errors.map(d => d.code)).toEqual(['MOV_WRITE_FIELD_TYPE']);
    expect(errors[0]!.message).toBe("'pages' on crm.note is number, but this expression produces file");
  });

  it('under a map key, with its text offered in its place', () => {
    refused(note('{ a: f }'), "and 'company.a' is file — a file, not a value. A file goes only into a field that holds files; inside a value, put its text in its place ('a: READ(f)').");
  });

  it('as a list member', () => {
    refused(note('[f]'), "and 'company[0]' is file");
  });

  it('under a key of a map under a key', () => {
    refused(note('{ a: { b: f } }'), "and 'company.a.b' is file");
  });

  it('as a member of a list under a key', () => {
    refused(note('{ a: [f] }'), "and 'company.a[0]' is file");
  });

  it('in one arm of a conditional', () => {
    refused(note('IF 1 > 0 THEN f ELSE "none" END'), "'company' on crm.note is json, and this may be file");
  });

  it('under a key in one arm of a conditional', () => {
    refused(note('IF 1 > 0 THEN { a: f } ELSE { a: "none" } END'), "and 'company.a' may be file");
  });

  it('held by a name the map was bound to', () => {
    // Version 1 types a map literal by its values alone, so its keys are not
    // known past the name — the file is under some key.
    refused(['  held = { a: f }', ...note('held')], version === 1 ? "and 'company[…]' is file" : "and 'company.a' is file");
  });

  it('into the second shape: a ledger entry\'s json properties bag', () => {
    refused(['  write l-[:entries]-> { Amount: 1, Meta: { scan: f } }'], "'Meta' on l.entry is json, and 'Meta.scan' is file");
  });

  it('in a match field — what the match finds by is a value too', () => {
    const errors = errorsUnder(version, [
      '  found = match crm-[:notes]-> { unique by (`title`), title: "hello", company: { a: f } }',
    ]).filter(d => d.code === 'MOV_WRITE_FIELD_TYPE');
    expect(errors.map(d => d.message)).toEqual([expect.stringContaining("and 'company.a' is file — a file, not a value")]);
  });

  it('in a field written along an edge', () => {
    refused(
      ['  co = write crm-[:companies]-> { name: "Acme Inc." }', '  write co-[:notes]-> { title: "hello", company: { a: f } }'],
      "'company' on crm.note is json, and 'company.a' is file",
    );
  });

  it('a file at a field that holds files is written', () => {
    expect(errorsUnder(version, ['  write crm-[:notes]-> { title: "hello", upload: f }'])).toEqual([]);
    expect(errorsUnder(version, ['  write l-[:entries]-> { Amount: 1, Receipt: f }'])).toEqual([]);
  });

  it('its text in its place is a value, and is written', () => {
    expect(errorsUnder(version, note('{ a: READ(f) }'))).toEqual([]);
  });
});

describe.each(VERSIONS)('under language version %i, a file field takes a file and never a record', version => {
  // A target takes its own kind of engine object only: a file in one arm must
  // not hide a record in the other.
  const ORG = '  org = write crm-[:companies]-> { name: "Acme Inc." }';
  const refusedRecord = (body: string[], where: string): void => {
    const errors = errorsUnder(version, [ORG, ...body]);
    expect(errors.map(d => d.code)).toEqual(['MOV_WRITE_FIELD_TYPE']);
    expect(errors[0]!.message).toContain(where);
    expect(errors[0]!.message).toContain('a record, not a value');
  };

  it('a record in the ELSE arm, a file in the THEN', () => {
    refusedRecord(['  write crm-[:notes]-> { title: "hello", upload: IF 1 > 0 THEN f ELSE org END }'], "'upload' on crm.note is file, and this may be ");
  });

  it('a record in the THEN arm, a file in the ELSE', () => {
    refusedRecord(['  write crm-[:notes]-> { title: "hello", upload: IF 1 > 0 THEN org ELSE f END }'], "'upload' on crm.note is file, and this may be ");
  });

  it('lists of each, one per arm', () => {
    refusedRecord(['  write crm-[:notes]-> { title: "hello", uploads: IF 1 > 0 THEN [f] ELSE [org] END }'], "and 'uploads[0]' may be ");
  });

  it('a record as a list member, with the path', () => {
    refusedRecord(['  write crm-[:notes]-> { title: "hello", uploads: [org] }'], "and 'uploads[0]' is ");
  });

  it('spreads of a list of files and a list of records', () => {
    // From version 3 the mixed list is refused in its own right as well.
    const errors = errorsUnder(version, [ORG, '  fl = [f]', '  ol = [org]', '  write crm-[:notes]-> { title: "hello", uploads: [...fl, ...ol] }']);
    expect(errors.map(d => d.code)).toEqual(version >= 3 ? ['MOV_LIST_MIXED', 'MOV_WRITE_FIELD_TYPE'] : ['MOV_WRITE_FIELD_TYPE']);
    const field = errors.find(d => d.code === 'MOV_WRITE_FIELD_TYPE')!;
    expect(field.message).toContain("and 'uploads[…]' is ");
    expect(field.message).toContain('a record, not a value');
  });

  it('a list of files, spread, is still files', () => {
    expect(errorsUnder(version, ['  fl = [f]', '  write crm-[:notes]-> { title: "hello", uploads: [...fl, f] }'])).toEqual([]);
  });
});

describe('a spread of a file is refused once, for what it is', () => {
  it.each(VERSIONS.filter(v => v >= 2))('under language version %i', version => {
    expect(errorsUnder(version, note('{ ...f }')).map(d => d.code)).toEqual(['MOV_MAP_SPREAD_NOT_KEYED']);
  });
});

describe.each(VERSIONS)('under language version %i, a plugin argument of a declared value type takes no file it does not hold (B5)', version => {
  // A text argument takes no file, and a file argument a file only as the
  // whole value: each used to validate, and the plugin was handed the
  // engine's description of the file. A bug fix, on every version, as the
  // structured-data argument's rule already was.
  const refused = (use: string, said: string): void => {
    const errors = errorsUnder(version, [use]);
    expect(errors.map(d => d.code)).toEqual(['MOV_CALL_ARG_TYPE']);
    expect(errors[0]!.message).toContain(said);
    expect(errors[0]!.message).toContain(FILE_NOT_A_VALUE);
  };

  it('a text-typed plugin argument, the file itself', () => {
    refused('  s = tag(label: f)', "'tag' takes text for 'label', and this is file — a file, not a value. A file goes to a plugin only as an argument it takes a file for; put its text in its place ('label: READ(f)').");
  });

  it('a text-typed plugin argument, a dict holding it', () => {
    refused('  s = tag(label: { a: f })', "'tag' takes text for 'label', and 'label.a' is file");
  });

  it('a text-typed plugin argument, one arm of a COALESCE', () => {
    refused('  s = tag(label: COALESCE(f, "x"))', "and this may be file");
  });

  it('a file-typed plugin argument, a dict holding it', () => {
    refused('  s = ocr(doc: { a: f })', "'ocr' takes file for 'doc', and 'doc.a' is file — a file, not a value. A file goes to a plugin only as an argument it takes a file for; hand it over as the whole argument ('doc: f')");
  });

  it('the file, or its text, is taken', () => {
    expect(errorsUnder(version, ['  s = ocr(doc: f)'])).toEqual([]);
    expect(errorsUnder(version, ['  s = tag(label: COALESCE(READ(f), ""))'])).toEqual([]);
  });
});

describe.each(VERSIONS)('under language version %i, a file joined into a text', version => {
  // It joined as "[object Object]". Refusing it changes what a saved program
  // means, so it lands with Dancing Wren (5): versions 1 to 4 keep it, and
  // the error under 5 keeps such a program on its version.
  it(version >= 5 ? 'is refused (MOV_FILE_IN_TEXT)' : 'is accepted, as it always was', () => {
    const errors = errorsUnder(version, ['  write crm-[:notes]-> { title: "x${f}" }']);
    expect(errors.map(d => d.code)).toEqual(version >= 5 ? ['MOV_FILE_IN_TEXT'] : []);
    if (version >= 5) expect(errors[0]!.message).toContain("this is a file, and a file is not text, so it can't be combined into text");
  });

  it('its text joins on every version', () => {
    expect(errorsUnder(version, ['  write crm-[:notes]-> { title: "x${COALESCE(READ(f), \"\")}" }'])).toEqual([]);
  });

  it(version >= 5 ? 'one that may be a file is refused' : 'one that may be a file is accepted', () => {
    expect(errorsUnder(version, ['  t = "x${COALESCE(f, \"y\")}"']).map(d => d.code)).toEqual(version >= 5 ? ['MOV_FILE_IN_TEXT'] : []);
  });
});

describe.each(VERSIONS)('under language version %i, a name bound to a conditional carries its arms (B5)', version => {
  // Closed: a name bound to a conditional carries its arms
  // (record_through_operators.unit.test.ts), so the record in one reaches no
  // file field through it.
  it('a record bound through a conditional, into a file field: refused', () => {
    const errors = errorsUnder(version, [
      '  org = write crm-[:companies]-> { name: "Acme Inc." }',
      '  x = IF 1 > 0 THEN f ELSE org END',
      '  write crm-[:notes]-> { title: "hello", upload: x }',
    ]);
    expect(errors.map(d => d.code)).toEqual(['MOV_WRITE_FIELD_TYPE']);
    expect(errors[0]!.message).toContain("'upload' on crm.note is file, and this may be ");
    expect(errors[0]!.message).toContain('a record, not a value');
  });
});

describe.each(VERSIONS.filter(v => v <= 3))('under language version %i, a file inside a link\'s body is refused', version => {
  // A link with a body is a match along the edge (the body form is retired
  // from version 4), and its fields are held to the same rule.
  it('under a map key', () => {
    const errors = errorsUnder(version, [
      '  co = write crm-[:companies]-> { name: "Acme Inc." }',
      '  link co -[:notes]-> { unique by (`title`), title: "hello", company: { a: f } }',
    ]).filter(d => d.code === 'MOV_WRITE_FIELD_TYPE');
    expect(errors.map(d => d.message)).toEqual([expect.stringContaining("and 'company.a' is file — a file, not a value")]);
  });
});

describe('a spread of a map holding a file copies the file', () => {
  it.each(VERSIONS.filter(v => v >= 2))('under language version %i', version => {
    const errors = errorsUnder(version, ['  held = { a: f }', ...note('{ ...held }')]);
    expect(errors.map(d => d.code)).toEqual(['MOV_WRITE_FIELD_TYPE']);
    expect(errors[0]!.message).toContain("and 'company.a' is file — a file, not a value");
  });

  it.each(VERSIONS.filter(v => v >= 2))('under language version %i, a record\'s file field, spread', version => {
    const errors = errorsUnder(version, ['  co = write crm-[:companies]-> { name: "Acme Inc.", logo: f }', ...note('{ ...co }')]);
    expect(errors.map(d => d.code)).toEqual(['MOV_WRITE_FIELD_TYPE']);
    expect(errors[0]!.message).toContain("and 'company.logo' is file — a file, not a value");
  });
});

describe.each(VERSIONS)('under language version %i, a file in a plugin\'s structured argument is refused', version => {
  const refused = (body: string[], where: string): void => {
    const errors = errorsUnder(version, body);
    expect(errors.map(d => d.code)).toEqual(['MOV_CALL_ARG_TYPE']);
    expect(errors[0]!.message).toContain(where);
    expect(errors[0]!.message).toContain(FILE_NOT_A_VALUE);
  };

  it('the whole argument', () => {
    refused(['  s = summarise(data: f)'], "'summarise' takes structured data for 'data', and 'data' is file — a file, not a value. A file goes to a plugin only as an argument it takes a file for; inside a value, put its text in its place ('data: READ(f)').");
  });

  it('under a map key', () => {
    refused(['  s = summarise(data: { a: f })'], "and 'data.a' is file");
  });

  it('a list member', () => {
    refused(['  s = summarise(data: [f])'], "and 'data[0]' is file");
  });

  it('under a key in one arm of a conditional', () => {
    refused(['  s = summarise(data: IF 1 > 0 THEN { a: f } ELSE { a: "x" } END)'], "and 'data.a' may be file");
  });

  it('an argument that declares no type, the same way', () => {
    refused(['  s = relay(data: { a: f })'], "'relay' takes structured data for 'data', and 'data.a' is file");
  });

  it('a record handed whole, whose fields hold a file', () => {
    refused(['  co = write crm-[:companies]-> { name: "Acme Inc.", logo: f }', '  s = summarise(data: co)'], "and 'data.logo' is file");
  });

  it('an argument that takes a file is handed one', () => {
    expect(errorsUnder(version, ['  s = ocr(doc: f)'])).toEqual([]);
  });
});

describe.each([3, 4])('under language version %i, a file a closure returns is refused', version => {
  const refusedAs = (code: string, body: string[], where: string): void => {
    const errors = errorsUnder(version, body);
    expect(errors.map(d => d.code)).toEqual([code]);
    expect(errors[0]!.message).toContain(where);
    expect(errors[0]!.message).toContain(FILE_NOT_A_VALUE);
  };

  it('a call returning a file, under a key of a write field', () => {
    refusedAs('MOV_WRITE_FIELD_TYPE', ['  g = () => { return f }', ...note('{ a: g() }')], "and 'company.a' is file");
  });

  it('a call returning a file, under a key of a plugin argument', () => {
    refusedAs('MOV_CALL_ARG_TYPE', ['  g = () => { return f }', '  s = summarise(data: { a: g() })'], "and 'data.a' is file");
  });

  it('a call returning a map that holds a file', () => {
    refusedAs('MOV_CALL_ARG_TYPE', ['  g = () => { return { a: f } }', '  s = summarise(data: g())'], "and 'data.a' is file");
  });
});

describe.each([1, 2])('KNOWN GAP: under language version %i, a call inside an expression is untyped', version => {
  // As for a record (record_in_field_value.unit.test.ts): versions 1 and 2
  // type a call written inside an expression as nothing anyone can see, so a
  // file a closure returns is not seen there. Accepted TODAY.
  const body = (use: string): string[] => ['  g = () => { return f }', '  h = () => { return { a: f } }', use];

  it.each([
    ['a write field, whole value', '  write crm-[:notes]-> { title: "hello", company: g() }'],
    ['a write field, under a key', '  write crm-[:notes]-> { title: "hello", company: { a: g() } }'],
    ['a plugin argument, under a key', '  s = summarise(data: { a: g() })'],
    ['a plugin argument, a map holding one', '  s = summarise(data: h())'],
  ])('%s: accepted today', (_label, use) => {
    expect(errorsUnder(version, body(use))).toEqual([]);
  });
});

describe('the type rule, as pure functions', () => {
  const dictHolding: FieldType = { kind: 'dict', of: 'json', shape: { a: 'file', b: 'text' } };

  it('json takes no value that holds a file at any depth', () => {
    for (const value of [
      dictHolding,
      { kind: 'list', of: dictHolding },
      { kind: 'tuple', of: ['text', 'file'] },
      { kind: 'dict', of: { kind: 'list', of: 'file' } },
    ] satisfies FieldType[]) {
      expect(fieldTypeCompatible(value, 'json')).toBe(false);
      expect(fieldAssignable(value, 'json')).toBe(false);
    }
  });

  it('a file field takes a file, and a file list its members', () => {
    expect(fieldTypeCompatible('file', 'file')).toBe(true);
    expect(fieldTypeCompatible({ kind: 'list', of: 'file' }, { kind: 'list', of: 'file' })).toBe(true);
  });

  it('names where the file sits, as for a record', () => {
    expect(handleWithin(dictHolding)).toEqual({ steps: [{ kind: 'key', key: 'a' }], handle: 'file', may: false });
    expect(handleWithin({ kind: 'tuple', of: ['text', 'file'] })?.steps).toEqual([{ kind: 'slot', index: 1 }]);
    expect(handleWithin('file')).toEqual({ steps: [], handle: 'file', may: false });
  });
});
