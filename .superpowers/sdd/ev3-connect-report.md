# ev3-connect (C6) — manifest-driven connect links

Branch `ev3-connect` from 30843618. Commits: fa9e587a (snapshot first), a958bb63 (connect flow + platform move), 305b6220 (fake provider + connect cases), 3d9c6891 (`lf connect`).

## Done
- `packages/movement-engine/services/secrets/connect.ts` (exported from `public/secrets`):
  - the authorize URL from a manifest `credentials[].oauth2` declaration (authorizeUrl, scopes, pkce S256, authorizeParams; a shell may pass its own signed state);
  - the code exchange at tokenUrl, client in Basic or body per `clientAuth`, the error text with secrets taken out;
  - a per-app connector (15 minute single-use attempt by state);
  - `createPendingStates` (the TTL store, with peek and take);
  - `storeGrant`, which writes through the secrets family's `update`, so the tokens merge over the stored fields under the store's lock.
- `oauth2.ts`: the refresh and the exchange share one function that places the client credentials (Basic header or form body); the refresh behaves exactly as before.
- The platform: Attio, Airtable, Dropbox, Google (Sheets/Drive) and Gmail authClients each define a declaration constant (the future module manifest). Their install URL and code exchange now run on the connector.
  - Kept the same: the callback URLs, the 100 byte state and 96 byte verifier, the 15 minute single-use state, and each `codeToToken` return shape. Stored payloads are unchanged.
  - `lib/oauthFlows.ts` keeps its exports and semantics (read without consuming, 15 minutes) on `createPendingStates`.
- `lf connect <credential> [--redirect-port N] [--no-browser]` (`apps/cli/src/connect.ts`):
  - reads the external's manifest for its oauth2 declaration;
  - prints the URL and opens it in the browser;
  - takes the redirect on a 127.0.0.1 listener, exchanges the code, and writes the tokens to the secrets file through `secretsOf(credential)` (SOPS or plain, under the lock file).
- A fake OAuth provider, `services/secrets/fake_oauth_server.ts`, exported from `public/secrets-testing`:
  - an authorize page that consents at once;
  - a token endpoint for the code and refresh grants that checks client auth, redirect and PKCE, uses each code once, and rotates refresh tokens.
  - ev3-oauthfake had not landed (no commits in its worktree), so this is a minimal one in tests.

## Decisions (why)
- **"Identical authorize URL"** means the same endpoint plus the same parameter set and values, with state and challenge masked to their lengths. Parameter order and `+`/`%20` encoding are not compared. Byte identity would have needed a per-flow parameter order option, which is complexity with no effect on providers.
- **Slack stays on its own installer flow.** Its URL has comma-joined scopes and no `response_type`, its state is a signed JWT, and its token answer is HTTP 200 with `ok:false`. The connect flow always adds `response_type=code`, so moving Slack would change its URL. It moves when Slack becomes a module. Its snapshot is pinned.
- **Connect-link minting stays in apps/api.** That is the connect_token table, user names and adapter-kind classification. It is database-bound, and engine code may not touch the DB. Only the OAuth mechanism moved, plus oauthFlows' generic store.
- **lf connect needs the secrets entry to exist first**, with `external`, `client_id` and optionally `client_secret`. Those values belong to the operator. This also means the secrets family needs no "create" operation. An environment-only credential is refused, because there is no file to write to.
- **The declaration is chosen as follows:** the external's single oauth2 credential, or the one named like the secrets entry when it declares several.

## Deviations to know
- **Airtable's code exchange now percent-encodes the client id and secret inside Basic auth**, as the host refresh already does (RFC 6749). The output is identical for alphanumeric ids and secrets. Airtable's own refresh (`exchangeRefreshToken`) is untouched and still sends them raw.
- **Google and Gmail code exchanges no longer go through google-auth-library's transport.** That transport retried on 5xx. A failed exchange now throws `OAuth2ExchangeFailed`, with secrets taken out of the text, instead of a GaxiosError. The library still does the token use and rotation.
- **Dropbox now requires `expires_in` on its exchange answer.** Before, a missing value silently stored NaN.
- **A reconnect whose grant lacks a refresh token or an expiry keeps the stored ones**, because the write-back merges.
- **The Rust `lf-host` has no `connect`.**

## Tests
- apps/api scoped unit set: adapters/{attio,airtable,dropbox,google,gmail,slack}, services/credentials, public_entries, adapters/remote. That is 23 suites and 266 tests passing, including the 13 snapshots recorded before the move (`oauth_connect_flows`: 7 authorize URLs, 5 code exchanges) and 6 connect cases against the fake provider (`secrets_connect`).
- apps/cli `pnpm test`: 186 tests, 175 pass, 0 fail, 11 skipped. That includes the new `connect.test.ts` (3 tests):
  - connect end to end, then a run that refreshes the connected token from the declaration: one token call, and the rotated token is written back;
  - a refused consent writes nothing;
  - a missing entry gets an error saying what to add.
- Type-check passes for apps/api (with the engine-boundary guard: 799, equal to the baseline), movement-engine and apps/cli.
- No integration tests were run. `catalog_connect.integration.test.ts` uses the connect link, whose minting is unchanged.

## Files outside this stream
- None owned by another wave-3 stream. protocol.ts was not touched: the declaration type is derived from the schema with `z.infer`.
