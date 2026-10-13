// Language version 5 ("Dancing Wren"): `delete x` only where the system
// declares it can delete a record of `x`'s type — the describe's per-type
// `deletable` promise. Under 5 the checker refuses:
//   - MOV_DELETE_NOT_DECLARED: `x`'s type (every member of a union) makes no
//     such promise;
//   - MOV_DELETE_NOT_RECORD: `x` is a value, or may hold one (a list, a value
//     union), or is an extracted node (a transient graph), or is not one
//     system's record at all.
// A system that describes nothing says nothing, so nothing is refused there.
// Under version 4 every one of these is left to the run, as it always was.

import { parseProgram } from '../../parser/parse';
import { checkProgram, DiagnosticCodes as C } from '../check';
import { mockCatalog, type InstanceSchema } from '../catalog';
import type { LanguageVersion } from '../../language_version';

const crmSchema: InstanceSchema = {
  positions: {
    company: {
      properties: { name: 'text' },
      edges: { notes: { target: 'note' }, people: { target: 'person' } },
      deletable: true,
    },
    note: { properties: { text: 'text' }, edges: {} },
    person: { properties: { name: 'text' }, edges: {}, deletable: true },
  },
  collections: { company: { target: 'company' }, note: { target: 'note' } },
  writableRoots: {
    company: { fields: { name: 'text' }, resultShape: { externalId: 'text', name: 'text' } },
    note: { fields: { text: 'text' }, resultShape: { externalId: 'text', text: 'text' } },
  },
  unions: { record: ['company', 'note'], party: ['company', 'person'] },
};

const catalog = mockCatalog({
  adapters: { crm: { constructionArgs: [], schema: crmSchema }, loose: { constructionArgs: [] } },
});

const source = (body: string, param = '<db-[:company]->>') => `import { crm, loose } from adapters
db = crm()
free = loose()

node Company: "each company named" {
  name: <text> "its name"
}

movement scan(x: ${param}) {
${body}
}`;

function check(src: string, languageVersion: LanguageVersion) {
  return checkProgram(parseProgram(src, { languageVersion }), catalog, { languageVersion }).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}
const codes = (body: string, v: LanguageVersion, param?: string) => check(source(body, param), v).map((d) => d.code);
const said = (body: string, v: LanguageVersion) => check(source(body), v).map((d) => d.message).join('\n');

describe('`delete` under Dancing Wren (5)', () => {
  it('a record whose type declares deletion: clean (a walked record, a write handle, a parameter)', () => {
    expect(codes('  x-[p:people]-> {\n    delete p\n  }', 5)).toEqual([]);
    expect(codes('  co = write db-[:company]-> { name: "Acme" }\n  delete co', 5)).toEqual([]);
    expect(codes('  delete x', 5)).toEqual([]);
  });

  it('a type that does not declare it: MOV_DELETE_NOT_DECLARED, naming the type and the promise', () => {
    expect(codes('  x-[n:notes]-> {\n    delete n\n  }', 5)).toEqual([C.DELETE_NOT_DECLARED]);
    expect(codes('  n = write db-[:note]-> { text: "hi" }\n  delete n', 5)).toEqual([C.DELETE_NOT_DECLARED]);
    const message = said('  x-[n:notes]-> {\n    delete n\n  }', 5);
    expect(message).toContain('db.note');
    expect(message).toContain("'deletable'");
  });

  it('a union is deletable only when every member is', () => {
    expect(codes('  delete x', 5, '<db-[:party]->>')).toEqual([]);
    expect(codes('  delete x', 5, '<db-[:record]->>')).toEqual([C.DELETE_NOT_DECLARED]);
  });

  it('a value, or a name that may hold one: MOV_DELETE_NOT_RECORD', () => {
    expect(codes('  v = "Acme"\n  delete v', 5)).toEqual([C.DELETE_NOT_RECORD]);
    expect(codes('  people = x-[:people]->\n  delete people', 5)).toEqual([C.DELETE_NOT_RECORD]);
    expect(codes('  v = IF x.name == "a" THEN x ELSE "b" END\n  delete v', 5)).toEqual([C.DELETE_NOT_RECORD]);
    expect(codes('  v = ONLY(x-[:people]->)\n  delete v', 5)).toEqual([]);
  });

  it('a name bound to an IF or a COALESCE is the union of its operands', () => {
    const company = '  y = ONLY(db-[:company]->)\n';
    // Every member a deletable record: clean.
    expect(codes(`${company}  v = IF x.name == "a" THEN x ELSE y END\n  delete v`, 5)).toEqual([]);
    expect(codes(`${company}  v = COALESCE(x, y)\n  delete v`, 5)).toEqual([]);
    expect(codes('  y = ONLY(x-[:people]->)\n  v = IF x.name == "a" THEN x ELSE y END\n  delete v', 5)).toEqual([]);
    // A member whose type makes no promise: NOT_DECLARED, not NOT_RECORD.
    expect(codes('  y = ONLY(db-[:note]->)\n  v = IF x.name == "a" THEN x ELSE y END\n  delete v', 5))
      .toEqual([C.DELETE_NOT_DECLARED]);
    // A member that is not a record at all.
    expect(codes('  v = IF x.name == "a" THEN x ELSE null END\n  delete v', 5)).toEqual([C.DELETE_NOT_RECORD]);
    // Records of a system that describes nothing say nothing.
    expect(codes('  y = ONLY(free-[:things]->)\n  v = IF x.name == "a" THEN x ELSE y END\n  delete v', 5, '<free-[:things]->>'))
      .toEqual([]);
    expect(codes(`${company}  v = IF x.name == "a" THEN x ELSE y END\n  delete v`, 4)).toEqual([]);
  });

  it('an extracted node — a transient graph: MOV_DELETE_NOT_RECORD', () => {
    const root = [
      '  d = extract from [x.name] {',
      '    node co: "a company" {',
      '      nm: <text> "the name"',
      '    }',
      '  }',
    ].join('\n');
    for (const body of [`${root}\n  delete d`, `${root}\n  d-[k:co]-> {\n    delete k\n  }`]) {
      const found = check(source(body), 5);
      expect(found.map((d) => d.code)).toEqual([C.DELETE_NOT_RECORD]);
      expect(found[0].message).toContain('transient');
      expect(check(source(body), 4)).toEqual([]);
    }
  });

  it('a system that describes nothing says nothing: no refusal', () => {
    expect(codes('  free-[r:things]-> {\n    delete r\n  }', 5)).toEqual([]);
  });

  it('under Luminous Owl (4) none of it is refused — the run decides', () => {
    expect(codes('  x-[n:notes]-> {\n    delete n\n  }', 4)).toEqual([]);
    expect(codes('  delete x', 4, '<db-[:record]->>')).toEqual([]);
    expect(codes('  v = "Acme"\n  delete v', 4)).toEqual([]);
  });
});
