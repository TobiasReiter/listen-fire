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
export const KNOWN_GAPS: readonly string[] = [];
