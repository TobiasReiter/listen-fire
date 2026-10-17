# checks-slim: the checks pin without program text

Branch `checks-slim` (worktree `.claude/worktrees/checks-slim`), cut from cloud-native 30843618. Not pushed.

## Read

- **Size:** the old pin was one 63.8 MB file. The new pin is 26.5 MB across 14 files. The largest file is 13.5 MB (`v5.diagnostics.json`). Sizes are below.
- **The pinned content did not change.** A one-off script rebuilt the old file from the new pin plus the harvested programs, and the result matched byte for byte. All 37,421 records came back. The catalog snapshot table is unchanged.
- **There are two files per language version, not one.** Version 5's checks with their diagnostics written inline came to 26.8 MB. Many checks share the same list of diagnostics (about 6,700 distinct lists answer 22,477 version 5 checks). So each version has:
  - a file of checks;
  - a table of diagnostic lists, which each check points at by key.
  Retiring a version still means deleting `v<n>.*`. (This works the same way as the existing catalog snapshot table.)
- **Some texts are stored after all: 174 programs, 91 KB, in `v4.programs.json` and `v5.programs.json`.** No test file writes these programs any more. Two tests kept them alive in a loop:
  - the upgrade floor test and the reachability test read the pin and re-check its programs;
  - the harvest records every check, so each re-harvest pinned those programs again.
  Nothing else can find their text. They account for 951 checks: 350 version 4 checks, 8 version 5 checks, and 593 upgrade checks made from them.
- **Decision for you:** the next re-harvest (`pnpm harvest:checks`) drops these 174 programs, deliberately. The pin will lose those 951 checks, and the upgrade floor's measured rate will move. I did not drop them now, because the brief froze the pin.
- **CI loses three corpus-wide checks.** The tests that need program text now run only when asked (`CHECKS_CORPUS=1`):
  - the regression's full replay of every pinned program;
  - the upgrade floor;
  - reachability.
  `pnpm checks:corpus` runs all three. The default `pnpm --filter movement-lang test` (the one CI runs) still checks that the pin is consistent with itself. Fully restoring the CI coverage would mean committing the 14.5 MB of program text.
- **Cost:** `pnpm checks:corpus` takes about 16 minutes (it runs every test suite twice). The parity harness runs it first, unless you pass `--corpus` to reuse the last one.

## What each reader reads now

| reader | reads |
|---|---|
| checker regression (movement-lang) | always: the pin files and the snapshot table (consistency checks); with `CHECKS_CORPUS=1`: the replay over `target/checks/checks.json` |
| upgrade floor | `target/checks/checks.json`, only with `CHECKS_CORPUS=1` |
| reachability (apps/api) | `target/checks/checks.json`, only with `CHECKS_CORPUS=1` |
| catalog differential | `target/checks/checks.json` (it was already gated by its own flag) |
| parity `reference.ts` | `target/checks/checks.json`; both checkers answer live; `run.sh` harvests first |
| `pnpm language:conformance` | any corpus file; ours is `target/checks/checks.json` (format unchanged) |
| harvest (`build_fixture.cjs`) | writes the pin (`--pin`), `target/checks/programs.jsonl` (hash, text, the tests it came from) and the assembled corpus |

## Results

- Proof script: 37,421 of 37,421 records rebuilt, byte for byte identical; snapshot table identical.
- `pnpm checks:corpus`, end to end: 37,421 pinned checks assembled. Then:
  - regression replay over the corpus: 7 of 7 tests passed, 0 records drifted;
  - upgrade floor: 5,000 of 5,967 programs (83.8%), the same as before;
  - reachability: passed.
- Parity (`run.sh`): 263 of 263 codes; 172,930 of 172,930 diagnostics matched; 48,272 of 48,272 records exact; 0 extra. Every corpus count is the same as before.
- `pnpm --filter movement-lang test`: 5,309 tests passed, 13 skipped.
- apps/api `src/services/movement_engine` (`--maxWorkers=4`): 3,969 tests passed, 1 skipped.
- `cargo test -p movement-checker`: 208 passed, 0 failed.
- `pnpm -r code:type-check`: clean.

## Aside

- Program hash: sha256 of the text's UTF-16 code units. Three test programs contain a lone surrogate. Hashed as UTF-8, two different programs got the same hash.
- The harvest's second pass runs the upgrade floor and reachability while the corpus is still incomplete. Their failures in that pass are allowed. Their assertions run afterwards, over the complete corpus.
- I found two problems that were already there before this change:
  - A harvest run aborted once on each of two timing-sensitive engine tests: the HTTP replay ordering in `engine_runs.v1` and the concurrency test in `collection_op_settings`. Both passed on the next run.
  - `parity/run.sh` failed at module load without `apps/api/.env`. It now preloads the jest suites' safe test defaults (`apps/api/src/test/test-env-defaults.ts`).
- File sizes (MB):

| version | checks | diagnostics | stored texts |
|---|---|---|---|
| v1 | 0.56 | 0.63 | |
| v2 | 0.63 | 0.70 | |
| v3 | 0.79 | 0.94 | |
| v4 | 1.76 | 1.06 | 0.09 |
| v5 | 5.85 | 13.47 | 0.01 |
| v99 | 0.002 | 0.001 | |

  The snapshot table is 1.42 MB and is unchanged.

## 2026-10-17: after the merge of cloud-native 52378364 and one re-harvest

### Read

- **The merge was clean.** No conflicts. cloud-native did not touch the checks pin or its readers.
- **The orphan programs are gone.** Both stored text files (`v4.programs.json`, `v5.programs.json`) are deleted, with the code that read them.
- **The loop is cut.** A re-harvest rewrites the pin from the first pass before the corpus readers run, so the readers only see programs some test writes.
- **The re-harvest dropped 3,909 checks and added 148: 37,421 became 33,660.** That is more than the 951 checks the orphans had.
  - 951 checks belonged to the 174 orphan programs.
  - 2,810 checks were of programs the tests still write, under 84 catalogs no test builds any more. Only the same loop kept them: the readers re-checked each pinned record against its pinned catalog.
  - 148 upgrade checks are new. The upgrade floor picks each version 4 program under its first catalog. Where that catalog was dropped, the program's rewrite is now checked under the next one.
  - No surviving check's diagnostics changed.
- **Upgrade floor: 0.837 → 0.858** (measured 4,732 of 5,515, which is 85.8%).
- **The ship gate now runs `pnpm checks:corpus`** (Henry's ruling: a ship gate step, not CI).

### Results

- `pnpm checks:corpus`: 33,660 checks assembled; the replay and the upgrade floor pass (6 of 6 tests); reachability passes.
- Parity: 263 of 263 codes; 163,937 of 163,937 diagnostics matched; every record exact (43,999); 0 extra.
- movement-lang: 5,308 passed, 13 skipped. Engine tests: 3,969 passed, 1 skipped. `cargo test -p movement-checker`: 208 passed. `pnpm -r code:type-check`: clean.
- Pin sizes (MB): v1 0.56 + 0.63, v2 0.63 + 0.70, v3 0.79 + 0.94, v4 1.63 + 1.04, v5 5.02 + 13.21, v99 0.002 + 0.001, snapshot table 1.24. Total 26.4 MB in 13 files.
