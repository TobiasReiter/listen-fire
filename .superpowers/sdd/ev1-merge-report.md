# ev1-merge report (everywhere wave 1, merged)

Branch `ev1-merge` from cloud-native 4ba5f821. Not pushed. cloud-native untouched.

## Merges (one merge commit each, in brief order)
protocol 980187ba, public e1b9963f, golden 30dbc98b, judge baceb285, filetext 24c3c107, providers 9efef541, pricing df7f093d, callbacks 061c0b2f, lfhost 89fc530c.
- Conflicts were only the expected ones:
  - CHANGELOG: every `### ev1-*` section kept, in merge order.
  - apps/api `build`: one line with all three added steps (file-text emit, the judge prompts copy, model-providers emit). The `code:type-check` line from public is kept.
  - deploy/Dockerfile: both COPY lines kept (a stray blank line removed in 114e6ad1).
- These merged without conflict: pnpm-lock.yaml, serve.ts, the cli tests, Cargo.toml members.
- The lockfile: `pnpm install --offline --frozen-lockfile` accepted the merged file as is, so no regeneration was needed.
- The first two merge commits lack the Co-Authored-By line. They were not amended.

## After-merge steps
1. **Boundary guard** (222110c3). Baseline 850 -> 813. The merge alone brought it to 822, but four modules grew:
   - pricing 0->1 (llm_usage)
   - identity_judge/judge 0->2 (entity_match)
   - run_host/callbacks 0->5 (callback_fire, callback_sink, callback_store)
   - run_host/store 5->6 (callback_store)

   I added pricing and the judge to `public/models.ts`, and the callback family to `public/run-host.ts`. Those apps/api files now import the public entries. The judge went in models because it is a model-backed decision with metering, beside the metered clients and run spend. No other entry in the plan's list fits it.

   Every remaining change is a decrease, because modules moved out of apps/api took their imports with them:
   - providers moved into packages/model-providers: lib/models/map 16->6, lib/run_spend 11->6, lib/utils/types 45->38, lib/google_cloud 6->4, lib/models/embedding/range 2->0, lib/models/chat 3->2, ai_tiers 2->1
   - pricing: run_cost 6->5
   - file text: logger 236->231, adapter 136->135, host 10->9
   - judge: uniqueness 6->5

   Note: packages/model-providers still imports movement-engine internals (map, registry, run_spend, utils/types). The guard does not scan packages.
2. **Callback and cancel contract cases on the Rust store: not done; it needs Rust callback tables (G5).** These cases need a `RecordsContractBackend`: the callback store (mint, get, record, markBodyStarted, landed, revokeRun), run records, requestCancel, runStatus and completeRun. lf-host's store has none of them, so the RPC bridge cannot serve them cheaply.
   - Found in the merge, and fixed (7954f3f0): ev1-callbacks changed lf's state file. The Rust store's schema test failed. Worse, the Rust work claim would refuse a whole batch on seeing a `fire_callback` row.
   - The Rust store now carries the callback table and the `fire_callback` kind, and adds the two cancel columns on open.
   - New cargo tests hold the work kinds and the added columns equal to state.ts.
3. **ENGINE_VERSION** (da16d4b9). apps/cli imports it from `public/movement-engine`, and its own constant is gone. lf-host keeps a Rust constant; a cargo test holds it equal to the public entry.

## Found in branch outputs and fixed
- ev1-filetext and ev1-pricing never committed their test fixtures. The root .gitignore drops any `fixtures/` folder, so those suites failed on the merge (ENOENT).
  - I copied the files from their worktrees into `__fixtures__`, which is the repo's convention, and committed them (44a695b9, 5cabe3e3).
  - The pricing snapshot used is the one written before its table moved (05:16, before the 05:23 move).
- ev1-pricing's report file is empty (0 bytes) on its branch.
- deploy/Dockerfile never copied `packages/movement-engine/package.json`. The api image build failed already at 4ba5f821 with 794 type errors (801 after the merge). Adding the one COPY line makes it green (8497940c).

## Verify
- `NODE_OPTIONS=--max-old-space-size=8192 pnpm -r code:type-check`: exit 0. 14 of 15 projects, including file-text and model-providers. Guard 813/813.
- cargo test --workspace: 567 passed, 0 failed, 2 ignored. clippy --workspace --all-targets -D warnings: exit 0, 0 warnings. lf-host 12/12.
- Package tests:
  - engine-contracts 54/54 (4 suites)
  - model-providers 147/147 (6)
  - file-text 8/8, after the fixture fix
- apps/cli full set (TS lf): 131/131. This includes the SQLite run_host contract (42) and the Rust run_host contract (30).
- Check tests under `LF_BIN=target/debug/lf-host` (catalog + example_project): 5/5 check cases pass. The other 8 cases in those files exercise run and serve, which lf-host refuses by design ("not in lf-host yet").
- apps/api scoped unit tests: 28 suites, 535/535. They cover:
  - inbound/__golden__ and the identity judge replay
  - entity_match, local_write, target_where, unique_by and uniqueness
  - the llm_usage price snapshot, the file_text sets and extract_document_text
  - the lib/models wrappers and host, and file_generation_image
  - the callback, door, await_resume, park_sink, run_lease and seam_guard suites, and public_entries
- apps/api production build: `pnpm build` in apps/api, as gate 21 step 7b did, exit 0. It prints the same benign resolve-tspaths line.
  - It leaves 0 stray `.js` beside movement-lang sources, and git status is clean.
  - The build output has `movement-engine/lib/models/prices.json` and the 4 judge prompt `.md` files, plus `file-text/` and `model-providers/`.
  - From the build: pricing, the judge prompts (it renders `entity_match.system`), file-text and model-providers all load.
- Docker: `docker build -f deploy/Dockerfile` from a `git archive HEAD` context. The archive keeps the 3.9 GB Rust `target/`, which .dockerignore does not exclude, out of the context. Green after the fix.
  - In the image: the prices, the prompts, file-text and model-providers are present.
  - The vendor SDKs and file-text's dependencies resolve from the package folders.
  - Temporary images were removed.
  - Dockerfile.web was not built. It carries file-text but not model-providers; nothing in web's closure depends on either.
- Integration on test DB 9432, one suite at a time. The env was as in gate-21-brief: DATABASE_URL_TEST(_READONLY), and the ENCRYPTION_* lines from .env.example only.
  - callback_store 25/25, callback_fire_race 9/9, callback_body_order 4/4, callback_revocation 3/3, run_host_contract 42/42: 83/83 in total.
