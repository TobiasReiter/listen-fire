// Object literals in movement expression slots.
//
// The literal is the shared formula grammar's (@listen-fire/shared/expression), so
// what this file pins is the movement side of it:
//
//   1. The BRIDGE's text-level rewrites — interpolated strings, prefix
//      EXISTS, namespaced stdlib calls — reach into and out of object values
//      unharmed, and its depth splitters never split inside a literal.
//   2. The STATEMENT parser keeps the two brace grammars apart: a write
//      body's `}` closes the body, an object literal's `}` does not, so a
//      field value may be a multi-line object with nested braces and commas.
//   3. The CHECKER walks object values (a name inside one still resolves,
//      or is reported).

import { objectMemberExpression } from '@listen-fire/shared/expression/types';
import { parseProgram } from '../../parser/parse';
import { checkProgram, DiagnosticCodes as C } from '../../checker/check';
import { mockCatalog } from '../../checker/catalog';
import { parseMovementCondition, parseMovementExpression, splitUniquenessConjuncts } from '../bridge';

describe('bridge — object literals in an expression slot', () => {
  it('parses to the object node with entries in author order', () => {
    expect(parseMovementExpression('{ type: "section", block_id: "b1" }')).toEqual({
      type: 'object',
      entries: [
        { key: 'type', value: { type: 'static', value: 'section' } },
        { key: 'block_id', value: { type: 'static', value: 'b1' } },
      ],
    });
  });

  it('desugars an interpolated string inside an object value', () => {
    expect(parseMovementExpression('{ text: "Deal ${msg.`subject`} closed" }')).toEqual({
      type: 'object',
      entries: [
        {
          key: 'text',
          value: {
            type: 'concat',
            parts: [
              { type: 'static', value: 'Deal ' },
              {
                type: 'traverse',
                aliasRoot: 'msg',
                steps: [],
                expression: { type: 'property', propertyTypeId: 'subject' },
              },
              { type: 'static', value: ' closed' },
            ],
          },
        },
      ],
    });
  });

  it('lifts a prefix EXISTS(…) inside an object value and splices it back', () => {
    const expr = parseMovementExpression('{ has_files: EXISTS(msg-[:files]->) }');
    if (expr.type !== 'object') throw new Error(`expected object, got ${expr.type}`);
    expect(expr.entries[0]).toEqual({
      key: 'has_files',
      value: {
        type: 'traverse',
        aliasRoot: 'msg',
        steps: [],
        expression: { type: 'exists', steps: [{ type: 'edge', edgeTypeId: 'files', direction: 'outgoing' }] },
      },
    });
  });

  it('folds a namespaced stdlib call inside an object value', () => {
    const expr = parseMovementExpression('{ amount: CURRENCY.GET_NUMBER_FROM_FIGURE("£1.2m") }');
    if (expr.type !== 'object') throw new Error(`expected object, got ${expr.type}`);
    expect(expr.entries[0]).toEqual({
      key: 'amount',
      value: {
        type: 'function',
        fn: 'currency.get_number_from_figure',
        args: [{ type: 'static', value: '£1.2m' }],
      },
    });
  });

  it('keeps a spread among the entries, in the order written', () => {
    const expr = parseMovementExpression('{ ...base, k: 1, ...more }');
    if (expr.type !== 'object') throw new Error(`expected object, got ${expr.type}`);
    expect(expr.entries).toEqual([
      { type: 'spread', expression: { type: 'property', propertyTypeId: 'base' } },
      { key: 'k', value: { type: 'static', value: 1 } },
      { type: 'spread', expression: { type: 'property', propertyTypeId: 'more' } },
    ]);
  });

  it('composes with list literals to a Block Kit shape', () => {
    const expr = parseMovementExpression(
      '[{ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Approve" } }] }]',
    );
    if (expr.type !== 'list') throw new Error(`expected list, got ${expr.type}`);
    const block = expr.elements[0];
    if (block.type !== 'object') throw new Error(`expected object, got ${block.type}`);
    const elements = objectMemberExpression(block.entries[1]);
    if (elements.type !== 'list') throw new Error(`expected list, got ${elements.type}`);
    expect(elements.elements[0].type).toBe('object');
  });

  it('reaches inside a hop WHERE — the bracket grammar does not claim the braces', () => {
    // A `{ … }` inside a traversal bracket is the meta-edge CONFIG object, but a
    // WHERE's own text is parsed by the sub-parser, so a literal survives there.
    const expr = parseMovementExpression('msg-[:files WHERE `meta` == { a: 1 }]->.`name`');
    if (expr.type !== 'traverse') throw new Error(`expected traverse, got ${expr.type}`);
    const hop = expr.steps[0];
    if (hop.type !== 'edge' || hop.expressionFilter?.type !== 'compare') {
      throw new Error('expected an edge hop carrying a comparison filter');
    }
    expect(hop.expressionFilter.right).toEqual({
      type: 'object',
      entries: [{ key: 'a', value: { type: 'static', value: 1 } }],
    });
  });

  it('a comma or AND inside an object literal is never a top-level separator', () => {
    // `unique by (…)` splits on the top-level comma; the object's own commas
    // sit at brace depth and must not split it into components.
    expect(splitUniquenessConjuncts('{ a: 1, b: 2 }').map((c) => c.raw)).toEqual([
      '{ a: 1, b: 2 }',
    ]);
    // A condition splits on the top-level AND — one inside a literal is a value.
    const condition = parseMovementCondition('{ flag: TRUE AND FALSE }');
    expect(condition.kind).toBe('expr');
  });
});

describe('statement parser — a write body vs an object literal', () => {
  const PRELUDE = [
    'import { email, slack } from adapters',
    'import { dealflow_inbox, acme_workspace } from credentials',
    '',
    'inbox = email(credentials: dealflow_inbox)',
    'team  = slack(credentials: acme_workspace)',
  ].join('\n');

  const writeFields = (body: string) => {
    const program = parseProgram(`${PRELUDE}\nmovement m(msg: <inbox-[:message]->>) {\n${body}\n}`);
    const movement = program.statements.find((s) => s.kind === 'movement');
    if (movement?.kind !== 'movement') throw new Error('expected a movement');
    const statement = movement.body[0];
    if (statement.kind !== 'write') throw new Error(`expected a write, got ${statement.kind}`);
    return statement.write.fields;
  };

  it('captures a multi-line object literal as ONE field value, and keeps the next field', () => {
    const fields = writeFields(
      [
        '  write team-[:message]-> {',
        '    channel: "#dealflow"',
        '    blocks: [',
        '      {',
        '        type: "section",',
        '        text: { type: "mrkdwn", text: "*Deal*, closed" }',
        '      }',
        '    ]',
        '    text: "fallback"',
        '  }',
      ].join('\n'),
    );
    expect(fields.map((f) => f.name)).toEqual(['channel', 'blocks', 'text']);
    const blocks = fields[1].value.raw;
    expect(blocks.startsWith('[')).toBe(true);
    expect(blocks.endsWith(']')).toBe(true);
    // The captured slot bridges as one expression — a list of one object.
    const expr = parseMovementExpression(blocks);
    if (expr.type !== 'list') throw new Error(`expected list, got ${expr.type}`);
    expect(expr.elements).toHaveLength(1);
    expect(expr.elements[0].type).toBe('object');
  });

  it("a `#` inside an object literal's string is text, not a comment", () => {
    const fields = writeFields('  write team-[:message]-> { blocks: { text: "#dealflow" } }');
    expect(parseMovementExpression(fields[0].value.raw)).toEqual({
      type: 'object',
      entries: [{ key: 'text', value: { type: 'static', value: '#dealflow' } }],
    });
  });

  it('an object literal left open to EOF is a loud unbalanced-brace error', () => {
    expect(() =>
      parseProgram(
        `${PRELUDE}\nmovement m(msg: <inbox-[:message]->>) {\n  write team-[:message]-> { blocks: { text: "x"`,
      ),
    ).toThrow(/Unbalanced '\{' — no matching '\}' before end of file/);
  });

  it('a brace the object literal swallowed is reported by the block it belonged to', () => {
    // One `}` short: the field value's literal closes, the write body claims
    // the movement's own closer, and the movement reports the shortfall.
    expect(() =>
      parseProgram(
        `${PRELUDE}\nmovement m(msg: <inbox-[:message]->>) {\n  write team-[:message]-> { blocks: { text: "x" }\n}`,
      ),
    ).toThrow(/Expected '\}' to close the movement 'm'/);
  });
});

describe('checker — names inside object values', () => {
  const catalog = mockCatalog({
    adapters: {
      email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], triggerConfig: ['key'] },
      slack: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }] },
    },
    credentials: {
      dealflow_inbox: { adapter: 'email' },
      acme_workspace: { adapter: 'slack' },
    },
  });

  const inMovement = (body: string) =>
    [
      'import { email, slack } from adapters',
      'import { dealflow_inbox, acme_workspace } from credentials',
      '',
      'inbox = email(credentials: dealflow_inbox)',
      'team  = slack(credentials: acme_workspace)',
      '',
      'movement m(msg: <inbox-[:message]->>) {',
      body,
      '}',
    ].join('\n');

  const errorCodes = (source: string): string[] =>
    checkProgram(parseProgram(source), catalog)
      .filter((d) => (d.severity ?? 'error') === 'error')
      .map((d) => d.code);

  it('reports an unresolved name that only appears inside an object value', () => {
    expect(
      errorCodes(inMovement('  write team-[:message]-> { blocks: { text: nowhere } }')),
    ).toContain(C.NAME_UNRESOLVED);
  });

  it('accepts a bound name read inside an object value', () => {
    expect(
      errorCodes(
        inMovement(
          [
            '  greeting = "hi"',
            '  write team-[:message]-> { blocks: { text: greeting, sub: msg.`subject` } }',
          ].join('\n'),
        ),
      ),
    ).toEqual([]);
  });
});
