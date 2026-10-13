import { ExpressionSyntaxError, parseExpression } from '../parse_expression';
import type { MExpr } from '../tree';

/** The tree without offsets, for comparing shapes. */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => k !== 'at')
        .map(([k, v]) => [k, shape(v)]),
    );
  }
  return value;
}

const parse = (text: string) => shape(parseExpression(text));
const name = (text: string, quoted = false) => ({ kind: 'name', name: { text, quoted } });
const nameOnly = (text: string, quoted = false) => ({ text, quoted });

describe('parseExpression', () => {
  describe('calls are calls — the parser resolves no name', () => {
    it.each(['COUNT(x)', 'AI("p")', 'EXISTS(x)', 'upper(s)', 'SORT(xs, DESC)', 'AT(xs, 0)'])('%s', text => {
      const tree = parseExpression(text);
      expect(tree.kind).toBe('call');
    });

    it('a namespaced call is a call on a member', () => {
      expect(parse('CURRENCY.PARSE(s)')).toEqual({
        kind: 'call',
        callee: { kind: 'member', object: name('CURRENCY'), property: nameOnly('PARSE') },
        args: [{ value: name('s') }],
      });
    });

    it('a movement call keeps its named arguments', () => {
      expect(parse('enrich(m: msg, depth: 2)')).toEqual({
        kind: 'call',
        callee: name('enrich'),
        args: [
          { name: nameOnly('m'), value: name('msg') },
          { name: nameOnly('depth'), value: { kind: 'literal', value: 2 } },
        ],
      });
    });

    it('a call nests anywhere a value does', () => {
      expect(parse('f(x) + 1')).toEqual({
        kind: 'binary',
        op: '+',
        left: { kind: 'call', callee: name('f'), args: [{ value: name('x') }] },
        right: { kind: 'literal', value: 1 },
      });
    });
  });

  describe('operators keep the formula grammar’s precedence', () => {
    it('OR < AND < NOT < compare < add < mul < unary', () => {
      expect(parse('a OR b AND NOT c = d + e * -f')).toEqual({
        kind: 'binary',
        op: 'or',
        left: name('a'),
        right: {
          kind: 'binary',
          op: 'and',
          left: name('b'),
          right: {
            kind: 'unary',
            op: 'not',
            operand: {
              kind: 'binary',
              op: '==',
              left: name('c'),
              right: {
                kind: 'binary',
                op: '+',
                left: name('d'),
                right: { kind: 'binary', op: '*', left: name('e'), right: { kind: 'unary', op: '-', operand: name('f') } },
              },
            },
          },
        },
      });
    });

    it('arithmetic is left-associative', () => {
      expect(parse('a - b - c')).toEqual({
        kind: 'binary',
        op: '-',
        left: { kind: 'binary', op: '-', left: name('a'), right: name('b') },
        right: name('c'),
      });
    });

    it('a comparison does not chain', () => {
      expect(() => parseExpression('a < b < c')).toThrow(ExpressionSyntaxError);
    });

    it('keywords are case-insensitive, and ! is NOT', () => {
      expect(parse('!a and true')).toEqual(parse('NOT a AND TRUE'));
    });

    it('a minus straight before a digit is a negative literal after an operator', () => {
      expect(parse('x = -5')).toEqual({ kind: 'binary', op: '==', left: name('x'), right: { kind: 'literal', value: -5 } });
      expect(parse('f(x) -1')).toEqual({
        kind: 'binary',
        op: '-',
        left: { kind: 'call', callee: name('f'), args: [{ value: name('x') }] },
        right: { kind: 'literal', value: 1 },
      });
    });

    it('postfix EXISTS, WITHIN and IS sit at comparison level', () => {
      expect(parse('x EXISTS')).toEqual({ kind: 'exists', operand: name('x') });
      expect(parse('t WITHIN 30d')).toEqual({
        kind: 'within',
        operand: name('t'),
        duration: { text: '30d', quoted: false },
      });
      expect(parse('rec IS <crm-[:company]->>')).toMatchObject({ kind: 'is', subject: name('rec'), type: { kind: 'named' } });
    });

    it('IF … THEN … ELSE IF … END chains with one END', () => {
      expect(parse('IF a THEN 1 ELSE IF b THEN 2 ELSE 3 END')).toEqual({
        kind: 'if',
        condition: name('a'),
        then: { kind: 'literal', value: 1 },
        else: {
          kind: 'if',
          condition: name('b'),
          then: { kind: 'literal', value: 2 },
          else: { kind: 'literal', value: 3 },
        },
      });
    });
  });

  describe('names', () => {
    it('a backtick name is the same name, quoted', () => {
      expect(parse('`Funding Round`.`Amount`')).toEqual({
        kind: 'member',
        object: name('Funding Round', true),
        property: nameOnly('Amount', true),
      });
    });

    it('a member chain nests to the left, as postfix syntax does', () => {
      expect(parse('a.b.c')).toEqual({
        kind: 'member',
        object: { kind: 'member', object: name('a'), property: nameOnly('b') },
        property: nameOnly('c'),
      });
    });
  });

  describe('paths', () => {
    it('reads every clause a hop can carry', () => {
      expect(parse('x-[r:Funding Round WHERE r.a == 1 ORDER BY r.b DESC LIMIT 3]->.c')).toEqual({
        kind: 'member',
        object: {
          kind: 'path',
          root: name('x'),
          hops: [
            {
              direction: 'out',
              arrow: '->',
              alias: nameOnly('r'),
              label: nameOnly('Funding Round'),
              where: {
                kind: 'binary',
                op: '==',
                left: { kind: 'member', object: name('r'), property: nameOnly('a') },
                right: { kind: 'literal', value: 1 },
              },
              orderBy: { key: { kind: 'member', object: name('r'), property: nameOnly('b') }, direction: 'desc' },
              limit: 3,
            },
          ],
        },
        property: nameOnly('c'),
      });
    });

    it('a label may be quoted, meta, or a resource shorthand', () => {
      const labels = (text: string) =>
        (parseExpression(text) as Extract<MExpr, { kind: 'path' }>).hops.map(h => h.label.text);
      expect(labels('-[:`Record Change`]->')).toEqual(['Record Change']);
      expect(labels('-[t:#transform { plugin: "p" }]->')).toEqual(['#transform']);
      expect(labels('-[:_resources:TEXT]->')).toEqual(['_resources:TEXT']);
    });

    it('a bare walk is a value; consecutive hops are one path', () => {
      expect(parse('-[:a]->-[b:c]->')).toMatchObject({
        kind: 'path',
        hops: [{ label: nameOnly('a') }, { alias: nameOnly('b'), label: nameOnly('c') }],
      });
    });

    it('an incoming hop closes with ]-', () => {
      expect(parse('x<-[:reports_to]-')).toMatchObject({
        kind: 'path',
        root: name('x'),
        hops: [{ direction: 'in', arrow: '-', label: nameOnly('reports_to') }],
      });
    });

    it('any expression may root a walk', () => {
      expect(parse('AT(rows, 0)-[c:company]->')).toMatchObject({
        kind: 'path',
        root: { kind: 'call', callee: name('AT') },
      });
    });

    it('a hop WHERE is an expression, nested walks and all', () => {
      expect(parse('x-[:a WHERE COUNT(y-[:b]->) > 1]->')).toMatchObject({
        hops: [{ where: { kind: 'binary', op: '>', left: { kind: 'call', args: [{ value: { kind: 'path' } }] } } }],
      });
    });

    it('`-` and `[` that open no hop are a minus and a list', () => {
      expect(parse('a -[1]')).toEqual({
        kind: 'binary',
        op: '-',
        left: name('a'),
        right: { kind: 'list', elements: [{ kind: 'literal', value: 1 }] },
      });
    });
  });

  describe('WHERE as a filter operator', () => {
    it('binds loosest, inside a call', () => {
      expect(parse('EXISTS(rec-[:co]-> WHERE name == "Acme" AND live)')).toMatchObject({
        kind: 'call',
        args: [
          {
            value: {
              kind: 'where',
              source: { kind: 'path', root: name('rec') },
              predicate: { kind: 'binary', op: 'and' },
            },
          },
        ],
      });
    });
  });

  describe('strings', () => {
    it('keeps interpolations as expressions', () => {
      expect(parse('"a ${x.`b`} c ${1 + 2}"')).toEqual({
        kind: 'string',
        quote: '"',
        parts: [
          'a ',
          { kind: 'member', object: name('x'), property: nameOnly('b', true) },
          ' c ',
          { kind: 'binary', op: '+', left: { kind: 'literal', value: 1 }, right: { kind: 'literal', value: 2 } },
        ],
      });
    });

    it('applies escapes, and a single-quoted string never interpolates', () => {
      expect(parse('"a\\n\\${x}"')).toEqual({ kind: 'string', quote: '"', parts: ['a\n${x}'] });
      expect(parse("'${x}'")).toEqual({ kind: 'string', quote: "'", parts: ['${x}'] });
    });

    it('an interpolation may hold strings and braces of its own', () => {
      expect(parse('"${CONCAT("}", { a: 1 }.a)}"')).toMatchObject({ kind: 'string', parts: [{ kind: 'call' }] });
    });

    it('refuses an empty interpolation', () => {
      expect(() => parseExpression('"a ${ } b"')).toThrow('Empty ${…} interpolation');
    });
  });

  describe('lists and maps', () => {
    it('a list spreads and takes a trailing comma', () => {
      expect(parse('[a, ...xs,]')).toEqual({
        kind: 'list',
        elements: [name('a'), { kind: 'spread', expr: name('xs') }],
      });
    });

    it('`{` where a value starts is a map', () => {
      expect(parse('{ text: x, "content-type": 1, `a b`: [] }')).toEqual({
        kind: 'map',
        entries: [
          { key: nameOnly('text'), value: name('x') },
          { key: { text: 'content-type', quoted: 'string' }, value: { kind: 'literal', value: 1 } },
          { key: nameOnly('a b', true), value: { kind: 'list', elements: [] } },
        ],
      });
    });

    it('a reserved word must be quoted to be a key', () => {
      expect(() => parseExpression('{ in: 1 }')).toThrow('reserved word');
    });
  });

  describe('types as values', () => {
    const type = (text: string) => (parse(`<${text}>`) as { type: unknown }).type;

    it('a name, an address, a borrowed field', () => {
      expect(type('number')).toEqual({ kind: 'named', name: nameOnly('number'), hops: [], array: false });
      expect(type('crm-[:company]->')).toMatchObject({ kind: 'named', hops: [{ label: nameOnly('company') }] });
      expect(type('at-[:`Record Change` WHERE `action` == "x"]->')).toMatchObject({
        hops: [{ label: nameOnly('Record Change', true), where: { kind: 'binary' } }],
      });
      expect(type('crm-[:companies]->.`stage`')).toMatchObject({ field: nameOnly('stage', true) });
    });

    it('arrays, records, unions and literals', () => {
      expect(type('text[]')).toMatchObject({ kind: 'named', array: true });
      expect(type('{ mode: text, owner?: text }')).toEqual({
        kind: 'record',
        members: [
          { name: nameOnly('mode'), optional: false, type: { kind: 'named', name: nameOnly('text'), hops: [], array: false } },
          { name: nameOnly('owner'), optional: true, type: { kind: 'named', name: nameOnly('text'), hops: [], array: false } },
        ],
        array: false,
      });
      expect(type('"A" | "B"')).toEqual({
        kind: 'union',
        members: [{ kind: 'literal', value: 'A' }, { kind: 'literal', value: 'B' }],
      });
      expect(type('text | null')).toMatchObject({ kind: 'union', members: [{ kind: 'named' }, { kind: 'literal', value: null }] });
    });

    it('a shape passes as an argument like any value', () => {
      expect(parse('extract(doc, <Deal>, { effort: "high" })')).toMatchObject({
        kind: 'call',
        args: [{ value: name('doc') }, { value: { kind: 'type' } }, { value: { kind: 'map' } }],
      });
    });
  });

  describe('closures', () => {
    it('a block body is kept as its extent — statements are not this grammar', () => {
      const text = '(n, m: <number>) => { return n }';
      const tree = parseExpression(text);
      expect(shape(tree)).toEqual({
        kind: 'closure',
        params: [{ name: nameOnly('n') }, { name: nameOnly('m'), type: { kind: 'named', name: nameOnly('number'), hops: [], array: false } }],
        body: { kind: 'block' },
      });
      if (tree.kind !== 'closure' || tree.body.kind !== 'block') throw new Error('expected a block body');
      expect(text.slice(tree.body.at.start, tree.body.at.end)).toBe('{ return n }');
    });

    it('an expression body is an expression', () => {
      expect(parse('(x) => (x + 1)')).toMatchObject({ kind: 'closure', body: { kind: 'expr', expr: { kind: 'paren' } } });
    });

    it('a parenthesised expression is not a closure', () => {
      expect(parse('(x) + 1')).toMatchObject({ kind: 'binary', left: { kind: 'paren' } });
    });

    it('a closure is an argument like any value', () => {
      expect(parse('MAP(xs, (x) => { return x })')).toMatchObject({
        kind: 'call',
        args: [{ value: name('xs') }, { value: { kind: 'closure' } }],
      });
    });

    // A `#` comment in a block body runs to the end of its line and nothing in
    // it is read: prose with a quote, a backtick or a brace must neither open a
    // literal nor close the body.
    describe('a comment in a nested block body is prose', () => {
      const body = (comment: string, extra = '') =>
        [
          '{',
          `    # ${comment}`,
          ...(extra ? [extra] : []),
          '    page = fetch_url(url: x.website)',
          '    return page',
          '  }',
        ].join('\n');
      const nested = (b: string) => `FIRST(MAP([e], { onError: "warn" }, (x) => ${b}))`;
      const blockOf = (text: string): string => {
        const tree = parseExpression(text);
        if (tree.kind !== 'call') throw new Error('expected a call');
        const map = tree.args[0].value;
        if (map.kind !== 'call') throw new Error('expected MAP');
        const closure = map.args[2].value;
        if (closure.kind !== 'closure' || closure.body.kind !== 'block') throw new Error('expected a block closure');
        return text.slice(closure.body.at.start, closure.body.at.end);
      };

      it.each([
        ['an apostrophe', "LinkedIn research isn't cheap"],
        ['a lone backtick', 'runs only for `x with no website'],
        ['a backtick pair', 'runs only for `x` with no website'],
        ['a double quote', 'the "website field may be empty'],
        ['a closing brace', 'no } here closes anything'],
        ['an opening brace', 'nor does { open anything'],
        ['all of them', 'isn\'t `x` "quoted" } {'],
      ])('%s', (_label, comment) => {
        const b = body(comment);
        expect(blockOf(nested(b))).toBe(b);
      });

      it('a `#` inside a string after the comment is still the string', () => {
        const b = body("isn't a boundary", '    tag = "issue #42 isn\'t } closed"');
        expect(blockOf(nested(b))).toBe(b);
      });

      it('a `#` inside a string is never a comment', () => {
        const b = '{\n    return "a # b }"\n  }';
        expect(blockOf(nested(b))).toBe(b);
      });

      it('a `#` head inside a hop is the hop, not a comment', () => {
        const b = '{\n    return FIRST(x-[#linked]->) }';
        expect(blockOf(nested(b))).toBe(b);
      });

      it('a comment after a `#` hop head on the same line is still a comment', () => {
        const b = "{\n    return FIRST(x-[#linked]->) # isn't } closed\n  }";
        expect(blockOf(nested(b))).toBe(b);
      });
    });

    // The body's end is found by the same rules the lexer reads it with, so no
    // literal can hide a brace from one and show it to the other.
    describe('a literal in a nested block body is read whole', () => {
      const nested = (b: string) => `FIRST(MAP([e], { onError: "warn" }, (x) => ${b}))`;
      const blockOf = (text: string): string => {
        const tree = parseExpression(text);
        if (tree.kind !== 'call') throw new Error('expected a call');
        const map = tree.args[0].value;
        if (map.kind !== 'call') throw new Error('expected MAP');
        const closure = map.args[2].value;
        if (closure.kind !== 'closure' || closure.body.kind !== 'block') throw new Error('expected a block closure');
        return text.slice(closure.body.at.start, closure.body.at.end);
      };

      it.each([
        ['a backtick name with an escaped backtick', '{\n    return x.`a\\`}`\n  }'],
        ["a ' inside a \" string", '{\n    return "it\'s } here"\n  }'],
        ["a \" inside a ' string", "{\n    return 'say \"hi\" }'\n  }"],
        ['a brace in a string inside an interpolation', '{\n    return "a ${ "}" } b"\n  }'],
      ])('%s', (_label, b) => {
        expect(blockOf(nested(b))).toBe(b);
      });

      it('an escaped backtick is part of the name', () => {
        expect(parseExpression('`a\\`b`')).toMatchObject({ kind: 'name', name: { text: 'a`b', quoted: true } });
      });
    });
  });

  describe('node and graph literals, inline declarations', () => {
    it('a node literal’s entries end at a comma, a newline or the close', () => {
      expect(parse('node {\n  a: x + 1\n  b: -[:c]->, d: <crm-[:e]->>\n  e: node { f: 1 }\n}')).toEqual({
        kind: 'node',
        entries: [
          { name: nameOnly('a'), value: { kind: 'binary', op: '+', left: name('x'), right: { kind: 'literal', value: 1 } } },
          {
            name: nameOnly('b'),
            value: { kind: 'path', hops: [{ direction: 'out', arrow: '->', label: nameOnly('c') }] },
          },
          {
            name: nameOnly('d'),
            value: {
              kind: 'declaredEdge',
              type: { kind: 'named', name: nameOnly('crm'), hops: [{ direction: 'out', arrow: '->', label: nameOnly('e') }], array: false },
            },
          },
          { name: nameOnly('e'), value: { kind: 'node', entries: [{ name: nameOnly('f'), value: { kind: 'literal', value: 1 } }] } },
        ],
      });
    });

    it('reads `lazy` walks, per-item tails and ordered declared edges', () => {
      expect(parse('node { files: lazy e-[a:Attachments]-> node { blob: a.`File` }, sent: <slack-[:Messages]->> order by arrival }')).toMatchObject({
        kind: 'node',
        entries: [
          {
            name: nameOnly('files'),
            value: { kind: 'lazy', walk: { kind: 'mapped', source: { kind: 'path' }, body: { kind: 'node' } } },
          },
          { name: nameOnly('sent'), value: { kind: 'declaredEdge', sequenced: nameOnly('arrival') } },
        ],
      });
      expect(parse('node { lazy: 1 }')).toMatchObject({ entries: [{ name: nameOnly('lazy'), value: { kind: 'literal' } }] });
    });

    it('a nested declaration may keep an order, and fields may end at ;', () => {
      expect(parse('node Entry { name: <text>; node founder { first: <text> } order by arrival }')).toMatchObject({
        declaration: {
          members: [{ kind: 'field' }, { kind: 'node', declaration: { name: nameOnly('founder'), sequenced: nameOnly('arrival') } }],
        },
      });
    });

    it('a value may still span lines inside brackets', () => {
      expect(parse('node { a: f(\n  x,\n  y\n) }')).toMatchObject({
        entries: [{ value: { kind: 'call', args: [{}, {}] } }],
      });
    });

    it('in a graph body `{` is a child node, not a map', () => {
      expect(parse('graph<Deal> { a: 1, child: { b: 2 }, kids: [{ c: 3 }], files: m-[x:Attachments]-> { n: x.name }, ...rest }')).toEqual({
        kind: 'graph',
        shape: nameOnly('Deal'),
        entries: [
          { name: nameOnly('a'), value: { kind: 'literal', value: 1 } },
          {
            name: nameOnly('child'),
            value: { kind: 'graph', entries: [{ name: nameOnly('b'), value: { kind: 'literal', value: 2 } }], spreads: [] },
          },
          {
            name: nameOnly('kids'),
            value: {
              kind: 'list',
              elements: [{ kind: 'graph', entries: [{ name: nameOnly('c'), value: { kind: 'literal', value: 3 } }], spreads: [] }],
            },
          },
          {
            name: nameOnly('files'),
            value: {
              kind: 'mapped',
              source: { kind: 'path', root: name('m'), hops: [{ direction: 'out', arrow: '->', alias: nameOnly('x'), label: nameOnly('Attachments') }] },
              body: {
                kind: 'graph',
                entries: [{ name: nameOnly('n'), value: { kind: 'member', object: name('x'), property: nameOnly('name') } }],
                spreads: [],
              },
            },
          },
        ],
        spreads: [name('rest')],
      });
    });

    it('`graph` and `node` alone are ordinary names', () => {
      expect(parse('graph + node')).toEqual({ kind: 'binary', op: '+', left: name('graph'), right: name('node') });
    });

    it('reads an inline declaration', () => {
      expect(parse('node Entry: "each item" {\n  name: <text> "the name"\n  amount: <number | null>\n  node Owner { email: <text> }\n}')).toEqual({
        kind: 'declaration',
        declaration: {
          name: nameOnly('Entry'),
          description: { kind: 'string', quote: '"', parts: ['each item'] },
          members: [
            {
              kind: 'field',
              name: nameOnly('name'),
              type: { kind: 'named', name: nameOnly('text'), hops: [], array: false },
              description: { kind: 'string', quote: '"', parts: ['the name'] },
            },
            {
              kind: 'field',
              name: nameOnly('amount'),
              type: {
                kind: 'union',
                members: [{ kind: 'named', name: nameOnly('number'), hops: [], array: false }, { kind: 'literal', value: null }],
              },
            },
            {
              kind: 'node',
              declaration: {
                name: nameOnly('Owner'),
                members: [{ kind: 'field', name: nameOnly('email'), type: { kind: 'named', name: nameOnly('text'), hops: [], array: false } }],
              },
            },
          ],
        },
      });
    });
  });

  describe('offsets', () => {
    it('every node spans exactly its source', () => {
      const text = 'COUNT(x-[:a]->) + y.`b`';
      const tree = parseExpression(text);
      if (tree.kind !== 'binary') throw new Error('expected a binary');
      expect(text.slice(tree.left.at.start, tree.left.at.end)).toBe('COUNT(x-[:a]->)');
      expect(text.slice(tree.right.at.start, tree.right.at.end)).toBe('y.`b`');
    });

    it('an error carries where it happened', () => {
      try {
        parseExpression('a + & b');
        throw new Error('expected a syntax error');
      } catch (e) {
        expect(e).toBeInstanceOf(ExpressionSyntaxError);
        expect((e as ExpressionSyntaxError).offset).toBe(4);
      }
    });
  });
});

// A `#` comment runs to the end of its line wherever the expression grammar
// reads — except directly inside a hop's brackets, where `#` begins a head.
describe('# comments inside an expression', () => {
  it('inside a list', () => {
    expect(parse('[1, # note\n  2]')).toEqual(parse('[1, 2]'));
  });

  it('inside a map literal', () => {
    expect(parse('{ a: 1, # note\n  b: 2 }')).toEqual(parse('{ a: 1, b: 2 }'));
  });

  it("after a closure's => on its own line", () => {
    expect(parse('MAP(xs, (x) => # the doubled value\n  x * 2)')).toEqual(parse('MAP(xs, (x) => x * 2)'));
  });

  it('a # hop head still parses, and a comment after the hop is a comment', () => {
    expect(parse('x-[#linked]-> # note')).toEqual(parse('x-[#linked]->'));
    expect(parse('[x-[#linked]->, # note\n  y]')).toEqual(parse('[x-[#linked]->, y]'));
  });

  it("a comment inside a hop's config map is a comment", () => {
    expect(parse('x-[:a { limit: 1, # note\n  order: 2 }]->')).toEqual(parse('x-[:a { limit: 1, order: 2 }]->'));
  });

  it('a # inside a string is text', () => {
    expect(parseExpression('"a # b"')).toMatchObject({ kind: 'string' });
    expect(parseExpression("'a # b'")).toMatchObject({ kind: 'string' });
  });
});
