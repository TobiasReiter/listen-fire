// Every expression text the corpora produce (v1, v2 and the current tests —
// see ../harvest), plus hand-written texts for what the corpora never write,
// lowers exactly as pinned in __fixtures__/expression_slots.lowered.json. The
// pins were recorded from the old text-rewriting bridge; an entry changes only
// with a ruling, and each ruling so far is spelled out below.
//
// Set UPDATE_LOWERED_FIXTURE=1 to rewrite the pins from the current lowering
// (after a re-harvest, or a ruling) — then read the diff: every changed entry
// must be one a ruling explains.
import type { Expression } from '@listen-fire/shared/expression/types';
import { POSITION_SENTINEL, type MovementCondition } from '../lower';
import { parseMovementCondition, parseMovementExpression } from '../../../expression/bridge';
import { BridgeError } from '../../../expression/error';
import {
  CONSTRUCTS,
  LOWERED,
  canonical,
  corpusCases,
  lowerNow,
  parseConstructs,
  type Lowered,
} from './lowering_fixture';

declare function require(id: string): unknown;
declare const process: { env: Record<string, string | undefined> };
declare const __dirname: string;

const key = (c: { raw: string; mode: string }) => `${c.mode}\u0000${c.raw}`;

describe('lowering regression', () => {
  if (process.env.UPDATE_LOWERED_FIXTURE) {
    const fs = require('fs') as { writeFileSync(path: string, data: string): void };
    const rows: Lowered[] = [
      ...corpusCases().map(c => lowerNow(c.raw, c.mode, 'corpus')),
      ...LOWERED.filter(l => l.source === 'synthetic').map(l => lowerNow(l.raw, l.mode, 'synthetic')),
    ].filter((row, i, all) => all.findIndex(r => key(r) === key(row)) === i);
    fs.writeFileSync(
      `${__dirname}/__fixtures__/expression_slots.lowered.json`,
      `[${rows.map(r => JSON.stringify(r)).join(',\n')}]\n`,
    );
  }

  it('pins every corpus text', () => {
    const pinned = new Set(LOWERED.filter(l => l.source === 'corpus').map(key));
    const cases = corpusCases();
    expect(cases.length).toBeGreaterThan(2000);
    expect(cases.filter(c => !pinned.has(key(c))).map(c => `${c.mode}: ${c.raw}`)).toEqual([]);
  });

  it('lowers every pinned text exactly as pinned', () => {
    const drifted = LOWERED.filter(pin => canonical(lowerNow(pin.raw, pin.mode, pin.source)) !== canonical(pin));
    expect(drifted.map(pin => `${pin.mode}: ${pin.raw}`)).toEqual([]);
  });

  it('parses every closure, node and graph literal and node declaration the corpora write', () => {
    const failures = parseConstructs().filter(c => !c.result.ok || c.result.kind !== CONSTRUCTS[c.construct]);
    expect(failures.map(c => `${c.construct}: ${c.result.ok ? c.result.kind : c.result.message}\n${c.raw}`)).toEqual([]);
  });
});

// The old bridge's defects, fixed under every language version (rulings after
// step 1 of plans/functional-extract-2026-10-02/2_one_grammar.md).
describe('ruled fixes', () => {
  const prop = (name: string): Expression => ({ type: 'property', propertyTypeId: name });
  const exprConjunct = (c: MovementCondition): Expression => {
    if (c.kind !== 'expr') throw new Error(`expected an expression conjunct, got ${c.kind}`);
    return c.expr;
  };

  it('a condition keeps AND binding tighter than OR: `a OR b AND c` is a OR (b AND c)', () => {
    // The bridge split a condition on every top-level AND before parsing, so
    // this ran as (a OR b) AND c.
    expect(parseMovementCondition('a OR b AND c')).toEqual({
      kind: 'expr',
      expr: {
        type: 'logical',
        op: 'or',
        operands: [prop('a'), { type: 'logical', op: 'and', operands: [prop('b'), prop('c')] }],
      },
    });
    expect(exprConjunct(parseMovementCondition('a OR b AND c'))).toEqual(parseMovementExpression('a OR b AND c'));
  });

  it('a condition still splits on its top-level ANDs', () => {
    const condition = parseMovementCondition('rec IS <crm-[:company]->> AND x == 1');
    expect(condition.kind).toBe('and');
  });

  it('an IF … AND … END in a condition reads whole', () => {
    // The same split cut the IF in half, and the condition was refused.
    const expr = exprConjunct(parseMovementCondition('IF a AND b THEN 1 ELSE 0 END == 1'));
    expect(expr).toEqual({
      type: 'compare',
      op: 'eq',
      left: {
        type: 'conditional',
        condition: { type: 'logical', op: 'and', operands: [prop('a'), prop('b')] },
        then: { type: 'static', value: 1 },
        else: { type: 'static', value: 0 },
      },
      right: { type: 'static', value: 1 },
    });
  });

  it("an interpolation inside EXISTS(…)'s walk is read, not left as a placeholder", () => {
    expect(parseMovementExpression('EXISTS(-[:a WHERE n == "${x}"]->)')).toEqual({
      type: 'exists',
      steps: [
        {
          type: 'edge',
          edgeTypeId: 'a',
          direction: 'outgoing',
          expressionFilter: {
            type: 'compare',
            op: 'eq',
            left: { type: 'edge_property', propertyTypeId: 'n' },
            right: { type: 'concat', parts: [prop('x')] },
          },
        },
      ],
    });
  });

  it("an EXISTS nested in EXISTS(…)'s walk is read, not left as a placeholder", () => {
    expect(parseMovementExpression('EXISTS(-[y:a WHERE EXISTS(y-[:r]->)]->)')).toEqual({
      type: 'exists',
      steps: [
        {
          type: 'edge',
          edgeTypeId: 'a',
          direction: 'outgoing',
          alias: 'y',
          expressionFilter: {
            type: 'traverse',
            aliasRoot: 'y',
            steps: [],
            expression: { type: 'exists', steps: [{ type: 'edge', edgeTypeId: 'r', direction: 'outgoing' }] },
          },
        },
      ],
    });
  });

  it('an empty hop WHERE is refused, saying what to write', () => {
    // The formula grammar read it as no filter at all.
    expect(() => parseMovementExpression('crm-[c:companies WHERE ]->.x')).toThrow(BridgeError);
    expect(() => parseMovementExpression('crm-[c:companies WHERE ]->')).toThrow(
      /a hop's WHERE needs a condition — write one after WHERE, or drop the WHERE/,
    );
    expect(() => parseMovementCondition('EXISTS(c-[m:Messages WHERE\n]->)')).toThrow(/WHERE needs a condition/);
  });

  describe('a bare walk is the records it lands on wherever a value goes', () => {
    const landings = (root: string, edge: string): Expression => ({
      type: 'traverse',
      aliasRoot: root,
      steps: [{ type: 'edge', edgeTypeId: edge, direction: 'outgoing' }],
      expression: prop(POSITION_SENTINEL),
    });

    it('as the whole expression, as before', () => {
      expect(parseMovementExpression('x-[:a]->')).toEqual(landings('x', 'a'));
    });

    it('as an argument of any call, not only an upper-case aggregate', () => {
      expect(parseMovementExpression('CONCAT(x-[:a]->)')).toEqual({ type: 'concat', parts: [landings('x', 'a')] });
      expect(parseMovementExpression('count(x-[:a]->)')).toEqual({
        type: 'aggregate',
        fn: 'count',
        expression: landings('x', 'a'),
      });
      expect(parseMovementExpression('COALESCE(x-[:a]->, [])')).toEqual({
        type: 'function',
        fn: 'coalesce',
        args: [landings('x', 'a'), { type: 'list', elements: [] }],
      });
    });

    it('as an operand and a list member', () => {
      expect(parseMovementExpression('[x-[:a]->]')).toEqual({ type: 'list', elements: [landings('x', 'a')] });
      expect(parseMovementExpression('x-[:a]-> == y')).toEqual({
        type: 'compare',
        op: 'eq',
        left: landings('x', 'a'),
        right: prop('y'),
      });
    });

    it('EXISTS(walk) stays a test that it lands anywhere, and walk.field a field read', () => {
      expect(parseMovementExpression('EXISTS(x-[:a]->)')).toEqual({
        type: 'traverse',
        aliasRoot: 'x',
        steps: [],
        expression: { type: 'exists', steps: [{ type: 'edge', edgeTypeId: 'a', direction: 'outgoing' }] },
      });
      expect(parseMovementExpression('CONCAT(x-[:a]->.b)')).toEqual({
        type: 'concat',
        parts: [
          {
            type: 'traverse',
            aliasRoot: 'x',
            steps: [{ type: 'edge', edgeTypeId: 'a', direction: 'outgoing' }],
            expression: prop('b'),
          },
        ],
      });
    });

    it('a walk ending in an incoming hop still needs a field read', () => {
      expect(() => parseMovementExpression('CONCAT(x<-[:a]-)')).toThrow(/ends in '\]->'/);
    });
  });
});
