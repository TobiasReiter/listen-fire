# Documentation

- [`dev-loop.md`](dev-loop.md): the local development loop. Boot the whole stack against real Postgres and Redis and fake third-party services, drive the knowledge agents and the UI, inject synthetic inbound events, and inspect what the system did. This is how a change is verified end to end without an account anywhere. [`CONTRIBUTING.md`](../CONTRIBUTING.md) has the short version.
- [`api-ingest.md`](api-ingest.md): the ingest API: submitting records over HTTP with an API key. [`api-ingest-slack.txt`](api-ingest-slack.txt) is the same content formatted for pasting into Slack.
- [`contracts/`](contracts/README.md): the five versioned contracts the movement core speaks, with an index of the versions each release supports and deprecates. The catalog snapshot, the parked run state, the host families (the boundary between the engine and the code that runs it, and the entry points), the adapter protocol a remote adapter serves, and the language versions.
- [`engine-host.md`](engine-host.md): how this repository's two hosts serve the host families: spend metering, the cross-run write locks, the production and test hosts, and what stays outside the contract.
- [`language/steady-lynx-migration.md`](language/steady-lynx-migration.md): migrating an automation to language version 3, Steady Lynx. Every rule that changed, grouped by topic, with the diagnostic codes and their rewrites.
- [`security-google-oauth.md`](security-google-oauth.md): the security posture of the Google OAuth integration, written against the CASA Tier 2 requirements.

Deployment documentation lives under [`deploy/`](../deploy):

- [`deploy/SELF_HOSTING.md`](../deploy/SELF_HOSTING.md): the runbook. What each unit is, what it needs, every configuration variable and what it does when unset, what the installation generates for itself on first boot, and what must be backed up. Start here.
- [`deploy/guides/`](../deploy/guides/README.md): the same runbook translated onto a specific platform: Render, AWS, Vercel plus a container host, and bringing your own identity provider.

The reference for the movement language itself is the handbook the authoring agents read, under [`apps/api/src/lib/knowledge/movement_handbook/chapters`](../apps/api/src/lib/knowledge/movement_handbook/chapters).
