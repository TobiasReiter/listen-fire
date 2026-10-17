# ev4-google — Google Sheets, Google Drive and Gmail as modules

Branch `ev4-google`, cut from `cloud-native` at 9cfa02d3. Not pushed. Done tier only.

## Read

- **Done: all three Google integrations are modules, and their lines are flipped.**
  - `@lf/google-sheets` (`modules/google-sheets`), `@lf/google-drive` (`modules/google-drive`), `@lf/gmail` (`modules/gmail`).
  - Each one's `BUILTIN_MODULES` line says `module`; switching back is that one line.
- **Parity holds in three subjects for each, from a recording made before any code moved.**
  - The subjects: the legacy line, the module in process through the platform registry, and the module served as a process (`serve-module`) over protocol 2.
  - Gmail was recorded twice: once for a mailbox somebody signed into, once for a mailbox the service account acts as (delegated).
- **Decision needed: protocol 2 drops two fields, so a served module loses them.** (The file is ev4-conncreds' this wave, so I did not edit it.)
  - A polled event's `idempotencyKey` does not cross the wire (`WireDiscriminableEvent` has no such field). On the platform Gmail runs in process and keeps it. A Gmail module served elsewhere loses the delivery key that stops a resync from running a message twice.
  - A read file's `size` does not cross either (the wire `resolveFileRef` answer is a url and a content type).
  - The fix in both cases is one optional field in `packages/engine-contracts/protocol.ts`, plus passing it through in the remote adapter and the server kit.
  - Until then, the served-module parity test removes exactly these two fields from the recording before comparing, and names them.
- **Bench: every module line is within +5% of legacy at p50, p99, RSS and boot.** (Numbers below; each was taken at a load average under 6.)
- **Gmail has no push route, so no inbound is declared.** The inbound golden corpus passes unchanged.

## Gmail — what was moved, and the choices made

- **The poll is the module's declared poll.** It keeps the same 60 second interval and the same checkpoint shape: `historyId`, `lastSeenAt`, `pending`.
- **No ctx.kv was added for dedup.** A message is not delivered twice because each event carries `idempotencyKey: gmail:<message id>`. The platform's event store keys on that (the "record bindings" option in the brief). Over protocol 2 this key is lost; see above.
- **Both credential shapes reach the module as one set of fields.** The fields are `access_token`, `mailbox`, `method`, `granted_scopes`, and, for a delegated mailbox, `send_access_token` or `send_refusal`. The module never sees a refresh client or a service account key.
  - Signed in: the platform reads the stored tokens through the secrets family. It refreshes them five minutes before expiry with the installation's Gmail OAuth client (the fake Google under the dev loop), and stores them back in the old shape. Granted scopes are never written back.
  - Delegated: the service account mints one token per scope. The platform holds them in memory until they near expiry and never stores them.
  - Before, every adapter call minted a new token. Now one pair serves until it nears expiry. The cost is one send token minted per hour even for a mailbox that only reads.
  - A grant without the send scope keeps reads working, and the send fails naming the missing scope, as before. Any other failure to mint the send token fails the call and caches nothing.
- **The mailbox allowlist is checked by the platform before the credential is handed over.** It is policy, not module code. Delegation is refused while the list is unset, as before.
- **Attachments are file handles from the Drive slice.** A file a message carries names itself by the module's handle (`moduleFileRef`), and the host names it as the install's. A file handed to a send is read at its url, or else through `ctx.files`, which is the platform's file reader.
- **The provider client keeps googleapis, holding one token per scope.** gaxios sends through the caller's fetch. A send uses the send scope's token and a read uses the read scope's token.
- **A module line may now supply its whole credential.** This is the `credential` hook in `builtin_modules.ts`, for when reading the stored payload is not enough. Gmail is the first user.
- **Deviation, dev loop only.** A delegated mailbox now sends a placeholder bearer token to the fake. Before, it sent an API key query parameter. The fake reads neither. The delegated recording compares requests without authentication for this reason.
- **The platform keeps its own users unchanged.** `GmailApiClient` keeps the same constructor, now built over the module's client. The stored shapes, the connect checks and the allowlist stay in `apps/api/src/adapters/gmail/apiClient.ts`. The legacy line is the module's adapter and poll over the old credential path, resolved per call.

## Sheets and Drive (from the earlier commits)

- **Sheets** (223a0802 recording, 34193e53 kit additions, a1ff6fe7 move, f58d7839 flip): the recording covers 82 calls and 376 requests.
  - Granted spreadsheets and the team's emails come from `ctx.kv`. On the platform that is the existing grants table, so nothing migrates.
  - The platform refreshes a Google token itself, five minutes before expiry, through the secrets family. It stores the token back as the connect flow wrote it.
  - `serve-module` keeps state in files when `MODULE_STATE_DIR` is set, and reads construction arguments from `MODULE_CONSTRUCTION_ARGS`.
- **Drive** (d904fad2 recording, 1084bc37 files both ways, c9ec4bca move, b6783959 flip, 26fe39fe bench): a module can now read files out and be handed files in.
  - `moduleFileRef` and `readHandedFile` in module-kit.
  - `ownedFilesAdapter` on the engine's public modules entry: the remote adapter's renaming of a module's files as the install's, now shared with in-process module lines.
  - `servedFiles` in serve-module: a file's bytes at a one-time URL.
  - `platformModuleFiles` in apps/api.
- **The Sheets grants integration suite was not run.** `apps/api/.env` is absent in this worktree. Gmail has no integration suites.

## Bench (hosted, interleaved, 5 runs each, medians)

| Module | When | Load | Legacy p50 / p99 / RSS / boot | Module vs legacy |
|---|---|---|---|---|
| Drive | 26fe39fe | ~3.9 | 0.786 ms / 2.652 ms / 309.5 MB / 818.7 ms | p50 +0.8%, p99 +1.9%, RSS +3.9%, boot −1.5% |
| Gmail | 3f8198ff | ~2.3 | 1.504 ms / 3.952 ms / 566.7 MB / 753.2 ms | p50 +0.7%, p99 −2.5%, RSS +0.1%, boot +1.0% |
| Sheets | re-run 2026-10-17 | ~2.5 | 1.092 ms / 3.130 ms / 295.3 MB / 152.9 ms | p50 +0.9%, p99 +4.3%, RSS +0.5%, boot +1.5% |

_Aside:_ the `validated` mode (answers checked against the protocol, as outside hosted production) is slower by design. It is reported by each bench for reference and is not gated.

## Tests (done tier)

- Gmail module: 71 unit tests (`modules/gmail`, `pnpm test`), type-check and module boundary clean.
- apps/api scoped set (Gmail and all adapters, credentials, inbound, the Gmail credential modal): 76 suites, 1283 passed, 5 skipped. This includes the Gmail parity suite (8 replay tests across two shapes and three subjects), the inbound golden corpus unchanged, and the new platform credential tests (11).
- apps/api `code:type-check` is clean. The engine boundary baseline went down: 779 → 765 (Sheets), 765 → 754 (Drive), 754 → 745 (Gmail).
- No integration tests were run.

## Files outside this stream

- `packages/module-kit` (ev4-plugins' core files, kept minimal): `define.ts` (`ModuleKv.list`), `in_process.ts`, `index.ts`, `module_server.ts`, `serve.ts`, `server.ts`; new `file_kv.ts`, `files.ts`, `served_files.ts`.
- `packages/movement-engine`: `public/modules.ts` (exports `ownedFilesAdapter`); `adapters/owned_files.ts` (new, moved out of `remote/index.ts`); `protocol/client.ts` (parses its JSON in its own realm).
- `apps/api/src/services/translation_graph/adapters/builtin_modules.ts` is shared with Dropbox. It gained these generic line hooks: `storedAs`, `hostApp`, `harnessService`, `kv`, `files`, `credential`.
- `packages/engine-contracts/protocol.ts` was not touched (the two gaps above).
