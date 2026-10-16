// The expression grammar's entry point. The grammar is the Rust parser's
// (crates/movement-parser/src/expr.rs), loaded as WebAssembly; it builds the
// structured tree in ./tree.ts. ./lower.ts converts the tree to the shared
// `Expression`, and expression/bridge.ts is the entry the statement parser's
// consumers (checker, story, engine) call.
//
// Nothing here knows what a name means. `COUNT(x)`, `EXISTS(p)` and
// `CURRENCY.PARSE(s)` are calls; which built-in (if any) a call reaches is
// decided by whoever has a scope.

import { rustParseExpression } from '../rust_parser';
import type { MExpr } from './tree';

export { ExpressionSyntaxError } from '../../expression/error';

/** Parse one expression slot. Throws `ExpressionSyntaxError`.
 *  `languageVersion`: a text that is part of a program, read under that
 *  program's version (`rustParseExpression`). */
export function parseExpression(source: string, languageVersion?: number): MExpr {
  return rustParseExpression(source, languageVersion);
}
