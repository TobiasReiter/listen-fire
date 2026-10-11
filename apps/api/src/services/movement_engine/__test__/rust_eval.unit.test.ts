// The evaluator switch against the committed artifact: an expression the
// Rust engine runs comes back with the value, the provenance and the errors
// the TypeScript evaluator gives, and one it does not is left to TypeScript.
// The corpora prove the semantics; this pins the crossing itself.

import { parseMovementExpression } from 'movement-lang';

import { MovementEngineError } from '../errors';
import { Environment, evalMovementExpr, type Binding, type MovementExprContext } from '../expression';
import type { Provenance } from '../provenance';
import { evalInRust, LOCAL_ZONE_UNVERIFIED, processLocalZone, rustCanEval } from '../rust_engine';
import { resetRustEvalStats, rustEvalStats } from '../rust_stats';

/** Every evaluation in a run carries the run's pin: version 3, which no
 *  expression here reads differently from version 4 (Luminous Owl changed
 *  matches, write handles and `@old`, none of which an expression alone holds). */
const PIN = 3;

function contextOf(bindings: Record<string, unknown>, extra: Partial<MovementExprContext> = {}): MovementExprContext {
  const env = new Environment();
  for (const [name, value] of Object.entries(bindings)) env.declare(name, { kind: 'value', value });
  return { env, languageVersion: PIN, ...extra };
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
    const ctx: MovementExprContext = { env, languageVersion: PIN, literalSpan: { start: { line: 1, col: 1 }, end: { line: 1, col: 4 } } };
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
    env.declare('s', { kind: 'value', value: 'x😀y' });
    const ctx: MovementExprContext = { env, languageVersion: PIN };
    expect(rustCanEval(parseMovementExpression('@current_date'))).toBe(false);
    expect(rustCanEval({ type: 'static', value: '\uD800' })).toBe(false);
    expect(inRust('e == null', ctx)).toBeUndefined();
    expect(inRust('when', ctx)).toBeUndefined();
    expect(inRust('missing', ctx)).toBeUndefined();
    // Astral text split into UTF-16 halves, which no Rust string holds.
    expect(inRust('SPLIT(s, "")', ctx)).toBeUndefined();
  });

  // Jest hands each suite a copy of the environment, so assigning `TZ` here
  // moves no clock: these two run in the zone the process started in, and
  // local_zone_matrix.unit.test.ts starts them under each zone of its own.
  it("reads a date text as this process's Date reads it, in this process's zone", async () => {
    const named = processLocalZone();
    expectZoneStanding(named);
    if (named === undefined) return;
    // The zone the shim hands the engine is the one `Date` reads in: the
    // same wall clock, to the second (local mean time included).
    for (const instant of ['2026-01-15T12:00:00Z', '2026-07-15T12:00:00Z', '2011-12-30T12:00:00Z', '1850-01-01T00:00:00Z']) {
      const at = new Date(instant);
      const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', { timeZone: named, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
          .formatToParts(at)
          .map((part) => [part.type, Number(part.value)]),
      );
      expect([instant, parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second]).toEqual([
        instant, at.getFullYear(), at.getMonth() + 1, at.getDate(), at.getHours(), at.getMinutes(), at.getSeconds(),
      ]);
    }
    const texts = [
      '2026-03-12T09:30', '2026-03-08T02:30', '2026-11-01T01:30', '2026-03-29T01:30', '2011-12-30T12:00', 'March 12, 2026 9:30 PM',
      '3/4', 'Thu, 12 Mar 2026 09:30:00 GMT+0530', '2026-03-12', 'nonsense',
    ];
    for (const [i, t] of texts.entries()) {
      const ctx = contextOf({ t, u: texts[(i + 1) % texts.length] });
      for (const text of ['DATETIME(t)', 'DATE.FORMAT(t, "YYYY-MM-DD HH:mm")', 't < u']) {
        const { rust, ts } = await both(text, ctx);
        expect(rust).toBeDefined();
        expect([named, t, text, rust?.value]).toEqual([named, t, text, ts.value]);
      }
    }
  });

  it("hands a date text back to TypeScript, by name, when Intl cannot name the zone Date reads in, in this process's zone", async () => {
    expectZoneStanding(processLocalZone());
    if (processLocalZone() !== undefined) return;
    resetRustEvalStats();
    try {
      const { rust, ts } = await both('DATETIME(t)', contextOf({ t: '2026-03-08T02:30' }));
      expect(rust).toBeUndefined();
      expect(ts.value).toBe(new Date('2026-03-08T02:30').toISOString());
      expect(rustEvalStats.fallback).toEqual({ [LOCAL_ZONE_UNVERIFIED]: 1 });
    } finally {
      resetRustEvalStats();
    }
  });

  it('counts what it sent, what Rust answered and what came back, by reason', () => {
    resetRustEvalStats();
    const ctx = contextOf({ n: 2, s: 'x😀y' });
    inRust('n + 1', ctx);
    inRust('SPLIT(s, "")', ctx);
    inRust('@current_date', ctx);
    expect(rustEvalStats).toEqual({
      notAdmitted: 1,
      admitted: 2,
      answered: 1,
      fallback: { 'splitting astral characters into UTF-16 halves': 1 },
    });
    resetRustEvalStats();
    expect(rustEvalStats).toEqual({ notAdmitted: 0, admitted: 0, answered: 0, fallback: {} });
  });
});

/** Under local_zone_matrix, which starts this suite with a `TZ` it knows the
 *  standing of: whether the shim names the zone. */
function expectZoneStanding(named: string | undefined): void {
  const expected = process.env.EXPECT_LOCAL_ZONE;
  if (expected !== undefined) expect([process.env.TZ, named === undefined ? 'unverified' : 'named']).toEqual([process.env.TZ, expected]);
}
