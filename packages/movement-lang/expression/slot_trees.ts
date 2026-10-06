// Each slot's parsed tree (or its syntax error), kept beside the slot rather
// than on it, so the AST a caller gets is exactly the statement layer's
// `{raw, span}`. The bridge fills it lazily; the parser wrappers fill it up
// front from the trees the Rust parser hands back with the program.

import type { ExprSlot } from '../parser/ast';
import type { MExpr } from '../parser/expression/tree';
import type { ExpressionSyntaxError } from './error';

export const slotTrees = new WeakMap<ExprSlot, MExpr | ExpressionSyntaxError>();
