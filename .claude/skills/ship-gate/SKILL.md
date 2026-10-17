---
name: ship-gate
description: Run the batched shippability gate — full monorepo typecheck + the chunk's test set in parallel — and drive fix-up dispatch on failure. Use before pushing or releasing; never during iteration.
---

# Ship gate

The only place expensive verification runs (see CLAUDE.md "Done vs shippable").
Gates everything accumulated on local main since the last gate.

## Procedure

1. Run both, in parallel, in the background (independent processes):
   - Full typecheck: `NODE_OPTIONS=--max-old-space-size=8192 pnpm -r code:type-check`
     (default heap OOMs with exit 134 — that's memory, not a hang).
     NEVER `pnpm -r tsc --noEmit` — no package defines a `tsc` script, so it
     matches nothing and exits 0 having checked NOTHING (caught 2026-08-02).
   - Declaration-emit check (tsc --noEmit misses TS4023/4058, and Render's
     api build emits declarations): in apps/api,
     `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --declaration
     --emitDeclarationOnly --noEmit false --outDir <scratch-dir>`
   - The chunk's test set: `pnpm test:unit --testPathPattern '<dirs touched by
     this chunk>'` — the chunk scope, not the whole suite, unless releasing.
     A wide pattern (2+ big dirs, e.g. `movement|interfaces/rest`) exceeds the
     600s background-command ceiling at ~15-18s/suite — run each big dir as
     its own sequential leg instead (learned twice, 2026-08-03/04).
     Add `--maxWorkers=4` on the command line: the unit config pins
     `maxWorkers: 1` for interactive runs, and a gate leg of ~240 suites at
     ~12s each takes ~50 min serially (seen 2026-10-05).
   - The checks corpus (every gate, whatever the chunk touched): in
     packages/movement-lang, `pnpm checks:corpus` (about 16 min). It runs the
     three corpus-wide checks that CI does not, because the checks pin holds
     no program text and only a harvest of the test suites finds it: the
     checker regression's full replay (0 drifted), the upgrade floor, and
     reachability. It exits non-zero on any of them.
   - Two tiers of test scope:
     - **Chunk gate** (every gate): only the dirs the chunk touched, plus
       the language-version conformance corpora when the chunk touched the
       language (`test:conformance:v1` / `:v2` in packages/movement-lang and
       apps/api). Target ~15–20 min wall time.
     - **Wide sweep** (before a push only, once per push): the broad apps/api
       pattern across every area the unpushed commits touched (adapters,
       translation_graph, mcp, trpc, lib, …), with `--maxWorkers=4`, as
       separate legs per big dir. Not repeated per chunk.
2. If the chunk touched an integration or agent path, also verify end-to-end
   through the dev loop (boot `pnpm dev:loop:agent`, exercise the real flow,
   check the data roundtrip).
3. **Green** → report gate-passed; push only if the user has asked for a push,
   and only after the wide sweep has passed on the exact commit being pushed.
4. **Red** → dispatch a fix-up agent (the `implementer` agent) carrying ONLY:
   the verbatim failure output, the suspect files, and the constraint "fix the
   gate failure, change nothing else". Re-run the failed leg (scoped to the
   failing files first, then the full leg).
5. Two failed fix-up rounds → stop and escalate to the user with the evidence.

## Rules

- Never run the gate mid-iteration; batch per shippable chunk.
- Legs run as background tasks — don't block on one before starting the other.
- Report results plainly: what ran, what passed, what failed with verbatim
  output. No hedging.
