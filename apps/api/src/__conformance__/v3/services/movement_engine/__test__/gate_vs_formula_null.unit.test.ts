// A gate and a formula that ask the SAME question must answer it the same way.
//
// The shape that burned us: an extract emitted an entity whose `name` came back
// null. A statement gate `f.name != null` and, inside the guarded write, a
// value-level `IF` re-testing the same fact took two different paths through two
// evaluators (the condition parser's conjunct split vs. the expression bridge).
// If they ever disagree, a movement either sends a message it gated against or
// gates away one it should have sent. This pins the agreement over the null case
// — and, for contrast, over the non-null one.

import { Environment, evalMovementExpr } from '../expression';
import type { ExtractEmission } from '../extraction';
import { parseMovementCondition, parseMovementExpression } from 'movement-lang';

function emission(fields: Record<string, unknown>): ExtractEmission {
  return {
    nodeName: 'Founder',
    fields,
    provenance: {},
    resources: [],
    children: new Map(),
  };
}

/** `f` bound to one extracted entity, plus the scalar the message interpolates. */
function envFor(name: string | null): Environment {
  const env = new Environment();
  env.declare('f', {
    kind: 'extractPosition',
    emission: emission({ name, is_raising: true }),
  });
  env.declare('requested_partner_name', { kind: 'value', value: 'Ramzi' });
  return env;
}

/** The engine's gate path: parse as a CONDITION, evaluate its expression
 *  conjunct, coerce to a boolean — `evaluateParsedCondition`'s 'expr' branch. */
async function gate(raw: string, env: Environment): Promise<boolean> {
  const condition = parseMovementCondition(raw);
  if (condition.kind !== 'expr') {
    throw new Error(`expected a plain expression condition, got '${condition.kind}'`);
  }
  return Boolean((await evalMovementExpr(condition.expr, { env })).value);
}

/** The formula path: the same text as a field EXPRESSION. */
async function formula(raw: string, env: Environment): Promise<unknown> {
  return (await evalMovementExpr(parseMovementExpression(raw), { env })).value;
}

const GATE = 'f.`name` != NULL';
const MESSAGE =
  'IF (f.`name` != NULL AND f.`is_raising` == TRUE AND EXISTS(requested_partner_name))' +
  ' THEN "Intro to ${requested_partner_name} (${f.`name`})" ELSE "" END';

describe('a null extracted field: gate and formula agree', () => {
  it('the gate is false when the extracted name came back null', async () => {
    await expect(gate(GATE, envFor(null))).resolves.toBe(false);
  });

  it('the formula takes the ELSE branch on the same emission', async () => {
    await expect(formula(MESSAGE, envFor(null))).resolves.toBe('');
  });

  it('with a name present, both take the positive branch', async () => {
    await expect(gate(GATE, envFor('Dana'))).resolves.toBe(true);
    const text = await formula(MESSAGE, envFor('Dana'));
    expect(text).toBe('Intro to Ramzi (Dana)');
  });
});

// `EXISTS(f.`name`)` — the same question in the third spelling. It reaches the
// engine as the comparison it means, so there is no second presence evaluator
// to disagree with the first; this pins that it answers identically on both
// paths, for a field that is there and one that is not.
describe('EXISTS over a dotted read asks the same question as `!= NULL`', () => {
  const DOTTED = 'EXISTS(f.`name`)';

  it('false on the absent field, on both paths', async () => {
    await expect(gate(DOTTED, envFor(null))).resolves.toBe(false);
    await expect(formula(DOTTED, envFor(null))).resolves.toBe(false);
  });

  it('true on the present one, on both paths', async () => {
    await expect(gate(DOTTED, envFor('Dana'))).resolves.toBe(true);
    await expect(formula(DOTTED, envFor('Dana'))).resolves.toBe(true);
  });

  it('agrees with the comparison spelling case for case', async () => {
    for (const name of [null, 'Dana'] as const) {
      expect(await gate(DOTTED, envFor(name))).toBe(await gate(GATE, envFor(name)));
    }
  });
});
