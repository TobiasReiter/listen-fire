# lfr-upgrade report

`lf-host upgrade [--check] [--all]` (crates/lf-host/src/upgrade.rs).

- Same loop as the shared TS upgrade loop: check under the project's version, take standing diagnostics' fixes (safe only, or all with `--all`), outermost first, skipping overlaps and duplicate fixes, apply by UTF-16 columns, repeat up to 16 passes. Output (unified diff for `--check`, remaining diagnostics, held-fix lines, summary) and exit code match apps/cli/src/upgrade.ts.
- Deviation from the brief's wording: lf has no pin to move (the pin is the engine in lf.yaml, already the current version), so nothing moves; TS lf does the same.
- Shared-file edits: main.rs only (mod line, `--check`/`--all` flags and Args fields, `"upgrade"` match arm, USAGE text, `upgrade` removed from NOT_YET). Cargo.toml untouched.
- Verification: cargo test (2 unit tests: diff, UTF-16 edit application), clippy -D warnings clean; apps/cli upgrade.test.ts + pins.test.ts pass under TS and under LF_BIN=lf-host (5/5 each); 5 hand-written v4 programs (non-ASCII, comments, nested/unsafe fixes, parse error, already clean) x {--check, default, --all}: TS and Rust stdout, exit code and resulting file bytes identical.
- Gap: no v4 .mvt files exist on disk (the corpus is embedded in test strings and the harvested pin holds no text), so the comparison used my own programs rather than harvested corpus ones.
