// The frozen conformance corpora build their expression contexts without a
// language version (they are transpiled, not type-checked, against an older
// tree). A corpus runs under one version, which the version setup makes the
// current one, so every evaluation a frozen test makes is handed that version
// here, as a saved movement's run would carry its pin.
import { CURRENT_LANGUAGE_VERSION } from 'movement-lang';

jest.mock('../services/movement_engine/rust_engine', () => {
  const actual = jest.requireActual('../services/movement_engine/rust_engine');
  return {
    ...actual,
    evalInRust: (expr: unknown, ctx: { languageVersion?: unknown }) =>
      actual.evalInRust(expr, ctx.languageVersion === undefined ? Object.assign(Object.create(ctx), { languageVersion: CURRENT_LANGUAGE_VERSION }) : ctx),
  };
});
