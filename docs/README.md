# Documentation

- [`dev-loop.md`](dev-loop.md): the local development loop. Boot the whole stack against real Postgres and Redis and fake third-party services, drive the knowledge agents and the UI, inject synthetic inbound events, and inspect what the system did. This is how a change is verified end to end without an account anywhere. [`CONTRIBUTING.md`](../CONTRIBUTING.md) has the short version.
- [`getting-started-lf.md`](getting-started-lf.md): running movements from a project folder with the `lf` command. [`core-slots.md`](core-slots.md): the modules `lf.yaml`'s `core:` chooses (models, judge, store, files). [`embedding.md`](embedding.md): running the engine inside your own product.
- [`api-ingest.md`](api-ingest.md): the ingest API: submitting records over HTTP with an API key. [`api-ingest-slack.txt`](api-ingest-slack.txt) is the same content formatted for pasting into Slack.
- [`contracts/`](contracts/README.md): the five versioned contracts the movement core speaks, with an index of the versions each release supports and deprecates. The catalog snapshot, the parked run state, the host families (the boundary between the engine and the code that runs it, and the entry points), the adapter protocol a remote adapter serves, and the language versions.
- [`engine-host.md`](engine-host.md): how this repository's two hosts serve the host families: spend metering, the cross-run write locks, the production and test hosts, and what stays outside the contract.
- [`language/steady-lynx-migration.md`](language/steady-lynx-migration.md): migrating an automation to language version 3, Steady Lynx. Every rule that changed, grouped by topic, with the diagnostic codes and their rewrites.
- [`security-google-oauth.md`](security-google-oauth.md): the security posture of the Google OAuth integration, written against the CASA Tier 2 requirements.

Deployment documentation lives under [`deploy/`](../deploy):

- [`deploy/SELF_HOSTING.md`](../deploy/SELF_HOSTING.md): the runbook. What each unit is, what it needs, every configuration variable and what it does when unset, what the installation generates for itself on first boot, and what must be backed up. Start here.
- [`deploy/guides/`](../deploy/guides/README.md): the same runbook translated onto a specific platform: Render, AWS, Vercel plus a container host, and bringing your own identity provider.

The reference for the movement language itself is the handbook the authoring agents read, under [`apps/api/src/lib/knowledge/movement_handbook/chapters`](../apps/api/src/lib/knowledge/movement_handbook/chapters).

## The documentation site

`pnpm docs:build` builds a static site into `site/` (gitignored) from the handbook chapters and the guides and contracts above, then checks every internal link. The generator is [`scripts/docs/build.mjs`](../scripts/docs/build.mjs); it needs no install. The [`docs` workflow](../.github/workflows/docs.yml) publishes it to GitHub Pages on a `docs-v*` tag or a manual run, never on a branch push.

URL scheme (stable; the language server links to it):

- `/docs/v<N>/<page>#<anchor>`, where `N` is the language version (`/docs/v5/` is version 5, Dancing Wren).
- `<page>` is a handbook chapter id (`foundations`, `anatomy`, `expressions`, `writes`, `traversal`, `extraction`, `branching`, `listeners`, `asks`, `patterns`, `use-cases`, `runs`, `reference`, `builtins`), a guide (`getting-started-lf`, `core-slots`, `embedding`, `adapter-protocol`, `dancing-wren-migration`), or `contracts` and `contracts-<name>`.
- `<anchor>` is the heading's GitHub style slug: the handbook's `###` section names (`writes#identity`) are the same anchors the in-app handbook routes use.
- Pages are files, so `.html` also works (`/docs/v5/writes.html#identity`).
- A new language version adds an entry to `VERSIONS` in the generator; the older sections stay at their URLs.
