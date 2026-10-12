// A record or a file reached THROUGH an operator, a through stage, an
// extraction input or a map lookup is held to the rule the direct form is
// (record_in_field_value / file_in_field_value). Where the checker could not
// see one, the engine handed its own object onward — to a connector, a plugin,
// an extraction prompt:
//
// - `COALESCE`, `IF … THEN … ELSE … END` and `MULTI` hold what their operands
//   hold, so a record or file in any arm is one the value may be (a `MULTI`'s,
//   a member of the list it builds); a name bound to one carries its arms;
// - a `through [ … ]` stage's argument is held to what the plugin takes, as a
//   plain call's is;
// - an extraction input is text, a file, a record (rendered as its fields,
//   which must be in hand) or a map or list of those — a file below an input
//   is refused;
// - `AT(record, key)` is refused for any key but an index: a record is no map.
//
// `AND` and `OR` answer a boolean in both engines (never an operand), so a
// record among their operands reaches nothing; pinned as accepted.
//
// A bug fix, so under every supported version (1, 3 and 4 asserted). Two
// adapter shapes, per the fixture rule: a CRM note with a json `company`, a
// text `title` and a file `upload`; a ledger entry with a json properties bag.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';
import { type LanguageVersion } from '../../language_version';

const crmSchema: InstanceSchema = {
  positions: {
    company: { properties: { name: 'text' }, edges: {} },
    note: { properties: { title: 'text', company: 'json', upload: 'file' }, edges: {} },
    doc: { properties: { label: 'text', scan: 'file' }, edges: {} },
  },
  collections: { companies: { target: 'company' }, notes: { target: 'note' }, docs: { target: 'doc' } },
  writableRoots: {
    company: { fields: { name: 'text' }, resultShape: { externalId: 'text', name: 'text' } },
    note: { fields: { title: 'text', company: 'json', upload: 'file' }, resultShape: { externalId: 'text' } },
    doc: { fields: { label: 'text', scan: 'file' }, resultShape: { externalId: 'text' } },
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
    // Structured data, no declared type, text, and a file.
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

const HELD = ['  org = write crm-[:companies]-> { name: "Acme Inc." }', '  f = FILE("contents", "pdf")'];

const program = (body: string[]): string => `${PRELUDE}\nmovement m() {\n${[...HELD, ...body].join('\n')}\n}`;

const errorsUnder = (version: LanguageVersion, body: string[]): Diagnostic[] =>
  checkProgram(parseProgram(program(body), { languageVersion: version }), catalog, { languageVersion: version }).filter(
    d => (d.severity ?? 'error') === 'error',
  );

const note = (fields: string): string[] => [`  write crm-[:notes]-> { title: "hello", ${fields} }`];
const extract = (input: string, through = ''): string[] => [
  `  d = extract from [${input}]${through} {`,
  '    a: "the thing"',
  '  }',
];

const RECORD_NOT_A_VALUE = 'a record, not a value';
const FILE_NOT_A_VALUE = 'a file, not a value';

const VERSIONS: LanguageVersion[] = [1, 3, 4];

describe.each(VERSIONS)('under language version %i, an operator holds what its operands hold', version => {
  const refused = (code: string, body: string[], where: string, what: string): void => {
    const errors = errorsUnder(version, body);
    expect(errors.map(d => d.code)).toEqual([code]);
    expect(errors[0]!.message).toContain(where);
    expect(errors[0]!.message).toContain(what);
  };

  it('a record in a COALESCE arm, into a json field', () => {
    refused('MOV_WRITE_FIELD_TYPE', note('company: COALESCE(org, "x")'), "'company' on crm.note is json, and this may be ", RECORD_NOT_A_VALUE);
  });

  it('a record in the second COALESCE arm', () => {
    refused('MOV_WRITE_FIELD_TYPE', note('company: COALESCE(null, org)'), "and this may be ", RECORD_NOT_A_VALUE);
  });

  it('a record in a COALESCE arm, under a key', () => {
    refused('MOV_WRITE_FIELD_TYPE', note('company: { a: COALESCE(org, "x") }'), "and 'company.a' may be ", RECORD_NOT_A_VALUE);
  });

  it('a file in a COALESCE arm, into a text field', () => {
    refused('MOV_WRITE_FIELD_TYPE', ['  write crm-[:notes]-> { title: COALESCE(f, "x") }'], "'title' on crm.note is text, and this may be file", FILE_NOT_A_VALUE);
  });

  it('a record in a COALESCE arm beside a file, into a file field', () => {
    refused('MOV_WRITE_FIELD_TYPE', note('upload: COALESCE(f, org)'), "'upload' on crm.note is file, and this may be ", RECORD_NOT_A_VALUE);
  });

  it('a file in an IF arm, into a text field', () => {
    refused('MOV_WRITE_FIELD_TYPE', ['  write crm-[:notes]-> { title: IF 1 > 0 THEN f ELSE "" END }'], "'title' on crm.note is text, and this may be file", FILE_NOT_A_VALUE);
  });

  it('a record in a MULTI, as a member of the list it builds', () => {
    refused('MOV_WRITE_FIELD_TYPE', note('company: MULTI(org)'), "and 'company[…]' is ", RECORD_NOT_A_VALUE);
  });

  it('a record in a list a MULTI splices in', () => {
    refused('MOV_WRITE_FIELD_TYPE', note('company: MULTI("a", [org])'), "and 'company[…]' is ", RECORD_NOT_A_VALUE);
  });

  it('into the second shape: a ledger entry\'s json bag', () => {
    refused('MOV_WRITE_FIELD_TYPE', ['  write l-[:entries]-> { Amount: 1, Meta: { by: COALESCE(org, "x") } }'], "'Meta' on l.entry is json, and 'Meta.by' may be ", RECORD_NOT_A_VALUE);
  });

  it('a record in a MULTI, into a plugin\'s structured argument', () => {
    refused('MOV_CALL_ARG_TYPE', ['  s = summarise(data: MULTI(org))'], "'summarise' takes structured data for 'data', and 'data[…]' is ", RECORD_NOT_A_VALUE);
  });

  it('a record in a COALESCE arm under a key of a plugin argument', () => {
    refused('MOV_CALL_ARG_TYPE', ['  s = summarise(data: { a: COALESCE(org, "x") })'], "and 'data.a' may be ", RECORD_NOT_A_VALUE);
  });

  it('a file in a COALESCE arm, into a plugin\'s structured argument', () => {
    refused('MOV_CALL_ARG_TYPE', ['  s = relay(data: COALESCE(f, "x"))'], "'relay' takes structured data for 'data', and 'data' may be file", FILE_NOT_A_VALUE);
  });

  it('a record as the whole of a COALESCE handed to structured data: its fields, as the direct form', () => {
    expect(errorsUnder(version, ['  s = summarise(data: COALESCE(org, org))'])).toEqual([]);
  });

  it('values through every operator are written', () => {
    expect(errorsUnder(version, note('company: { a: COALESCE(org.name, "x"), b: MULTI("a", "b") }'))).toEqual([]);
    expect(errorsUnder(version, note('upload: COALESCE(f, f)'))).toEqual([]);
  });
});

describe.each(VERSIONS)('under language version %i, a name bound to an operator carries its arms', version => {
  const refused = (body: string[], where: string, what: string): void => {
    const errors = errorsUnder(version, body);
    expect(errors.map(d => d.code)).toEqual(['MOV_WRITE_FIELD_TYPE']);
    expect(errors[0]!.message).toContain(where);
    expect(errors[0]!.message).toContain(what);
  };

  it('a conditional of a file and a record, into a file field', () => {
    refused(['  x = IF 1 > 0 THEN f ELSE org END', ...note('upload: x')], "'upload' on crm.note is file, and this may be ", RECORD_NOT_A_VALUE);
  });

  it('a COALESCE of a record and a text, into a json field', () => {
    refused(['  x = COALESCE(org, "x")', ...note('company: x')], "'company' on crm.note is json, and this may be ", RECORD_NOT_A_VALUE);
  });

  it('a MULTI holding a record', () => {
    refused(['  x = MULTI(org)', ...note('company: x')], "and 'company[…]' is ", RECORD_NOT_A_VALUE);
  });

  it('a map holding a COALESCE of a record', () => {
    refused(['  x = { a: COALESCE(org, "x") }', ...note('company: x')], "and 'company.a' may be ", RECORD_NOT_A_VALUE);
  });

  it('the name under a key of another value', () => {
    refused(['  x = COALESCE(org, "x")', ...note('company: { b: x }')], "and 'company.b' may be ", RECORD_NOT_A_VALUE);
  });

  it('a second name for it', () => {
    refused(['  x = COALESCE(f, "x")', '  y = x', '  write crm-[:notes]-> { title: y }'], "'title' on crm.note is text, and this may be file", FILE_NOT_A_VALUE);
  });

  it('into a plugin argument', () => {
    const errors = errorsUnder(version, ['  x = { a: COALESCE(org, "x") }', '  s = summarise(data: x)']);
    expect(errors.map(d => d.code)).toEqual(['MOV_CALL_ARG_TYPE']);
    expect(errors[0]!.message).toContain("and 'data.a' may be ");
  });

  it('a conditional of two files still goes to a file field', () => {
    expect(errorsUnder(version, ['  x = IF 1 > 0 THEN f ELSE f END', ...note('upload: x')])).toEqual([]);
  });
});

describe.each(VERSIONS)('under language version %i, a through stage\'s argument is held to what the plugin takes', version => {
  const refused = (through: string, where: string, what: string): void => {
    const errors = errorsUnder(version, extract('"a document"', ` through [${through}]`));
    expect(errors.map(d => d.code)).toEqual(['MOV_CALL_ARG_TYPE']);
    expect(errors[0]!.message).toContain(where);
    expect(errors[0]!.message).toContain(what);
  };

  it('a record under a key of an untyped argument', () => {
    refused('relay(data: { a: org })', "'relay' takes structured data for 'data', and 'data.a' is ", RECORD_NOT_A_VALUE);
  });

  it('a record in a list of a structured argument', () => {
    refused('summarise(data: [org])', "and 'data[0]' is ", RECORD_NOT_A_VALUE);
  });

  it('a record handed to a text argument', () => {
    refused('tag(label: org)', "'tag' takes text for 'label', and this is a record", "pass one of its fields");
  });

  it('a file handed to a structured argument', () => {
    refused('summarise(data: f)', "and 'data' is file", FILE_NOT_A_VALUE);
  });

  it('a record in a COALESCE arm under a key', () => {
    refused('relay(data: { a: COALESCE(org, "x") })', "and 'data.a' may be ", RECORD_NOT_A_VALUE);
  });

  it('a record handed whole to structured data (its fields), a file to a file, a field to text', () => {
    expect(errorsUnder(version, extract('"a document"', ' through [summarise(data: org)]'))).toEqual([]);
    expect(errorsUnder(version, extract('"a document"', ' through [ocr(doc: f)]'))).toEqual([]);
    expect(errorsUnder(version, extract('"a document"', ' through [tag(label: org.name)]'))).toEqual([]);
  });
});

describe.each(VERSIONS)('under language version %i, an extraction input is text, a file, a record\'s fields, or a map of those', version => {
  const refused = (body: string[], where: string): void => {
    const errors = errorsUnder(version, body);
    expect(errors.map(d => d.code)).toEqual(['MOV_EXTRACT_CONTENT']);
    expect(errors[0]!.message).toContain(where);
  };

  it('a record, a map holding one, a file, a list of files', () => {
    expect(errorsUnder(version, extract('org'))).toEqual([]);
    expect(errorsUnder(version, extract('{ a: org }'))).toEqual([]);
    expect(errorsUnder(version, extract('f'))).toEqual([]);
    expect(errorsUnder(version, extract('MULTI(f, f)'))).toEqual([]);
  });

  it('a file under a key of an input', () => {
    refused(
      extract('{ a: f }'),
      "An extraction reads a file only as an input of its own, and '{ a: f }' holds a file at '.a' — a file, not a value. Hand it over as its own input, or put its text in its place ('a: READ(f)')",
    );
  });

  it('a file in a COALESCE arm under a key', () => {
    refused(extract('{ a: COALESCE(f, "x") }'), `'{ a: COALESCE(f, "x") }' may hold a file at '.a'`);
  });

  it('a record whose fields hold a file', () => {
    refused(
      ['  doc = write crm-[:docs]-> { label: "deck", scan: f }', ...extract('doc')],
      "and 'doc.scan' is a file — a file, not a value. Hand it over as its own input (`from [doc.scan]`), or put its text in its place ('scan: READ(f)')",
    );
  });

  it('a system\'s record, whose fields are not in hand', () => {
    const errors = errorsUnder(version, [
      '  crm-[c:companies]-> {',
      '    d = extract from [c] {',
      '      a: "the thing"',
      '    }',
      '  }',
    ]).filter(d => d.code === 'MOV_EXTRACT_CONTENT');
    expect(errors.map(d => d.message)).toEqual([
      "An extraction reads a record as its fields, and 'c' is crm.company, whose fields are read from its system one at a time. Pass a dict of the fields it needs in its place ('{ name: r.name, … }')",
    ]);
  });
});

describe.each(VERSIONS)('under language version %i, AT over a record takes an index only', version => {
  const refused = (body: string[], said: string): void => {
    const errors = errorsUnder(version, body);
    expect(errors.map(d => d.code)).toEqual(['MOV_AT_RECORD_KEY']);
    expect(errors[0]!.message).toContain(said);
  };

  it('a literal key naming an engine member', () => {
    refused(['  x = AT(org, "handle")'], "AT looks up a list's slot or a map's key, and this is a record — 'handle' is not a key it holds. Read a field with a dot (org.handle)");
  });

  it.each(['provenance', 'kind', 'graph', 'fields', 'edges'])('the member %s', member => {
    refused([`  x = AT(org, "${member}")`], `'${member}' is not a key it holds`);
  });

  it('a literal field name: a field is read with a dot', () => {
    refused(['  x = AT(org, "name")'], "'name' is not a key it holds. Read a field with a dot (org.name)");
  });

  it('a key that is not written down', () => {
    refused(['  k = "name"', '  x = AT(org, k)'], 'its fields are not keys to look up');
  });

  it('inside a written value', () => {
    const errors = errorsUnder(version, note('company: { a: AT(org, "graph") }'));
    expect(errors.map(d => d.code)).toContain('MOV_AT_RECORD_KEY');
  });

  it('an index reads the record, as one value is read', () => {
    expect(errorsUnder(version, ['  x = AT(org, 0)'])).toEqual([]);
  });

  it('a map is still looked up by its key', () => {
    expect(errorsUnder(version, ['  bag = { a: "x" }', '  x = AT(bag, "a")'])).toEqual([]);
  });
});

describe.each(VERSIONS)('PINNED: under language version %i, AND and OR answer a boolean', version => {
  // Both engines evaluate `a AND b` / `a OR b` to true or false, never to an
  // operand, so a record among the operands is read for its truth and goes
  // nowhere.
  it.each([
    ['AND', 'company: org AND 1 > 0'],
    ['OR', 'company: org OR 1 > 0'],
  ])('%s with a record operand, into a json field: accepted', (_label, field) => {
    expect(errorsUnder(version, note(field))).toEqual([]);
  });
});

describe.each(VERSIONS)('under language version %i, the walk never passes over a record handed over as its fields', version => {
  // An extraction input and a plugin argument taking structured data render
  // a record as its fields. Every record the walk meets — at any depth, in any
  // arm — is held to that: its fields in hand, none of them a file.
  const SYS = (inner: string[]): string[] => ['  crm-[c:companies]-> {', ...inner.map(line => `  ${line}`), '  }'];
  const DOC = '  doc = write crm-[:docs]-> { label: "deck", scan: f }';
  const codesOf = (body: string[], code: string): string[] =>
    errorsUnder(version, body).filter(d => d.code === code).map(d => d.message);

  it.each([
    ['{ a: c }', "'{ a: c }' holds crm.company at '.a'"],
    ['{ a: [c] }', "'{ a: [c] }' holds crm.company at '.a[0]'"],
    ['[c]', "'[c]' holds crm.company at '[0]'"],
    ['COALESCE(c, "x")', `'COALESCE(c, "x")' may be crm.company`],
    ['MULTI(c)', "'MULTI(c)' holds crm.company at '[…]'"],
  ])('a system record in the input %s', (input, said) => {
    expect(codesOf(SYS(extract(input)), 'MOV_EXTRACT_CONTENT')).toEqual([
      `An extraction reads a record as its fields, and ${said}, whose fields are read from its system one at a time. Pass a dict of the fields it needs in its place ('{ name: r.name, … }')`,
    ]);
  });

  it('a system record under a key of a bound map', () => {
    expect(codesOf(SYS(['  y = { a: c }', ...extract('y')]), 'MOV_EXTRACT_CONTENT')).toEqual([
      expect.stringContaining(`and '${version === 1 ? 'y[…]' : 'y.a'}' is crm.company, whose fields are read from its system one at a time`),
    ]);
  });

  it.each([
    ['crm', "'crm' is 'crm' (the instance itself) — a connection, not a record"],
    ['{ a: crm }', "'{ a: crm }' holds 'crm' (the instance itself) at '.a' — a connection, not a record"],
  ])('an instance in the input %s', (input, said) => {
    expect(codesOf(extract(input), 'MOV_EXTRACT_CONTENT')).toEqual([expect.stringContaining(said)]);
  });

  it.each([
    ['{ a: doc }', "'{ a: doc }' holds a file at '.a.scan'"],
    ['[{ a: doc }]', "'[{ a: doc }]' holds a file at '[0].a.scan'"],
    ['COALESCE(doc, "x")', `'COALESCE(doc, "x")' may hold a file at '.scan'`],
    ['MULTI(doc)', "'MULTI(doc)' holds a file at '[…].scan'"],
  ])('a record whose fields hold a file, in the input %s', (input, said) => {
    expect(codesOf([DOC, ...extract(input)], 'MOV_EXTRACT_CONTENT')).toEqual([
      expect.stringContaining(`An extraction reads a file only as an input of its own, and ${said} — a file, not a value.`),
    ]);
  });

  it('a field of a system record, and a record the run wrote, are inputs', () => {
    expect(errorsUnder(version, SYS(extract('{ a: c.name }')))).toEqual([]);
    expect(errorsUnder(version, extract('{ a: [org], b: COALESCE(org, "x") }'))).toEqual([]);
  });

  it.each([
    ['summarise(data: COALESCE(c, "x"))', "'summarise' takes every field of the record it is given as 'data', and this may be crm.company"],
    ['relay(data: c)', "'relay' takes every field of the record it is given as 'data', and this is crm.company"],
    ['relay(data: IF 1 > 0 THEN c ELSE "x" END)', "'relay' takes every field of the record it is given as 'data', and this may be crm.company"],
  ])('a system record handed whole to %s, plain and in a stage', (call, said) => {
    const plain = codesOf(SYS([`  s = ${call}`]), 'MOV_CALL_ARG_TYPE');
    const staged = codesOf(SYS(extract('"a document"', ` through [${call}]`)), 'MOV_CALL_ARG_TYPE');
    for (const messages of [plain, staged]) {
      expect(messages).toEqual([expect.stringContaining(`${said}, whose fields are read from its system one at a time`)]);
    }
  });

  it('a record whose fields hold a file, handed whole through an arm', () => {
    expect(codesOf([DOC, '  s = summarise(data: COALESCE(doc, "x"))'], 'MOV_CALL_ARG_TYPE')).toEqual([
      expect.stringContaining("and 'data.scan' may be file — a file, not a value"),
    ]);
  });
});

describe.each(VERSIONS)('under language version %i, MULTI\'s list is one of its members\' kind', version => {
  const refused = (body: string[], code: string, said: string): void => {
    const errors = errorsUnder(version, body);
    expect(errors.map(d => d.code)).toEqual([code]);
    expect(errors[0]!.message).toContain(said);
  };

  it('a member picked off it, under a key', () => {
    refused(note('company: { a: FIRST(MULTI(org)) }'), 'MOV_WRITE_FIELD_TYPE', "and 'company.a' is ");
    refused(note('company: { a: AT(MULTI(org), 0) }'), 'MOV_WRITE_FIELD_TYPE', "and 'company.a' is ");
  });

  it('a member picked off it, as the field: refused, as the same read off a list is', () => {
    for (const field of ['company', 'upload']) {
      const fromMulti = errorsUnder(version, note(`${field}: FIRST(MULTI(org))`));
      const fromList = errorsUnder(version, note(`${field}: FIRST([org])`));
      expect(fromMulti.map(d => d.code)).toEqual(fromList.map(d => d.code));
      expect(fromMulti.map(d => d.code)).toContain('MOV_ABSENT_REQUIRED');
    }
  });

  it('AT over an operator that may be a record, at an index, picks the record', () => {
    refused(note('company: { a: AT(COALESCE(org, "x"), 0) }'), 'MOV_WRITE_FIELD_TYPE', "and 'company.a' may be ");
  });

  it('a list of values is still a list of values', () => {
    expect(errorsUnder(version, note('company: { a: MULTI("a", ["b"]) }'))).toEqual([]);
  });
});

describe.each(VERSIONS)('under language version %i, AT sees a record through an operator', version => {
  const refused = (body: string[], said: string): void => {
    const errors = errorsUnder(version, body);
    expect(errors.map(d => d.code)).toEqual(['MOV_AT_RECORD_KEY']);
    expect(errors[0]!.message).toContain(said);
  };

  it.each([
    ['AT(COALESCE(org, "x"), "graph")', "this may be a record — 'graph' is not a key it holds. Read a field with a dot (r.graph)"],
    ['AT(IF 1 > 0 THEN org ELSE org END, "graph")', "this may be a record — 'graph'"],
    ['AT(AT(MULTI(org), 0), "handle")', "this is a record — 'handle'"],
  ])('%s', (read, said) => {
    refused([`  x = ${read}`], said);
  });

  it('a name bound to an operator, by its own name', () => {
    refused(['  y = COALESCE(org, "x")', '  x = AT(y, "graph")'], "this may be a record — 'graph' is not a key it holds. Read a field with a dot (y.graph)");
  });
});
