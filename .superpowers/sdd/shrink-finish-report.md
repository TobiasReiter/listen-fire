# shrink-finish report (2026-10-17)

Branch shrink-integrate (worktree .claude/worktrees/shrink-integrate). Not pushed.

## Items
1. Patterns oracle Rust-only, regenerated once: done by the previous integrator's helper (bb53d73e, 5fb8bea5, 8c941912); tsconfig.oracle.json type-check passes. Mine: 4a3e6c60 retires the records/parallel/handles generators (they recorded TypeScript runs); their .json stay frozen as corpora, since the reachability test, checker parity and the upgrade corpus read their ~5,800 programs (controller agreed).
2. apps/api movement_engine failures: fixed by the helper (14 commits through 3f2147b1). Mine: e47b15a8, a Rust result naming no writes is read as writing nothing (it fell back to the old wire's empty list); the it.failing test is now a normal test.
3. engine-contracts dryAdmission: already fixed (10aba65b); 38/38.
4. Re-harvest + parity: one TypeScript checker bug found and fixed first (09a5d7be: an extracted record's field named `__proto__` was taken for an edge found on Object.prototype). Harvest ran to completion only once the floor passed; PARITY.md: 256/256 codes, 47,938/47,938 records exact, 0 extra (d0719332).
5. Upgrade floor: measured after the harvest at 4,966 of 5,900 (84.17%); floor 0.841, reason in the comment (file-level values refused from 5, walks off maybe-absent records).
6. Wasm rebuilt and committed (0b28afbb): movement.wasm 1,266,053 B gz (raw 4,052,440); movement_parser.wasm 362,737 B gz (raw 1,309,768). CHANGELOG size line updated.
- Controller extra: `Number.parse("")` / `"  "` is null end to end on Rust (9f81caab, test in v5_surface_run).

## Verify
- cargo test (engine, parser, checker): 544 passed, 0 failed; clippy clean.
- movement-lang: 5,221 passed, 11 skipped, 0 failed (177 suites).
- apps/api movement_engine dir (--maxWorkers=4): 130/130 suites, 3,957/3,957 tests; reachability passes, known gaps 16 (not grown).
- `pnpm -r code:type-check`: clean.
- limit_pause / pinned_resume integration: skipped per controller (no apps/api/.env here; the gate runs them from the main checkout).

## For Henry
- The TypeScript-behaviour oracles that remain (stdlib, numbers, regex, dates, strings, chunks, tail) are still regenerated from TypeScript by CI's "oracle is current" step; ruling 23 says retire or re-baseline them for v5. Not done here.
- The CHANGELOG v5 entry still mentions `MOVEMENT_ENGINE=rust` in places (for example near the Rust checker line).
