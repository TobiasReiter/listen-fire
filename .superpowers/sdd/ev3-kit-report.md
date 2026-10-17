# ev3-kit report — A0: the module kit and loader (adapters and plugins), pilot Dealroom

Branch `ev3-kit` from 30843618. Not pushed. Commits, in order:
ced5f2a4 parity recording · 647334aa kit + protocol + inbound rule · 25e11f92 Dealroom module ·
af56055f lf · fd2d8974 lf-host · ffa6df38 install manifest · f7930cb0 benchmark · 65aceb8c CHANGELOG.

## Done

- **`packages/module-kit`** (named `module-kit`, since it covers plugins as well as adapters).
  - `defineModule`: an adapter module (`kind: 'adapter'`, the host manifest, declarations, `create(ctx)`)
    or a plugin module (`kind: 'plugin'`, plugin declarations, `create(ctx)` giving `invokePlugin`).
  - The context: `credential` (fields read per call; `update` writes back), `fetch`, `log`, `files`, `kv`, `config`
    (`tenant`, `baseUrlOverride`, `constructionArgs`).
  - In-process transport (`adapterInProcess`, `pluginsInProcess`). Answers are validated against the
    protocol schemas when the host asks. `inProcessValidationDefault`: on unless `NODE_ENV=production`;
    `ADAPTER_VALIDATE=1|0` overrides.
  - Process transport: the protocol server kit moved here from apps/api (`server.ts`), plus
    `module_server.ts` (one module built per request, from that request's tenant and credential;
    `credentialUpdate` returned on success and failure) and `serve-module` (`bin/serve-module.cjs`).
  - The adapter helpers `BaseAdapter`, `uniformWalk` and name resolution moved into `module-kit/adapter/*`.
    26 apps/api importers were repointed (import lines only).
  - Guard: `scripts/check-module-boundary.cjs`, run by each module's and the kit's `code:type-check`.
    It refuses imports into apps/*, database clients and `lib/recording`, and engine imports outside
    `movement-engine/public/*`. There is no baseline: the count is zero.
- **Protocol** (`protocol.ts`, `adapter-protocol.md`; no version bump):
  - New manifest declaration `plugins: { package, plugins: [{ name, spec }] }`, paired with the new
    method `invokePlugin` (`{ name, config, extractedContext }` → `{ text?, data?, records?, outcome?, costMicrodollars? }`).
  - `refuseUnpairedDeclarations` is exported, and there is a new `WireManifestResultShape`.
  - `RemoteAdapter` gains `poll`, `runPeriodic` and `invokePlugin`.
  - New public entry `public/modules.ts`, which exports the remote adapter.
- **Signed inbound rule** (`services/inbound/verify.ts`): `declaredInboundVerifier`. For every scheme, a
  delivery is refused when the key is missing, blank or `pending`, or when the signature is bad.
  - The platform door uses it only for a built-in on a module line that declares `inbound`
    (`builtinModuleInboundVerifier`, a one-line change in `webhook_sync/handler.ts`).
  - The frozen built-in table is unchanged.
- **`BUILTIN_MODULES`** (`apps/api/.../adapters/builtin_modules.ts`): one line per built-in.
  - Lines: 12 adapters and the 6 bundled plugins. Each says `legacy` or `module`; only dealroom says `module`.
  - A module line is loaded on first use. Its manifest comes eagerly from `@lf/dealroom/manifest` (data only).
  - What the platform supplies as host: the credential through the secrets family over the encrypted
    store; the dev-loop fake as `baseUrlOverride` (test-harness team only); the engine logger.
  - What the declarations become: `poll` becomes the registry's poll source, replacing the hand-written
    factory for module lines. Each `periodic` task becomes a work kind
    (`module_periodic:<adapter>:<task>`, run per connected credential). A plugin module line takes that
    plugin's calls (`transformInvokerFor(teamId)` in `engine_host.ts`).
- **Pilot `@lf/dealroom`** (`modules/dealroom`), flipped to `module`.
  - The code was moved, not copied: adapter, client, schema, pushdown and poll. The client takes the
    host's fetch and log, with one pacing gate per API key per process.
  - The unit tests moved with it. The one agent-projection case stays in apps/api.
  - The legacy line (`adapters/dealroom/index.ts`, `client.ts`) is the module's adapter over the old
    decrypt-the-row path. Rolling back is one edit.
- **Recorded parity.** The fixture was recorded from the legacy adapter *before* the move, against
  fake-channels: 50 answers and 23 provider requests, including both poll cases. Three subjects replay
  it with identical answers and identical requests:
  - the legacy line;
  - the module in process, through the real registry and the secrets family;
  - `serve-module` as a child process, called through `RemoteAdapter` over protocol 2.
- **lf (TypeScript):**
  - `lf-external.yaml` takes `module:` (served by serve-module).
  - Plugin externals are started; their package joins the catalog under its tag.
  - `llm.transforms.invoke` calls `invokePlugin`, with the cost charged to the run.
  - `@lf/dealroom` runs in lf with its declared credential.
- **lf-host (Rust):** `module:` externals, plugin manifests (paired), catalog plugins with package
  tags, and `llm.transforms.invoke` through `invokePlugin`.
- **Install manifest file** (`remote/manifest.ts`): adds the optional `credentials`, `inbound`, `poll`,
  `periodic` and `plugins`. They are deliberately not paired with `methods`, so a stored row never
  stops parsing.

## Decisions (why)

- **Plugin import spelling:** none was invented. The language already has package imports for plugins
  (``import { `@lf/web` as web } from plugins``, members `web.fetchUrl`, matched on `spec.package`,
  in both checkers). The protocol's `plugins.package` feeds that.
- **Legacy line = the module's adapter class over the old credential path.** The alternative was a
  second copy of 2,000 lines. Parity against the pre-move recording guards the moved code.
- **`ctx.files` and `ctx.kv`** refuse by name on the platform and in serve-module. No module uses them
  yet, and a silent in-memory stand-in would lose state. Their real stores land with the first module
  that needs one.
- **The hosted remote-install credential binding is not wired.** `resolve.ts` still passes no
  `credential`. The install's `credentials_id` is the remote server's secret, not a provider
  credential, so binding one needs a second credential per install. That is a product decision.

## Performance gate (`modules/dealroom`, `pnpm bench`; interleaved, median of 5 processes, 1,500 rounds)

| | p50 | p99 | RSS | boot |
|---|---|---|---|---|
| legacy | 0.647 ms | 2.444 ms | 285.8 MB | 199.9 ms |
| module (production: unvalidated) | +3.9% | +0.2% | +0.7% | +0.9% |
| module, validated (dev/test) | +24.9% | +7.5% | −0.4% | +0.8% |

- All within +5%.
- The bench excludes the database. The legacy line decrypts the row on every client call; the module
  line's secrets family caches it per instance. So hosted reality should favour the module.

## Tests (done tier)

- module-kit: 3 suites, 43/43.
  - Includes both transports, pairing refusal, validation, credential write-back, and a plugin module.
  - Also `serve-module` run as a child process.
- @lf/dealroom: 43/43.
- engine-contracts: 4 suites, 58/58.
- apps/api, scoped (adapters, poll_source, webhook_sync, inbound, credentials, protocol, movement,
  trpc views, work, plus movement_engine extraction, seam_guard and public_entries): 153 suites,
  2465 passed, 1 skipped, 0 failed, after one fix. The fix: `seam_guard` named the server kit's old
  path; its embeddable root is now the whole `module-kit` entry, which reaches no database code.
- apps/api, dealroom parity: 4/4 (recording skipped).
- apps/api, declared inbound: 24/24.
- apps/api, transform invoker: 9/9.
- apps/api, remote: 101/101.
- apps/cli `pnpm test`: 186 tests, 175 pass, 0 fail, 11 skipped (real sops). The new modules test is 3/3.
- apps/cli with `LF_BIN=lf-host`:
  - modules: 2/3. The Dealroom run is refused, by name, because lf-host sends no declared credential (G4).
  - catalog 4/4, externals 3/3, pins 3/3.
- cargo test lf-host 37/37. clippy `-D warnings` clean.
- Type-check clean: engine-contracts (plus embed smoke), movement-engine, module-kit, @lf/dealroom,
  apps/cli, and apps/api (including the oracle config and the boundary guard, 780 = baseline,
  lowered from 799).
- Integration tests were not run. There is no apps/api/.env here, and copying one is forbidden. The
  integration files touched only had an import line changed, and they type-check.

## Flags for Henry

- `pnpm -r codegen:trpc` was not committed. The only router change is optional manifest fields, which
  web never reads. But regenerating now rewrites `packages/trpc/types.ts` to import
  `movement-engine/public/*` and an unrelated `CapturedWrite`, and apps/web cannot resolve those.
  Something already drifted at base; it needs a look before the next regeneration.
- The six bundled plugins still run on their legacy lines. Moving each one into `modules/<name>`, and
  setting its `package` tag in the catalog, is wave-4 work (A-stream). Today lf serves only custom
  plugin modules.
- lf-host cannot run a module that needs a declared credential until G4.

## Files outside the stream (minimal)

- 26 apps/api adapter and test files: one import line each (moved helpers).
- `webhook_sync/handler.ts`: one verifier line.
- `movement/engine_host.ts`: one invoker line.
- `credentials/connect_form_spec.ts`, `trpc/views/credentials.ts`: import paths.
- `adapters/remote/index.ts` (engine): the three module methods.
- `deploy/Dockerfile`, apps/api build script: the two new packages.
- `pnpm-workspace.yaml`: `modules/*`.
- The example project's `lf-external.yaml` comment.
- `scripts/engine-boundary-baseline.json`: lowered.
