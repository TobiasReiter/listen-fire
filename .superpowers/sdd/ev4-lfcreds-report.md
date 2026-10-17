# ev4-lfcreds report

Branch `ev4-lfcreds` from 9cfa02d3. Done tier.

## What landed

- `lf connect [<module>] [--url <server url>]` sets a module up by prompts (apps/cli/src/connect.ts):
  - no module: lists installed externals (how reached, install set up or not, its credentials) and `@lf/*` packages in the project's node_modules not yet installed;
  - installs when needed: a package the project resolves → `externals/<name>/lf-external.yaml` with `module:`; otherwise a separately-run module at a server URL (asked, or `--url`) with `auth: bearer server_secret`; a failed manifest read removes what it installed;
  - asks the install's secrets: the server secret (external's `auth` field), the webhook secret (enter generates one) when inbound is declared, and for OAuth 2 modules the app's client id, client secret (empty = public client) and the registered loopback port; prints the redirect URIs to register (loopback, and `<publicUrl>/oauth/callback` when lf.yaml has publicUrl);
  - never asks for a user credential.
- `lf credential add --module <m> [name] [--credential <declared>]`, `update <name> [--no-reauthorize]`, `delete <name>`, `list` (apps/cli/src/credentials.ts). Names mirror the platform's credentials router (list/add/update/delete; name + type ↔ name + module).
- Sign-in redirects (apps/cli/src/oauth_redirect.ts): loopback (default, port from `--redirect-port` or the install's `redirect_port`, 0 = any), `--headless` (paste the redirect URL; needs a fixed port), `--public` (redirect to `<publicUrl>/oauth/callback`; lf serve hands it over through `.lf/oauth/<sha256(state)>`, only where a waiting marker exists).
- Prompts (apps/cli/src/prompt.ts): line by line, so answers can be piped; secrets not echoed on a TTY.

## Field names — for ev4-conncreds

- User credential entry: `module: <external name>` + `credential: <declared credential name>`, then fields (tokens, static fields).
- Install entry (`lf connect`): `module: <external name>` alone, then `server secret field`, `webhook_secret`, `client_id`, `client_secret`, `redirect_port`.
- Hand-written entry: `external: <name>`, read as before (install and credential in one). `lf credential update` rewrites it to `module` + `credential`, keeping its name and every field (so its webhook URL `/hooks/<ext>/<name>` and its own client id still work).
- In memory (apps/cli/src/secrets.ts): `Credential.external` is the owner for every kind; `Credential.binding?: { kind: 'legacy' } | { kind: 'install' } | { kind: 'credential'; declared }` (absent = legacy, so hand-built test credentials need no change); helpers `bindingOf`, `installOf(credentials, external)`.

## Gaps left for ev4-conncreds (runtime, not this stream's files)

- A credential made by `lf credential add` holds no server secret and no OAuth client. The runtime must take them from `installOf(...)`:
  - remote.ts `secretOf` (the bearer secret) and the declared refresh's `client`.
  - Until then, `lf run` with a split credential fails ("has no token field"); a migrated hand-written entry works (tested).
- sources.ts `catalogOf` still lists install entries as credentials a `using` may name; it should list only `credential` and `legacy` kinds.
- externals.ts `credentialFor` (first entry for the external) may now return the install for `connect x` without `using`.

## Other gaps

- Module config: the protocol declares no install config, so `lf connect` asks for none.
- Shell autocompletion: not done; `lf connect` with no argument lists the modules.
- Rust lf-host has no credential commands; `LF_BIN=… connect.test.ts` would fail. It now reads module-bound entries.

## Tests

- apps/cli/src/__test__/connect.test.ts (replaces wave 3's): 12/12 pass — connect listing, install written, separately-run install refused and undone, loopback add, headless paste, public through lf serve, refusals (not installed, no OAuth app, refused sign-in writes nothing), hand-written entry migrated then refreshed by `lf run`, static add/update/delete on plain and SOPS (stand-in sops with set/unset; real sops absent here), environment refused.
- Whole apps/cli set: 203 pass, 0 fail, 12 skipped; the two Rust parity files timed out at a 120 s cap while cargo built; rerun alone: 17/17 pass.
- crates/lf-host: `cargo test secrets` 1/1; clippy clean.
- `tsc --noEmit` apps/cli clean.

## Files outside this stream

- apps/cli/src/secrets.ts (entry parsing, whole-entry writes, `installOf`), apps/cli/src/main.ts (commands), apps/cli/src/serve.ts (GET /oauth/callback, one route), crates/lf-host/src/secrets.rs (reads `module`/`credential`), examples/lf-acme/secrets.example.yaml (comments).
