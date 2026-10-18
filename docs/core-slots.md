# Core slots

The engine and the run host's rules are fixed. What they lean on is not: it is a module in a slot, chosen per project in `lf.yaml` under `core:`.

```yaml
core:
  store: "@lf/postgres-store"   # a slot omitted keeps its default
```

## The slots

| slot | what it is | default | other built-in |
|---|---|---|---|
| `models` | the model calls a run makes: `ai(…)`, `extract(…)` | `@lf/anthropic` | |
| `judge` | settles whether a written record is one already there, when the rules cannot | `@lf/judge` (declines every question, so an ambiguous match creates a new record) | |
| `store` | where run state lives: runs, parks, callbacks, work to drain | `@lf/sqlite-store` (`.lf/state.db`) | `@lf/postgres-store` |
| `files` | where documents a run stores are kept | `@lf/local-files` (`.lf/files/`) | |
| `limiter` | keeps calls to modules and models inside the providers' limits | `@lf/memory-limiter` (in lf's own process) | |

A slot accepts only a module of its own kind; `lf check` and `lf run` refuse anything else, naming the slots.

## Units: `cron` and `manual`

Two sources are the run host's own, not modules: every host has them, and a movement listens to them with no import and no `connect` (from language version 5).

```
function digest(t: <cron-[:Tick]->>) { … }
listen to cron { schedule: "0 9 * * 1", timezone: "Europe/London" } fire digest

function backfill(run: <manual-[:Invocation]->>) { … }
listen to manual fire backfill
```

- `manual` fires when you ask: `lf run backfill` here, "Run now" on the platform.
- `cron` fires on its schedule. `lf serve` and `lf drain` fire each due tick. A tick that came due while no worker ran fires once on the next drain (only the latest one missed), however many workers drain the store.

## Polled sources

A module with no webhooks declares `poll: { intervalSeconds }` in its manifest. The host then polls it for each listen on it:

- `lf serve` polls each listen on the module's interval; `lf drain` polls whatever is due.
- A poll missed while no worker ran is one poll on the next drain.
- The store keeps each listen's checkpoint, the module's own bookmark, so the next poll asks for what is new since it.
- One worker at a time polls a listen, however many drain the store (the poll is a row in the store's work queue, held under its lease).
- Each event runs the listen as a webhook's event does. An event the listen has run before (the same `idempotencyKey`) runs nothing.
- `lf run --poll <movement>` polls now, once.

## The limiter

Before every call to a module and every model request, the host asks the limiter slot. The call waits until it is granted.

- A module declares its provider's limits in its manifest. Each counts per credential, per module, per install or per team:

  ```json
  "limits": [
    { "scope": "credential", "calls": 100, "per": "10s" },
    { "scope": "module", "concurrent": 4 }
  ]
  ```

- An answer may carry `retryAfter` (seconds): the provider asked for quiet. Every call as that credential then waits that long.
- `@lf/anthropic` declares its own limit: 8 requests in flight at once, held through each request's retries.
- `@lf/memory-limiter` keeps the limits in one lf process. Two lf workers draining one store each keep their own count.
- A limiter shared by all your workers is a module filling the slot over [its wire](contracts/limiter-slot.md). Name it in `core:`, like a store module.
- The engine never sees a limit. A movement means the same under any limiter; it only waits longer.

## Filling a slot

1. Name the module in `lf.yaml`'s `core:` (not needed for a default).
2. Run `lf connect <module>`. It asks for the module's settings, keeps them in your secrets file, and runs the module's setup (the Postgres store creates and migrates its own `lf` schema).

```
lf connect                        # lists the modules lf knows, and which are set up
lf connect @lf/anthropic          # asks for api_key, and base_url for another Messages API endpoint
lf connect @lf/postgres-store     # asks for url (postgres://…?sslmode=verify-full), creates the schema
```

Settings sit under an entry named after the module without its scope (`@lf/postgres-store` is `postgres_store`). In containers and CI set them as environment variables instead of keeping a file:

```
LF_SECRET__POSTGRES_STORE__EXTERNAL=@lf/postgres-store
LF_SECRET__POSTGRES_STORE__URL=postgres://…?sslmode=verify-full
```

`lf --store <state.db | postgres://…>` overrides the store slot for one command.

A module of your own, served as a process, fills the `store` or `limiter` slot (`kind: core` in its `lf-external.yaml`; see [the store's wire](contracts/store-slot.md) and [the limiter's](contracts/limiter-slot.md)). The other slots take only lf's built-ins.

## Embedding

An embedded engine has the same four slots; you fill each with your own part of the host. See [`embedding.md`](embedding.md#5-the-host-filling-the-slots).
