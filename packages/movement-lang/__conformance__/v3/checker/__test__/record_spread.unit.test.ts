// Spreading a record, TypeScript-style, and the absence that rides with it.
//
//   - `{ ...a, k: v, ...b }` — a map literal copies a map's keys or a record's
//     fields in place, a later key winning. A spread that may be absent copies
//     nothing when it is (`...undefined`), so its keys read `T | absent`.
//   - `d.k` off a dict is the lookup `AT(d, "k")` is (version 3).
//   - `graph<Shape> { ...r }` copies ONE record's fields as a snapshot, by the
//     rule a bare walk copies by.
//   - a value that may be absent can't fill a graph literal's required field,
//     and a field read off a record that may be absent (`ONLY(…)`) may be
//     absent (version 3). Before it, both were silent.
// Plan: plans/functional-extract-2026-10-02/1_design.md, "The modern shape".

import { parseProgram } from '../../parser/parse';
import type { NodeLiteral, Statement } from '../../parser/ast';
import { checkProgram, DiagnosticCodes as C } from '../check';
import { mockCatalog, type InstanceSchema } from '../catalog';
import type { LanguageVersion } from '../../language_version';

const inboxSchema: InstanceSchema = {
  positions: {
    message: {
      properties: { Subject: 'text', Body: 'text', Count: 'number' },
      edges: { Attachments: { target: 'attachment', readable: true } },
    },
    attachment: { properties: { Name: 'text', File: 'file' }, edges: {} },
  },
  collections: { messages: { target: 'message' } },
  writableRoots: {
    message: { fields: { Subject: 'text', Body: 'text' }, resultShape: { Subject: 'text' }, edges: {} },
  },
};

const catalog = mockCatalog({ adapters: { email: { constructionArgs: [], schema: inboxSchema } } });

const PRELUDE = `import { email } from adapters
inbox = email()

node Company: "each company named in this message" {
  name: <text> "the company's name"
  website: <text | null> "its website, if given"
  node round: "each round it raised" {
    stage: <text> "the stage"
  }
}

node CompanyDetail: "more about the company described last" {
  summary: <text> "one line on what it does"
}

node Merged {
  name: <text>
  website: <text | null>
  summary: <text>
}

node Loose {
  name: <text>
  website: <text | null>
  summary: <text | null>
  node round {
    stage: <text>
  }
}

node Note {
  label: <text>
}
`;

const FAN_OUT = `  content = [m.Body]
  companies = extract(content, Company, { tier: 'careful' })`;

function program(body: string, languageVersion: LanguageVersion) {
  const source = `${PRELUDE}
movement under_test(m: <inbox-[:message]->>) {
${body}
}
listen to inbox fire under_test`;
  return parseProgram(source, { languageVersion });
}

function check(body: string, languageVersion: LanguageVersion = 3) {
  return checkProgram(program(body, languageVersion), catalog, { languageVersion }).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}
const codes = (body: string, languageVersion?: LanguageVersion): string[] =>
  check(body, languageVersion).map((d) => d.code);
const messages = (body: string): string => check(body).map((d) => d.message).join('\n');

/** `details = ONLY(extract(…))` inside a MAP over `companies`, returning `ret`. */
function perCompany(ret: string, after = ''): string {
  return `${FAN_OUT}
  detailed = MAP(companies, (c) => {
    details = ONLY(extract([...content, TEXT.SERIALISE(c, 'JSON')], CompanyDetail, { tier: 'careful' }))
    return ${ret}
  })${after}`;
}

describe('a map literal spreads maps and records, TypeScript-style', () => {
  it("the plan's modern example checks clean, and its result reads by key downstream", () => {
    expect(
      codes(
        perCompany(
          '{ ...c, ...details }',
          `
  MAP(detailed, (d) => {
    write inbox-[:messages]-> { Subject: d.name, Body: COALESCE(d.summary, "none") }
  })`,
        ),
      ),
    ).toEqual([]);
  });

  it('a key from a spread that may be absent is maybe-absent, so a required slot refuses it', () => {
    expect(
      codes(
        perCompany(
          '{ ...c, ...details }',
          `
  MAP(detailed, (d) => {
    write inbox-[:messages]-> { Subject: d.name, Body: d.summary }
  })`,
        ),
      ),
    ).toEqual([C.ABSENT_REQUIRED]);
  });

  it("a record contributes its fields, typed as the record's; not its edges", () => {
    expect(
      codes(
        perCompany(
          '{ ...c }',
          `
  MAP(detailed, (d) => {
    n = d.name * 2
    r = d.round
  })`,
        ),
      ),
    ).toEqual([C.ARITH_NON_NUMERIC, C.DICT_UNKNOWN_KEY]);
  });

  it('later keys win, in the order written', () => {
    expect(codes('  v = { a: 1 }\n  z = { ...v, a: "x" }\n  n = z.a * 2')).toEqual([C.ARITH_NON_NUMERIC]);
    expect(codes('  v = { a: 1 }\n  z = { ...v, a: "x" }\n  n = AT(z, "a") * 2')).toEqual([C.ARITH_NON_NUMERIC]);
    expect(codes('  v = { a: 1 }\n  w = { b: "x", ...v }\n  n = w.a * 2\n  t = UPPER(w.b)')).toEqual([]);
  });

  it('a written key a later spread always overwrites is refused, as TypeScript refuses it', () => {
    expect(codes('  v = { a: 1 }\n  w = { a: "x", ...v }')).toEqual([C.MAP_KEY_OVERWRITTEN]);
    expect(messages('  v = { a: 1 }\n  w = { a: "x", ...v }')).toMatch(/move 'a: …' after the spread/);
  });

  it('a spread that may be absent keeps an earlier key, joined with its own', () => {
    expect(
      codes(perCompany('{ summary: "unknown", ...details }', '\n  MAP(detailed, (d) => {\n    t = UPPER(d.summary)\n  })')),
    ).toEqual([]);
  });

  it('refuses a spread of something with no keys, and of a record the program does not hold', () => {
    expect(codes('  w = { ...m.Body }')).toEqual([C.MAP_SPREAD_NOT_KEYED]);
    expect(codes('  w = { ...[1, 2] }')).toEqual([C.MAP_SPREAD_NOT_KEYED]);
    expect(codes('  w = { ...m }')).toEqual([C.MAP_SPREAD_NOT_KEYED]);
    expect(messages('  w = { ...m }')).toMatch(/read from its system one at a time/);
  });

  it('a spread whose keys are data leaves the literal keyed by data', () => {
    expect(codes('  v = KEYBY([m.Subject], (s) => s)\n  w = { ...v, a: "x" }\n  t = AT(w, "zzz")')).toEqual([]);
  });

  it("a config record is written out key by key — a spread is refused there", () => {
    expect(codes(`${FAN_OUT}\n  cfg = { tier: 'careful' }\n  more = extract(content, Company, { ...cfg })`)).toEqual([
      C.EXTRACT_CONFIG,
    ]);
  });
});

describe('d.k off a dict is the key lookup (version 3)', () => {
  it('types the key, and refuses a key the literal was not written with', () => {
    expect(codes('  d = { a: "x" }\n  n = d.a * 2')).toEqual([C.ARITH_NON_NUMERIC]);
    expect(codes('  d = { a: "x" }\n  n = d.b')).toEqual([C.DICT_UNKNOWN_KEY]);
  });

  it('before version 3 the read typed nothing, as it always did', () => {
    expect(codes('  d = { a: "x" }\n  n = d.a * 2', 2)).toEqual([]);
    expect(codes('  d = { a: "x" }\n  n = d.b', 2)).toEqual([]);
  });
});

describe('graph<Shape> { ...record } copies the record as a snapshot', () => {
  function graphSpread(body: string): NodeLiteral['spreads'] {
    const parsed = program(body, 3);
    checkProgram(parsed, catalog, { languageVersion: 3 });
    const found: NodeLiteral[] = [];
    const visit = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      const record = value as Record<string, unknown>;
      if ('graph' in record && 'entries' in record) found.push(record as unknown as NodeLiteral);
      Object.values(record).forEach(visit);
    };
    visit(parsed.statements as Statement[]);
    return found[0]?.spreads;
  }

  it('the shape decides the fields and follows the edge of the same name', () => {
    expect(codes(perCompany('graph<Loose> { ...c, ...details }'))).toEqual([]);
    const spreads = graphSpread(perCompany('graph<Loose> { ...c, ...details }'));
    expect(spreads?.map((s) => s.copy)).toEqual([
      { fields: ['name', 'website'], edges: { round: { fields: ['stage'], edges: {} } } },
      { fields: ['summary'], edges: {} },
    ]);
  });

  it("a record that may be absent can't fill a required field", () => {
    expect(codes(perCompany('graph<Merged> { ...c, ...details }'))).toEqual([C.ABSENT_REQUIRED]);
    expect(messages(perCompany('graph<Merged> { ...c, ...details }'))).toMatch(
      /'\.\.\.details' supplies one that may be absent/,
    );
  });

  it('a field written in the body wins over the spread, so its absence is the body\'s', () => {
    expect(
      codes(perCompany('graph<Merged> { ...c, ...details, summary: COALESCE(details.summary, "") }')),
    ).toEqual([]);
  });

  it('checks the copied fields against the shape', () => {
    expect(codes(perCompany('graph<Note> { ...c, label: "x" }'))).toEqual([]);
    expect(codes(`${FAN_OUT}\n  g = MAP(companies, (c) => { return graph<Merged> { ...c } })`)).toEqual([
      C.GRAPH_FIELD_MISSING,
    ]);
  });

  it("without a shape, the record's own fields are copied and no edge is followed", () => {
    expect(codes(perCompany('graph { ...c }', '\n  MAP(detailed, (d) => {\n    n = d.name\n  })'))).toEqual([]);
    expect(graphSpread(perCompany('graph { ...c }'))?.map((s) => s.copy)).toEqual([
      { fields: ['name', 'website'], edges: {} },
    ]);
  });

  it('a system record copies too — a snapshot, read field by field', () => {
    expect(codes('  g = graph<Note> { ...m, label: m.Subject }')).toEqual([]);
  });

  it('refuses a spread of a list of records — a spread copies one', () => {
    expect(codes(`${FAN_OUT}\n  g = graph<Loose> { ...companies }`)).toEqual([C.GRAPH_SPREAD_NOT_MAP]);
  });
});

describe('a value that may be absent fills no required graph field (version 3)', () => {
  it('a field read off ONLY(…) may be absent, and is refused for a required field', () => {
    const body = perCompany('graph<Merged> { name: c.name, website: c.website, summary: details.summary }');
    expect(codes(body)).toEqual([C.ABSENT_REQUIRED]);
    expect(messages(body)).toMatch(/<Merged> needs `summary` \(text\).*COALESCE.*<text \| null>/);
  });

  it('a fallback, or a field that may be left empty, takes it', () => {
    expect(
      codes(perCompany('graph<Merged> { name: c.name, summary: COALESCE(details.summary, "none") }')),
    ).toEqual([]);
    expect(codes(perCompany('graph<Loose> { name: c.name, summary: details.summary }'))).toEqual([]);
  });

  it('a guard narrows the record, as TypeScript narrows `r.x` after `r != null`', () => {
    const guarded = (test: string) => `${FAN_OUT}
  MAP(companies, (c) => {
    details = ONLY(extract([...content, TEXT.SERIALISE(c, 'JSON')], CompanyDetail, { tier: 'careful' }))
    if ${test} {
      g = graph<Merged> { name: c.name, summary: details.summary }
    }
  })`;
    expect(codes(guarded('details != null'))).toEqual([]);
    expect(codes(guarded('c.name != ""'))).toEqual([C.ABSENT_REQUIRED]);
  });

  it('before version 3 both were silent, as they always were', () => {
    expect(
      codes(
        `  gs = MAP([m.Subject], (s) => { return graph<Note> { label: s } })
  first = FIRST(gs)
  g = graph<Note> { label: first.label }`,
        2,
      ),
    ).toEqual([]);
    expect(
      codes(
        `  gs = MAP([m.Subject], (s) => { return graph<Note> { label: s } })
  first = FIRST(gs)
  g = graph<Note> { label: first.label }`,
      ),
    ).toEqual([C.ABSENT_REQUIRED]);
  });
});

describe('a graph literal takes members in the order written, as a map literal does', () => {
  const ordered = (members: string, version?: LanguageVersion) =>
    codes(`  v = { label: "a" }\n  g = graph<Note> { ${members} }`, version);

  it('a key written after the spread overrides it, and a key written before is overwritten', () => {
    expect(ordered('...v, label: "mine"')).toEqual([]);
    expect(ordered('label: "mine", ...v')).toEqual([C.MAP_KEY_OVERWRITTEN]);
  });

  it('the type of a field is the last member that wrote it', () => {
    expect(ordered('...v, label: 3')).toEqual([C.GRAPH_FIELD_TYPE]);
    expect(codes('  v = { label: 3 }\n  g = graph<Note> { label: "x", ...v }').sort()).toEqual(
      [C.GRAPH_FIELD_TYPE, C.MAP_KEY_OVERWRITTEN].sort(),
    );
  });

  it('a record spread follows the same order', () => {
    expect(codes(perCompany('graph<Merged> { name: "x", ...c, summary: "s" }'))).toEqual([C.MAP_KEY_OVERWRITTEN]);
    expect(codes(perCompany('graph<Merged> { ...c, name: "x", summary: "s" }'))).toEqual([]);
  });

  it('a spread that may be absent overwrites nothing when it is, so an earlier key is no error', () => {
    expect(codes(perCompany('graph<Merged> { name: "x", summary: "s", ...c, ...details }'))).toEqual([
      C.MAP_KEY_OVERWRITTEN,
    ]);
    expect(codes(perCompany('graph<Merged> { name: "x", website: "w", summary: "s", ...details }'))).toEqual([]);
  });

  it('a child node written before a spread that supplies it is overwritten too', () => {
    expect(
      codes(
        '  v = { name: "a", website: "w", round: [{ stage: "a" }] }\n  g = graph<Company> { round: [{ stage: "mine" }], ...v }',
      ),
    ).toEqual([C.MAP_KEY_OVERWRITTEN]);
  });

  it('holds under an older language version too: graph literals never had another order', () => {
    expect(ordered('label: "mine", ...v', 2)).toEqual([C.MAP_KEY_OVERWRITTEN]);
  });
});
