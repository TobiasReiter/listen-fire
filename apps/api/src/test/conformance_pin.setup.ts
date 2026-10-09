// The frozen conformance corpora build their expression contexts without a
// language version (they are transpiled, not type-checked, against an older
// tree). A corpus runs under one version, which the version setup makes the
// current one, so every evaluation a frozen test starts is handed that version
// here, as a saved movement's run would carry its pin. The injection sits at
// the evaluator's entry, which both engines share; nested evaluation reuses
// the context it was given.
import { CURRENT_LANGUAGE_VERSION } from 'movement-lang';

jest.mock('../services/movement_engine/expression', () => {
  const actual = jest.requireActual('../services/movement_engine/expression');
  const pinned = (ctx: { languageVersion?: unknown }) =>
    ctx.languageVersion === undefined ? { ...ctx, languageVersion: CURRENT_LANGUAGE_VERSION } : ctx;
  return {
    ...actual,
    evalMovementExpr: (expr: unknown, ctx: { languageVersion?: unknown }) => actual.evalMovementExpr(expr, pinned(ctx)),
    evaluateMovementExpression: (expr: unknown, ctx: { languageVersion?: unknown }) =>
      actual.evaluateMovementExpression(expr, pinned(ctx)),
  };
});
