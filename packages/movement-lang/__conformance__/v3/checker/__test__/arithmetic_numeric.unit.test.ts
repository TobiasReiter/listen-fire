// Arithmetic is NUMERIC — `+ - * /` take numbers, and `+` has no concat
// overload. A known non-numeric operand is MOV_ARITH_NON_NUMERIC, not a silent
// `Number()` coercion to NaN → null (which is what `"a" + b` did before).
//
// The three rules, in one place:
//   - a KNOWN non-numeric operand is a loud error, with a `${…}` did-you-mean
//     when it is a string (the one real string-building path);
//   - an UNKNOWN operand stays silent — this layer errors on what it can see;
//   - a `json` operand is MOV_JSON_OPAQUE's, reported once, not twice.
//
// Two adapter shapes throughout, per the fixture rule: one adapter's shape
// cannot tell derived from hardcoded (here, the did-you-mean's rewritten form).

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic } from '../check';
import { FieldType, SchemaFieldType, InstanceSchema, mockCatalog } from '../catalog';
import { checkArithmeticOperands, maybeAbsent } from '../typing';

const CODE = 'MOV_ARITH_NON_NUMERIC';

const numberList: SchemaFieldType = { kind: 'list', of: 'number' };
const textList: SchemaFieldType = { kind: 'list', of: 'text' };
const stageEnum: SchemaFieldType = { kind: 'enum', options: ['Seed', 'Series A'] };

// ── The rule, as a pure function ──
//
// The operand vocabulary is easier to pin here than through a schema: absence
// and list cardinality are the two shapes a movement can't cheaply produce.

const arith = (op: '+' | '-' | '*' | '/' | '%', left: FieldType | undefined, right: FieldType | undefined) =>
  checkArithmeticOperands(
    { type: 'arithmetic', op, left: { type: 'static', value: 1 }, right: { type: 'static', value: 1 } },
    left,
    right,
  );

describe('what counts as a numeric operand', () => {
  const legal: Array<[string, FieldType | undefined]> = [
    ['number', 'number'],
    ['number | absent — absence is the require-present sites\' concern, not this one', maybeAbsent('number')],
    ['a list of number — cardinality is transparent here', numberList],
    ['an unknown type — silence is this layer\'s contract', undefined],
    ['json — MOV_JSON_OPAQUE reports that one', 'json'],
  ];

  it.each(legal)('%s passes', (_label, type) => {
    expect(arith('+', type, 'number')).toBeNull();
    expect(arith('*', 'number', type)).toBeNull();
  });

  const illegal: Array<[string, FieldType]> = [
    ['text', 'text'],
    ['an enum (a text base)', stageEnum],
    ['a list of text', textList],
    ['date', 'date'],
    ['datetime', 'datetime'],
    ['boolean', 'boolean'],
    ['file', 'file'],
  ];

  it.each(illegal)('%s is reported', (_label, type) => {
    expect(arith('+', type, 'number')?.code).toBe(CODE);
    expect(arith('/', 'number', type)?.code).toBe(CODE);
  });

  it('names which side, and its type', () => {
    expect(arith('+', 'text', 'number')?.message).toContain("the left side of '+' is text");
    expect(arith('-', 'number', 'date')?.message).toContain("the right side of '-' is date");
    expect(arith('*', 'text', 'text')?.message).toContain("both sides of '*' are text");
    expect(arith('+', 'text', 'date')?.message).toContain(
      "the left side of '+' is text and the right side is date",
    );
  });

  it('leads with the TypeScript analogue', () => {
    expect(arith('+', 'text', 'text')?.message).toMatch(
      /^An arithmetic operation requires numeric operands/,
    );
  });

  it('points a date at the shift function, not at interpolation', () => {
    const said = arith('+', 'date', 'number')!.message;
    expect(said).toContain('DATE.ADD_DAYS(date, days)');
    expect(said).not.toMatch(/interpolation/);
  });

  it('offers no guess for a boolean or a file', () => {
    expect(arith('+', 'boolean', 'number')!.message).toMatch(/numeric operands — .*\.$/);
    expect(arith('+', 'file', 'number')!.message).not.toMatch(/instead/);
  });

  it('sends a string to NUMBER(…) under an operator nobody means as concat', () => {
    expect(arith('*', 'text', 'number')!.message).toContain('NUMBER(…)');
    expect(arith('*', 'text', 'number')!.message).not.toMatch(/interpolation/);
  });
});

// ── Two adapter shapes ──

/** Shape 1: a deal, whose text/number/date/enum/json fields are all reachable
 *  from one position, and whose names are identifier-safe. */
const crmSchema: InstanceSchema = {
  positions: {
    deal: {
      properties: {
        Name: 'text',
        Amount: 'number',
        Stage: stageEnum,
        Closed: 'date',
        Won: 'boolean',
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

/** Shape 2: an invoice line whose field names are NOT identifier-safe (spaces),
 *  and which carries a multi-valued number — so the did-you-mean's rewritten
 *  form has to quote what this adapter calls things, not what the first one did. */
const billingSchema: InstanceSchema = {
  positions: {
    line: {
      properties: {
        'Line Ref': 'text',
        'Line Total': 'number',
        'Unit Prices': numberList,
        'Due At': 'datetime',
      },
      edges: {},
    },
  },
  collections: { lines: { target: 'line' } },
  writableRoots: {
    line: {
      fields: { 'Line Ref': 'text', 'Line Total': 'number' },
      resultShape: { externalId: 'text' },
    },
  },
};

const catalog = mockCatalog({
  adapters: {
    crm: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: crmSchema,
    },
    billing: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: billingSchema,
    },
  },
  credentials: { crm_cred: { adapter: 'crm' }, billing_cred: { adapter: 'billing' } },
});

const PRELUDE = [
  'import { crm, billing } from adapters',
  'import { crm_cred, billing_cred } from credentials',
  '',
  'c = crm(credentials: crm_cred)',
  'b = billing(credentials: billing_cred)',
].join('\n');

/** A movement over a deal (`d`) — shape 1. */
const onDeal = (body: string): string =>
  `${PRELUDE}\nmovement m(d: <c-[:deal]->>) {\n${body}\n}`;

/** A movement over an invoice line (`l`) — shape 2. */
const onLine = (body: string): string =>
  `${PRELUDE}\nmovement m(l: <b-[:line]->>) {\n${body}\n}`;

const errors = (source: string): Diagnostic[] =>
  checkProgram(parseProgram(source), catalog).filter(d => (d.severity ?? 'error') === 'error');
const codes = (source: string): string[] => errors(source).map(d => d.code);
const messages = (source: string): string[] => errors(source).map(d => d.message);
const said = (source: string): string => messages(source).join('\n');

function expectClean(source: string): void {
  expect(errors(source).map(d => `${d.code}: ${d.message}`)).toEqual([]);
}

// ── Through a real program ──

describe('a string operand is loud', () => {
  it('two literals', () => {
    expect(codes(onDeal('  write c-[:deals]-> { Amount: "a" + "b" }'))).toContain(CODE);
  });

  it('a literal and a number', () => {
    expect(codes(onDeal('  write c-[:deals]-> { Amount: "a" + 2 }'))).toContain(CODE);
  });

  it('a field of known text type', () => {
    expect(codes(onDeal('  write c-[:deals]-> { Name: d.`Name` + "!" }'))).toContain(CODE);
    expect(codes(onLine('  write b-[:lines]-> { `Line Ref`: l.`Line Ref` + "!" }'))).toContain(CODE);
  });

  it('an enum field — a text base is still text', () => {
    expect(codes(onDeal('  write c-[:deals]-> { Name: d.`Stage` + "!" }'))).toContain(CODE);
  });

  it('reported once per operation, not once per rule', () => {
    expect(codes(onDeal('  write c-[:deals]-> { Amount: "a" + "b" }')).filter(c => c === CODE))
      .toHaveLength(1);
  });
});

describe('the did-you-mean rewrites the expression the author wrote', () => {
  it('shows the interpolated form when every part is printable', () => {
    expect(said(onDeal('  write c-[:deals]-> { Name: d.`Name` + "!" }')))
      .toContain('"${d.Name}!"');
  });

  it('quotes a name the way THAT adapter needs it quoted', () => {
    // The second shape's names carry spaces — a hardcoded rewrite would print
    // `l.Line Ref`, which does not parse back.
    expect(said(onLine('  write b-[:lines]-> { `Line Ref`: l.`Line Ref` + "!" }')))
      .toContain('"${l.`Line Ref`}!"');
  });

  it('carries a trailing query string verbatim — the ask-link idiom', () => {
    expect(said(onDeal('  write c-[:deals]-> { Name: d.`Name` + "?answer=true" }')))
      .toContain('"${d.Name}?answer=true"');
  });

  it('flattens a chain, so the suggestion is the whole string', () => {
    expect(said(onDeal('  write c-[:deals]-> { Name: "*" + d.`Name` + "*" }')))
      .toContain('"*${d.Name}*"');
  });

  it('suggests interpolation with no rewrite when a part has no short form', () => {
    const message = said(onDeal('  write c-[:deals]-> { Name: AI("a name") + "!" }'));
    expect(message).toContain('interpolation instead.');
    // No half-written suggestion that dropped the AI() call.
    expect(message).not.toMatch(/instead: /);
  });

  it('never suggests concatenation with +, the thing being retired', () => {
    expect(said(onDeal('  write c-[:deals]-> { Name: d.`Name` + "!" }'))).not.toMatch(/CONCAT/);
  });
});

describe('a date operand is loud too — + is not a date shift', () => {
  it('names the shift function', () => {
    const shift = onDeal('  write c-[:deals]-> { Amount: d.`Closed` + 7 }');
    expect(codes(shift)).toContain(CODE);
    expect(said(shift)).toContain('DATE.ADD_DAYS');
  });

  it('the same for a datetime, through the second shape', () => {
    expect(codes(onLine('  write b-[:lines]-> { `Line Total`: l.`Due At` + 7 }'))).toContain(CODE);
  });
});

describe('what stays silent', () => {
  it('numbers', () => {
    expectClean(onDeal('  write c-[:deals]-> { Amount: d.`Amount` + 1 }'));
    expectClean(onDeal('  write c-[:deals]-> { Amount: 2 * 3 - 1 / 4 }'));
    expectClean(onDeal('  write c-[:deals]-> { Amount: d.`Amount` * d.`Amount` }'));
  });

  it('a multi-valued number, through the second shape', () => {
    expectClean(onLine('  write b-[:lines]-> { `Line Total`: l.`Unit Prices` * 2 }'));
  });

  it('an operand this layer cannot see', () => {
    expectClean(onDeal('  write c-[:deals]-> { Amount: AI("how many") + 1 }'));
    expectClean(onDeal('  write c-[:deals]-> { Amount: NUMBER(d.`Name`) + 1 }'));
  });

  it('a boolean condition is untouched — this is an arithmetic rule only', () => {
    expectClean(
      onDeal('  if d.`Won` {\n    write c-[:deals]-> { Amount: d.`Amount` + 1 }\n  }'),
    );
  });
});

describe('a structured operand belongs to MOV_JSON_OPAQUE alone', () => {
  const jsonArith = '  write c-[:deals]-> { Amount: d.`Payload` * 2 }';

  it('still reports the opaque error', () => {
    expect(codes(onDeal(jsonArith))).toContain('MOV_JSON_OPAQUE');
  });

  it('does not pile this one on top', () => {
    expect(codes(onDeal(jsonArith))).not.toContain(CODE);
  });

  it('nor when the OTHER side is the string', () => {
    const both = '  write c-[:deals]-> { Amount: d.`Payload` + "x" }';
    expect(codes(onDeal(both))).toContain('MOV_JSON_OPAQUE');
    expect(codes(onDeal(both))).not.toContain(CODE);
  });
});

// ── Unary minus: negating a number is a number; anything else is refused
// the way `+` on a non-number is (same code, same "requires numeric
// operands" wording — see checkNegateOperand). ──

describe('unary minus operand typing', () => {
  it('negating a number is a number — clean', () => {
    expectClean(onDeal('  write c-[:deals]-> { Amount: -d.`Amount` }'));
    expectClean(onDeal('  write c-[:deals]-> { Amount: -(d.`Amount` + 1) }'));
    expectClean(onDeal('  write c-[:deals]-> { Amount: 3 * -d.`Amount` }'));
  });

  it('negating text is refused the way + on text is', () => {
    expect(codes(onDeal('  write c-[:deals]-> { Amount: -d.`Name` }'))).toContain(CODE);
  });

  it('negating a date is refused, pointed at the shift function', () => {
    const source = onDeal('  write c-[:deals]-> { Amount: -d.`Closed` }');
    expect(codes(source)).toContain(CODE);
    expect(said(source)).toContain('DATE.ADD_DAYS(date, days)');
  });

  it('negating a boolean is refused', () => {
    expect(codes(onDeal('  write c-[:deals]-> { Amount: -d.`Won` }'))).toContain(CODE);
  });

  it('a structured (json) operand belongs to MOV_JSON_OPAQUE alone, not doubled up', () => {
    const codes_ = codes(onDeal('  write c-[:deals]-> { Amount: -d.`Payload` }'));
    expect(codes_).toContain('MOV_JSON_OPAQUE');
    expect(codes_).not.toContain(CODE);
  });

  it('an operand this layer cannot see stays silent', () => {
    expectClean(onDeal('  write c-[:deals]-> { Amount: -NUMBER(d.`Name`) }'));
  });
});

// ── % (remainder): same rule as + - * /, no new code. ──

describe('% operand typing — same rule as + - * /', () => {
  it('numeric operands are clean', () => {
    expect(arith('%', 'number', 'number')).toBeNull();
  });

  it('a non-numeric operand is reported, naming the operator', () => {
    expect(arith('%', 'text', 'number')?.code).toBe(CODE);
    expect(arith('%', 'text', 'number')?.message).toContain("the left side of '%' is text");
  });

  it('clean through a real program', () => {
    expectClean(onDeal('  write c-[:deals]-> { Amount: d.`Amount` % 3 }'));
  });

  it('loud through a real program', () => {
    expect(codes(onDeal('  write c-[:deals]-> { Amount: d.`Name` % 3 }'))).toContain(CODE);
  });
});
