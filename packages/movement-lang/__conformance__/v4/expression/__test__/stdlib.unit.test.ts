// The namespaced stdlib (../stdlib.ts) and its bridge surface:
//
//   1. Folding — `NS.FN(args)` (which the formula grammar parses as an
//      alias-rooted traverse with a function-call terminal) becomes a
//      plain `function` node carrying the dotted id, everywhere an
//      expression can appear (slots, interpolation, conditions, hop
//      WHERE filters).
//   2. Precise errors — unknown family member lists the family's
//      functions; unknown ALL-CAPS namespace in call position lists the
//      families; arity mistakes name the signature.
//   3. FILE(content, "pdf" | "text") — static shape validation.
//   4. READ(file) — static shape validation (the argument's TYPE is the
//      checker's; only the count is call shape).
//   5. CHUNKS(text, { size | entities, overlap }) — the options MAP's keys, which are
//      call shape for the same reason an artifact type is: they are written
//      down, and nothing computes one.
//   6. The implementations — pure, deterministic, null-safe.

import {
  BridgeError,
  parseMovementCondition,
  parseMovementExpression,
} from '../bridge';
import {
  applyStdlib,
  checkDateFormatPattern,
  coerceToDate,
  coerceToDatetime,
  coerceToNumber,
  builtinOptionsFor,
  CHUNKS_FUNCTION_ID,
  describeBuiltinOptions,
  FILE_FUNCTION_ID,
  READ_FUNCTION_ID,
  STDLIB_FAMILIES,
  stdlibFamily,
  stdlibFunctionById,
} from '../stdlib';

/** A pure member never looks at the instant; a clock-reading one is handed
 *  this unless the case supplies its own. */
const SOME_INSTANT = new Date('2026-06-15T09:00:00.000Z');

function apply(id: string, ...args: unknown[]): unknown {
  return applyAt(SOME_INSTANT, id, ...args);
}

function applyAt(now: Date, id: string, ...args: unknown[]): unknown {
  const spec = stdlibFunctionById(id);
  if (!spec) throw new Error(`no stdlib function '${id}'`);
  return applyStdlib(spec, args, now);
}

// ── 1. Folding ───────────────────────────────────────────────────────────────

describe('namespaced stdlib calls fold to dotted function nodes', () => {
  it('CURRENCY.GET_NUMBER_FROM_FIGURE("£1.2m") folds to a plain function node', () => {
    expect(parseMovementExpression('CURRENCY.GET_NUMBER_FROM_FIGURE("£1.2m")')).toEqual({
      type: 'function',
      fn: 'currency.get_number_from_figure',
      args: [{ type: 'static', value: '£1.2m' }],
    });
  });

  it('URL.HOST(text) folds to a plain function node', () => {
    expect(parseMovementExpression('URL.HOST(msg.`link`)')).toEqual({
      type: 'function',
      fn: 'url.host',
      args: [
        {
          type: 'traverse',
          aliasRoot: 'msg',
          steps: [],
          expression: { type: 'property', propertyTypeId: 'link' },
        },
      ],
    });
  });

  it('NUMBER.FORMAT(n, "compact") folds to a plain function node — NUMBER is both a namespace and a bare coercer, like DATETIME', () => {
    expect(parseMovementExpression('NUMBER.FORMAT(n, "compact")')).toEqual({
      type: 'function',
      fn: 'number.format',
      args: [
        { type: 'property', propertyTypeId: 'n' },
        { type: 'static', value: 'compact' },
      ],
    });
  });

  it('CURRENCY.FORMAT_FIGURE(n, code) folds to a plain function node — code may be any expression, not only a literal', () => {
    expect(parseMovementExpression('CURRENCY.FORMAT_FIGURE(n, msg.`code`)')).toEqual({
      type: 'function',
      fn: 'currency.format_figure',
      args: [
        { type: 'property', propertyTypeId: 'n' },
        {
          type: 'traverse',
          aliasRoot: 'msg',
          steps: [],
          expression: { type: 'property', propertyTypeId: 'code' },
        },
      ],
    });
  });

  it('DATE.ADD_DAYS(d, -back_days) — a unary-minus argument parses (was the motivating case for the grammar amendment)', () => {
    expect(parseMovementExpression('DATE.ADD_DAYS(d, -back_days)')).toEqual({
      type: 'function',
      fn: 'date.add_days',
      args: [
        { type: 'property', propertyTypeId: 'd' },
        { type: 'negate', expression: { type: 'property', propertyTypeId: 'back_days' } },
      ],
    });
  });

  it('namespace and function names are case-insensitive (function-name convention)', () => {
    expect(parseMovementExpression('currency.get_code_from_figure(msg.`amount`)')).toEqual({
      type: 'function',
      fn: 'currency.get_code_from_figure',
      args: [
        {
          type: 'traverse',
          aliasRoot: 'msg',
          steps: [],
          expression: { type: 'property', propertyTypeId: 'amount' },
        },
      ],
    });
  });

  it('folds inside larger expressions, interpolation, and conditions', () => {
    const compared = parseMovementExpression(
      'CURRENCY.GET_NUMBER_FROM_FIGURE(msg.`amount`) > 1000000',
    );
    expect(compared.type).toBe('compare');
    if (compared.type === 'compare') {
      expect(compared.left).toMatchObject({ type: 'function', fn: 'currency.get_number_from_figure' });
    }

    const interpolated = parseMovementExpression('"due ${DATE.ADD_DAYS(due_date, 7)}"');
    expect(interpolated.type).toBe('concat');
    if (interpolated.type === 'concat') {
      expect(interpolated.parts[1]).toMatchObject({ type: 'function', fn: 'date.add_days' });
    }

    const condition = parseMovementCondition('TEXT.SLUG(msg.`name`) == "acme"');
    expect(condition.kind).toBe('expr');
    if (condition.kind === 'expr') {
      expect(condition.expr).toMatchObject({
        type: 'compare',
        left: { type: 'function', fn: 'text.slug' },
      });
    }
  });

  it('folds inside hop WHERE filters', () => {
    const expr = parseMovementExpression(
      'msg-[f:files WHERE TEXT.SLUG(name) == "deck"]->.`name`',
    );
    expect(expr.type).toBe('traverse');
    if (expr.type === 'traverse' && expr.steps[0].type === 'edge') {
      expect(expr.steps[0].expressionFilter).toMatchObject({
        type: 'compare',
        left: { type: 'function', fn: 'text.slug' },
      });
    }
  });

  it('a lowercase non-namespace alias root with a dotted property read is untouched', () => {
    expect(parseMovementExpression('company.`url`')).toEqual({
      type: 'traverse',
      aliasRoot: 'company',
      steps: [],
      expression: { type: 'property', propertyTypeId: 'url' },
    });
  });
});

// ── 2. Precise errors ────────────────────────────────────────────────────────

describe('namespaced-call errors carry the family inventory', () => {
  it('unknown member of a known family lists the family functions', () => {
    expect(() => parseMovementExpression('CURRENCY.PARSE("£1m")')).toThrow(BridgeError);
    expect(() => parseMovementExpression('CURRENCY.PARSE("£1m")')).toThrow(
      /CURRENCY has no function PARSE\(\).*GET_NUMBER_FROM_FIGURE\(figure\).*GET_CODE_FROM_FIGURE\(figure\)/,
    );
  });

  it('aggregate-named members error as unknown family functions too', () => {
    expect(() => parseMovementExpression('DATE.COUNT(x)')).toThrow(
      /DATE has no function COUNT\(\).*PARSE\(text\)/,
    );
  });

  it('unknown ALL-CAPS namespace in call position lists the families', () => {
    expect(() => parseMovementExpression('MONEY.PARSE("£1m")')).toThrow(
      /Unknown function namespace 'MONEY' — the namespaced families are: CURRENCY, DATE, DATETIME, TEXT/,
    );
  });

  it('a family member read like a property is rejected with the inventory', () => {
    expect(() => parseMovementExpression('CURRENCY.GET_CODE_FROM_FIGURE')).toThrow(
      /CURRENCY is a function family, not a position/,
    );
  });

  it('arity mistakes name the signature', () => {
    expect(() => parseMovementExpression('DATE.ADD_DAYS("2026-03-12")')).toThrow(
      /DATE\.ADD_DAYS\(date, days\) takes 2 arguments, got 1/,
    );
    expect(() =>
      parseMovementExpression('TEXT.REGEX_EXTRACT(a, b, c, d)'),
    ).toThrow(/TEXT\.REGEX_EXTRACT\(text, pattern, group\?\) takes 2–3 arguments, got 4/);
  });
});

// ── 3. FILE() static shape ───────────────────────────────────────────────────

describe('FILE(content, "pdf" | "text") validates at the bridge', () => {
  it('parses to a plain function node with the validated literal type', () => {
    expect(parseMovementExpression('FILE(digest, "pdf")')).toEqual({
      type: 'function',
      fn: FILE_FUNCTION_ID,
      args: [
        { type: 'property', propertyTypeId: 'digest' },
        { type: 'static', value: 'pdf' },
      ],
    });
  });

  it('rejects wrong arity', () => {
    expect(() => parseMovementExpression('FILE(digest)')).toThrow(
      /FILE\(content, "pdf" \| "text"\) takes exactly 2 arguments, got 1/,
    );
  });

  it('rejects a non-literal or unknown artifact type', () => {
    expect(() => parseMovementExpression('FILE(digest, kind)')).toThrow(
      /second argument is the artifact type — a literal "pdf" or "text"/,
    );
    expect(() => parseMovementExpression('FILE(digest, "docx")')).toThrow(
      /a literal "pdf" or "text"/,
    );
  });

  it('validates inside larger expressions', () => {
    expect(() => parseMovementExpression('COALESCE(FILE(digest, "docx"), x)')).toThrow(
      /a literal "pdf" or "text"/,
    );
  });
});

// ── 4. READ() static shape ───────────────────────────────────────────────────

describe('READ(file) validates at the bridge', () => {
  it('parses to a plain function node carrying its one argument', () => {
    expect(parseMovementExpression('READ(attachment)')).toEqual({
      type: 'function',
      fn: READ_FUNCTION_ID,
      args: [{ type: 'property', propertyTypeId: 'attachment' }],
    });
  });

  it('rejects no argument', () => {
    expect(() => parseMovementExpression('READ()')).toThrow(
      /READ\(file\) takes exactly 1 argument, got 0/,
    );
  });

  it('rejects more than one argument', () => {
    expect(() => parseMovementExpression('READ(attachment, "pdf")')).toThrow(
      /READ\(file\) takes exactly 1 argument, got 2/,
    );
  });

  it('validates inside larger expressions', () => {
    expect(() => parseMovementExpression('COALESCE(READ(a, b), "")')).toThrow(
      /READ\(file\) takes exactly 1 argument, got 2/,
    );
  });
});

// ── 5. CHUNKS() options map ──────────────────────────────────────────────────

describe('CHUNKS(text, { size | entities, overlap }) validates its options at the bridge', () => {
  it('parses to a plain function node carrying the text and the map', () => {
    expect(parseMovementExpression('CHUNKS(body, { size: 2000, overlap: 200 })')).toEqual({
      type: 'function',
      fn: CHUNKS_FUNCTION_ID,
      args: [
        { type: 'property', propertyTypeId: 'body' },
        {
          type: 'object',
          entries: [
            { key: 'size', value: { type: 'static', value: 2000 } },
            { key: 'overlap', value: { type: 'static', value: 200 } },
          ],
        },
      ],
    });
  });

  it('takes an ordinary expression for a size — only the KEYS are call shape', () => {
    expect(() => parseMovementExpression('CHUNKS(body, { size: LENGTH(body) / 3 })')).not.toThrow();
  });

  it('rejects a bare second argument — the options are a map', () => {
    expect(() => parseMovementExpression('CHUNKS(body, 2000)')).toThrow(
      /takes its options as a map/,
    );
  });

  it('rejects the wrong number of arguments', () => {
    expect(() => parseMovementExpression('CHUNKS(body)')).toThrow(
      /takes exactly 2 arguments, got 1/,
    );
  });

  it('rejects an option nobody has, listing the ones there are', () => {
    expect(() => parseMovementExpression('CHUNKS(body, { size: 10, stride: 2 })')).toThrow(
      /has no option 'stride'.*overlap/s,
    );
  });

  it('nudges a near-miss key towards the real one', () => {
    expect(() => parseMovementExpression('CHUNKS(body, { sixe: 10 })')).toThrow(
      /did you mean 'size'\?/,
    );
  });

  it('rejects the same key written twice', () => {
    expect(() => parseMovementExpression('CHUNKS(body, { size: 10, size: 20 })')).toThrow(
      /given 'size' twice/,
    );
  });

  it('rejects a call that says neither how many characters nor how many records', () => {
    expect(() => parseMovementExpression('CHUNKS(body, { overlap: 10 })')).toThrow(
      /needs one of 'size' or 'entities'/,
    );
  });

  it('takes a number of expected records instead of a size', () => {
    expect(() => parseMovementExpression('CHUNKS(body, { entities: 20 })')).not.toThrow();
  });

  it('rejects both ways of saying how big a piece is', () => {
    expect(() => parseMovementExpression('CHUNKS(body, { size: 2000, entities: 20 })')).toThrow(
      /'size' and 'entities', which are two ways of saying how big a piece is/,
    );
  });

  it('takes an overlap beside a count of records — there is no size for it to exceed', () => {
    expect(() =>
      parseMovementExpression('CHUNKS(body, { entities: 20, overlap: 5000 })'),
    ).not.toThrow();
  });

  it('takes an ordinary expression for a count of records', () => {
    expect(() =>
      parseMovementExpression('CHUNKS(body, { entities: LENGTH(body) / 5000 })'),
    ).not.toThrow();
  });

  it('rejects an overlap that is not smaller than the size, where both are written down', () => {
    expect(() => parseMovementExpression('CHUNKS(body, { size: 100, overlap: 100 })')).toThrow(
      /not smaller than a size of 100/,
    );
  });

  it('says nothing about an overlap it cannot see — a computed one is the run\'s to refuse', () => {
    expect(() => parseMovementExpression('CHUNKS(body, { size: 100, overlap: n })')).not.toThrow();
  });

  it('takes the unit it counts in, written down', () => {
    expect(() => parseMovementExpression('CHUNKS(body, { size: 10, unit: "chars" })')).not.toThrow();
  });

  it('reserves "tokens" in the grammar but refuses it, saying what to write', () => {
    expect(() => parseMovementExpression('CHUNKS(body, { size: 10, unit: "tokens" })')).toThrow(
      /token chunking is not available yet; use unit: "chars"/,
    );
  });

  it('rejects a unit spelling nobody has', () => {
    expect(() => parseMovementExpression('CHUNKS(body, { size: 10, unit: "words" })')).toThrow(
      /'unit' has no value "words"/,
    );
  });

  it('rejects a computed unit — a spelling is written down, not worked out', () => {
    expect(() => parseMovementExpression('CHUNKS(body, { size: 10, unit: whatever })')).toThrow(
      /'unit' is written down, not worked out/,
    );
  });

  it('validates inside larger expressions', () => {
    expect(() => parseMovementExpression('COALESCE(CHUNKS(b, { overlap: 1 }), [])')).toThrow(
      /needs one of 'size' or 'entities'/,
    );
  });
});

describe('the options contract is declared, not hand-written', () => {
  it('CHUNKS declares its keys, so a future built-in can declare its own', () => {
    const spec = builtinOptionsFor(CHUNKS_FUNCTION_ID);
    expect(spec?.options.map(o => [o.key, o.type, o.required])).toEqual([
      ['size', 'number', false],
      ['entities', 'number', false],
      ['overlap', 'number', false],
      ['unit', 'literal', false],
    ]);
    expect(spec?.exactlyOne).toEqual([
      { keys: ['size', 'entities'], what: 'how big a piece is' },
    ]);
  });

  it('a built-in without a contract has none — nothing is validated by name', () => {
    expect(builtinOptionsFor('read')).toBeUndefined();
  });

  it('the inventory a diagnostic prints comes from the contract', () => {
    const spec = builtinOptionsFor(CHUNKS_FUNCTION_ID)!;
    expect(describeBuiltinOptions(spec)).toContain('size — the most characters');
    expect(describeBuiltinOptions(spec)).toContain('overlap');
    expect(describeBuiltinOptions(spec)).toContain("exactly one of 'size' or 'entities'");
  });
});

// ── 6. The implementations ───────────────────────────────────────────────────

describe('CURRENCY', () => {
  it('GET_NUMBER_FROM_FIGURE parses figures with symbols, separators, magnitudes', () => {
    expect(apply('currency.get_number_from_figure', '£1.2m')).toBe(1_200_000);
    expect(apply('currency.get_number_from_figure', '$4,500')).toBe(4500);
    expect(apply('currency.get_number_from_figure', 'USD 3.5k')).toBe(3500);
    expect(apply('currency.get_number_from_figure', 'raised €2bn last year')).toBe(2_000_000_000);
    expect(apply('currency.get_number_from_figure', '2 billion')).toBe(2_000_000_000);
    expect(apply('currency.get_number_from_figure', 1500)).toBe(1500);
  });

  it('GET_NUMBER_FROM_FIGURE is null-safe and null on no figure', () => {
    expect(apply('currency.get_number_from_figure', null)).toBeNull();
    expect(apply('currency.get_number_from_figure', 'no numbers here')).toBeNull();
  });

  it('GET_CODE_FROM_FIGURE reads symbols and ISO codes', () => {
    expect(apply('currency.get_code_from_figure', '£1.2m')).toBe('GBP');
    expect(apply('currency.get_code_from_figure', '$5k')).toBe('USD');
    expect(apply('currency.get_code_from_figure', '3.5m EUR')).toBe('EUR');
    expect(apply('currency.get_code_from_figure', 'usd 12')).toBe('USD');
    expect(apply('currency.get_code_from_figure', '5m')).toBeNull();
    expect(apply('currency.get_code_from_figure', null)).toBeNull();
  });

  it('FORMAT_FIGURE is the inverse of GET_NUMBER_FROM_FIGURE — a symbol where the table has one', () => {
    expect(apply('currency.format_figure', 1_200_000, 'EUR')).toBe('€1.2M');
    expect(apply('currency.format_figure', 1_200_000, 'GBP')).toBe('£1.2M');
    expect(apply('currency.format_figure', 350_000, 'USD')).toBe('$350K');
  });

  it('FORMAT_FIGURE prints a symbol-less but known code after the amount, with a space', () => {
    expect(apply('currency.format_figure', 1_200_000, 'CHF')).toBe('1.2M CHF');
  });

  it('FORMAT_FIGURE prints the bare compact number for an empty or unknown code', () => {
    expect(apply('currency.format_figure', 1_200_000, '')).toBe('1.2M');
    expect(apply('currency.format_figure', 1_200_000, null)).toBe('1.2M');
    expect(apply('currency.format_figure', 1_200_000, 'ZZZ')).toBe('1.2M');
  });

  it('FORMAT_FIGURE keeps the sign, and is null-safe', () => {
    expect(apply('currency.format_figure', -1_200_000, 'EUR')).toBe('-€1.2M');
    expect(apply('currency.format_figure', null, 'EUR')).toBeNull();
  });

  it('FORMAT_FIGURE takes its code case-insensitively, trimmed', () => {
    expect(apply('currency.format_figure', 1_200_000, ' eur ')).toBe('€1.2M');
  });

  it('is declared maybeAbsent, like DATE.PARSE and URL.HOST, and does not check its code as a literal', () => {
    const spec = stdlibFunctionById('currency.format_figure');
    expect(spec?.maybeAbsent).toBe(true);
    expect(spec?.literalArgs).toBeUndefined();
  });
});

describe('NUMBER.FORMAT', () => {
  it('the worked "compact" examples', () => {
    expect(apply('number.format', 1_200_000, 'compact')).toBe('1.2M');
    expect(apply('number.format', 350_000, 'compact')).toBe('350K');
    expect(apply('number.format', 2_100_000_000, 'compact')).toBe('2.1B');
    expect(apply('number.format', 999, 'compact')).toBe('999');
    expect(apply('number.format', 1000, 'compact')).toBe('1K');
    expect(apply('number.format', 1500, 'compact')).toBe('1.5K');
  });

  it('compact keeps the sign and never prints a trailing ".0"', () => {
    expect(apply('number.format', -1_200_000, 'compact')).toBe('-1.2M');
    expect(apply('number.format', 2_000_000, 'compact')).toBe('2M');
    expect(apply('number.format', -2_000_000, 'compact')).toBe('-2M');
  });

  it('compact reaches T for trillions', () => {
    expect(apply('number.format', 3_400_000_000_000, 'compact')).toBe('3.4T');
  });

  it('the worked "grouped" examples', () => {
    expect(apply('number.format', 1_200_000, 'grouped')).toBe('1,200,000');
    expect(apply('number.format', 1234.5, 'grouped')).toBe('1,234.5');
  });

  it('grouped keeps the sign and a whole number carries no decimal point', () => {
    expect(apply('number.format', -1200, 'grouped')).toBe('-1,200');
    expect(apply('number.format', 999, 'grouped')).toBe('999');
  });

  it('is null-safe and null on an uncoercible value', () => {
    expect(apply('number.format', null, 'compact')).toBeNull();
    expect(apply('number.format', 'not a number', 'grouped')).toBeNull();
  });

  it('is declared maybeAbsent with a checked literal style', () => {
    const spec = stdlibFunctionById('number.format');
    expect(spec?.maybeAbsent).toBe(true);
    expect(spec?.literalArgs?.map((a) => [a.index, a.what])).toEqual([[1, 'the format style']]);
    expect(spec?.literalArgs?.[0].check('compact')).toBeUndefined();
    expect(spec?.literalArgs?.[0].check('grouped')).toBeUndefined();
    expect(spec?.literalArgs?.[0].check('percent')).toContain(
      'write "compact" or "grouped"',
    );
  });
});

describe('DATE', () => {
  it('PARSE reads ISO and written English dates to an ISO date', () => {
    expect(apply('date.parse', '2026-03-12')).toBe('2026-03-12');
    expect(apply('date.parse', '2026-3-5')).toBe('2026-03-05');
    expect(apply('date.parse', '2026/03/12')).toBe('2026-03-12');
    expect(apply('date.parse', '12 March 2026')).toBe('2026-03-12');
    expect(apply('date.parse', 'March 12, 2026')).toBe('2026-03-12');
    expect(apply('date.parse', '3rd Sept 2026')).toBe('2026-09-03');
  });

  it('PARSE is null on ambiguous or unreadable input (deterministic, no guessing)', () => {
    expect(apply('date.parse', '12/03/2026')).toBeNull(); // D/M vs M/D — ambiguous
    expect(apply('date.parse', '31 February 2026')).toBeNull();
    expect(apply('date.parse', 'next tuesday')).toBeNull();
    expect(apply('date.parse', null)).toBeNull();
  });

  it('ADD_DAYS shifts by whole days across month boundaries', () => {
    expect(apply('date.add_days', '2026-03-12', 7)).toBe('2026-03-19');
    expect(apply('date.add_days', '2026-03-30', 5)).toBe('2026-04-04');
    expect(apply('date.add_days', '12 March 2026', -12)).toBe('2026-02-28');
    expect(apply('date.add_days', '2026-03-12', 'soon')).toBeNull();
    expect(apply('date.add_days', null, 7)).toBeNull();
  });

  it('FORMAT_ISO normalises dates, timestamps, and epoch millis to ISO 8601 UTC', () => {
    expect(apply('date.format_iso', '2026-03-12')).toBe('2026-03-12T00:00:00.000Z');
    expect(apply('date.format_iso', '2026-03-12T09:30:00.000Z')).toBe('2026-03-12T09:30:00.000Z');
    expect(apply('date.format_iso', Date.UTC(2026, 2, 12, 9, 30))).toBe('2026-03-12T09:30:00.000Z');
    expect(apply('date.format_iso', 'garbage')).toBeNull();
    expect(apply('date.format_iso', null)).toBeNull();
  });
});

describe('TEXT', () => {
  it('REGEX_EXTRACT returns the first match, preferring the first capture group', () => {
    expect(apply('text.regex_extract', 'Deal ABC-123 closed', '[A-Z]+-\\d+')).toBe('ABC-123');
    expect(apply('text.regex_extract', 'from: a@b.dev', 'from: (\\S+)')).toBe('a@b.dev');
    expect(apply('text.regex_extract', 'a 1 b 2', '(\\d) b (\\d)', 2)).toBe('2');
    expect(apply('text.regex_extract', 'nothing', '\\d+')).toBeNull();
    expect(apply('text.regex_extract', 'x', '(unclosed')).toBeNull(); // invalid pattern
    expect(apply('text.regex_extract', null, '\\d+')).toBeNull();
  });

  it('SLUG lowercases, strips diacritics, hyphenates', () => {
    expect(apply('text.slug', 'Acme Corp Ltd.')).toBe('acme-corp-ltd');
    expect(apply('text.slug', '  Café — Zürich  ')).toBe('cafe-zurich');
    expect(apply('text.slug', null)).toBeNull();
  });
});

describe('URL.HOST', () => {
  it('lowercases the host, otherwise verbatim', () => {
    expect(apply('url.host', 'https://WWW.Acme.com/path?x=1')).toBe('www.acme.com');
  });

  it('keeps www., drops port and path', () => {
    expect(apply('url.host', 'https://www.acme.com:8080/deals/1')).toBe('www.acme.com');
  });

  it('a URL with no host (mailto:, a relative path) is absent', () => {
    expect(apply('url.host', 'mailto:a@b.com')).toBeNull();
    expect(apply('url.host', '/deals/1')).toBeNull();
  });

  it('accepts a scheme-less address, assumed http://', () => {
    expect(apply('url.host', 'acme.com')).toBe('acme.com');
    expect(apply('url.host', 'www.Acme.com/path?x=1')).toBe('www.acme.com');
    expect(apply('url.host', 'acme.com:8080')).toBe('acme.com');
  });

  it('a URL with an explicit scheme is unchanged', () => {
    expect(apply('url.host', 'https://acme.com')).toBe('acme.com');
  });

  it('an email is not a host', () => {
    expect(apply('url.host', 'joe@acme.com')).toBeNull();
  });

  it('text that is not a URL at all is absent', () => {
    expect(apply('url.host', 'not a url')).toBeNull();
    expect(apply('url.host', '')).toBeNull();
  });

  it('null is absent', () => {
    expect(apply('url.host', null)).toBeNull();
  });
});

describe('TEXT.PAIRS', () => {
  it('the worked example — the Project A composer row', () => {
    expect(apply('text.pairs', { name: 'Acme', url: 'acme.com' })).toBe('name=Acme | url=acme.com');
  });

  it('a custom separator', () => {
    expect(apply('text.pairs', { a: 1, b: 2 }, ', ')).toBe('a=1, b=2');
  });

  it('keys in written order', () => {
    expect(apply('text.pairs', { z: 1, a: 2, m: 3 })).toBe('z=1 | a=2 | m=3');
  });

  it('renders each value exactly as interpolation would', () => {
    expect(apply('text.pairs', { present: 'x', gone: null, on: true, off: false, n: 3 })).toBe(
      'present=x | gone= | on=true | off=false | n=3',
    );
  });

  it('skips a nested node/edge field — only scalar fields render', () => {
    expect(apply('text.pairs', { name: 'Acme', address: { city: 'NYC' } })).toBe('name=Acme');
    expect(apply('text.pairs', { name: 'Acme', tags: ['a', 'b'] })).toBe('name=Acme');
  });

  it('an empty record is an empty string', () => {
    expect(apply('text.pairs', {})).toBe('');
  });

  it('defaults the separator to " | "', () => {
    const spec = stdlibFunctionById('text.pairs');
    expect(spec?.signature).toBe('TEXT.PAIRS(record, separator?)');
  });
});

describe('TEXT.SERIALISE', () => {
  const json = (value: unknown): unknown => apply('text.serialise', value, 'JSON');

  it('writes keys sorted, two-space indented, one member per line', () => {
    expect(json({ b: 1, a: { d: true, c: 'x' } })).toBe(
      ['{', '  "a": {', '    "c": "x",', '    "d": true', '  },', '  "b": 1', '}'].join('\n'),
    );
  });

  it('the same value is the same bytes whatever order its keys were written in', () => {
    const one = { name: 'Acme', founder: { last: 'B', first: 'A' }, raised: 5 };
    const other = { raised: 5, founder: { first: 'A', last: 'B' }, name: 'Acme' };
    expect(json(one)).toBe(json(other));
  });

  it('keys sort by code unit, not locale', () => {
    expect(json({ b: 1, B: 2, a: 3, é: 4 })).toBe('{\n  "B": 2,\n  "a": 3,\n  "b": 1,\n  "é": 4\n}');
  });

  it('scalars are their JSON', () => {
    expect(json('hi "there"')).toBe('"hi \\"there\\""');
    expect(json(3.5)).toBe('3.5');
    expect(json(true)).toBe('true');
  });

  it('numbers: -0 is 0, non-finite is null', () => {
    expect(json([-0, NaN, Infinity, 1e21])).toBe('[\n  0,\n  null,\n  null,\n  1e+21\n]');
  });

  it('a Date is its UTC ISO instant; an invalid one is null; text dates stay as written', () => {
    expect(json({ at: new Date('2026-03-12T10:00:00Z'), bad: new Date('x'), day: '2026-03-12' })).toBe(
      '{\n  "at": "2026-03-12T10:00:00.000Z",\n  "bad": null,\n  "day": "2026-03-12"\n}',
    );
  });

  it('absent is null — a key keeps its place, a whole absent value is the text null', () => {
    expect(json({ a: null, b: undefined })).toBe('{\n  "a": null,\n  "b": null\n}');
    expect(json([null, undefined])).toBe('[\n  null,\n  null\n]');
    expect(json(null)).toBe('null');
    expect(json(undefined)).toBe('null');
  });

  it('a list keeps its order and an empty one is []', () => {
    expect(json(['b', 'a'])).toBe('[\n  "b",\n  "a"\n]');
    expect(json([])).toBe('[]');
    expect(json({})).toBe('{}');
  });

  it('a file is a descriptor, never its contents', () => {
    const file = {
      __brand: 'FileRef',
      name: 'deck.pdf',
      size: 12,
      contentType: 'application/pdf',
      retrieve: () => 'bytes',
    };
    expect(json({ deck: file })).toBe(
      '{\n  "deck": {\n    "contentType": "application/pdf",\n    "kind": "file",\n    "name": "deck.pdf",\n    "size": 12\n  }\n}',
    );
    expect(json({ f: { __brand: 'FileRef' } })).toBe(
      '{\n  "f": {\n    "contentType": null,\n    "kind": "file",\n    "name": null,\n    "size": null\n  }\n}',
    );
  });

  it('declares the format as a written-down literal', () => {
    const spec = stdlibFunctionById('text.serialise');
    expect(spec?.signature).toBe('TEXT.SERIALISE(value, format)');
    expect(spec?.literalArgs?.[0]?.check('JSON')).toBeUndefined();
    expect(spec?.literalArgs?.[0]?.check('json')).toContain('did you mean "JSON"');
    expect(spec?.literalArgs?.[0]?.check('YAML')).toContain('"JSON"');
  });
});

// The coercers DATE / DATETIME / NUMBER are BARE built-in functions (like
// COALESCE / TRIM): the formula grammar parses them straight to a flat
// `{ fn: 'date' | 'datetime' | 'number' }` node — NOT a namespaced family
// (those `DATE.OF` / `NUMBER.OF` families are retired). The pure
// implementations are exported (`coerceToDate` etc.) so the engine runtime
// shares one source of truth; the checker types the bare `fn`.
describe('coercers (bare DATE / DATETIME / NUMBER built-ins)', () => {
  it('DATE(x) parses to a flat function node', () => {
    expect(parseMovementExpression('DATE(x)')).toEqual({
      type: 'function',
      fn: 'date',
      args: [{ type: 'property', propertyTypeId: 'x' }],
    });
  });

  it('DATETIME(x) parses to a flat function node', () => {
    expect(parseMovementExpression('DATETIME(x)')).toEqual({
      type: 'function',
      fn: 'datetime',
      args: [{ type: 'property', propertyTypeId: 'x' }],
    });
  });

  it('NUMBER(x) parses to a flat function node', () => {
    expect(parseMovementExpression('NUMBER(x)')).toEqual({
      type: 'function',
      fn: 'number',
      args: [{ type: 'property', propertyTypeId: 'x' }],
    });
  });

  it('the retired DATE.OF / DATETIME.OF / NUMBER.OF namespaces no longer resolve', () => {
    expect(stdlibFunctionById('date.of')).toBeUndefined();
    expect(stdlibFunctionById('datetime.of')).toBeUndefined();
    expect(stdlibFunctionById('number.of')).toBeUndefined();
    expect(() => parseMovementExpression('DATE.OF(x)')).toThrow(BridgeError);
  });

  it('coerceToDate normalises any readable date/timestamp to midnight-UTC ISO date', () => {
    expect(coerceToDate('2026-03-12')).toBe('2026-03-12');
    expect(coerceToDate('2026-03-12T09:30:00.000Z')).toBe('2026-03-12');
    expect(coerceToDate('12 March 2026')).toBe('2026-03-12');
    expect(coerceToDate('garbage')).toBeNull();
    expect(coerceToDate(null)).toBeNull();
  });

  it('coerceToDatetime normalises to a full ISO 8601 UTC instant (midnight for a bare date)', () => {
    expect(coerceToDatetime('2026-03-12')).toBe('2026-03-12T00:00:00.000Z');
    expect(coerceToDatetime('2026-03-12T09:30:00.000Z')).toBe('2026-03-12T09:30:00.000Z');
    expect(coerceToDatetime(Date.UTC(2026, 2, 12, 9, 30))).toBe('2026-03-12T09:30:00.000Z');
    expect(coerceToDatetime('garbage')).toBeNull();
    expect(coerceToDatetime(null)).toBeNull();
  });

  it('coerceToNumber parses numbers and is null on unparseable', () => {
    expect(coerceToNumber('42')).toBe(42);
    expect(coerceToNumber('3.5')).toBe(3.5);
    expect(coerceToNumber(7)).toBe(7);
    expect(coerceToNumber('not a number')).toBeNull();
    expect(coerceToNumber(null)).toBeNull();
  });
});

// ── Registry coherence ───────────────────────────────────────────────────────

describe('the registry', () => {
  it('every spec id is its lowercased dotted name, unique, and resolvable', () => {
    const ids = STDLIB_FAMILIES.flatMap((f) => f.functions.map((fn) => fn.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const family of STDLIB_FAMILIES) {
      expect(stdlibFamily(family.namespace.toLowerCase())).toBe(family);
      for (const fn of family.functions) {
        expect(fn.id).toBe(`${family.namespace.toLowerCase()}.${fn.name.toLowerCase()}`);
        expect(stdlibFunctionById(fn.id)).toBe(fn);
      }
    }
  });
});

// ── DATE.FORMAT — the closed pattern language ────────────────────────────────

describe('DATE.FORMAT writes a date out from a pattern', () => {
  it('the worked example', () => {
    expect(apply('date.format', '2026-08-31', 'MMMM D, YYYY')).toBe('August 31, 2026');
  });

  it('every token, and non-letters printed as written', () => {
    const at = '2026-08-31T09:05:07.000Z';
    expect(apply('date.format', at, 'YYYY-MM-DD')).toBe('2026-08-31');
    expect(apply('date.format', at, 'YYYYMMDD')).toBe('20260831');
    expect(apply('date.format', at, 'YY/M/D')).toBe('26/8/31');
    expect(apply('date.format', at, 'MMM D')).toBe('Aug 31');
    expect(apply('date.format', at, 'dddd, D MMMM YYYY')).toBe('Monday, 31 August 2026');
    expect(apply('date.format', at, 'ddd')).toBe('Mon');
    expect(apply('date.format', at, 'HH:mm:ss')).toBe('09:05:07');
    expect(apply('date.format', at, 'H:m:s')).toBe('9:5:7');
  });

  it('a bare date reads as midnight, and an unreadable value is empty', () => {
    expect(apply('date.format', '2026-08-31', 'HH:mm')).toBe('00:00');
    expect(apply('date.format', 'garbage', 'YYYY')).toBeNull();
    expect(apply('date.format', null, 'YYYY')).toBeNull();
  });

  it('a month is not a minute — case tells them apart', () => {
    expect(apply('date.format', '2026-08-31T09:05:00Z', 'MM')).toBe('08');
    expect(apply('date.format', '2026-08-31T09:05:00Z', 'mm')).toBe('05');
  });
});

// ── Zones — DATE.TODAY / DATETIME.AT ─────────────────────────────────────────

describe('DATE.TODAY answers with the day it is in a place', () => {
  /** 23:30 UTC on the 11th is already the 12th in Berlin — the whole reason
   *  a calendar day needs a zone. */
  const LATE_UTC = new Date('2026-03-11T23:30:00.000Z');

  it('the zone decides the day, not UTC', () => {
    expect(applyAt(LATE_UTC, 'date.today', 'Europe/Berlin')).toBe('2026-03-12');
    expect(applyAt(LATE_UTC, 'date.today', 'UTC')).toBe('2026-03-11');
    expect(applyAt(LATE_UTC, 'date.today', 'America/New_York')).toBe('2026-03-11');
    expect(applyAt(LATE_UTC, 'date.today', 'Australia/Sydney')).toBe('2026-03-12');
  });

  it('the answer comes from the instant it is given, never a live clock', () => {
    const a = applyAt(new Date('2020-01-01T00:00:00.000Z'), 'date.today', 'UTC');
    const b = applyAt(new Date('2020-01-01T00:00:00.000Z'), 'date.today', 'UTC');
    expect(a).toBe('2020-01-01');
    expect(b).toBe(a);
  });

  it('is declared as a clock reader with a checked literal zone', () => {
    const spec = stdlibFunctionById('date.today');
    expect(spec?.readsClock).toBe(true);
    expect(spec?.arity).toEqual({ min: 1, max: 1 });
    expect(spec?.returns).toBe('date');
    expect(spec?.literalArgs?.map((a) => [a.index, a.what])).toEqual([[0, 'the time zone']]);
    expect(spec?.literalArgs?.[0].check('Europe/Berlin')).toBeUndefined();
    expect(spec?.literalArgs?.[0].check('Mars/Olympus')).toContain('not a recognised IANA time zone');
  });

  it('an unreadable zone fails the run naming the function', () => {
    expect(() => applyAt(LATE_UTC, 'date.today', 'Mars/Olympus')).toThrow(/DATE\.TODAY\(zone\)/);
  });
});

describe('DATETIME.AT anchors a wall time on a date in a zone', () => {
  it('an ordinary day, summer and winter', () => {
    expect(apply('datetime.at', '2026-06-15', '07:00', 'Europe/Berlin')).toBe(
      '2026-06-15T05:00:00.000Z',
    );
    expect(apply('datetime.at', '2026-01-15', '07:00', 'Europe/Berlin')).toBe(
      '2026-01-15T06:00:00.000Z',
    );
    expect(apply('datetime.at', '2026-06-15', '07:00', 'UTC')).toBe('2026-06-15T07:00:00.000Z');
  });

  it('a wall time that never happens resolves forward to the first valid instant', () => {
    // Berlin springs forward 02:00 → 03:00 on 2026-03-29, so 02:30 is not a time.
    expect(apply('datetime.at', '2026-03-29', '02:30', 'Europe/Berlin')).toBe(
      '2026-03-29T01:00:00.000Z',
    );
    // Sydney springs forward 02:00 → 03:00 on 2026-10-04 (local), i.e. 16:00Z the day before.
    expect(apply('datetime.at', '2026-10-04', '02:30', 'Australia/Sydney')).toBe(
      '2026-10-03T16:00:00.000Z',
    );
  });

  it('a wall time that happens twice takes the earlier offset', () => {
    // Berlin falls back 03:00 → 02:00 on 2026-10-25: 02:30 happens at +02:00 and again at +01:00.
    expect(apply('datetime.at', '2026-10-25', '02:30', 'Europe/Berlin')).toBe(
      '2026-10-25T00:30:00.000Z',
    );
    // Sydney falls back 03:00 → 02:00 on 2026-04-05: 02:30 at +11:00 then +10:00.
    expect(apply('datetime.at', '2026-04-05', '02:30', 'Australia/Sydney')).toBe(
      '2026-04-04T15:30:00.000Z',
    );
  });

  it('arithmetic in calendar space then anchoring gives a 23h and a 25h window', () => {
    const dayBefore = (day: string) => apply('date.add_days', day, -1);
    const at = (day: unknown) => apply('datetime.at', day, '07:00', 'Europe/Berlin') as string;
    const hours = (from: string, to: string) =>
      (Date.parse(to) - Date.parse(from)) / 3_600_000;

    expect(hours(at(dayBefore('2026-03-29')), at('2026-03-29'))).toBe(23);
    expect(hours(at(dayBefore('2026-10-25')), at('2026-10-25'))).toBe(25);
    expect(hours(at(dayBefore('2026-06-15')), at('2026-06-15'))).toBe(24);
  });

  it('DATE.TODAY feeds it directly', () => {
    const today = applyAt(new Date('2026-03-11T23:30:00.000Z'), 'date.today', 'Europe/Berlin');
    expect(apply('datetime.at', today, '07:00', 'Europe/Berlin')).toBe(
      '2026-03-12T06:00:00.000Z',
    );
  });

  it('no value in, no value out — but garbage in fails the run naming the function', () => {
    expect(apply('datetime.at', null, '07:00', 'UTC')).toBeNull();
    expect(apply('datetime.at', '2026-06-15', null, 'UTC')).toBeNull();
    expect(() => apply('datetime.at', 'last Tuesday', '07:00', 'UTC')).toThrow(
      /DATETIME\.AT\(date, time, zone\).*is not a calendar date/s,
    );
    expect(() => apply('datetime.at', '2026-06-15', '7am', 'UTC')).toThrow(/24-hour HH:mm/);
    expect(() => apply('datetime.at', '2026-06-15', '07:00', 'Mars/Olympus')).toThrow(
      /not a recognised IANA time zone/,
    );
  });

  it('is a pure member with two checked literal arguments', () => {
    const spec = stdlibFunctionById('datetime.at');
    expect(spec?.readsClock).toBeUndefined();
    expect(spec?.arity).toEqual({ min: 3, max: 3 });
    expect(spec?.returns).toBe('datetime');
    expect(spec?.literalArgs?.map((a) => [a.index, a.what])).toEqual([
      [1, 'the time of day'],
      [2, 'the time zone'],
    ]);
  });

  it('folds through the bridge like any other family call', () => {
    expect(parseMovementExpression('DATETIME.AT(d, "07:00", "Europe/Berlin")')).toEqual({
      type: 'function',
      fn: 'datetime.at',
      args: [
        { type: 'property', propertyTypeId: 'd' },
        { type: 'static', value: '07:00' },
        { type: 'static', value: 'Europe/Berlin' },
      ],
    });
  });

  it('DATETIME is both a coercer and a namespace, like DATE', () => {
    expect(parseMovementExpression('DATETIME(x)')).toEqual({
      type: 'function',
      fn: 'datetime',
      args: [{ type: 'property', propertyTypeId: 'x' }],
    });
    expect(stdlibFamily('DATETIME')?.functions.map((f) => f.name)).toEqual(['AT']);
  });
});

describe('a DATE.FORMAT pattern is checked where it is written', () => {
  it('every documented pattern passes', () => {
    for (const pattern of ['MMMM D, YYYY', 'YYYY-MM-DD', 'ddd HH:mm', 'D/M/YY', '']) {
      expect(checkDateFormatPattern(pattern)).toBeUndefined();
    }
  });

  it('a run of letters that is no token is refused, with the closest one named', () => {
    const problem = checkDateFormatPattern('Day');
    expect(problem).toContain("'Day' isn't a date format token");
    expect(problem).toContain("Did you mean 'DD'?");
    expect(problem).toContain('YYYY');
  });

  it('a too-long token is refused rather than printed wrong', () => {
    expect(checkDateFormatPattern('MMMMM')).toContain("Did you mean 'MMMM'?");
  });

  it('a letter belonging to no token has no did-you-mean, just the vocabulary', () => {
    const problem = checkDateFormatPattern('QQ');
    expect(problem).toContain("'QQ' isn't a date format token");
    expect(problem).not.toContain('Did you mean');
  });

  it('the spec declares the pattern as a checked literal argument', () => {
    const spec = stdlibFunctionById('date.format');
    expect(spec?.literalArgs).toEqual([
      { index: 1, what: 'the format pattern', check: checkDateFormatPattern },
    ]);
  });
});
