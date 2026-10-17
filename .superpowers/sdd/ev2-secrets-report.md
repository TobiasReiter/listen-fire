# ev2-secrets report (decision #2, steps B1–B4)

Done. Branch ev2-secrets, cut from da4342f9. Commits: 52213cd6 (B1), 0c8c0657 (B2), 6058e62a (B3), 3af90019 (B4).

## What landed
- B1 `packages/movement-engine/services/secrets/` (exported by `public/secrets.ts`; contract by new `public/secrets-testing.ts`):
  family (`resolve`, `writeBack(ref, fields, expectedVersion)`, `update`, `refresh(ref, { seenVersion, refresher })`, `withSecret`),
  generic OAuth 2 refresher (`oauth2Refresher`, `declaredRefresher`, `declaredFields`), in-memory vault, 11 contract cases.
- B2 `apps/api/src/services/credentials/secrets_postgres.ts`: store over `external_service_credentials`.
  Dropbox refresh goes through `family.refresh`; Google and Gmail rotation write-backs through `family.update`.
- B3 `apps/cli/src/secrets.ts`: plain and SOPS file stores, environment store (read-only, warns once), a per-credential layered store; `withCredential` / `refreshCredential` keep their signatures.
- B4 `RemoteAdapter` takes an optional `credential` binding: sends the declared credential, writes back `credentialUpdate` (failures too), refreshes from the declaration or the module's `refreshCredential`, retries once on `unauthorized`. `postRpc` gains `credential` + `onCredentialUpdate`. lf binds it when an external's manifest declares a credential.

## Decisions
- Version = sha256 of the stored ciphertext (Postgres) or of the fields (files, vault, env). No schema change, no new column; every write draws a fresh nonce so any change moves it.
- Cross-process single flight = the store's `exclusive`: Postgres `pg_advisory_xact_lock` in a transaction (inside an already-open context transaction the lock is held until that one ends; the token call runs under it); lf a `<secrets file>.lock` created exclusively, stale after 30 s.
- The refresher runs only if the stored version still equals the caller's `seenVersion`; otherwise the stored (already refreshed) credential is the answer. `assertWritable` runs before anything, so a SOPS file without `sops` refuses before a token is spent.
- Payload shapes: `flatPayloadShape` (string keys pass through) and `camelTokenPayloadShape` (Dropbox/Google/Gmail `{accessToken, refreshToken, expiresAt ms}` ↔ `access_token/refresh_token/expires_at` ISO). Write-back merges into the stored JSON, so keys it does not name are kept. Small behaviour change: Dropbox and Google refreshes used to rewrite the whole payload; now other keys survive.
- Only declared fields (+ the three token fields for oauth2) are sent, and only those may come back in `credentialUpdate`; any other field refuses the call, naming field names not values.
- A `credentialUpdate` that hits a version conflict is applied with `update` (locked, last writer wins): losing a rotated refresh token is worse than replacing a newer access token.
- Credentials go only over HTTPS or loopback (`CredentialChannelRefused`), and only to a manifest that declares the binding's name.
- One credential per request (the protocol's envelope): the first declared. Written into the protocol doc.
- Errors from a refresh are redacted of every field value (`redactSecrets`); canary case proves it (mutation-checked: disabling redaction fails it).

## Not done / for other streams
- Hosted installs: `resolve.ts` passes no binding, because the stored remote manifest file does not carry `credentials` yet (ev1 left this for A0/B4). The binding is ready; A0 should store declarations and pass `{ name, secrets: createSecretsFamily({ backend: postgresSecrets({ teamId }) }), ref, client }`.
- Rust secrets backend (plan §2 lists one): not in B1–B4.
- Real sops + age: not installed here, so that suite is skipped with a reason; a stand-in `sops` (keeps plaintext beside the file, applies `set`) runs the same 11 cases.
- protocol.ts: unchanged.

## Tests
- apps/api unit, scoped (remote adapter, protocol, credentials, gmail/dropbox/google clients, remote inbound): 27 suites, 339 pass. New: vault contract 11, remote credential door 9.
- apps/api integration (test DB 9432, run alone): `secrets_postgres.integration.test.ts` 15/15 — contract 11, legacy cipher reads new ciphertext and back, camel payload keeps keys and types, shell row refused by name, two Dropbox clients → one token call.
- apps/cli `pnpm test`: 176 tests, 165 pass, 0 fail, 11 skipped (real sops). New: contract on plain, stand-in SOPS, env (33), declared oauth2 credential end to end through `lf run` (1).
- Type-check clean: movement-engine, engine-contracts, apps/cli, apps/api (engine boundary 813 = baseline).

## Files outside the stream
- `apps/cli/src/__test__/secrets_identity_files.test.ts`: the "sops unavailable" case now points at a real temp file (the old one pointed at `/secrets/lf.yaml`, which the lock file cannot be created beside).
- `packages/movement-engine/services/translation_graph/adapters/remote/index.ts` and `protocol/client.ts`: B4 by brief, but shared ground with other streams.
