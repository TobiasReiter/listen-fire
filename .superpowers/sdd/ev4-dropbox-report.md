# ev4-dropbox — Dropbox as a module

Branch `ev4-dropbox` from 9cfa02d3. Not pushed. Dropbox is `@lf/dropbox` (`modules/dropbox`), `BUILTIN_MODULES.dropbox` = `module`.

## Done

- Recorded the legacy adapter against fake-channels first (commit ae8790fc): 40-odd steps (introspection, root and nested reads, every field, file bytes, folder create and reuse, file create from inline text / a file value / a copied Dropbox file, the refusals), 17 provider requests with bytes.
- Moved adapter, schema, writes and client into the module. The client takes the host's fetch. The credential is `ctx.credential`, declared `oauth2` (authorize and token URL moved from `authClient` into the manifest, `authClient` imports it). The base URL is `ctx.config.baseUrlOverride`, else the credential's `baseUrl`.
- Files cross as handles. A returned file is `{ adapterType, handle: <path> }` and nothing else; bytes a write carries are read through `ctx.files.read`.
- Platform as host (`builtin_modules.ts`, new `module_files.ts`):
  - a module line may now say `payloadShape` (Dropbox: the camel token payload the connect flow stores) and `refresher`;
  - an expiring OAuth token is refreshed through the secrets family (compare-and-swap, one refresh at a time) against the platform's own Dropbox app (`DropboxAuthClient.refresher()`, which points at the dev loop's fake OAuth provider there) before the module is handed it. Failure says "Dropbox token refresh failed", as before;
  - `platformFiles(teamId)` is the platform's `ctx.files` (the team's own bytes, via `streamFileRef`; `put` via the hosted document store). All module lines now get it instead of refusing;
  - `nameFileOwner` adds the install (credential id) to a file the module returns, so the descriptor equals the legacy one (two Dropbox installs stay unambiguous).
- Legacy line (`adapters/dropbox/index.ts`) is the module's adapter over the old decrypt-the-row path; `apps/api/src/adapters/dropbox/apiClient.ts` re-exports the module's client (the v3 output pipeline shares it).
- Module kit, for served modules (needed to make file reads and writes work over a process):
  - `resolveFileRef`: when the ref has no URL, the adapter's stream is hosted at a one-use, 60 s path on the served module and that URL is the answer (`ServedFiles` in `module_server.ts`, `serveBytes` option in `server.ts`);
  - `ctx.files.read` in a served module fetches the URL the host sent (`serve.ts`);
  - `getFieldValue` answers a file in the wire spelling (`{ ownerAdapterType, handle }`).

## Parity (apps/api `dropbox_parity.unit.test.ts`)

The recording replays with identical answers and identical provider requests for: the legacy line, the module in process through the platform registry and secrets family, and the module as `serve-module` called through `RemoteAdapter` over protocol 2 (file read by the served URL, file write by the exposed URL). The process subject strips the transport's error wrapper; nothing else is normalised. One jest-only workaround: `Response.prototype.json` is patched in that test, because jest's sandbox `Object` differs from the one fetch builds JSON with and file descriptors read as "not plain" there (not a production issue).

## Decisions

- `ctx.files` real on the platform now, not per module: Dropbox is the first module that needs one; Drive and Gmail will too.
- Served-file hosting lives in the kit (not Dropbox): it is the protocol's "bytes by URL" and every file-returning module needs it.
- The refresh client app is a per-line `refresher` hook, not a registry of apps: the platform's apps already live in `services`.
- No `ctx.kv`: Dropbox is create-only, tier-0 dedup is by name within the parent folder (unchanged), `resolveEntity` returns no candidates (unchanged).
- Inbound / poll / periodic: none (Dropbox declares none today; the golden corpus has no Dropbox case).

## Tests (done tier)

- `modules/dropbox`: 28/28 (21 moved adapter tests, 3 read graph, 4 module-as-loaded). Type-check and module boundary clean.
- `module-kit`: 46/46 (3 suites; +3 new for served bytes and the wire spelling). Type-check clean.
- `apps/api` scoped (translation_graph/adapters, adapters/dropbox, services/credentials, webhook_sync, services/inbound, translation_graph/movement, output_v3, trpc/views, services/work): 150 suites, 2205 passed, 2 skipped; the one failure was a 5 s timeout of my new host test on a machine at load 30, fixed with a 60 s suite timeout and re-run green with the parity file (8 + skipped recording).
- `apps/api` type-check clean (incl. oracle config); engine boundary 766, baseline lowered 779 -> 766.
- `apps/cli` modules test 3/3, type-check clean.
- Integration tests: not run (none cover Dropbox; no `.env`). Dev loop: not booted (ev4-cleanup's job); the same fake-channels Dropbox and fake OAuth refresh are exercised by the parity and host tests instead.

## Performance (`modules/dropbox`, `pnpm bench`, interleaved, median of 5 processes, 1,500 rounds)

Run while the machine was at load average about 31 (siblings), so absolute numbers are noisy; legacy vs module are interleaved.

| | p50 | p99 | RSS | boot |
|---|---|---|---|---|
| legacy | 5.20 ms | 188.6 ms | 117.8 MB | 2264 ms |
| module (production, unvalidated) | -23.1% | -72.3% | +0.5% | -49.4% |
| module, validated | +0.5% | +8.4% | -7.8% | -56.0% |

Within +5% for the production mode on every figure. Worth re-running on a quiet machine before the gate.

## Files outside the stream

- `apps/api/.../adapters/builtin_modules.ts` (dropbox line; `payloadShape` and `refresher` on a module line; `storedCredential` refresh; real `ctx.files`; `nameFileOwner` on the factory) and `registry.ts` (dropbox import and factory, as dealroom's).
- `packages/module-kit/{server,module_server,serve}.ts` and its server test (served files, above).
- `apps/api/package.json` (dependency and build step), `deploy/Dockerfile`, `pnpm-lock.yaml` (new workspace package only), `scripts/engine-boundary-baseline.json` (lowered), `CHANGELOG.md`.
- `drive_dropbox_read.unit.test.ts`: the Dropbox half moved into the module (Drive half untouched; file not renamed).
- `apps/api/src/adapters/dropbox/{apiClient,authClient}.ts`.

## Flags for Henry

- Redeeming a returned file through a served module needs the served process to be reachable by the host at the Host header it was called with (the URL is built from it). Behind a proxy that rewrites Host, the URL would be wrong; there is no override yet.
- Served modules still get no `ctx.files.put` and no `ctx.kv` (refuse by name).
- The hosted remote-install credential binding (G4) is still conncreds'; Dropbox over `lf` needs it to run with its OAuth credential.
