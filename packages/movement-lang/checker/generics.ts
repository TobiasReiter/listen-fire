// A landing type that is GENERIC OVER ITS CONSTRUCTION SITE (asks-as-adapter
// layer 5, chunk B).
//
// Some edges promise a record whose shape the WRITE decides: an ask's
// `Response` lands an `Answer` typed by the very `Options` the ask offered, so
// `Choose` with `["Seed","Series A"]` answers an enum of those two, and nothing
// weaker is the truth. The TS analogue is a generic parameter inferred from an
// argument: `Response<T>` where `T` comes from the body.
//
// THE TYPE IS ITS DERIVATION. Two Choose asks offering the same options in the
// same order have the SAME response type, so the synthesized landing is keyed
// by an opaque token derived from (written type, edge, the authored literal
// values) — collisions are structural identity, not a hazard. The host derives
// the key when it registers the landing; the checker derives it when it looks
// one up; neither parses it. Exactly `refinementKey`'s contract, over a write
// body instead of a WHERE.
//
// The checker DECIDES nothing here: which body field parameterizes the landing
// is the adapter's own declaration (`EdgeSchema.genericOver`), and what the
// literals MEAN is the host's synthesis. The checker only agrees on a key.

import { BridgeError, parseMovementExpression } from '../expression/bridge';
import type { LanguageVersion } from '../language_version';

/**
 * THE IDENTITY of a construction-site landing — the key it lives under in
 * `InstanceSchema.genericLandings`.
 *
 * It is the edge's DECLARED target plus the authored values, and nothing else:
 * the specialization is of the base type, so two edges specializing the same
 * base with the same values name ONE type — structural identity, the same rule
 * that makes `unionKey` collapse two spellings of `A | B`. The written record
 * type is deliberately absent: it is already what fixes the base target.
 *
 * `values` is in AUTHORED order, deliberately: the values become an enum's
 * option list, and `fieldTypeEquals` compares enum options positionally, so a
 * reordered list IS a different type. Sorting here would make two distinct
 * types share one key.
 *
 * The `'generic-landing'` tag is what stops it colliding with the other opaque
 * keys sharing the `positions` namespace (a refinement, a union, an event
 * address).
 */
export function genericLandingKey(input: {
  /** The edge's DECLARED landing type — what this specializes. */
  target: string;
  /** The parameter's literal values, in authored order. */
  values: readonly string[];
}): string {
  return JSON.stringify(['generic-landing', input.target, [...input.values]]);
}

/** The author-facing NAME of a construction-site landing: TS's own notation for
 *  the thing it is, `Choose Response<Seed | Series A>`. Minted by the host when
 *  it grafts (the checker only ever looks the key up), and readable on purpose
 *  — a diagnostic naming this type should read like the type. Distinct values
 *  give distinct names, so the name collides exactly when the type does. */
export function genericLandingName(input: {
  target: string;
  values: readonly string[];
}): string {
  return `${input.target}<${input.values.join(' | ')}>`;
}

/**
 * The literal string value(s) a write-body slot carries — `"number"` as
 * `['number']`, `["Seed", "Series A"]` as both. Undefined for anything that is
 * not a compile-time literal (a property read, an `AI()`, an interpolation, a
 * list with one computed element), which is the honest "I can't see it" answer:
 * dynamic options are legitimate, and the landing simply stays the base type.
 *
 * Shared by the host pre-pass (reading the scanned write body) and the checker
 * (reading the same slot at the write site) so the two cannot disagree about
 * what a literal is.
 */
export function literalStringValuesOf(raw: string, options: { languageVersion: LanguageVersion }): string[] | undefined {
  let parsed;
  try {
    parsed = parseMovementExpression(raw, options.languageVersion);
  } catch (e) {
    if (e instanceof BridgeError) return undefined;
    throw e;
  }
  if (parsed.type === 'static') {
    return typeof parsed.value === 'string' ? [parsed.value] : undefined;
  }
  if (parsed.type !== 'list') return undefined;
  const values = parsed.elements.map((element) =>
    element.type === 'static' && typeof element.value === 'string' ? element.value : undefined,
  );
  return values.every((v): v is string => v !== undefined) ? values : undefined;
}
