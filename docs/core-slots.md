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

A slot accepts only a module of its own kind; `lf check` and `lf run` refuse anything else, naming the slots.

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

Only lf's built-in modules fill a slot today. A module of your own, served as a process, is not loaded yet.

## Embedding

An embedded engine has the same four slots; you fill each with your own part of the host. See [`embedding.md`](embedding.md#5-the-host-filling-the-slots).
