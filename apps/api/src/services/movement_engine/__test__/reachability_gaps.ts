// The reachability gaps still open: a checked-clean version-5 program the
// Rust engine refuses by construct. One list, read by the reachability test
// (reachability.unit.test.ts), which fails on a gap not listed and on a
// listed gap nothing reaches, and by the patterns oracle
// (crates/movement-engine/tests/oracle/patterns_oracle.ts), which records a
// program refused so only where its gap is listed here.

/** A gap's reason with the names it quotes masked, so one construct is one
 *  entry however many programs reach it. */
export const reasonOf = (gap: string) => gap.replace(/'[^']*'/g, "'…'").slice(0, 90);

/**
 * The gaps the reachability test found when it was written (2026-10-16), each still
 * open: a checked-clean version-5 program the Rust engine refuses. Each is a
 * checker refusal or an engine port still to make; closing one removes its
 * line here, and a gap not listed fails that test. A listed gap no program
 * reaches any more fails it too, so the list stays the inventory.
 */
export const KNOWN_GAPS: readonly string[] = [
  // Engine ports: the language says these run.
  "MOVENG_UNSUPPORTED: traversing from a value binding ('…') is not supported by the movement",
  "MOVENG_UNSUPPORTED: traversing inside EXISTS() from '…', which holds nothing rather than a",
  "MOVENG_UNSUPPORTED: traversing inside EXISTS() from '…', which holds a list that is not al",
  "MOVENG_UNSUPPORTED: await '…' is not supported by the movement engine yet (await needs a w",
  "MOVENG_UNSUPPORTED: the expression kind '…' is not supported by the movement engine yet",
  "MOVENG_UNSUPPORTED: reading '…' (a deferred traversal) as a bare value is not supported by",
  "MOVENG_UNSUPPORTED: reading '…' (the movement parameter (the event position)) as a bare va",
  "MOVENG_UNSUPPORTED: handing a record held as a value (a write handle) to the host is not s",
  // Checker refusals still to add: forms the engine does not run.
  "MOVENG_UNSUPPORTED: multi-hop linked writes is not supported by the movement engine yet (a",
  "MOVENG_UNSUPPORTED: rootless EXISTS() is not supported by the movement engine yet (root th",
  "MOVENG_UNSUPPORTED: rootless block heads (relative traversal) is not supported by the move",
  "MOVENG_UNSUPPORTED: unique by on a shape write is not supported by the movement engine yet",
  // What the host answers decides these; each should end as the host's
  // runtime failure, not a refusal by construct.
  "MOVENG_UNSUPPORTED: await '…' on '…' is not supported by the movement engine yet (the '…' ",
  "MOVENG_UNSUPPORTED: the function DOMAIN_OF() is not supported by the movement engine yet (",
  "MOVENG_RUNTIME: '…' reads a collection of values and got nothing — the checker should have",
];
