# v5i3-checker report

Branch `v5i3-checker`, from `e46730ca`. All six items are done, each in its own commit, with tests in both checkers.

## Read

- **Parity is no worse.** Before: 246 of 253 codes at parity, 1 extra in Rust, 46,676 of 46,749 records exact. After: 247 of 254 codes, the same 1 extra, the same 46,676 exact.
  - The one code added is the new upgrade warning. It matches on all 231 diagnostics.
  - The extra left over is not the `sort(…)[0]` one. It is a `MOV_V5_SPELLING` about a field read in a walk (`le.cutof`), which belongs to the parity agent.
- **Decision 1 (item e).** A plugin that only an extraction fed used to be told "write it as a stage: `extract from […] through [p] { … }`". Version 5 retires that form. It is now told to call the plugin like any other: `out = p(…)`.
  - This assumes the sibling v5i3-plugins makes such plugins callable as functions.
  - The plugin-call messages at check.ts ~15521 and ~15554 still suggest `through […]`. That is v5i3-plugins' area, so I left them.
- **Decision 2 (item c).** The upgrade corpus floor moves from 0.868 to 0.865.
  - The new warning keeps 104 version 4 programs from upgrading clean. A person has to decide each one.
  - I sampled them. They are real cases: a graph literal's `entries ORDER BY name`, and a node literal's walk entry with `LIMIT 3`.
- **For the controller:** the `checks_regression` fixture (checks.json) needs a harvest. On the base it already differed in 1,458 lines; now it differs in 1,691. The new lines are this branch's intended changes: the new warning, the reworded `#` hop messages, and the number and true/false field reads.

## Items

**a. The checkers re-read slot text under the program's pinned version.** (`65ed46d5`)
- Cause: in the TypeScript checker, a slot without its cached parse was read with the version 1–4 grammar.
- Fixed in: check.ts (every slot reader, plus five helper functions that now take the version), the plugin-argument binder (catalog.ts; its two engine callers pass the run's version), the generic-landing literal reader (generics.ts), the chain scan (selectors.ts), completions and hover (service.ts), and the story (story.ts).
- The host's generic-landing pass now reads each write body under its own file's pin, so it derives the same key as the checker (apps/api catalog.ts, generic_landings.ts).
- The Rust checker already ran every re-read inside the check's version scope. The answer's nested-call placement passes the version explicitly.
- Tests:
  - TypeScript (`v5_leftovers`): a version 5 program cloned so its slots lose their cached parse checks the same as the original. Without the fix it gets 4 `MOV_EXPR_PARSE` errors.
  - Rust (`tests/slot_versions.rs`): a program rebuilt from its JSON is read under 5.

**b. `sort(xs, …)[0]` under 5.** (`aa069b14`)
- The design allows it: indexing is TypeScript's, on any value. Before the fix TypeScript accepted it and Rust refused it.
- The case that reproduces it: the sort key calls `Text.upper`, so the checker hoists the call to a name of its own.
- Cause: Rust hoists by rewriting the slot's text. It padded the name to the call's length with spaces placed after the name, so `[0]` no longer touched the name, and no grammar reads that.
- Fix: the padding now goes before the name.
- Tests: Rust `slot_versions`; TypeScript plus Rust through the wasm in `v5_leftovers`.

**c. New upgrade warning `MOV_IN_MEMORY_HOP_ORDER`.** (`faae6b87`)
- When it fires: a check for a move up across 5 (`upgradingFrom`), on a hop with `ORDER BY` or `LIMIT` over records the run already holds.
- Records the run holds: an extraction's entities, and the landed entries of a local node (a node or graph literal, a run-built node). A lazy entry is excluded, because it walks its source again at every read.
- It is marked as an upgrade diagnostic, like `MOV_PRESENCE_OF_RETURNED`. Its message says the hop's result may change.
- The CHANGELOG and the Dancing Wren migration guide name it.
- Tests in `v5_leftovers` (both checkers):
  - It fires for a graph literal, a node literal, an expression hop and an extraction.
  - It stays silent for a hop over a system's records, a hop without either clause, a plain check under 4, and a plain check under 5.

**e. No `#transform` message suggests `through`.** (`c93ed5e5`, plus fixture and test updates `9eefdea6` and the `rules.fixtures` commit)
- One wording still did: the one for a plugin that only an extraction fed (see Decision 1).
- The `#` hop messages' examples also used a named argument (`fetch_url(url: …)`). They now use a positional one.
- A test checks every wording of the message, the fallbacks included.

**f. `MOV_TEXT_HAS_NO_FIELDS` covers numbers and true/false values.** (`fe1a00d2`)
- Engine check first: under 3 and 4, both engines read a field of a number, a true/false value or text as null.
  - I ran a probe on both engines (`n = 3` / `true` / `"x"`, then `n.x == null`); every combination reported "was null".
  - So the gating matches text's: an error from 5, a warning under 3 and 4.
- The message says "a number" or "a true/false value".
- Tests in both checkers (`v5_leftovers`).

## Checks

- Type-check is clean: apps/api (which includes movement-lang) and movement-engine.
- `cargo test -p movement-checker`: everything passes.
- Clippy: no warning on the changed lines.
- movement-lang checker, service and story suites: the same failures as the base (all old spellings), except the two I updated on purpose (`meta_hops_retired`, `upgrade_corpus`) and `checks_regression` (see above).
- apps/api `generic_landings`, `ask_demand` and `handbook`: 216 of 216 pass.
- The wasm was rebuilt locally only, not committed. PARITY.md is not committed.

## Also seen

- apps/api catalog.ts (~line 1877) parses a refinement's `narrow.where` with `parseMovementExpression` without a version. It is host code, outside the checkers.
