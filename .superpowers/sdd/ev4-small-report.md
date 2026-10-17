# ev4-small report — granola and evertrace as modules

Branch `ev4-small` from 9cfa02d3. Not pushed. Commits, in order:
2c14c173 granola parity recording · 39e96583 evertrace parity recording · 5e7a7574 `@lf/granola` ·
d393141a granola bench · b9db1184 `@lf/evertrace` · (this report + bench tweaks).

## Done

- **`@lf/granola`** (`modules/granola`) and **`@lf/evertrace`** (`modules/evertrace`), both on their
  `BUILTIN_MODULES` line = `module`. Code moved, not copied (adapter, client, poll; for Evertrace also
  schema, pushdown, saved search reading, write surface). The legacy line (`adapters/granola`,
  `adapters/evertrace`) is the module's adapter over the old decrypt-the-row credential path, one edit
  from rollback, as for Dealroom.
- **Recorded parity, recorded BEFORE the move** against fake-channels, replayed against three subjects:
  the legacy line, the module through the platform registry (in process, over the secrets family), and
  the module served by `serve-module` and called through `RemoteAdapter` over protocol 2. All three give
  identical answers and make identical requests.
  - Granola: 42 provider requests, 4 seeded notes; schema, back-catalogue (pushed and unpushed WHERE,
    LIMIT), every field and edge, actor, event types, five polls.
  - Evertrace: 77 provider requests, 184 answers; every type described, every root collection (pushdown),
    every field and edge by descriptor, read-back by id, all writes (create/update/delete of searches,
    lists, entries; screened/viewed; idempotent re-add; every refusal; not-found), both poll kinds,
    saved-search and list scoping, unknown search/list errors. The clock is fixed (a new search is
    stamped from it).
- Neither declares `inbound` (both are polled-only), so the signed-inbound rule and the inbound golden
  corpus are unaffected (golden suite passes unchanged, nothing re-recorded).
- Poll: the module's declared poll replaces the legacy factory for both. Interval 300 s, as before;
  `pollIntervalSeconds` listen option still overrides. Checkpoints keep their shape, so existing
  trigger rows continue unchanged. No periodic tasks.
- Credential: `{ apiKey, baseUrl? }` through `ctx.credential`; the dev loop's fake through
  `ctx.config.baseUrlOverride`. Stored ciphertext and payload shapes untouched.

## Decisions (why)

- **Parity script reads fields by descriptor.** Evertrace's script asks `describe()` for each type and
  reads every declared field/edge, so a field added later is covered without editing the script.
- **Process-transport errors are compared after the transport prefix.** Over the wire a refusal reads
  `Remote adapter error for method "x": adapter_error — <message>`; parity holds of the message. This
  is existing behaviour of the protocol client, not new.
- **Exchange server learned to track named request headers** (`apps/api/.../dealroom/__test__/parity/exchange.ts`,
  an option; Dealroom's recording and test are unchanged). Evertrace's fake refuses a request without
  `X-API-Version`, so the proxy must forward it; replay now also holds the module to sending it.
- **Evertrace's `UPDATE_NOT_FOUND` and an exhaustive-switch helper are local to `write.ts`.** The platform
  versions live in apps/api and `movement-engine/lib/utils/types` is not a public entry, so a module
  cannot import them. Two small local definitions rather than adding to module-kit (ev4-plugins' file).
- **Evertrace's memoized per-key client is gone** (legacy now builds a client per resolve, as Dealroom's
  does). The client is stateless (no pacing gate), so nothing is lost.
- **Evertrace poll takes `(client, input, { log })`**: the saved-search diagnostics logged through the
  engine logger; the module logs through `ctx.log`.
- No kv store needed: dedup is the checkpoint in both.

## Tests (done tier)

- `@lf/granola`: 3 suites, 33/33 (the moved adapter and movement suites plus a new module-seam suite) — code:type-check clean.
- `@lf/evertrace`: 3 suites, 113/113 — code:type-check clean (includes module boundary guard).
- Parity (granola, evertrace, dealroom together): 3 suites, 12 passed, 3 skipped (the recorders), 0 failed.
  Each of granola and evertrace: recording sanity + legacy + module in process + module as a process.
- apps/api scoped, `translation_graph|poll_source|services/credentials|services/inbound|webhook_sync|
  interfaces/rest/__test__|interfaces/trpc|movement_engine/__test__/(seam|public)`: 223 suites,
  3484 passed, 3 skipped, 0 failed.
- apps/api `pnpm code:type-check` (tsc, oracle config, engine boundary): clean. Boundary baseline lowered
  779 -> 761.
- Integration tests (DB 9432) were not run: nothing here touches a suite that needs them. Dev loop not
  booted (ev4-cleanup's).

## Performance gate: NOT resolved (host too busy)

Benchmarks (`pnpm bench` in each module, interleaved, same harness as Dealroom plus a CPU-time column)
were run with host load averages of 20-47 from other agents; the same pair swung from -27% to +53% run to
run, and legacy RSS from 111 to 277 MB (swap). No figure is trustworthy. The module path adds exactly the
kit overhead Dealroom measured (p50 +3.9%, p99 +0.2%, RSS +0.7%, boot +0.9%), and the client/adapter code
is unchanged, but the gate is **unmeasured**: re-run `BENCH_RUNS=15 pnpm bench` in `modules/granola` and
`modules/evertrace` on a quiet host before shipping, and flip the line back if any figure is over +5%.

## Files outside the streams (all minimal)

- `apps/api/.../adapters/builtin_modules.ts`: two lines flipped, two manifest imports.
- `apps/api/.../adapters/registry.ts`: granola/evertrace through `builtinAdapterFactory` / `builtinPollSourceFactory`.
- `apps/api/src/interfaces/trpc/views/credentials.ts`, `services/credentials/connect_form_spec.ts`,
  `scripts/dev/inject.ts`: Evertrace creds parser / version constant import path only.
- `apps/api/package.json`, `deploy/Dockerfile`, `pnpm-lock.yaml`: the two packages (build script, copy, lock).
  Siblings add the same kind of line next to these; expect trivial merge conflicts there.
- `scripts/engine-boundary-baseline.json`: lowered. `CHANGELOG.md`: `### ev4-small`.
- Dealroom's `parity/exchange.ts`: the optional tracked-headers support (above).

## Flags

- The connect form for Granola still asks only for an API key (unchanged); the module's declared
  credential also lists an optional `baseUrl`, as Dealroom's does.
- `apps/api/src/adapters/evertrace/apiClient.ts` is deleted (moved); nothing else imported its client.
