# Verifying a remote adapter (homespun CRM)

Scaffolding to prove the remote-adapter subsystem works end to end against a
user-supplied "remote" adapter, without needing a real third-party system. The
stand-in is a **fake CRM** (`fake_crm_adapter.ts`) with one writable record
type, `Company` (fields `Name`, `Description`), served behind the same wire
protocol a real remote-adapter server speaks.

There are two levels of proof:

- **A — No-DB round-trip test** (fast, no dev loop): a `RemoteAdapter` driving
  the fake CRM over a real HTTP socket (ephemeral port). Proves `describe` +
  `createRecord` cross the wire.
- **B — Full dev-loop e2e** (`pnpm dev:remote-verify`): installs the fake CRM
  as a `remote_adapter` for the dev-loop team and runs a real movement that
  writes a Company to it through normal dispatch.

## The durable fixture (why `acme_crm` stays inspectable)

The fake CRM is a **standing dev-loop service**, not just something a verify run
conjures. `dev/loop.sh` starts it (`pnpm dev:fake-crm`) on this profile's
`FAKE_REMOTE_ADAPTER_PORT` — harness base + 2, so `default` gets 5557 and
`agent` gets 6057 — alongside fake-channels, and `pnpm dev:seed` installs the
`acme_crm` `remote_adapter` row pointing at it.

This exists because a `remote_adapter` ROW outlives the process that wrote it.
When the only installer was `dev:remote-verify` binding port 0, the row went
stale the moment that script exited, and `acme_crm` — the loop's only remote
adapter — rendered as `Error: fetch failed` in the graph explorer.
A profile-assigned port makes the installed URL a standing
promise. The install is an upsert on `(team, adapter_type)`, so **re-running
`pnpm dev:seed` heals a stale row** rather than duplicating it.

`dev:remote-verify` still spins its OWN ephemeral server (so it proves the path
from nothing, with no fixture required) and re-points the row back at the
durable fixture on the way out.

## A. No-DB proof (test)

No prerequisites beyond the repo — it touches no Postgres (it runs under the
integration jest config only because that config owns real-transport
`*.integration.test.ts` files).

```bash
# from apps/api
pnpm test:integration --testPathPattern 'fake_crm_adapter'
```

Expected: both tests pass —

```
PASS src/scripts/dev/__test__/fake_crm_adapter.integration.test.ts
  Fake CRM RemoteAdapter round-trip (over real HTTP, no Postgres)
    ✓ describe(Company) round-trips over the wire with a writable Name field
    ✓ createRecord(Company) reaches the fake CRM in-memory writes over the wire
```

## B. Full e2e (dev loop)

Prerequisites:

1. The dev loop must be **free** — only one `dev:loop:agent` stack can hold the
   shared Postgres/Redis at a time. This harness does not boot the loop; it uses
   the same DB + dispatch path, so the DB must already be up (started by the
   loop) and not mid-migration.
2. The dev-loop team must be seeded:

   ```bash
   pnpm dev:seed
   ```

Then run:

```bash
# from apps/api
pnpm dev:remote-verify
```

What it does: starts its own fake CRM on an ephemeral port, ensures the dev-loop
team, then does the **real one-step install** —
`installRemoteAdapterFromManifest` with the bearer secret, which mints an
encrypted `REMOTE` credential (`app_id` = the adapter slug) and links it onto
the install — saves a movement that writes a `Company` on a manual invocation,
and fires it with `runMovementNow`.

Expected output ends with:

```
[remote-verify] fake CRM listening at http://127.0.0.1:<port>/
[remote-verify] installed remote adapter 'acme_crm' + minted its REMOTE credential (<uuid>)
{ "run": { "ok": true, "recordCount": 1, ... }, "fakeCrmWrites": [ { "externalId": "company-1", "fields": { "Name": "Vireo Robotics" } } ] }
[remote-verify] PASS — Company reached the fake CRM (recordCount=1)
[remote-verify] restored the durable 'acme_crm' install → http://127.0.0.1:<stable port>/
```

A non-zero exit + `FAIL` line means either the movement did not save live or the
write never reached the fake CRM.

## Credential provisioning (now first-class)

Remote-adapter secrets are provisioned through `ExternalServiceType.REMOTE` — an
encrypted `{ secret }` credential whose `app_id` is bound to the adapter slug, so
a secret minted for one remote adapter can never drive another (`resolveAdapter`
enforces it). Two surfaces, both via `mintRemoteCredential`:

- **One step (web):** the install takes the secret alongside the manifest and
  mints + links it in one operation — what `dev:remote-verify` exercises.
- **Out-of-band (agent):** a `/api/connect` key-entry link lets the user paste
  the secret in the browser; the submit mints it and writes the FK back.

## Known gaps this surfaces

- **Catalog "needs connecting" surface.** A remote install with no credential
  yet resolves to a clear runtime error ("no credential configured"), but the
  authoring catalogue does not yet proactively flag "installed, connect the
  secret" (its `requiresCredential` stays false to keep construction
  credential-free). Follow-up: a remote-aware connected-state derived from the
  install's `credentials_id`.
- **Inbound is covered by the dev loop, not by this harness.** The fake CRM
  is now the reference protocol-2 adapter (`docs/contracts/adapter-protocol.md`): a
  `Company` comment thread an automation can `await`, and dev routes that
  push `emit` / `wake` to the API (`pnpm dev:inject crm-company`,
  `pnpm dev:inject crm-comment`, `pnpm dev:inspect crm`). The walkthrough is
  the "Build your first adapter" section of that doc. This harness still
  proves only the write path.
- **Some web views are static-only.** The Adapters/integrations UI projects an
  installed remote manifest via `remoteAdapterManifest`, but this harness
  verifies only the engine + wire path, not the editor/catalogue rendering of a
  remote install.
