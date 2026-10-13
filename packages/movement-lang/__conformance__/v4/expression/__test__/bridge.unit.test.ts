import { BridgeError, parseMovementCondition, parseMovementExpression, POSITION_SENTINEL, splitUniquenessConjuncts } from '../bridge';
import type { Expression } from '@listen-fire/shared/expression/types';
import { serialize } from '@listen-fire/shared/expression/formula';

describe('splitUniquenessConjuncts', () => {
  const shape = (raw: string) =>
    splitUniquenessConjuncts(raw).map(({ raw, fuzzy }) => ({ raw, fuzzy }));

  it('splits components on the top-level comma', () => {
    expect(shape('`First Name`, `Last Name`')).toEqual([
      { raw: '`First Name`', fuzzy: false },
      { raw: '`Last Name`', fuzzy: false },
    ]);
  });

  it('lifts a leading FUZZY modifier off the component it prefixes', () => {
    expect(shape('`Domain`, FUZZY `Name`')).toEqual([
      { raw: '`Domain`', fuzzy: false },
      { raw: '`Name`', fuzzy: true },
    ]);
  });

  it('a lone fuzzy component', () => {
    expect(shape('FUZZY `Name`')).toEqual([{ raw: '`Name`', fuzzy: true }]);
  });

  it('does NOT split a comma inside a string, a call, or a bracketed hop', () => {
    expect(shape('WITHIN(7, days)')).toEqual([{ raw: 'WITHIN(7, days)', fuzzy: false }]);
    expect(shape('`Tag` == "a, b"')).toEqual([{ raw: '`Tag` == "a, b"', fuzzy: false }]);
  });

  it('keeps AND working WITHIN a component (comma is the separator, AND is an operator)', () => {
    expect(shape('`a` AND `b`')).toEqual([{ raw: '`a` AND `b`', fuzzy: false }]);
  });

  it('a field literally named lowercase `fuzzy` is not mistaken for the modifier', () => {
    expect(shape('`fuzzy`')).toEqual([{ raw: '`fuzzy`', fuzzy: false }]);
  });
});

describe('parseMovementExpression', () => {
  describe('formula passthrough with identity resolvers', () => {
    it('parses an alias-rooted traversal with a backtick property (spec §B)', () => {
      // From 3_syntax_sketch.md §B: domains: [msg-[:sender]->.`domain`]
      expect(parseMovementExpression('msg-[:sender]->.`domain`')).toEqual({
        type: 'traverse',
        aliasRoot: 'msg',
        steps: [{ type: 'edge', edgeTypeId: 'sender', direction: 'outgoing' }],
        expression: { type: 'property', propertyTypeId: 'domain' },
      });
    });

    it('parses a dot-chain handle read (company.`url`)', () => {
      expect(parseMovementExpression('company.`url`')).toEqual({
        type: 'traverse',
        aliasRoot: 'company',
        steps: [],
        expression: { type: 'property', propertyTypeId: 'url' },
      });
    });

    it('bare property reads are the default style — company.name ≡ company.`name`', () => {
      expect(parseMovementExpression('company.name')).toEqual(
        parseMovementExpression('company.`name`'),
      );
      expect(parseMovementExpression('company.name')).toEqual({
        type: 'traverse',
        aliasRoot: 'company',
        steps: [],
        expression: { type: 'property', propertyTypeId: 'name' },
      });
    });

    it('bare property reads work after traversals: c-[:company]->.name', () => {
      expect(parseMovementExpression('c-[:company]->.name')).toEqual(
        parseMovementExpression('c-[:company]->.`name`'),
      );
      expect(parseMovementExpression('c-[:company]->.name')).toEqual({
        type: 'traverse',
        aliasRoot: 'c',
        steps: [{ type: 'edge', edgeTypeId: 'company', direction: 'outgoing' }],
        expression: { type: 'property', propertyTypeId: 'name' },
      });
    });

    it('bare names work in hop WHERE filters and interpolation', () => {
      expect(parseMovementExpression('msg-[f:files WHERE status == "open"]->.name')).toEqual(
        parseMovementExpression('msg-[f:files WHERE `status` == "open"]->.`name`'),
      );
      expect(parseMovementExpression('"from ${msg.subject}"')).toEqual(
        parseMovementExpression('"from ${msg.`subject`}"'),
      );
    });

    it('backticks remain required for spaced names (msg.`sender name`)', () => {
      expect(parseMovementExpression('msg.`sender name`')).toEqual({
        type: 'traverse',
        aliasRoot: 'msg',
        steps: [],
        expression: { type: 'property', propertyTypeId: 'sender name' },
      });
    });

    it('folds == to eq (amendment 1 — handled by the formula tokenizer)', () => {
      expect(parseMovementExpression('stage == "Series A"')).toEqual({
        type: 'compare',
        op: 'eq',
        left: { type: 'property', propertyTypeId: 'stage' },
        right: { type: 'static', value: 'Series A' },
      });
    });

    it('unary minus: -back_days negates the property read', () => {
      expect(parseMovementExpression('-back_days')).toEqual({
        type: 'negate',
        expression: { type: 'property', propertyTypeId: 'back_days' },
      });
    });

    it('unary minus over a parenthesised expression: -(a + b)', () => {
      expect(parseMovementExpression('-(a + b)')).toEqual({
        type: 'negate',
        expression: {
          type: 'arithmetic',
          op: '+',
          left: { type: 'property', propertyTypeId: 'a' },
          right: { type: 'property', propertyTypeId: 'b' },
        },
      });
    });

    it("a - b, a -b, a-b all stay binary subtraction — spacing doesn't turn the right operand into a unary minus", () => {
      const subtraction = {
        type: 'arithmetic',
        op: '-',
        left: { type: 'property', propertyTypeId: 'a' },
        right: { type: 'property', propertyTypeId: 'b' },
      };
      expect(parseMovementExpression('a - b')).toEqual(subtraction);
      expect(parseMovementExpression('a -b')).toEqual(subtraction);
      expect(parseMovementExpression('a-b')).toEqual(subtraction);
    });

    it('% is remainder, at the same precedence as * and /', () => {
      expect(parseMovementExpression('a % b')).toEqual({
        type: 'arithmetic',
        op: '%',
        left: { type: 'property', propertyTypeId: 'a' },
        right: { type: 'property', propertyTypeId: 'b' },
      });
    });

    it('% binds tighter than + — a + b % c is a + (b % c)', () => {
      expect(parseMovementExpression('a + b % c')).toEqual({
        type: 'arithmetic',
        op: '+',
        left: { type: 'property', propertyTypeId: 'a' },
        right: {
          type: 'arithmetic',
          op: '%',
          left: { type: 'property', propertyTypeId: 'b' },
          right: { type: 'property', propertyTypeId: 'c' },
        },
      });
    });

    it('% is left-associative: a % b % c is (a % b) % c', () => {
      expect(parseMovementExpression('a % b % c')).toEqual({
        type: 'arithmetic',
        op: '%',
        left: {
          type: 'arithmetic',
          op: '%',
          left: { type: 'property', propertyTypeId: 'a' },
          right: { type: 'property', propertyTypeId: 'b' },
        },
        right: { type: 'property', propertyTypeId: 'c' },
      });
    });

    it('probe: CONCAT("a", b) parses to { type: concat, parts } — the shape interpolation mirrors', () => {
      expect(parseMovementExpression('CONCAT("a", b)')).toEqual({
        type: 'concat',
        parts: [
          { type: 'static', value: 'a' },
          { type: 'property', propertyTypeId: 'b' },
        ],
      });
    });

    it('! is NOT: !x parses to the same not node NOT x does', () => {
      const not = { type: 'not', expression: { type: 'property', propertyTypeId: 'x' } };
      expect(parseMovementExpression('!x')).toEqual(not);
      expect(parseMovementExpression('NOT x')).toEqual(not);
    });

    it('!EXISTS(path) is the negation of EXISTS(path), identical to NOT EXISTS(path)', () => {
      const exists = parseMovementExpression('EXISTS(x-[:e]->)');
      expect(parseMovementExpression('!EXISTS(x-[:e]->)')).toEqual({ type: 'not', expression: exists });
      expect(parseMovementExpression('!EXISTS(x-[:e]->)')).toEqual(parseMovementExpression('NOT EXISTS(x-[:e]->)'));
    });

    it('!!x is double negation', () => {
      expect(parseMovementExpression('!!x')).toEqual({
        type: 'not',
        expression: { type: 'not', expression: { type: 'property', propertyTypeId: 'x' } },
      });
    });

    it('! sits at NOT precedence: !a = b is NOT (a = b), and a AND !b negates only b', () => {
      expect(parseMovementExpression('!a = b')).toEqual(parseMovementExpression('NOT a = b'));
      expect(parseMovementExpression('a AND !b')).toEqual(parseMovementExpression('a AND NOT b'));
    });

    it('!= is still the not-equal operator, spaced or not', () => {
      const neq = {
        type: 'compare',
        op: 'neq',
        left: { type: 'property', propertyTypeId: 'a' },
        right: { type: 'property', propertyTypeId: 'b' },
      };
      expect(parseMovementExpression('a != b')).toEqual(neq);
      expect(parseMovementExpression('a!=b')).toEqual(neq);
    });

    it('! inside a hop WHERE negates there too', () => {
      expect(parseMovementExpression('EXISTS(x-[n:e WHERE !`done`]->)')).toEqual(
        parseMovementExpression('EXISTS(x-[n:e WHERE NOT `done`]->)'),
      );
    });

    it('! as a character inside a string or a backtick name is text, not an operator', () => {
      expect(parseMovementExpression('"hi!"')).toEqual({ type: 'static', value: 'hi!' });
      expect(parseMovementExpression('`wow!`')).toEqual({ type: 'property', propertyTypeId: 'wow!' });
    });

    it('serialize prints ! back as NOT, which re-parses to the same tree', () => {
      const tree = parseMovementExpression('!a');
      expect(parseMovementExpression(serialize(tree, (id) => id))).toEqual(tree);
    });

    describe('an unrecognised character is refused, never skipped', () => {
      const refusal = (raw: string): BridgeError => {
        try {
          parseMovementExpression(raw);
        } catch (e) {
          if (e instanceof BridgeError) return e;
          throw e;
        }
        throw new Error(`expected '${raw}' to be refused`);
      };

      it.each([
        ['a & b', '&', 2, 'AND'],
        ['a && b', '&', 2, 'AND'],
        ['a | b', '|', 2, 'OR'],
        ['a || b', '|', 2, 'OR'],
        ['a ? b : c', '?', 2, 'IF'],
        ['a \\ b', '\\', 2, 'quoted string'],
        ['a ; b', ';', 2, ';'],
        ['a \u2013 b', '\u2013', 2, 'en dash'],
        ['a \u2014 b', '\u2014', 2, 'em dash'],
        ['a \u2212 b', '\u2212', 2, 'minus sign'],
        ['\u201Chi\u201D', '\u201C', 0, 'curly quote'],
        ['a ^ b', '^', 2, undefined],
        ['a ~ b', '~', 2, undefined],
        ['a $ b', '$', 2, undefined],
        ['caf\u00e9', '\u00e9', 3, undefined],
      ])('%s → refuses %s at %d', (raw, ch, pos, hint) => {
        const e = refusal(raw);
        expect(e.message).toContain(`Unrecognised character '${ch}'`);
        expect(e.pos).toBe(pos);
        if (hint !== undefined) expect(e.message).toContain(hint);
      });

      it('a trailing stray character is refused too (it used to vanish)', () => {
        expect(refusal('a = 1;').message).toContain("Unrecognised character ';'");
      });

      it('inside a hop WHERE as well', () => {
        expect(refusal('EXISTS(x-[n:e WHERE `a` && `b`]->)').message).toContain("Unrecognised character '&'");
      });

      it('the same characters inside a string are text', () => {
        expect(parseMovementExpression('"a && b; c? d | e"')).toEqual({ type: 'static', value: 'a && b; c? d | e' });
      });
    });

    it('wraps formula ParseError as BridgeError with a position', () => {
      try {
        parseMovementExpression('COALESCE(');
        fail('expected BridgeError');
      } catch (e) {
        expect(e).toBeInstanceOf(BridgeError);
        expect(typeof (e as BridgeError).pos).toBe('number');
      }
    });
  });

  describe('amendment 3 — interpolated and multiline strings', () => {
    it('desugars ${…} interpolation to CONCAT with 4 parts (spec §I)', () => {
      const raw = '"New deal from ${msg-[:sender]->.`name`}: ${company.`url`}"';
      expect(parseMovementExpression(raw)).toEqual({
        type: 'concat',
        parts: [
          { type: 'static', value: 'New deal from ' },
          {
            type: 'traverse',
            aliasRoot: 'msg',
            steps: [{ type: 'edge', edgeTypeId: 'sender', direction: 'outgoing' }],
            expression: { type: 'property', propertyTypeId: 'name' },
          },
          { type: 'static', value: ': ' },
          {
            type: 'traverse',
            aliasRoot: 'company',
            steps: [],
            expression: { type: 'property', propertyTypeId: 'url' },
          },
        ],
      });
    });

    it('desugared interpolation deep-equals the explicit CONCAT a formula author would write', () => {
      expect(parseMovementExpression('"a ${b} c"')).toEqual(
        parseMovementExpression('CONCAT("a ", b, " c")'),
      );
    });

    it('keeps a multiline string with no interpolation as a single static node', () => {
      // From 3_syntax_sketch.md §I — company_prompt is a multiline string.
      const raw = '"the company name this email is about.\n  Prefer the legal entity name;\n  ignore the sender."';
      expect(parseMovementExpression(raw)).toEqual({
        type: 'static',
        value: 'the company name this email is about.\n  Prefer the legal entity name;\n  ignore the sender.',
      });
    });

    it('escaped \\${ stays literal text', () => {
      expect(parseMovementExpression('"costs \\${total}"')).toEqual({
        type: 'static',
        value: 'costs ${total}',
      });
    });

    it('\\n and \\t escapes translate to control characters', () => {
      expect(parseMovementExpression('"line one\\nline two\\tend"')).toEqual({
        type: 'static',
        value: 'line one\nline two\tend',
      });
    });

    it('escapes translate inside interpolated strings too', () => {
      expect(parseMovementExpression('"a\\n${company.`url`}\\nb"')).toEqual({
        type: 'concat',
        parts: [
          { type: 'static', value: 'a\n' },
          {
            type: 'traverse',
            aliasRoot: 'company',
            steps: [],
            expression: { type: 'property', propertyTypeId: 'url' },
          },
          { type: 'static', value: '\nb' },
        ],
      });
    });

    it('escaped quotes and backslashes are the character itself', () => {
      expect(parseMovementExpression('"say \\"hi\\" \\\\once"')).toEqual({
        type: 'static',
        value: 'say "hi" \\once',
      });
    });

    it('desugars interpolation nested inside a larger expression in place', () => {
      // The nested literal lifts out and desugars exactly as the same literal
      // would on its own, splicing back into the function argument.
      expect(parseMovementExpression('COALESCE(x, "a ${b}")')).toEqual({
        type: 'function',
        fn: 'coalesce',
        args: [
          { type: 'property', propertyTypeId: 'x' },
          parseMovementExpression('"a ${b}"'),
        ],
      });
    });

    it('desugars interpolation inside an AI() prompt argument', () => {
      // The motivating case: AI("…${x}…") used to throw; the prompt is now a
      // concat carried as the llm node's promptExpression.
      const parsed = parseMovementExpression('AI("the company in ${msg.`Subject`}")');
      expect(parsed.type).toBe('llm');
      if (parsed.type !== 'llm') return;
      expect(parsed.promptExpression).toEqual(parseMovementExpression('"the company in ${msg.`Subject`}"'));
    });

    it('lifts multiple nested interpolated literals independently', () => {
      expect(parseMovementExpression('CONCAT("a ${b}", "c ${d}")')).toEqual({
        type: 'concat',
        parts: [
          parseMovementExpression('"a ${b}"'),
          parseMovementExpression('"c ${d}"'),
        ],
      });
    });

    it('leaves a non-interpolated literal beside an interpolated one untouched', () => {
      // AI(prompt, "thorough") — the tier literal has no ${…} and must stay a
      // plain static string, not get lifted.
      const parsed = parseMovementExpression('AI("name in ${msg.`Body`}", "thorough")');
      expect(parsed.type).toBe('llm');
      if (parsed.type !== 'llm') return;
      expect(parsed.tier).toBe('thorough');
      expect(parsed.promptExpression?.type).toBe('concat');
    });
  });

  describe("AI()'s tier", () => {
    const tierOf = (source: string): string | undefined => {
      const parsed = parseMovementExpression(source);
      return parsed.type === 'llm' ? parsed.tier : undefined;
    };

    it('carries the written word through, unresolved', () => {
      expect(tierOf('AI("x", "quick")')).toBe('quick');
      expect(tierOf('AI("x", "careful")')).toBe('careful');
      expect(tierOf('AI("x", "thorough")')).toBe('thorough');
      expect(tierOf('AI("x")')).toBeUndefined();
    });

    // A word nobody recognises has to REACH the checker, which owns the closed
    // set and the did-you-mean; dropping it here would be the silence this
    // language refuses.
    it('carries a word that is no tier through to the checker', () => {
      expect(tierOf('AI("x", "loud")')).toBe('loud');
      expect(tierOf('AI("x", "smart")')).toBe('smart');
    });

    it('refuses a computed tier — it is read where the program is saved', () => {
      expect(() => parseMovementExpression('AI("x", msg.`Body`)')).toThrow(BridgeError);
      expect(() => parseMovementExpression('AI("x", 3)')).toThrow(BridgeError);
    });

    it('spells the tier back — a call without it is a different call', () => {
      const named = (id: string) => id;
      expect(serialize(parseMovementExpression('AI("x", "thorough")'), named))
        .toBe('AI("x", "thorough")');
      expect(serialize(parseMovementExpression('AI("x")'), named)).toBe('AI("x")');
    });
  });

  describe('amendment 4 — retired extraction constructs', () => {
    it('rejects EXTRACT_VALUE("x")', () => {
      expect(() => parseMovementExpression('EXTRACT_VALUE("x")')).toThrow(BridgeError);
      expect(() => parseMovementExpression('EXTRACT_VALUE("x")')).toThrow(/EXTRACT_VALUE is retired/);
    });

    it('does NOT reject "EXTRACT_VALUE" inside a string literal', () => {
      expect(parseMovementExpression('"EXTRACT_VALUE"')).toEqual({
        type: 'static',
        value: 'EXTRACT_VALUE',
      });
    });

    it('rejects the #extract meta-edge', () => {
      expect(() => parseMovementExpression('msg-[#extract { description: "x" }]->.`name`'))
        .toThrow(/#extract meta-edge is retired/);
    });
  });

  describe('closures outside their one legal position', () => {
    it('rejects a closure literal as a call argument value, with its own code', () => {
      expect(() => parseMovementExpression('(n) => n.`name`')).toThrow(BridgeError);
      try {
        parseMovementExpression('(n) => n.`name`');
        fail('expected BridgeError');
      } catch (e) {
        expect((e as BridgeError).code).toBe('MOV_EXPR_CLOSURE_POSITION');
        expect((e as BridgeError).message).toMatch(/closure cannot be written here/);
      }
    });

    it('rejects a closure literal inside a hop WHERE', () => {
      const raw = 'crm-[:companies WHERE (n) => TRUE]->.`__movement_head_probe__`';
      expect(() => parseMovementExpression(raw)).toThrow(BridgeError);
      try {
        parseMovementExpression(raw);
        fail('expected BridgeError');
      } catch (e) {
        expect((e as BridgeError).code).toBe('MOV_EXPR_CLOSURE_POSITION');
      }
    });

    it('does NOT trip on a closure-shaped arrow inside a string literal', () => {
      expect(parseMovementExpression('"x => 1"')).toEqual({ type: 'static', value: 'x => 1' });
    });

    it('does NOT trip on >=, <=, or == comparisons', () => {
      expect(() => parseMovementExpression('a >= b')).not.toThrow();
      expect(() => parseMovementExpression('a <= b')).not.toThrow();
      expect(() => parseMovementExpression('a == b')).not.toThrow();
    });
  });

  describe('prefix EXISTS(…) lifting', () => {
    it('parses alias-rooted EXISTS into a re-rooted exists node', () => {
      expect(parseMovementExpression('EXISTS(rec-[:Company]->)')).toEqual({
        type: 'traverse',
        aliasRoot: 'rec',
        steps: [],
        expression: {
          type: 'exists',
          steps: [{ type: 'edge', edgeTypeId: 'Company', direction: 'outgoing' }],
        },
      });
    });

    it('parses context-rooted EXISTS with a top-level WHERE predicate', () => {
      expect(parseMovementExpression('EXISTS(-[:notes]-> WHERE author == "me")')).toEqual({
        type: 'exists',
        steps: [{ type: 'edge', edgeTypeId: 'notes', direction: 'outgoing' }],
        where: {
          type: 'compare',
          op: 'eq',
          left: { type: 'property', propertyTypeId: 'author' },
          right: { type: 'static', value: 'me' },
        },
      });
    });

    it('composes inside a larger boolean expression', () => {
      expect(parseMovementExpression('NOT EXISTS(rec-[:Company]->)')).toEqual({
        type: 'not',
        expression: {
          type: 'traverse',
          aliasRoot: 'rec',
          steps: [],
          expression: {
            type: 'exists',
            steps: [{ type: 'edge', edgeTypeId: 'Company', direction: 'outgoing' }],
          },
        },
      });
    });

    it('does not lift KG_EXISTS', () => {
      const parsed = parseMovementExpression('KG_EXISTS("MATCH (n) RETURN n", x)');
      expect(parsed.type).toBe('kg_exists');
    });
  });

  describe('aggregates over bare traversals (spec §C)', () => {
    it('COUNT(orgs-[:co]->) parses — terminal-less traversal yields the positions', () => {
      expect(parseMovementExpression('COUNT(orgs-[:co]->)')).toEqual({
        type: 'aggregate',
        fn: 'count',
        expression: {
          type: 'traverse',
          aliasRoot: 'orgs',
          steps: [{ type: 'edge', edgeTypeId: 'co', direction: 'outgoing' }],
          expression: { type: 'property', propertyTypeId: POSITION_SENTINEL },
        },
      });
    });

    it('context-rooted bare traversal works too: COUNT(-[:notes]->)', () => {
      const parsed = parseMovementExpression('COUNT(-[:notes]->)');
      expect(parsed.type).toBe('aggregate');
      if (parsed.type !== 'aggregate') return;
      expect(parsed.expression).toEqual({
        type: 'traverse',
        steps: [{ type: 'edge', edgeTypeId: 'notes', direction: 'outgoing' }],
        expression: { type: 'property', propertyTypeId: POSITION_SENTINEL },
      });
    });

    it('postfix property on the aggregate is moved inside: FIRST(orgs-[:co]->).`url`', () => {
      expect(parseMovementExpression('FIRST(orgs-[:co]->).`url`')).toEqual(
        parseMovementExpression('FIRST(orgs-[:co]->.`url`)'),
      );
    });

    it('the §C interpolation parses whole', () => {
      const raw = '"Logged ${COUNT(orgs-[:co]->)} companies. First: ${FIRST(orgs-[:co]->).`url`}"';
      const parsed = parseMovementExpression(raw);
      expect(parsed.type).toBe('concat');
      if (parsed.type !== 'concat') return;
      expect(parsed.parts.map(p => p.type)).toEqual([
        'static',
        'aggregate',
        'static',
        'aggregate',
      ]);
    });

    it('leaves aggregates over property-terminated traversals untouched', () => {
      expect(parseMovementExpression('FIRST(orgs-[:co]->.`url`)')).toEqual({
        type: 'aggregate',
        fn: 'first',
        expression: {
          type: 'traverse',
          aliasRoot: 'orgs',
          steps: [{ type: 'edge', edgeTypeId: 'co', direction: 'outgoing' }],
          expression: { type: 'property', propertyTypeId: 'url' },
        },
      });
    });

    it('leaves non-traversal aggregate arguments untouched', () => {
      expect(parseMovementExpression('COUNT(items)')).toEqual({
        type: 'aggregate',
        fn: 'count',
        expression: { type: 'property', propertyTypeId: 'items' },
      });
    });

    it('does not rewrite aggregate names inside string literals', () => {
      expect(parseMovementExpression('"COUNT(orgs-[:co]->)"')).toEqual({
        type: 'static',
        value: 'COUNT(orgs-[:co]->)',
      });
    });

    it('nested aggregates rewrite independently: JOIN(COLLECT(orgs-[:co]->), ", ")', () => {
      const parsed = parseMovementExpression('JOIN(COLLECT(orgs-[:co]->), ", ")');
      expect(parsed.type).toBe('aggregate');
      if (parsed.type !== 'aggregate') return;
      expect(parsed.fn).toBe('join');
      expect(parsed.expression.type).toBe('aggregate');
    });

    // General rule: a backtick-quoted root is still a bare traversal path —
    // `blankLiterals` turns the backtick span into spaces (not nothing), so
    // the bare-path shape probe must tolerate that leading blank run rather
    // than require a bare identifier.
    it('a backtick-quoted root is recognised as a bare traversal too: COUNT(`my org`-[:co]->)', () => {
      expect(parseMovementExpression('COUNT(`my org`-[:co]->)')).toEqual({
        type: 'aggregate',
        fn: 'count',
        expression: {
          type: 'traverse',
          aliasRoot: 'my org',
          steps: [{ type: 'edge', edgeTypeId: 'co', direction: 'outgoing' }],
          expression: { type: 'property', propertyTypeId: POSITION_SENTINEL },
        },
      });
    });
  });
});

describe('parseMovementCondition', () => {
  it('splits top-level AND into isTest + expr conjuncts (spec §F)', () => {
    const cond = parseMovementCondition('rec IS <crm-[:company]->> AND EXISTS(rec-[:Company]->)');
    expect(cond).toEqual({
      kind: 'and',
      conjuncts: [
        { kind: 'isTest', subjectRaw: 'rec', type: { graph: 'crm', position: 'company' } },
        {
          kind: 'expr',
          expr: {
            type: 'traverse',
            aliasRoot: 'rec',
            steps: [],
            expression: {
              type: 'exists',
              steps: [{ type: 'edge', edgeTypeId: 'Company', direction: 'outgoing' }],
            },
          },
        },
      ],
    });
  });

  it('returns a lone expr conjunct unwrapped', () => {
    const cond = parseMovementCondition('stage == "Series A"');
    expect(cond.kind).toBe('expr');
    if (cond.kind !== 'expr') return;
    expect(cond.expr).toEqual({
      type: 'compare',
      op: 'eq',
      left: { type: 'property', propertyTypeId: 'stage' },
      right: { type: 'static', value: 'Series A' },
    });
  });

  it('parses a lone IS test, graph-only form included', () => {
    expect(parseMovementCondition('rec IS <crm-[:company]->>')).toEqual({
      kind: 'isTest',
      subjectRaw: 'rec',
      type: { graph: 'crm', position: 'company' },
    });
    expect(parseMovementCondition('rec IS <kg>')).toEqual({
      kind: 'isTest',
      subjectRaw: 'rec',
      type: { graph: 'kg' },
    });
  });

  it('a bare IS type gets the angle-bracket fix-it', () => {
    // A bare DOTTED spelling lands on the valid address in one hop — never on
    // the retired dotted marker.
    expect(() => parseMovementCondition('rec IS crm.company')).toThrow(
      /Write '<crm-\[:company\]->>' instead of '<crm\.company>'/,
    );
    expect(() => parseMovementCondition('rec IS kg')).toThrow(
      /wrap the type in angle brackets: <kg>/,
    );
  });

  it('the dotted IS type is retired with the exact address replacement', () => {
    expect(() => parseMovementCondition('rec IS <crm.company>')).toThrow(
      /'\.' reads a property — a type names an EDGE, and an edge is an address\. Write '<crm-\[:company\]->>' instead of '<crm\.company>'\./,
    );
    expect(() => parseMovementCondition('rec IS <crm.`Record Created`>')).toThrow(
      /Write '<crm-\[:`Record Created`\]->>' instead of '<crm\.`Record Created`>'/,
    );
  });

  it('does not split on AND inside strings or brackets', () => {
    const cond = parseMovementCondition('msg.`subject` CONTAINS "deal AND debt"');
    expect(cond.kind).toBe('expr');
  });

  it('rejects IS under OR (not yet supported)', () => {
    expect(() => parseMovementCondition('rec IS <crm-[:company]->> OR x == 1')).toThrow(/not yet supported/);
  });

  it('rejects IS under NOT (not yet supported)', () => {
    expect(() => parseMovementCondition('NOT rec IS <crm-[:company]->>')).toThrow(/not yet supported/);
  });

  it('rejects IS under ! the same way — ! is NOT', () => {
    expect(() => parseMovementCondition('!rec IS <crm-[:company]->>')).toThrow(/not yet supported/);
  });

  it('!= beside an IS conjunct is a comparison, not a negation', () => {
    expect(parseMovementCondition('rec IS <crm-[:company]->> AND rec.`name` != "x"')).toMatchObject({ kind: 'and' });
  });

  it('rejects a malformed IS right-hand side', () => {
    expect(() => parseMovementCondition('rec IS "crm"')).toThrow(/IS expects a position type/);
  });

  it('rejects retired constructs in expr conjuncts', () => {
    expect(() => parseMovementCondition('x == 1 AND EXTRACT_VALUE("y")')).toThrow(/EXTRACT_VALUE is retired/);
  });

  // General rule: every name position is backtickable, including the
  // instance/graph root of an IS type test — not just the position/edge name
  // IS_TYPE_PATTERN already covered.
  describe('backtick-quoted roots (general rule)', () => {
    it('narrows through the address (hop-with-WHERE) form with a backtick-quoted instance root', () => {
      expect(
        parseMovementCondition(
          'rec IS <`My CRM`-[:`Record Created` WHERE `action` == "created"]->>',
        ),
      ).toEqual({
        kind: 'isTest',
        subjectRaw: 'rec',
        type: {
          graph: 'My CRM',
          hopsRaw: '-[:`Record Created` WHERE `action` == "created"]->',
        },
      });
    });

    it('a bare backtick-quoted root gets the angle-bracket fix-it', () => {
      expect(() => parseMovementCondition('rec IS `My CRM`')).toThrow(
        /wrap the type in angle brackets: <`My CRM`>/,
      );
    });

    it('a backtick-quoted root in the retired dotted form gets the address replacement, backticks preserved', () => {
      expect(() => parseMovementCondition('rec IS <`My CRM`.company>')).toThrow(
        /Write '<`My CRM`-\[:company\]->>' instead of '<`My CRM`\.company>'/,
      );
    });
  });
});

// Type-level check: the bridge returns the shared Expression AST.
const _typecheck: Expression = parseMovementExpression('"x"');
void _typecheck;

// ── ORDER BY / LIMIT in traversal brackets ──────────────────────────────────

describe('bracket ORDER BY / LIMIT', () => {
  it('parses WHERE + ORDER BY DESC + LIMIT onto the step cardinality', () => {
    const e = parseMovementExpression(
      'crm-[c:companies WHERE `stage` == "Seed" ORDER BY `created_at` DESC LIMIT 10]->.`name`',
    );
    expect(e.type).toBe('traverse');
    if (e.type !== 'traverse') return;
    const step = e.steps[0];
    expect(step.type).toBe('edge');
    if (step.type !== 'edge') return;
    expect(step.expressionFilter).toBeDefined();
    expect(step.cardinality).toEqual({
      mode: 'n',
      limit: 10,
      orderBy: { type: 'property', propertyTypeId: 'created_at' },
      orderDirection: 'desc',
    });
  });

  it('ORDER BY alone keeps mode all (no limit) and defaults ascending', () => {
    const e = parseMovementExpression('kg-[c:companies ORDER BY `name`]->.`name`');
    if (e.type !== 'traverse' || e.steps[0].type !== 'edge') throw new Error('shape');
    expect(e.steps[0].cardinality).toEqual({
      mode: 'all',
      orderBy: { type: 'property', propertyTypeId: 'name' },
      orderDirection: 'asc',
    });
  });

  it('LIMIT alone carries mode n', () => {
    const e = parseMovementExpression('COUNT(kg-[c:companies LIMIT 3]->)');
    expect(e.type).toBe('aggregate');
    if (e.type !== 'aggregate') return;
    const inner = e.expression;
    if (inner.type !== 'traverse' || inner.steps[0].type !== 'edge') throw new Error('shape');
    expect(inner.steps[0].cardinality).toEqual({ mode: 'n', limit: 3 });
  });

  it('a plain hop carries no cardinality', () => {
    const e = parseMovementExpression('msg-[:files]->.`name`');
    if (e.type !== 'traverse' || e.steps[0].type !== 'edge') throw new Error('shape');
    expect(e.steps[0].cardinality).toBeUndefined();
  });
});

// An ordering key is an expression over the element the hop lands on — a
// property of it, a short path off it, anything pure. The bare property is the
// degenerate case, and it is the only one an adapter is ever handed.
describe('ORDER BY takes an expression over the element', () => {
  const hop = (source: string) => {
    const e = parseMovementExpression(source);
    if (e.type !== 'traverse' || e.steps[0].type !== 'edge') throw new Error('shape');
    return e.steps[0];
  };

  it('a bare property is a property read of the landed record', () => {
    expect(hop('l-[e:Entries ORDER BY `Added At` DESC]->.`Name`').cardinality).toEqual({
      mode: 'all',
      orderBy: { type: 'property', propertyTypeId: 'Added At' },
      orderDirection: 'desc',
    });
  });

  it('a path key roots at the hop’s own alias and keeps the LIMIT after it', () => {
    const step = hop('l-[e:Entries ORDER BY e-[:Signal]->.`Discovered At` DESC LIMIT 2]->.`Name`');
    expect(step.cardinality?.limit).toBe(2);
    expect(step.cardinality?.orderDirection).toBe('desc');
    expect(step.cardinality?.orderBy).toEqual({
      type: 'traverse',
      aliasRoot: 'e',
      steps: [{ type: 'edge', edgeTypeId: 'Signal', direction: 'outgoing' }],
      expression: { type: 'property', propertyTypeId: 'Discovered At' },
    });
  });

  it('a key may be computed, and ASC is the default', () => {
    const step = hop('l-[e:Entries ORDER BY LOWER(`Name`)]->.`Name`');
    expect(step.cardinality?.orderDirection).toBe('asc');
    expect(step.cardinality?.orderBy).toEqual({
      type: 'function',
      fn: 'lower',
      args: [{ type: 'property', propertyTypeId: 'Name' }],
    });
  });

  it('the bracket may wrap across lines, WHERE and all', () => {
    const step = hop(
      'l-[e:Entries\n  WHERE `Kind` == "note"\n  ORDER BY e-[:Signal]->.`Discovered At`\n  DESC\n  LIMIT 5]->.`Name`',
    );
    expect(step.expressionFilter).toBeDefined();
    expect(step.cardinality?.limit).toBe(5);
    expect(step.cardinality?.orderDirection).toBe('desc');
    expect(step.cardinality?.orderBy?.type).toBe('traverse');
  });

  it('round-trips through the serializer, key and all', () => {
    const source = 'l-[e:Entries ORDER BY e-[:Signal]->.`Discovered At` DESC LIMIT 2]->.`Name`';
    const e = parseMovementExpression(source);
    // The terminal loses its backticks (it needs none) — the KEY keeps them.
    expect(serialize(e, (id) => id)).toBe(
      'l-[e:Entries ORDER BY e-[:Signal]->.`Discovered At` DESC LIMIT 2]->.Name',
    );
  });

  it('round-trips a bare key', () => {
    const source = 'l-[e:Entries ORDER BY `Added At` DESC]->.`Name`';
    expect(serialize(parseMovementExpression(source), (id) => id)).toBe(
      'l-[e:Entries ORDER BY `Added At` DESC]->.Name',
    );
  });
});

describe('SORT orders a collection already in hand', () => {
  const sort = (source: string) => {
    const e = parseMovementExpression(source);
    if (e.type !== 'aggregate') throw new Error('shape');
    return e;
  };

  it('the members by themselves, ascending', () => {
    expect(sort('SORT(scores)')).toEqual({
      type: 'aggregate',
      fn: 'sort',
      expression: { type: 'property', propertyTypeId: 'scores' },
      orderDirection: 'asc',
    });
  });

  it('a bare DESC in the last slot is the direction, not a key', () => {
    const e = sort('SORT(scores, DESC)');
    expect(e.orderBy).toBeUndefined();
    expect(e.orderDirection).toBe('desc');
  });

  it('a key, and a key with a direction', () => {
    expect(sort('SORT(entries, `Added At`)').orderBy).toEqual({
      type: 'property',
      propertyTypeId: 'Added At',
    });
    const both = sort('SORT(entries, `Added At`, DESC)');
    expect(both.orderBy).toEqual({ type: 'property', propertyTypeId: 'Added At' });
    expect(both.orderDirection).toBe('desc');
  });

  it('the key may be a path off the member', () => {
    expect(sort('SORT(entries, e-[:Signal]->.`Discovered At`, DESC)').orderBy).toEqual({
      type: 'traverse',
      aliasRoot: 'e',
      steps: [{ type: 'edge', edgeTypeId: 'Signal', direction: 'outgoing' }],
      expression: { type: 'property', propertyTypeId: 'Discovered At' },
    });
  });

  it('an empty call, and a direction written before the key, are refused', () => {
    expect(() => parseMovementExpression('SORT()')).toThrow(/SORT orders a collection/);
    expect(() => parseMovementExpression('SORT(xs, DESC, `Added At`)')).toThrow(/SORT/);
  });

  it('round-trips through the serializer', () => {
    for (const source of [
      'SORT(scores)',
      'SORT(scores, DESC)',
      'SORT(entries, `Added At`)',
      'SORT(entries, `Added At`, DESC)',
      'JOIN(SORT(names), ", ")',
    ]) {
      expect(serialize(parseMovementExpression(source), (id) => id)).toBe(source);
    }
  });
});
