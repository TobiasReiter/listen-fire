// The flat built-ins the evaluator applies (expression.ts `evalMovementExpr`'s
// function case): pure, argument for argument. Apart from the evaluator so the
// Rust engine's oracle (crates/movement-engine/tests/oracle/generate.ts) can
// call them without loading the evaluator's import graph.

import { coerceToDate, coerceToDatetime, coerceToNumber } from 'movement-lang';

import { MovementEngineError } from './errors';

/** Mirrors the frozen engine's `applyFunction` verbatim (minus `coalesce`,
 *  which the caller handles for its branch-selection provenance). */
export function applyMovementFunction(fn: string, args: unknown[]): unknown {
  switch (fn) {
    case 'isnull':
      return args[0] === null || args[0] === undefined;
    case 'trim':
      return args[0] === null || args[0] === undefined ? null : String(args[0]).trim();
    case 'lower':
      return args[0] === null || args[0] === undefined ? null : String(args[0]).toLowerCase();
    case 'upper':
      return args[0] === null || args[0] === undefined ? null : String(args[0]).toUpperCase();
    case 'length':
      if (args[0] === null || args[0] === undefined) return 0;
      if (Array.isArray(args[0])) return args[0].length;
      return String(args[0]).length;
    case 'abs':
      return Math.abs(Number(args[0]));
    case 'round':
      return Math.round(Number(args[0]));
    case 'floor':
      return Math.floor(Number(args[0]));
    case 'ceil':
      return Math.ceil(Number(args[0]));
    case 'tostring':
      return args[0] === null || args[0] === undefined ? null : String(args[0]);
    case 'tonumber': {
      const n = Number(args[0]);
      return Number.isNaN(n) ? null : n;
    }
    case 'date':
      return coerceToDate(args[0]);
    case 'datetime':
      return coerceToDatetime(args[0]);
    case 'number':
      return coerceToNumber(args[0]);
    case 'multi': {
      // MULTI(a, b, c) → flat array of non-null values; nested arrays
      // flatten one level (frozen semantics).
      const flat: unknown[] = [];
      for (const v of args) {
        if (v == null) continue;
        if (Array.isArray(v)) flat.push(...v.filter((x) => x != null));
        else flat.push(v);
      }
      return flat;
    }
    case 'split': {
      // SPLIT(str, sep) → trimmed, non-empty parts; sep defaults to ','.
      if (args[0] == null) return [];
      const sep = args[1] == null ? ',' : String(args[1]);
      return String(args[0])
        .split(sep)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
    default:
      throw new MovementEngineError('MOVENG_RUNTIME', `unknown built-in function: ${fn}`);
  }
}
