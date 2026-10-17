# Getting started with `lf`

`lf` runs movements from a project folder on your machine. Build it with `cargo build --release -p lf` (the binary is `target/release/lf`), or install a release.

## 1. Make a project

```
lf init my-project && cd my-project
```

This writes `lf.yaml`, `movements/`, `externals/` and `.lf/` (run state and secrets, git-ignored). `lf.yaml` pins the engine version the project runs on.

A working project to read or copy is [`examples/lf-acme`](../examples/lf-acme): one movement, one external, a sample secrets file.

## 2. Write a movement

Put a `.mvt` file in `movements/`:

```
import { acme_crm } from adapters
import { acme } from credentials

crm = connect acme_crm using acme

function welcome(company: <crm-[:Company]->>) {
  write crm-[:Company]-> { Name: "Welcome ${company.Name}" }
}

listen to crm { events: ["company.created"] } fire welcome
```

`lf check` prints every diagnostic; fix them before running.

## 3. Connect a module

A system is reached through an external: a folder in `externals/` holding an `lf-external.yaml` that says how the host starts or reaches it.

```
lf connect              # lists the modules lf knows
lf connect <module>     # installs it and asks for its server secret, webhook secret and OAuth app
```

## 4. Add a credential

```
lf credential add --module <module> my_credential
```

This signs you in at the provider (OAuth) or asks for the module's fields, and stores the result in `.lf/secrets.yaml`. A movement names it with `import { my_credential } from credentials`. `lf credential list|update|delete` manage the rest. In containers and CI, set `LF_SECRET__<NAME>__<FIELD>` instead of keeping a file.

## 5. Run

```
lf run --event events/company_created.json     # route one event to the listens it matches
lf run --event events/company_created.json --dry-run
lf runs                                        # the runs, most recent first
lf resume [<run-id>]                           # step a parked run, or every due one
```

## 6. Serve

```
lf serve [--port N]
```

`lf serve` receives webhooks and callbacks and drains due work, so listens fire on their own. Set `publicUrl` in `lf.yaml` when the outside world reaches it at another address. `lf call <callback-id>` and `lf cancel <run-id>` act on a parked or running run.

## 7. Upgrade a project

`lf upgrade --check` prints what would change; `lf upgrade` rewrites the movement files into the current language version.
