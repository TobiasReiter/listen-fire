# ev4-conncreds report

Branch `ev4-conncreds` from 9cfa02d3. ev4-lfcreds was MERGED in (f27c6c19), not cherry-picked. Done tier.

## Done

- The design works end to end (Henry's Alice/Bob acceptance), on the platform and in TS lf:
  - one HubSpot-like remote module (served as its own process by serve-module);
  - one install, holding the server secret and the host's OAuth app;
  - two user credentials;
  - a movement listens as Alice and writes as Bob;
  - Alice's expired token is refreshed by the host, and the rotated tokens land on her credential only.
- What `using` meant before, for a remote module:
  - Platform: `using` could name only the install's own server-secret row. Any other credential was refused at run time. Remote credentials were never offered to the checker. No module was ever sent a declared credential.
  - lf: `using` named one hand-written entry holding both the server secret and the provider fields.
  - So no saved movement depended on `using` meaning the server secret. No version conditional was added.
  - Hand-written lf entries still work as before. On the platform, naming the install's own row still means "no provider credential".
- What `using` means now: always the provider credential. The install's secret signs every call.

## Decisions (why)

- Platform binding is stored as a new nullable column, `external_service_credentials.declared_credential`. `app_id` is the module's slug. The declared credential name has to be known to the checker without decrypting anything. A column is compared, never parsed; a name packed into `app_id` would have to be parsed. Existing rows and ciphertext are untouched.
  - The migration was written by hand, mirroring schema.sql. The Kysely type and the Prisma schema were also edited by hand. `schema:generate` and `schema:apply` need apps/api/.env, which I may not read.
  - The integration run applied the migration to the shared test DB on 9432 (`20261017_150000_credential_declared_credential.sql`).
- The host's OAuth app lives in the install's encrypted payload, as `oauthClients[<declared name>]`. It is optional, so stored installs still parse.
- Checker rule: same code `MOV_CRED_WRONG_ADAPTER`, with a new message for "fills a credential the module does not declare". The catalog snapshot gains two optional fields: `credentials.<name>.credential` and `adapters.<name>.declaredCredentials`. Wasm artifacts were rebuilt.
- lf field names follow lfcreds: `module` + `credential`.
  - The catalog never offers install entries to `using`.
  - `credentialFor` never picks the install.
- Behaviour change in lf: a module that declares a credential must now be connected with `using` (`connect dealroom` became `connect dealroom using dr` in modules.test.ts). This matches the platform. A module that declares no credential connects as itself once its install entry exists.

## Tests

- lf acceptance `apps/cli/src/__test__/alice_bob.test.ts`: 2/2. Covers the run, and the check refusing the install, another declaration's credential and another module's.
- Platform acceptance `remote/__test__/alice_bob.integration.test.ts`: 1/1. Nothing is mocked: real catalog, real dispatch, real engine, test DB on 9432.
- Integration, one run: remote, credentials, catalog_connect and adapter_doors suites, 75/76.
  - The one failure was adapter_doors. A cross-team drain picked up 31 leftover work rows other suites had left in the shared DB.
  - adapter_doors alone: 14/14.
- Unit tests:
  - apps/api remote and catalog: 207/207.
  - movement-lang: 5311 pass, 13 skipped.
  - Checker twin tests: TS 3 and Rust 3, with the TS and Rust diagnostics required to match exactly.
  - apps/cli suite: 175/175 (12 skipped), after the dealroom fix.
  - lf-host parity files: 47/47.
- cargo:
  - lf-host 38/38; movement-checker all pass.
  - The `hang.rs` timing tests failed under load average 40 and passed when rerun alone.
  - clippy is clean.
- Type-check is clean: apps/api (engine boundary 779, unchanged), movement-engine, apps/cli, movement-lang.
- `pnpm checks:corpus`: see the last section.

## Gaps

- lf-host does not send declared credentials or refresh them (that is G4). It refuses to run a connection with a user credential, saying so. The lf-host check path honours the bindings.
- The platform has no UI, tRPC route or connect link for creating a provider credential yet. Only the service `mintRemoteModuleCredential` exists, and the test uses it.
- module-kit `module_server.ts` (owned by ev4-plugins) accepts only the FIRST declared credential. A module with two declared credentials would refuse a connection that fills the second.
- A per-team export of credentials does not carry `declared_credential`. Not checked.

## Files outside this stream

- apps/cli: remote.ts, externals.ts, sources.ts, host.ts, runs.ts, doors.ts (`hookTarget` uses `installOf`), and `__test__/modules.test.ts`. lfcreds handed the lf run path to me.
- crates/lf-host: secrets.rs, externals.rs, remote.rs, catalog.rs.
- movement-engine: adapter.ts (`declaredCredentials`), catalog_snapshot.ts, schema_projection.ts.
- movement-lang: catalog.ts, snapshot.ts, check.ts. Rust: movement-parser catalog types, movement-checker systems.rs.
- docs/contracts/catalog-snapshot.md.
- apps/api: persist_credential.ts, remote_credential.ts, install.ts, resolve.ts, catalog.ts, schema.sql plus the migration and the generated types.

## Checks corpus

- `pnpm checks:corpus` passed (exit 0), so the checks pin is unchanged. The new rule fires only when the new binding fields are present, and the corpus has none.
  - `harvest:checks` was not run: nothing needed re-pinning.
  - During the partial "readers" step, the upgrade-corpus rate assertion failed (82.7%, below its floor). The script expects that and says those assertions are checked over the complete corpus. The final step over the complete corpus passed.
- lf-host's `Binding` enum (Legacy | Install | Credential(declared)) has the shape lfr-secrets copied. It is unchanged.
