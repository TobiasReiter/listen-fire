// order_limit.json: what one hop asks its adapter for and what the engine
// keeps of the answer, written by the TypeScript's own helpers
// (packages/shared/expression/order_limit.ts `hopPushdown` and
// `applyHopOrderLimit`, filter.ts `pureLeafReads` / `replacePureLeaves`), which
// tests/order_limit_pin.rs holds crates/movement-engine/src/order_limit.rs to.
//
// Each case is a hop's bracket (a WHERE, an ORDER BY key and direction, a
// LIMIT, seeded), the leaves of its pushed WHERE that a scope substitutes
// (by position in `pureLeafReads` order, with the scalar each becomes — what
// expression.ts `closedHopPushdown` does with the values the scope holds), the
// pushdown's JSON text exactly as JSON.stringify writes it, and for an ordered
// hop the ORDER BY keys of seeded items and the indices the hop keeps, in
// order. Written by generate.ts; deterministic.

import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { parseMovementExpression } from '../../../../packages/movement-lang/expression/bridge';
import { pureLeafReads, replacePureLeaves } from '../../../../packages/shared/expression/filter';
import { applyHopOrderLimit, hopPushdown } from '../../../../packages/shared/expression/order_limit';
import type { EdgeStep, Expression } from '../../../../packages/shared/expression/types';

const FILTERS = [
  '',
  '`stage` == "Seed"',
  '`stage` == wanted',
  'c.`Flag` == true',
  '`revenue` > 10 AND `stage` != "Late"',
  '`stage` == "Seed" OR `revenue` >= n',
  'NOT (`name` CONTAINS "x")',
  '`name` IN ["Acme", wanted]',
  '`revenue` + 1 > n * 2',
  'IF `stage` == "Seed" THEN `revenue` ELSE 0 END > 5',
  'AT(`tags`, 0) == "a"',
  '"${`name`}!" == "Acme!"',
  '-`revenue` < 0',
  '`stage` == go.`Text`',
  '`when` <= @current_date',
  'TRIM(`name`) == "Acme"',
  'EXISTS(c-[:owner]->)',
  '`a` == 1 AND (`b` == 2 AND `c` == wanted)',
];
const KEYS = ['', '`revenue`', '`name`', 'c.`name`', 'c-[:owner]->.`joined`', 'UPPER(`name`)'];
const DIRECTIONS = ['', ' ASC', ' DESC'];
const LIMITS = ['', ' LIMIT 0', ' LIMIT 1', ' LIMIT 2', ' LIMIT 5'];

/** Scalars a scope may hold for a leaf; null is never substituted (a
 *  presence question is the engine's). */
const SCALARS: unknown[] = ['Globex', '', 3, 0, -2.5, true, false, 'Seed'];

/** ORDER BY keys of the kinds a record's field answers: numbers, texts
 *  (numeric ones too, whose text and numeric orders disagree), booleans,
 *  empties, lists. */
const KEY_POOL: unknown[] = [
  10, 30, 50, 20, 2, -1, 0, 1.5, 10, 'Acme', 'Globex', 'acme', '10', '9', '2', '', 'Ümlaut', 'Z', true, false, null, undefined,
  ['b', 'a'], ['a'], NaN, Infinity, -Infinity,
];

function wire(value: unknown): unknown {
  if (value === undefined) return ['u'];
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return ['n', 'NaN'];
    if (value === Infinity) return ['n', 'Infinity'];
    if (value === -Infinity) return ['n', '-Infinity'];
    if (Object.is(value, -0)) return ['n', '-0'];
    return value;
  }
  if (Array.isArray(value)) return ['l', 0, value.map(wire)];
  return value;
}

function edgeStep(hop: string): EdgeStep {
  const probed = parseMovementExpression(`graph${hop}.\`__movement_engine_probe__\``);
  if (probed.type !== 'traverse' || probed.steps.length !== 1) throw new Error(`not a one-hop walk: ${hop}`);
  const step = probed.steps[0];
  if (step.type !== 'edge') throw new Error(`not an edge hop: ${hop}`);
  return step;
}

export async function writeOrderLimitOracle(rand: () => number): Promise<void> {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
  const cases: unknown[] = [];
  const seen = new Set<string>();
  for (let attempt = 0; cases.length < 600 && attempt < 5000; attempt++) {
    const filter = pick(FILTERS);
    const key = pick(KEYS);
    const bracket =
      (filter !== '' ? ` WHERE ${filter}` : '') + (key !== '' ? ` ORDER BY ${key}${pick(DIRECTIONS)}` : '') + pick(LIMITS);
    const hop = `-[c:company${bracket}]->`;
    let step: EdgeStep;
    try {
      step = edgeStep(hop);
    } catch {
      continue;
    }
    const pushed = hopPushdown(step);
    // The leaves a scope stands values in for: each, by a coin.
    const leaves = pushed.where !== undefined ? pureLeafReads(pushed.where) : [];
    const subs: Array<[number, unknown]> = [];
    leaves.forEach((_, index) => {
      if (rand() < 0.4) subs.push([index, pick(SCALARS)]);
    });
    const replacements = new Map<Expression, Expression>();
    for (const [index, value] of subs) {
      replacements.set(leaves[index], { type: 'static', value: value as string | number | boolean });
    }
    const pushdown = pushed.where !== undefined && replacements.size > 0 ? { ...pushed, where: replacePureLeaves(pushed.where, replacements) } : pushed;
    const signature = `${hop}|${JSON.stringify(subs)}`;
    const ordered = step.cardinality?.orderBy !== undefined;
    // Several item sets per bracket; past 64 items, keys of one kind (a
    // total order, where every stable sort agrees with V8's).
    for (let set = 0; set < (ordered ? 4 : 1); set++) {
      const count = ordered ? (set === 3 ? 64 + Math.floor(rand() * 40) : Math.floor(rand() * 14)) : Math.floor(rand() * 8);
      const keys = Array.from({ length: count }, () => (set === 3 ? Math.floor(rand() * 50) : pick(KEY_POOL)));
      const items = keys.map((_, index) => index);
      const plan = await applyHopOrderLimit(items, step.cardinality, { value: async (index) => keys[index] });
      const id = `${signature}|${set}`;
      if (seen.has(id)) continue;
      seen.add(id);
      cases.push({
        hop,
        subs: subs.map(([index, value]) => [index, wire(value)]),
        pushdown: JSON.stringify(pushdown),
        ...(ordered ? { keys: keys.map(wire) } : {}),
        plan,
        ...(ordered ? {} : { count }),
      });
    }
  }
  writeFileSync(path.join(__dirname, 'order_limit.json'), `[\n${cases.map((c) => JSON.stringify(c)).join(',\n')}\n]\n`);
  console.log(`order_limit.json: ${cases.length} cases`);
}
