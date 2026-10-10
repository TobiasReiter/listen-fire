// Language version 4 ("Luminous Owl"): a handle a write returned reaches the
// record as it stood before that write through `-[:@old]->`; `@` names an edge
// the engine makes, never one a system declares; and the write-outcome fields
// `created` / `committed` are retired from the handle in favour of asking
// `@old`. Under 3 an `@` edge is an ordinary unknown edge and both fields read.
//
// Two schema shapes on purpose (movement-lang/CLAUDE.md): a CRM whose write
// shapes carry no `created` field, and a graph whose own types DECLARE one —
// so a check that only ever met the first could not pass by refusing the name.

import { parseProgram } from '../../parser/parse';
import { checkProgram, DiagnosticCodes as C } from '../check';
import { InstanceSchema, SchemaFieldType, mockCatalog } from '../catalog';

const textList: SchemaFieldType = { kind: 'list', of: 'text' };

const emailSchema: InstanceSchema = {
  positions: {
    message: { properties: { subject: 'text', text: 'text' }, edges: {} },
  },
  collections: { messages: { target: 'message' } },
  writableRoots: {},
};

const crmSchema: InstanceSchema = {
  positions: {
    company: { properties: { Name: 'text', Domains: textList }, edges: {} },
    note: { properties: { title: 'text' }, edges: {} },
  },
  collections: { companies: { target: 'company' }, notes: { target: 'note' } },
  supportsInPlaceUpdate: true,
  writableRoots: {
    company: {
      fields: { Name: 'text', Domains: textList },
      resultShape: { externalId: 'text', url: 'text', Name: 'text', Domains: textList },
    },
    note: {
      fields: { title: 'text' },
      resultShape: { externalId: 'text', url: 'text', title: 'text' },
    },
  },
};

/** A graph whose types declare fields literally named `created` and
 *  `committed` — one on the write's result, one only on the position. */
const graphSchema: InstanceSchema = {
  positions: {
    meeting: { properties: { title: 'text', created: 'date' }, edges: {} },
    minute: { properties: { title: 'text', committed: 'text' }, edges: {} },
  },
  collections: { meetings: { target: 'meeting' }, minutes: { target: 'minute' } },
  writableRoots: {
    meeting: {
      fields: { title: 'text' },
      resultShape: { externalId: 'text', title: 'text', created: 'date' },
    },
    minute: {
      fields: { title: 'text' },
      resultShape: { externalId: 'text', title: 'text' },
    },
  },
};

const catalog = mockCatalog({
  adapters: {
    email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: emailSchema },
    attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: crmSchema },
    kg: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: graphSchema },
  },
  credentials: {
    dealflow_inbox: { adapter: 'email' },
    acme_main: { adapter: 'attio' },
    native_knowledge: { adapter: 'kg' },
  },
});

const PRELUDE = [
  'import { email, attio, kg } from adapters',
  'import { dealflow_inbox, acme_main, native_knowledge } from credentials',
  '',
  'inbox = email(credentials: dealflow_inbox)',
  'crm   = attio(credentials: acme_main)',
  'graph = kg(credentials: native_knowledge)',
].join('\n');

const inMovement = (body: string) =>
  `${PRELUDE}\nmovement main(msg: <inbox-[:message]->>) {\n${body}\n}`;

// Info severity dropped: the fixture movement declares no listen, which
// legitimately carries MOV_LISTEN_MISSING.
const under = (version: number, body: string) =>
  checkProgram(parseProgram(inMovement(body)), catalog, { languageVersion: version }).filter((d) => d.severity !== 'info');
const errors = (version: number, body: string) =>
  under(version, body).filter((d) => (d.severity ?? 'error') === 'error').map((d) => d.code);

const ORG = '  org = write crm-[:companies]-> { unique by (`Name`), Name: "Acme", Domains: ["acme.com"] }';

describe('the @old edge', () => {
  it('under 4 @old from a write handle lands on the same type; FIRST of it is maybe-absent; the chain types', () => {
    expect(errors(4, [ORG,
      '  was = FIRST(org-[:@old]->)',
      '  verb = IF was == null THEN "created" ELSE "matched" END',
      '  if was != null { write crm-[:notes]-> { title: was.`Name` } }',
      // A hop off a call is not yet a formula (`FIRST(…)-[:e]->` fails to
      // lower), so the chain is shown off a name and as one walk.
      '  older = FIRST(was-[:@old]->)',
      '  depth = COUNT(org-[:@old]->-[:@old]->)',
    ].join('\n'))).toEqual([]);
  });
  it('under 4 the unguarded read off FIRST(org-[:@old]->) is MOV_ABSENT_REQUIRED (every walk is maybe-empty)', () => {
    expect(errors(4, [ORG, '  write crm-[:notes]-> { title: FIRST(org-[:@old]->).`Name` }'].join('\n'))).toEqual([C.ABSENT_REQUIRED]);
  });
  it('under 4 @old on a match handle, a narrowed match handle, and a traversal landing is MOV_OLD_EDGE_NOT_A_WRITE', () => {
    const match = '  ex = match crm-[:companies]-> { unique by (`Name`), Name: "Acme" }';
    expect(errors(4, [match, '  if ex != null { n = COUNT(ex-[:@old]->) }'].join('\n'))).toEqual([C.OLD_EDGE_NOT_A_WRITE]);
    // Ordered, so the pick is a pick: the traversal landing is the subject here, not the fold.
    const landing = '  c = FIRST(crm-[x:companies ORDER BY `Name`]->)';
    expect(errors(4, [landing, '  if c != null { n = COUNT(c-[:@old]->) }'].join('\n'))).toEqual([C.OLD_EDGE_NOT_A_WRITE]);
  });
  it('under 4 any other @edge is MOV_ARTIFICIAL_EDGE_UNKNOWN; under 3 @old is the plain unknown edge', () => {
    expect(errors(4, [ORG, '  n = COUNT(org-[:@previous]->)'].join('\n'))).toEqual([C.ARTIFICIAL_EDGE_UNKNOWN]);
    expect(errors(3, [ORG, '  n = COUNT(org-[:@old]->)'].join('\n'))).toEqual([C.TRAVERSE_UNKNOWN_EDGE]);
  });
});

describe('created / committed', () => {
  it('under 4 .created / .committed on a write handle is MOV_HANDLE_FIELD_RETIRED naming @old; under 3 both read clean', () => {
    for (const f of ['created', 'committed']) {
      const d = under(4, [ORG, `  write crm-[:notes]-> { title: IF org.${f} THEN "y" ELSE "n" END }`].join('\n'));
      expect(d.map((x) => x.code)).toEqual([C.HANDLE_FIELD_RETIRED]);
      expect(d[0].message).toContain('-[:@old]->');
      expect(errors(3, [ORG, `  write crm-[:notes]-> { title: IF org.${f} THEN "y" ELSE "n" END }`].join('\n'))).toEqual([]);
    }
  });
  it('a declared property literally named created still reads through a write handle under 4', () => {
    // `created` declared on the write's own result shape; `committed` only on
    // the position the handle stands on. Both are the record's fields.
    expect(errors(4, [
      '  m = write graph-[:meetings]-> { unique by (`title`), title: "Kickoff" }',
      '  stamp = m.created',
      '  r = write graph-[:minutes]-> { unique by (`title`), title: "Kickoff" }',
      '  write graph-[:minutes]-> { unique by (`title`), title: r.committed }',
    ].join('\n'))).toEqual([]);
  });
});

describe('an in-place write on a write handle', () => {
  it('crossing 4 a write <alias> { … } on a write handle carries MOV_HANDLE_UPDATED_IN_PLACE, named or not — the alias is updated either way', () => {
    const src = inMovement([ORG, '  write org { Name: "Acme Ltd" }'].join('\n'));
    const d = checkProgram(parseProgram(src), catalog, { languageVersion: 4, upgradingFrom: 3 });
    const unnamed = d.find((x) => x.code === C.HANDLE_UPDATED_IN_PLACE);
    expect(unnamed?.upgrade).toBe(true);
    expect(unnamed?.message).toContain("'org' reads as the updated record below this line");
    const named = checkProgram(parseProgram(inMovement([ORG, '  org2 = write org { Name: "Acme Ltd" }'].join('\n'))), catalog, { languageVersion: 4, upgradingFrom: 3 })
      .find((x) => x.code === C.HANDLE_UPDATED_IN_PLACE);
    expect(named?.upgrade).toBe(true);
    expect(named?.message).toContain("'org' reads as the updated record below this line");
    expect(named?.message).toContain("'org2' names the same record");
  });
  it('under 4 without an upgrade, the in-place write is clean and carries no warning', () => {
    const d = checkProgram(parseProgram(inMovement([ORG, '  write org { Name: "Acme Ltd" }'].join('\n'))), catalog, { languageVersion: 4 });
    expect(d.filter((x) => x.severity !== 'info').map((x) => x.code)).toEqual([]);
  });
});

describe('a write off a traversal landing', () => {
  const LANDING = '  c = FIRST(crm-[x:companies ORDER BY `Name`]->)';
  const body = (read: string) =>
    [LANDING, '  if c != null {', '    w = write c { Name: "Acme Ltd" }', `    ${read}`, '  }'].join('\n');
  it('under 4 the named result is a written handle of the landing\'s type: @old types, fields read', () => {
    expect(errors(4, body('n = COUNT(w-[:@old]->)'))).toEqual([]);
    expect(errors(4, body('write crm-[:notes]-> { title: w.`Name` }'))).toEqual([]);
  });
  it('under 4 the landing alias itself keeps its position type: c-[:@old]-> is still refused', () => {
    expect(errors(4, body('n = COUNT(c-[:@old]->)'))).toEqual([C.OLD_EDGE_NOT_A_WRITE]);
  });
  it('under 3 the result is the landing type, as before: @old is the plain unknown edge', () => {
    expect(errors(3, body('n = COUNT(w-[:@old]->)'))).toEqual([C.TRAVERSE_UNKNOWN_EDGE]);
  });
});

describe('a write off a found record', () => {
  const FOUND = '  ex = match crm-[:companies]-> { unique by (`Name`), Name: "Acme" }';
  const body = (read: string) =>
    [FOUND, '  if ex != null {', '    w = write ex { Name: "Acme Ltd" }', `    ${read}`, '  }'].join('\n');
  it('under 4 the named result is a written handle: @old types', () => {
    expect(errors(4, body('n = COUNT(w-[:@old]->)'))).toEqual([]);
  });
  it('under 4 the match handle itself is still the record as found: ex-[:@old]-> is refused', () => {
    expect(errors(4, body('n = COUNT(ex-[:@old]->)'))).toEqual([C.OLD_EDGE_NOT_A_WRITE]);
  });
});

describe('a field the write did not set, read off its handle', () => {
  const crossing = (body: string) =>
    checkProgram(parseProgram(inMovement(body)), catalog, { languageVersion: 4, upgradingFrom: 3 })
      .filter((d) => d.code === C.HANDLE_READ_FOUND);
  const SET_NAME = '  org = write crm-[:companies]-> { unique by (`Name`), Name: "Acme" }';
  const read = (field: string) => `  seen = org.${field}`;
  it('crossing 4 reading an unset field is a move-up warning naming the field and the handle', () => {
    const d = crossing([SET_NAME, read('Domains')].join('\n'));
    expect(d).toHaveLength(1);
    expect(d[0].upgrade).toBe(true);
    expect(d[0].severity).toBe('warning');
    expect(d[0].message).toContain("'Domains' on 'org' reads the record as the write found it");
  });
  it('crossing 4 reading a field the body set with plain `:` is silent', () => {
    expect(crossing([SET_NAME, '  write crm-[:notes]-> { title: org.`Name` }'].join('\n'))).toEqual([]);
  });
  it('crossing 4 a `?:` fill does not count as set', () => {
    const fill = '  org = write crm-[:companies]-> { unique by (`Name`), Name: "Acme", Domains ?: ["acme.com"] }';
    expect(crossing([fill, read('Domains')].join('\n'))).toHaveLength(1);
  });
  it('no warning under 4 without a move up, nor under 3', () => {
    const src = inMovement([SET_NAME, read('Domains')].join('\n'));
    expect(checkProgram(parseProgram(src), catalog, { languageVersion: 4 }).some((d) => d.code === C.HANDLE_READ_FOUND)).toBe(false);
    expect(checkProgram(parseProgram(src), catalog, { languageVersion: 3 }).some((d) => d.code === C.HANDLE_READ_FOUND)).toBe(false);
  });
});
