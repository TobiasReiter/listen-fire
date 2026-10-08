# Vercel for the web app, a container for the API

The honest split, stated up front: **Vercel hosts your frontend; the API and its workers need a container.** That is two deployments and one DNS entry each, not a microservice estate, and it needs saying at the start rather than discovered in week three.

This guide uses **Fly.io** as the worked example for the container half, because it is the smallest thing that satisfies the constraints. Railway and Render work identically; `render.md` is the Render version of the same shape.

The part that actually goes wrong is not the hosting. It is the three URL variables at the end of this document, so read that section even if you skip the rest. [`deploy/SELF_HOSTING.md`](../SELF_HOSTING.md) is the runbook this guide translates; start there.

---

## 1. Why the API cannot be serverless

This is not a preference and it is not a gap waiting to be closed. **The API needs its own hostname; a serverless platform in front is not enough.** It is one long-running process with in-process pollers and a WebSocket server, so it needs a container with its own public hostname, TLS and CORS. A proxy in front of it does not carry WebSocket upgrades, and long authoring-agent calls should be pointed at the API origin directly rather than through a proxy with a request timeout.

Three independent reasons, each sufficient on its own:

- **The process is long-running.** Everything is mounted in one process that listens on one port. There is no serverless adapter anywhere in the tree, and building one is not on any roadmap here.
- **The workers are in-process.** Every unit's loops but automations' hold a per-unit advisory lock, and a request-scoped runtime has no process to hold one. Automations' work (schedules, polls, webhook refresh, resumes) is rows in a work table run by a drain worker that takes no lock: work rows are claimed with leases and each run is stepped under its own lease, so it runs on every instance. It can be ticked from outside with `AUTOMATIONS_DRAIN_MODE=external` and `POST /api/v1/system/automations/drain`, which any instance answers. But the API process is still long-running, and the other units' loops still need a process to hold their locks, so that does not make a serverless shape possible.
- **There is a WebSocket server.** Live run updates ride it, and Vercel rewrites do not carry protocol upgrades.

The last one is already handled in the code rather than left to bite you: the web app's WebSocket client connects straight to `NEXT_PUBLIC_API_URL` instead of going through the rewrite. The consequence is that **the API needs its own public hostname with TLS and correct CORS** — not merely an origin the Vercel project can reach.

## 2. The web app on Vercel

The web app is a Next.js application in `apps/web`. It is not in `deploy/Dockerfile` — that image is the API and its workers. (`deploy/Dockerfile.web` builds the web app for the compose stack; on Vercel you build it the Vercel way instead.)

**Project settings.** Root directory `apps/web`. It is a pnpm workspace, so the install has to run from the repository root with the workspace filtered to the web app and its dependencies; Vercel's monorepo settings as of this writing detect pnpm workspaces, but check the build log the first time rather than assuming the filter took.

**Environment.** One variable is required:

| variable | value |
|---|---|
| `NEXT_PUBLIC_API_URL` | your API's public origin — the container's hostname, not a Vercel internal one. It bakes that origin into the client bundle, so the API's CORS must allow the Vercel origin. (The containerised web image uses `API_INTERNAL_URL` instead, proxying at run time so the browser stays same-origin; on Vercel the rewrites below do that job.) |

The rest are optional and only turn on the feature they name: `NEXT_PUBLIC_SITE_URL`, and the `NEXT_PUBLIC_GOOGLE_*` ids for the browser-side pickers. The Google and Microsoft SIGN-IN buttons are not among them — those client ids live on the API (`GOOGLE_AUTH_CLIENT_ID`, `MICROSOFT_CLIENT_ID`) and the login page reads them at run time.

**What the rewrites do, and why they matter.** The web app proxies a fixed set of paths to `NEXT_PUBLIC_API_URL`: `/api/trpc/*`, `/api/public/*`, `/api/asks/*`, `/api/auth/*`, `/subscriptions/*`, the MCP routes under `/api/v1/mcp/*`, and the OAuth metadata documents. Those rewrites are load-bearing for the OAuth connect flow in §5 — the callback pages hand the authorization code back through `/api/public/*` on their own origin.

**Two Vercel-specific edges.**

The web app sets a five-minute proxy timeout because authoring-agent requests are genuinely that long. Five minutes is at or past the ceiling on most Vercel plans as of this writing, so point long agent calls at the API origin directly rather than through the proxy.

Vercel rewrites do not carry WebSocket upgrades. Nothing to configure — the client already bypasses them — but it is why the API hostname must be publicly resolvable and CORS-correct rather than private.

## 3. The API on Fly.io

One app, one machine, always on.

**Build from the shipped Dockerfile.** The build context is the **repository root**, not `deploy/`:

```toml
# fly.toml
app = "listen-fire-api"
primary_region = "lhr"

[build]
  dockerfile = "deploy/Dockerfile"

[env]
  NODE_ENV = "production"
  PORT = "3000"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = false
  auto_start_machines = false
  min_machines_running = 1

  [[http_service.checks]]
    path = "/.well-known/health-check"
    interval = "15s"
    timeout = "5s"
```

**`auto_stop_machines = false` is not an optimisation.** A machine that stops between requests stops the background workers with it: scheduled automations stop firing, poll-driven listens stop noticing changes, and automations parked on a timer never resume. Scale-to-zero and an in-process worker model are incompatible by construction.

**The health check answers 201.** That is its contract, not a quirk — a checker that insists on exactly 200 has to be configured to accept 2xx. `/healthz/workers` is the surface you alert on: every mounted worker, whether this process started it, its last tick, and a reason for any deliberately idle one.

**Keep it at one machine.** Two are safe — each product's workers take a per-product advisory lock, so every loop runs on exactly one instance — but you lose the unambiguous reading of `startedHere: false` on the worker health surface, which on a single machine means "wedged, page me".

**Migrations are a separate step that must finish first.** The compose file runs them as a one-shot service before the API starts, so a restart never races the schema. On Fly, that is a release command:

```toml
[deploy]
  release_command = "pnpm schema:migrate \"$DATABASE_URL\""
```

The migration runner takes the database as an **argument** and does not read the ambient environment, which is why the URL is passed explicitly.

**Secrets.** Off compose nothing mints them for you: the compose stack generates its own on first boot, and here you supply the same set by hand ([`SELF_HOSTING.md`](../SELF_HOSTING.md), "What the installation generates for itself"). Never rotate the two encryption keys.

**Postgres, Redis, storage.** Managed Postgres 16 anywhere you like. The migration set grants to two roles (`agent`, `readonly`) that no managed provider creates for you, and a database without them dies on an early migration having built almost nothing — so **the migration runner creates them**, from `deploy/postgres-init/00-roles.sql`, before it applies anything, whenever the user in `DATABASE_URL` holds `CREATEROLE`. Run that file by hand only when the runner stops and tells you to. Redis is configured with `MESSAGE_QUEUE_REDIS_HOSTNAME` and `MESSAGE_QUEUE_REDIS_PORT` — there is no URL form, and the client takes a host and a port and nothing else, so a managed Redis requiring AUTH or TLS cannot be configured through them. Object storage is any S3-compatible bucket; there is no local-filesystem driver, and without one configured the process boots normally and only file-touching steps fail, naming the variables they wanted.

## 4. DNS

`app.example.com` → Vercel. `api.example.com` → the container.

The API hostname is the load-bearing one. Every inbound webhook you register with a third party is built from it, every capability link Listen-Fire hands out is absolute at it, and both are already in other people's hands by the time you want to change it. **It must be right the first time and stable forever.** There is no rewrite mechanism and there cannot be one: the recipients' message history is not yours to edit.

## 5. The URL triangle

This is the section people get wrong, so it is spelled out rather than summarised.

| variable | whose environment | what it is | what it must be |
|---|---|---|---|
| `API_BASE_URL` | the API container | where this API is reachable from the internet | the **API** origin |
| `WEB_BASE_URL` | the API container | where the web app is | the **WEB** origin |
| `OAUTH_REDIRECT_BASE_URL` | the API container | where an OAuth consent screen returns the user | the **WEB** origin |
| `NEXT_PUBLIC_API_URL` | the Vercel project | where the browser talks to the API | the **API** origin |

**`OAUTH_REDIRECT_BASE_URL` is the WEB origin.** Not the API's. Every OAuth adapter except Slack builds its redirect as `<OAUTH_REDIRECT_BASE_URL>/<adapter>/callback`, and those paths are **pages in the web app** — the API container does not serve them at all. Point it at the API and every consent screen returns the user to a 404 after they have already granted access.

The full chain, once, so the pieces are visible:

1. You register the redirect URL `https://app.example.com/attio/callback` with the provider ([`SELF_HOSTING.md`](../SELF_HOSTING.md), "Registering your own third-party apps", has the per-system list).
2. A person clicks connect in the web app and consents.
3. The provider returns them to `https://app.example.com/attio/callback` — the Next.js page.
4. That page forwards the authorization code to `/api/public/auth/attio/callback` **on its own origin**, which the web app's rewrite proxies to the API.
5. The API exchanges the code and stores the credential.

Step 4 is why the `/api/public/*` rewrite matters, and why an OAuth connect cannot be completed by a deployment that ships no web app.

**Slack is the one exception, and it is an exception in your favour.** `SLACK_MOVEMENTS_REDIRECT_URI` is passed to Slack verbatim rather than derived, so you control it outright — set it to `https://app.example.com/slack/callback` and paste exactly that value into the Slack app's OAuth redirect setting. Slack's two other URLs are API-side and take `API_BASE_URL`: `<API_BASE_URL>/api/public/slack/events` and `<API_BASE_URL>/api/public/slack-actions`.

**One more that degrades quietly.** `EXPOSED_FILE_PUBLIC_BASE_URL` falls back to `OAUTH_REDIRECT_BASE_URL` and then to a localhost literal. It is the one URL default that does not fail loudly, so set it explicitly — to the **API** origin, which is what serves those bytes.

**And one that is not a URL at all.** `SESSION_JWT_AUDIENCE` is an audience claim, any stable string. Your own URL is a fine choice, but the value is baked into every live session cookie and realtime token, so changing it logs everybody out at once.

## 6. What you still have to do

Registering your own Slack app, Google OAuth client, Dropbox app, Telegram bot, WhatsApp number and Mailgun domain is the long pole of any real cutover — Google's restricted-scope review and Meta's business verification take weeks, not days. [`SELF_HOSTING.md`](../SELF_HOSTING.md), "Registering your own third-party apps", is the system-by-system runbook, and it belongs at the **start** of a project.

Connecting anyone's account to those apps needs real user accounts, which means running the `core` product and the web app alongside. A single-tenant deployment — one team, one API key — can register the apps but cannot complete a connect: minting a connect link binds it to a person, and a machine credential names none. See `byo-auth.md` for what identity you are choosing between.
