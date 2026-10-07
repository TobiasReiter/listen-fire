// The evaluator switch against the committed artifact: an expression the
// Rust engine runs comes back with the value, the provenance and the errors
// the TypeScript evaluator gives, and one it does not is left to TypeScript.
// The corpora prove the semantics; this pins the crossing itself.

import { parseMovementExpression } from 'movement-lang';

import { MovementEngineError } from '../errors';
import { Environment, evalMovementExpr, type Binding, type MovementExprContext } from '../expression';
import type { Provenance } from '../provenance';
import { evalInRust, rustCanEval } from '../rust_engine';
import { resetRustEvalStats, rustEvalStats } from '../rust_stats';

function contextOf(bindings: Record<string, unknown>, extra: Partial<MovementExprContext> = {}): MovementExprContext {
  const env = new Environment();
  for (const [name, value] of Object.entries(bindings)) env.declare(name, { kind: 'value', value });
  return { env, ...extra };
}

function inRust(text: string, ctx: MovementExprContext) {
  return evalInRust(parseMovementExpression(text), ctx);
}

/** Both evaluators, the TypeScript one forced. */
async function both(text: string, ctx: MovementExprContext) {
  const previous = process.env.MOVEMENT_ENGINE;
  process.env.MOVEMENT_ENGINE = 'ts';
  try {
    return { rust: inRust(text, ctx), ts: await evalMovementExpr(parseMovementExpression(text), ctx) };
  } finally {
    if (previous === undefined) delete process.env.MOVEMENT_ENGINE;
    else process.env.MOVEMENT_ENGINE = previous;
  }
}

describe('the Rust evaluator switch', () => {
  it('evaluates what it admits, value and provenance as TypeScript does', async () => {
    const trail: Provenance = { origins: [{ kind: 'meta', key: 'k' }], direct: { kind: 'meta', key: 'k' } };
    const env = new Environment();
    env.declare('x', { kind: 'value', value: 'Acme', provenance: trail });
    env.declare('n', { kind: 'value', value: 1_200_000 });
    const ctx: MovementExprContext = { env, literalSpan: { start: { line: 1, col: 1 }, end: { line: 1, col: 4 } } };
    for (const text of ['x', 'CONCAT("Re: ", x, " ", NUMBER.FORMAT(n, "compact"))', '"lit"', 'IF n > 1 THEN x ELSE "no" END', '-n % 7']) {
      const { rust, ts } = await both(text, ctx);
      expect(rust).toEqual(ts);
    }
    // A name hands its binding's own trail back, the very object.
    expect(inRust('x', ctx)?.provenance).toBe(trail);
    const literal = inRust('"lit"', ctx)?.provenance;
    expect(literal?.direct).toBe(literal?.origins[0]);
  });

  it('hands back the caller’s own objects, and keeps -0, NaN and undefined', () => {
    const d = { b: 1, a: [2] };
    const ctx = contextOf({ d, z: -0, u: undefined });
    expect(inRust('IF TRUE THEN d ELSE 0 END', ctx)?.value).toBe(d);
    expect(inRust('[d, d]', ctx)?.value).toEqual([d, d]);
    expect((inRust('[d, d]', ctx)?.value as unknown[])[1]).toBe(d);
    expect(Object.is(inRust('z', ctx)?.value, -0)).toBe(true);
    expect(inRust('-"x"', ctx)?.value).toBeNaN();
    expect(inRust('AT({ a: u }, "a")', ctx)?.value).toBeUndefined();
    expect(Object.keys(inRust('{ z: 1, ...d, "10": 2, "9": 3 }', ctx)?.value as object)).toEqual(['9', '10', 'z', 'b', 'a']);
  });

  it('throws what the TypeScript evaluator throws', () => {
    const ctx = contextOf({ m: 5, s: 'x' });
    expect(() => inRust('{ ...m }', ctx)).toThrow(MovementEngineError);
    expect(() => inRust('{ ...m }', ctx)).toThrow("MOVENG_UNSUPPORTED: copying the keys of a number into a map");
    expect(() => inRust('[...s]', ctx)).toThrow("MOVENG_RUNTIME: '...' splices a list's members into a list, and this value is not a list (string)");
    expect(() => inRust('DATE.ADD_DAYS("2026-01-01", 1000000000)', ctx)).toThrow(RangeError);
  });

  it('reads zones, URLs and Unicode through this runtime, as TypeScript does', async () => {
    const ctx = contextOf({}, {
      meta: {
        now: new Date('2026-03-12T23:30:00Z'),
        bag: {},
        resolveActingUser: async () => null,
        actingUserCache: {},
        actorCache: {},
      },
    });
    const { rust, ts } = await both('DATE.TODAY("Europe/Berlin")', ctx);
    expect(rust?.value).toBe('2026-03-13');
    expect(rust?.value).toBe(ts.value);
    expect(() => inRust('DATE.TODAY("Mars/Base")', ctx)).toThrow('DATE.TODAY(zone)');
    for (const text of [
      'DATETIME.AT(DATE.TODAY("Europe/Berlin"), "02:30", "Europe/Berlin")',
      'DATETIME.AT("2026-03-29", "02:30", "Europe/Berlin")',
      'URL.HOST("https://BÜCHER.de:8080/x")',
      'URL.HOST("http://127.1/")',
      'TEXT.SLUG("Café Ünïcode ﬁ ½")',
    ]) {
      const answered = await both(text, ctx);
      expect(answered.rust).toBeDefined();
      expect(answered.rust?.value).toEqual(answered.ts.value);
    }
  });

  it('leaves to TypeScript what it does not run', () => {
    const position: Binding = { kind: 'event' };
    const env = new Environment();
    env.declare('e', position);
    env.declare('when', { kind: 'value', value: new Date(0) });
    env.declare('t', { kind: 'value', value: '2026-03-12T09:30' });
    const ctx: MovementExprContext = { env };
    expect(rustCanEval(parseMovementExpression('@current_date'))).toBe(false);
    expect(rustCanEval({ type: 'static', value: '\uD800' })).toBe(false);
    expect(inRust('e == null', ctx)).toBeUndefined();
    expect(inRust('when', ctx)).toBeUndefined();
    expect(inRust('missing', ctx)).toBeUndefined();
    // A date-time with no offset is local time, which only V8 knows here.
    expect(inRust('DATE.FORMAT_ISO(t)', ctx)).toBeUndefined();
  });

  it('counts what it sent, what Rust answered and what came back, by reason', () => {
    resetRustEvalStats();
    const ctx = contextOf({ n: 2, t: '2026-03-12T09:30' });
    inRust('n + 1', ctx);
    inRust('DATE.FORMAT_ISO(t)', ctx);
    inRust('@current_date', ctx);
    expect(rustEvalStats).toEqual({
      notAdmitted: 1,
      admitted: 2,
      answered: 1,
      fallback: { 'V8 reads "2026-03-12T09:30" its own way': 1 },
    });
    resetRustEvalStats();
    expect(rustEvalStats).toEqual({ notAdmitted: 0, admitted: 0, answered: 0, fallback: {} });
  });
});
