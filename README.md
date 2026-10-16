# Listen-Fire

Listen-Fire runs small programs over the systems a team already uses. A program is a plain text file with a `.mvt` extension, written in a language called movement: it names the systems it touches, traverses them as graphs of records joined by edges, and moves data between them. The platform around it holds the connections and their credentials, receives the inbound events, runs the programs, parks them when they need a person to answer something, and resumes them when the answer arrives.

## Listen and fire

An automation **listens** to something in one of your systems and **fires** a named automation in response. That is the whole shape of a program, and it is where the name comes from.

```
import { `@lf/email` as email, `@lf/attio` as attio } from adapters
import { acme_main } from credentials

inbox = connect email
crm   = connect attio using acme_main

function `Inbound Intake`(msg: <inbox-[:Email]->>) {
  write crm-[:Companies]-> {
    unique by (Name)
    Name: msg.Subject
  }
}

listen to inbox { key: "intake" } fire `Inbound Intake`
```

The event that arrives is a *position*: a point in the graph of the system it came from. From there the program traverses to related records, fans out across them, and writes into other systems along their own edges. `unique by` makes a repeat update an existing record instead of duplicating it.

The language lives in [`packages/movement-lang`](packages/movement-lang). The reference the authoring agents read is the handbook under [`apps/api/src/lib/knowledge/movement_handbook/chapters`](apps/api/src/lib/knowledge/movement_handbook/chapters); `foundations.ts` and `anatomy.ts` are the two to start with.

## What you can connect

Each system is reached through an adapter, which presents it as a graph. The adapters in the tree are:

| adapter | system |
|---|---|
| `slack` | Slack |
| `email` | inbound and outbound email |
| `gmail` | one Gmail mailbox, read and written as itself |
| `whatsapp` | WhatsApp, via the Meta Cloud API |
| `telegram` | Telegram, via the Bot API |
| `attio` | Attio |
| `affinity` | Affinity |
| `airtable` | Airtable |
| `google_sheets` | Google Sheets |
| `google_drive` | Google Drive |
| `dropbox` | Dropbox |
| `granola` | Granola meeting notes |
| `evertrace` | Evertrace |
| `dealroom` | Dealroom |
| `kg` | the built-in knowledge graph |
| `ask` | a question put to a person, answered on a link |
| `cron` | a schedule |
| `manual` | an on-demand run |

The valuations unit is reachable the same way, as a system of its own. Beyond these, an adapter can also live outside this repository and be reached over a wire protocol; see [`apps/api/src/services/translation_graph/adapters/remote`](apps/api/src/services/translation_graph/adapters/remote).

## Self-hosting

Listen-Fire comes apart into five units (`core`, `knowledge`, `automations`, `valuations`, `asks`) which are the same image with a different environment. You name the ones you want.

```bash
git clone https://github.com/listen-fire/listen-fire.git && cd listen-fire
cp deploy/.env.example deploy/.env      # set ANTHROPIC_API_KEY, or set nothing and add --demo
./deploy/up.sh knowledge automations    # any combination of the five units
```

`up.sh` pulls the published images, waits for the stack to answer, and prints the web URL and the credential to sign in with. Add `--demo` to run against stand-in third-party services and a sample dataset, with no API keys at all, or `--build` to build from your checkout instead (give Docker about 8 GiB; the first build takes several minutes).

A release is a git tag, and the images are published at it. **Pin `LISTEN_FIRE_VERSION=v0.1.0` in `deploy/.env` and the installation moves only when you change that line** — see [`deploy/UPGRADING.md`](deploy/UPGRADING.md), and [`CHANGELOG.md`](CHANGELOG.md) for what each release changed.

The web UI answers on port 8080 and the API on 8081. To stop it again, see ["Stopping and removing"](deploy/SELF_HOSTING.md#stopping-and-removing) — `down` keeps your data and `down -v` destroys it, including the volume holding the keys every stored credential is encrypted under. For a deployment behind a real hostname, put the settings in `deploy/.env` and run `docker compose` yourself:

```
LISTEN_FIRE_PRODUCTS=knowledge,automations
LISTEN_FIRE_PRINCIPAL=static            # `core` when the unit list includes core
API_BASE_URL=https://api.example.com
WEB_BASE_URL=https://app.example.com
```

[`deploy/SELF_HOSTING.md`](deploy/SELF_HOSTING.md) is the runbook: every variable, what the installation generates for itself on first boot, what to back up, and which values must never be rotated. [`deploy/guides/`](deploy/guides/README.md) translates it onto Render, AWS and Vercel, and covers bringing your own identity provider.

## Talking to it from Claude

The API serves three MCP connectors, each mounted only when its unit runs: `/api/v1/mcp/automation` builds and runs automations against your real connected systems, `/api/v1/mcp/knowledge` queries and edits the knowledge graph directly, and `/api/v1/mcp/valuations` answers what you own and what it is worth. Each carries its own instructions and tool set, so an agent that connects to one is told how to use it; the automation connector additionally serves the movement handbook, which is what an agent reads before it writes a `.mvt` file. The definitions are in [`apps/api/src/interfaces/mcp/connectors`](apps/api/src/interfaces/mcp/connectors).

## Repository layout

Applications:

- [`apps/api`](apps/api): the API. One long-running process, with the background workers, schedulers and the movement engine inside it.
- [`apps/web`](apps/web): the web UI (Next.js), including the automation authoring surface.
- [`apps/admin`](apps/admin): the operator console, served only on a `core` installation.
- [`apps/fake-channels`](apps/fake-channels): stand-in implementations of the third-party services, used by the dev loop and by `--demo`.

Packages:

- [`packages/movement-lang`](packages/movement-lang): the movement language: parser, checker and type model.
- [`packages/principal`](packages/principal): the identity contracts (Principal and Directory) that `core` and the single-tenant stub both satisfy.
- [`@listen-fire/shared`](packages/shared): types and helpers shared between the API and the web app.
- [`@listen-fire/trpc`](packages/trpc): the generated tRPC types the web app builds against.
- [`packages/story-view`](packages/story-view): the shareable picture of an automation's structure.

Also: [`deploy/`](deploy) for the container images, compose file and self-hosting runbook, and [`docs/`](docs/README.md) for the contributor and API documentation.


## Developing

[`CONTRIBUTING.md`](CONTRIBUTING.md) covers setup, the dev loop that boots the whole stack with fake third parties, the schema and codegen workflows, and how to run the tests.

## Licence

Apache License 2.0. See [`LICENSE`](LICENSE), and [`NOTICE`](NOTICE) for third-party attributions.
