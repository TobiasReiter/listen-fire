// A node declaration's field types, held wherever the declaration is used.
//
// Two facts, both "the type system said nothing" before:
// (1) a value reaching a field the declaration types is judged by its TYPE —
//     a number or a yes/no is not text, whichever road it arrives by: a
//     `node { … }` argument, a write into a collecting node's `<Entry>`
//     entries, a spread, and a `COALESCE` that used to type as nothing;
// (2) `<T | null>` on a declaration field is `T | absent` wherever the
//     declaration is used — a parameter, a collecting node's entries, a
//     spread — not only as an extraction's shape.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic, DiagnosticCodes as C } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';

const inboxSchema: InstanceSchema = {
  positions: {
    message: {
      properties: {
        Subject: 'text',
        Count: 'number',
        Flag: { kind: 'maybeAbsent', of: 'boolean' },
        Maybe: { kind: 'maybeAbsent', of: 'text' },
      },
      edges: {},
    },
  },
  collections: { messages: { target: 'message' } },
  writableRoots: {},
};

// A system to write into, carrying every field `Deal` declares, so a spread of
// a `<Deal>` has somewhere to land.
const crmSchema: InstanceSchema = {
  positions: {
    deal: {
      properties: { title: 'text', amount: 'number', diverse: 'text', via: 'text' },
      edges: {},
    },
  },
  collections: { deals: { target: 'deal' } },
  writableRoots: {
    deal: {
      fields: { title: 'text', amount: 'number', diverse: 'text', via: 'text' },
      resultShape: { externalId: 'text' },
    },
  },
};

const catalog = mockCatalog({
  adapters: {
    email: { constructionArgs: [], schema: inboxSchema },
    crm: { constructionArgs: [], schema: crmSchema },
  },
});

const PRELUDE = `import { email, crm } from adapters
inbox = email()
book = crm()

node Deal {
  title: <text>
  amount: <number>
  diverse: <text>
  via: <text | null>
}

movement takes_deal(d: <Deal>) {
}
`;

function diagnostics(body: string, param = '<inbox-[:message]->>'): Diagnostic[] {
  const source = `${PRELUDE}
movement m(e: ${param}) {
${body}
}`;
  return checkProgram(parseProgram(source), catalog);
}
const errors = (body: string, param?: string): Diagnostic[] =>
  diagnostics(body, param).filter((d) => (d.severity ?? 'error') === 'error');
const codes = (body: string, param?: string): string[] => errors(body, param).map((d) => d.code);
const messages = (body: string, param?: string): string =>
  errors(body, param).map((d) => d.message).join('\n');
const infoCodes = (body: string, param?: string): string[] =>
  diagnostics(body, param).filter((d) => d.severity === 'info').map((d) => d.code);

/** A `node { … }` for `Deal`, with `diverse` (and optionally `via`) given. */
const literal = (diverse: string, via = '"email"'): string =>
  `node { title: "x", amount: 1, diverse: ${diverse}, via: ${via} }`;

describe('a declared text field refuses a number or a yes/no', () => {
  it('a COALESCE argument is typed by what its arguments share — the Project A case', () => {
    const body = `  takes_deal(d: ${literal('COALESCE(e.`Flag`, FALSE)')})`;
    expect(codes(body)).toEqual([C.NODE_ARG_SHAPE]);
    expect(messages(body)).toContain(
      'its `diverse` is boolean, not text — write the text it should be: `IF … THEN "Yes" ELSE "No" END`',
    );
  });

  it('a number is refused naming TOSTRING', () => {
    const body = `  takes_deal(d: ${literal('e.`Count`')})`;
    expect(codes(body)).toEqual([C.NODE_ARG_SHAPE]);
    expect(messages(body)).toContain(
      'its `diverse` is number, not text — write the text it should be: `TOSTRING(…)`',
    );
  });

  it('the repairs the message names are accepted', () => {
    expect(codes(`  takes_deal(d: ${literal('IF COALESCE(e.`Flag`, FALSE) THEN "Yes" ELSE "No" END')})`)).toEqual([]);
    expect(codes(`  takes_deal(d: ${literal('TOSTRING(e.`Count`)')})`)).toEqual([]);
  });

  it('COALESCE of disagreeing kinds stays untyped, and so is not refused', () => {
    expect(codes(`  takes_deal(d: ${literal('COALESCE(e.`Count`, "none")')})`)).toEqual([]);
  });

  it('a write into a collecting node typed by the declaration holds the same line', () => {
    const write = (diverse: string): string =>
      `  deduped = node { deals: <Deal> }\n  write deduped-[:deals]-> { title: "x", amount: 1, diverse: ${diverse}, via: "v" }`;
    expect(codes(write('TRUE'))).toEqual([C.WRITE_FIELD_TYPE]);
    expect(messages(write('TRUE'))).toContain(
      "'diverse' on 'deals' on a node this run built is text, and this is boolean — write the text it should be: `IF … THEN \"Yes\" ELSE \"No\" END`",
    );
    expect(messages(write('e.`Count`'))).toContain('is text, and this is number — write the text it should be: `TOSTRING(…)`');
    expect(codes(write('"yes"'))).toEqual([]);
  });

  it('a spread into a collecting node is judged field by field', () => {
    const body = `  deduped = node { deals: <Deal> }\n  n = ${literal('e.`Count`')}\n  write deduped-[:deals]-> { ...n }`;
    expect(codes(body)).toEqual([C.WRITE_FIELD_TYPE]);
    expect(messages(body)).toContain("'diverse' on 'deals'");
  });

  it("a system's text field keeps the lenient write rule", () => {
    expect(
      codes('  write book-[:deals]-> { title: e.`Count`, amount: 1, diverse: "d", via: "v" }'),
    ).toEqual([]);
  });

  it('`<text | null>` accepts absent', () => {
    expect(codes(`  takes_deal(d: ${literal('"d"', 'null')})`)).toEqual([]);
    expect(codes(`  takes_deal(d: ${literal('"d"', 'e.`Maybe`')})`)).toEqual([]);
    expect(
      codes(
        '  deduped = node { deals: <Deal> }\n  write deduped-[:deals]-> { title: "x", amount: 1, diverse: "d", via: e.`Maybe` }',
      ),
    ).toEqual([]);
  });
});

describe('`<T | null>` on a declaration is `T | absent` wherever it is used', () => {
  it('a parameter: the null test is a real test, not an always-true note', () => {
    const guarded = '  if e.via != null {\n    x = e.via\n  }';
    expect(codes(guarded, '<Deal>')).toEqual([]);
    expect(infoCodes(guarded, '<Deal>')).not.toContain(C.PRESENCE_TEST_CONSTANT);
    // A plain field keeps the note: it is always there.
    expect(infoCodes('  if e.title != null {\n  }', '<Deal>')).toContain(C.PRESENCE_TEST_CONSTANT);
  });

  it('a parameter: a plain write into a system text field is refused until guarded or `?:`', () => {
    const write = (line: string): string =>
      `  write book-[:deals]-> { title: "t", amount: 1, diverse: "d", ${line} }`;
    expect(codes(write('via: e.via'), '<Deal>')).toEqual([C.ABSENT_REQUIRED]);
    expect(codes(write('via ?: e.via'), '<Deal>')).toEqual([]);
    expect(codes(`  if e.via != null {\n  ${write('via: e.via')}\n  }`, '<Deal>')).toEqual([]);
    // A plain `<text>` field needs nothing.
    expect(codes(write('via: e.title'), '<Deal>')).toEqual([]);
  });

  it("a collecting node's entries: the same", () => {
    const body = (inner: string): string =>
      `  deduped = node { deals: <Deal> order by arrival }\n  deduped-[x:deals]-> {\n${inner}\n  }`;
    const guarded = body('    if x.via != null {\n      y = x.via\n    }');
    expect(codes(guarded)).toEqual([]);
    expect(infoCodes(guarded)).not.toContain(C.PRESENCE_TEST_CONSTANT);
    expect(
      codes(body('    write book-[:deals]-> { title: x.title, amount: x.amount, diverse: x.diverse, via: x.via }')),
    ).toEqual([C.ABSENT_REQUIRED]);
    expect(
      codes(body('    write book-[:deals]-> { title: x.title, amount: x.amount, diverse: x.diverse, via ?: x.via }')),
    ).toEqual([]);
  });

  it('a spread: `...d` names the maybe-absent field, `?...d` takes it', () => {
    expect(codes('  write book-[:deals]-> { ...e }', '<Deal>')).toEqual([C.ABSENT_REQUIRED]);
    expect(messages('  write book-[:deals]-> { ...e }', '<Deal>')).toContain("'?...e'");
    expect(codes('  write book-[:deals]-> { ?...e }', '<Deal>')).toEqual([]);
  });

  it('`IS`: a record whose field is always there still fits a `| null` field', () => {
    expect(codes('  if e IS <Deal> {\n  }', '<book-[:deal]->>')).toEqual([]);
  });

  it('an extraction taking the declaration as its shape is unchanged', () => {
    const body = `  found = extract from [e.\`Subject\`] {\n    node entry: <Deal>\n  }\n  found-[x:entry]-> {\n    if x.via != null {\n      y = x.via\n    }\n  }`;
    expect(codes(body)).toEqual([]);
    expect(infoCodes(body)).not.toContain(C.PRESENCE_TEST_CONSTANT);
  });
});
