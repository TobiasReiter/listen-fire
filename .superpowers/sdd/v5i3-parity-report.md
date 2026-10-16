# v5i3-parity — Rust checker parity gaps

**Read:**
- Parity is now complete on the committed corpus, with the patterns oracle loaded: 253 of 253 codes, 0 extra in Rust, 46,749 of 46,749 records exact, 0 refused (it was 246 of 253, 1 extra, 59 refused).
- Six gaps were Rust bugs, fixed in Rust. One was a TypeScript bug, fixed in the TypeScript for version 5 only (the last item below).
- Two things for the controller, both outside this slice:
  - The committed checks corpus no longer replays clean, and not because of this branch. `checks_regression` drifts on 1,220 records with the committed wasm and on 1,456 with the wasm rebuilt from source. My TypeScript change moves one of those records. The re-harvest you planned covers this.
  - A possible narrowing regression, worth an owner. Under version 5 a block head whose WHERE joins with `&&` (`le.listName == "Deal Pipeline" && le.x >= y`) no longer narrows the landing to that list. The corpus pin narrowed it; both checkers now say "has no field 'Deal Created' — it has: listName". They agree, so parity does not show it.

## Gaps: cause, fix, proof

Each fix has a case in `crates/movement-checker/tests/rules.fixtures.json`, with the answer taken from the TypeScript checker.

1. **59 records refused: the snapshot has no `writableRoots`** (b1048159)
   - Cause: the Rust catalog required the field. The TypeScript reads a missing one as empty (a hand-written slack schema that is only read).
   - Fix: a missing field now defaults to empty, the same way `priced` defaults. When the schema is handed back it carries `{}`.
   - Decision: I did not copy `priced`'s "handed back exactly as written". Handing back `{}` reads the same in the TypeScript, and a missing field there would crash its readers.
   - Proof: a test in the parser's catalog tests.

2. **The internal error for a binding nothing typed was missing (the `__proto__` records)** (c95d2b94)
   - Cause: `__proto__` had nothing to do with it. The program writes off `crm`, whose value failed to parse. The TypeScript reports that binding as its internal error; the Rust read it silently as an unknown record.
   - Fix: Rust now reports it at the same five places the TypeScript does. To avoid false reports, a write, match, link or lazy walk that hands back no handle now binds "a record nobody could type". That is the TypeScript's rule; without it, Rust reported 55 extras.

3. **A walk or match off a node declaration's own name was not refused** (`Note-[:item]->`, `Lead-[c:companies]->`) (992c3469)
   - Cause: the TypeScript treats a declared node's name as a graph whose one collection is itself. The Rust lookup of where a walk starts only read the symbol's own position, so it found nothing and passed.
   - Fix: both Rust lookups (the type core's, and the block head's) now fall back to the declaration.

4. **A `unique by` part that the expression lowering refuses was not reported** (a closure inside `unique by`) (7c808770)
   - Cause: Rust skipped the part silently, assuming another rule reported it. No other rule did.
   - Fix: Rust now reports MOV_EXPR_PARSE at the part, as the TypeScript does.
   - Note: the lowering refuses `map([1], (v) => v)` anywhere inside `unique by`. Both sides share that lowering, so I left it alone.

5. **`UPPER(text: …)` under version 2 was not reported as an unknown name** (af1b36df)
   - Cause: Rust's function-call check exempted names that spell a built-in. The TypeScript has no such exemption: before version 3, a built-in is just a name nothing binds.
   - Fix: the exemption is removed.

6. **The placeholder leaked into messages and fixes** (`` inc(`#call@7:11`) ``) (6d4251cb)
   - Cause: Rust pulls a nested call out of an expression by rewriting the slot's text. The TypeScript rewrites only the parsed tree and keeps the text. The stand-in name was longer than a short call, so:
     - every position after it shifted, and one case crashed the parity run;
     - messages and fixes quoted the stand-in, for example "[`#call@…`, 2][0]" in an AT fix.
   - Fix, in two parts:
     - The stand-in is now one private-use character in backquotes. It fits even in `f()`, so positions stay the original's. It never appears in a message; the TypeScript's name never does either.
     - Messages and fixes now quote the text as written.
   - Proof: a focused test in `tests/rules.rs` checks the AT fix's text and span.
   - Known limit: after 6,400 such calls in one file the stand-in grows to two characters. A three-character call (`f()`) past that point would shift positions again.

7. **One extra version 5 spelling diagnostic for `cutof` (a TypeScript bug)** (6c84bb4f)
   - Cause: the TypeScript parses a block head's hops for the walk-field and call checks without passing the program's version, so they parse as versions 1–4 do. Under version 5 a head joined with `&&` then failed to parse, and its bare fields and calls went unchecked. Rust parsed under version 5 and reported `cutof`.
   - Fix: the TypeScript now passes the program's version.
   - Versions 1–4 are unchanged: only version 5 changes the expression grammar.
   - Two other TypeScript calls also parse without a version: a type address probe at check.ts:3627 and a closure-return read at check.ts:2213. The corpus shows no gap from them, so I left them.

## Verification
- Parity: `run.sh` run with the database environment set (both sides, patterns oracle included). Result as in the first bullet.
- `cargo test -p movement-checker` and `cargo test -p movement-parser` both pass.
- clippy shows no warnings on the lines I changed.
- The movement-lang `tsc --noEmit` is clean.
- jest on the checker's `checks_regression`, expression-head, walk and v5 suites: 157 of 158 tests pass. The one failure is the stale corpus described above.
- Not committed: the wasm files and PARITY.md.
