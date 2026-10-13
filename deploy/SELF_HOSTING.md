# Self-hosting Listen-Fire

## Quick start

```bash
git clone <this repo> && cd <this repo>
cp deploy/.env.example deploy/.env      # set ANTHROPIC_API_KEY — or set nothing and add --demo
./deploy/up.sh knowledge automations    # any combination of the five units below
```

`up.sh` pulls the published images, waits for the stack to answer, and prints the web URL and the credential to sign in with. Add `--demo` to run with stand-in third-party services and a sample dataset, and no keys at all. Add `--build` to build from the checkout instead.

Before automations run unattended on a real model key, consider setting `MOVEMENT_MAX_RUN_COST_USD` in `deploy/.env`: the most one automation run may spend on model calls and paid services. It is not mandatory, but it is encouraged (see "Automations").

**If you build, give Docker about 8 GiB, and never build the images together.** The api build and the web build each ask for a 6 GiB node heap, and a single `docker compose up --build` hands every service to one BuildKit session, which runs them concurrently — an out-of-memory kill on a stock Docker Desktop, reported as a broken repository rather than a full machine. `up.sh --build` builds one image at a time for exactly this reason, and the first build takes several minutes.

## What you are choosing

Listen-Fire comes apart into five units. They are the same image with a different environment, so a composition is configuration rather than a fork, and adding a unit later is a restart rather than a migration.

| unit | what it runs |
|---|---|
| `asks` | ask a person a question, get the answer back to your system |
| `valuations` | what you own and what it is worth, and an API that values it on a date |
| `knowledge` | a graph of the things you track and how they relate |
| `automations` | small programs over your other systems, and the surface that authors them |
| `core` | accounts, teams, invitations, login, and the connector that lets an agent sign in on a person's behalf |

**Naming `core` is the identity decision, and it is the only one.** Without it the installation is single-tenant: one team, one generated API key, and you sign in to the web UI by pasting that key. With it you get real accounts, invitations, and login by emailed link or password. There is no third shape, and no half of one — naming `core` without the matching identity setting (or the reverse) fails at boot rather than at the first request.

Everything else follows from the unit list. Which pages the web UI shows, which API routes answer, which background loops run, and which delivery path a graph change or a settled question takes are all derived from it; a page for a unit you did not choose is never shown, and a route for one answers 404.

## Two ways to start it

**`./deploy/up.sh <units…> [--demo]`** is the door for a trial on your own machine. It works out the identity setting, the delivery paths and the optional services from the units you name, waits for health, and prints how to sign in. It defaults the public URLs to `http://localhost:<port>`, which is what makes the printed links work on a machine that has named none — but `deploy/.env` wins over every one of those defaults, so an installation behind a real hostname keeps its own URLs, ports and bind address through an `up.sh` run.

**`docker compose pull && docker compose up -d`, run from `deploy/`**, is the production shape. It needs no build and no toolchain — just Docker and the tag you pinned:

```bash
# from deploy/ — COMPOSE_PROFILES in your .env names the optional pieces
docker compose pull
docker compose up -d
```

To run the code in your checkout instead of a release, build the images one at a time, for the memory reason above — there is no supported `up --build`:

```bash
# migrate and seed share the api image; the admin one is only worth building
# with core, whose console it is
docker compose build api && docker compose build web \
  && docker compose build admin \
  && docker compose up -d
```

`docker compose build <service>` has been seen to hang on at least one machine where the plain builder works. `docker build` against the same Dockerfile is the exact equivalent, run from the repository root, and tags the same images compose starts — which is what `up.sh --build` itself calls:

```bash
docker build -f deploy/Dockerfile --build-arg LISTEN_FIRE_VERSION=dev \
  -t ghcr.io/listen-fire/api:latest .
docker build -f deploy/Dockerfile.web --target web -t ghcr.io/listen-fire/web:latest .
docker build -f deploy/Dockerfile.web --target admin -t ghcr.io/listen-fire/admin:latest .
```

Those `:latest` tags are what an unpinned installation starts. With `LISTEN_FIRE_VERSION` pinned, tag the build with that value instead, or compose will pull the release over the top of what you built.

With nothing else set it is the whole of Listen-Fire — every unit, with accounts and login. To run a subset, or to run behind your own hostname, put the settings in `deploy/.env` and start compose directly:

```bash
# deploy/.env
LISTEN_FIRE_PRODUCTS=knowledge,automations
LISTEN_FIRE_PRINCIPAL=static                 # `core` when the unit list includes core
KNOWLEDGE_MUTATION_DELIVERY=local      # `webhook` unless knowledge AND automations are both listed
ASKS_SETTLE_DELIVERY=webhook           # `local` only when asks AND automations are both listed
API_BASE_URL=https://api.example.com
WEB_BASE_URL=https://app.example.com
```

**Which optional pieces run is `COMPOSE_PROFILES` in `deploy/.env`,** not a flag you remember to type. Five profile names exist. Three are the bundled datastores — `postgres`, `redis`, `minio` — and the shipped line turns all three on; each turns itself off when you name a datastore of your own, so leave that part alone (see "Bringing your own datastores"). The other two are `admin`, the operator console, which is only useful with `core`, and `demo`, the stand-in third parties and the sample data:

```
COMPOSE_PROFILES=postgres,redis,minio,admin
```

**Put them there rather than on the command line.** A `--profile` flag REPLACES this list on older Docker Compose versions instead of adding to it, which is how a `docker compose --profile admin down` ends up leaving the database container running. One list in one file is correct on every version. `up.sh` names its own profiles on the command line and passes no list, which is the same rule from the other side.

**`demo` on its own is not a working demo** — the demo also needs the environment `up.sh` sets for it, and without that the API runs in production mode and the login email goes to a mail provider you have not configured instead of the fake outbox.

## Versions

A release is a git tag on the public repository, `vMAJOR.MINOR.PATCH`. Tagging publishes four images — `api`, `web`, `admin` and `fake-channels` — to `ghcr.io/listen-fire/<name>` at that tag and at `latest`, for `linux/amd64` and `linux/arm64`. The tag is the version; the `version` fields in the repository's `package.json` files mean nothing and are not maintained.

**Pinning a tag is how an installation chooses when it moves.** Set it in `deploy/.env`:

```
LISTEN_FIRE_VERSION=v0.1.0
```

Both `up.sh` and `docker compose` then pull exactly those images and start nothing else, until you edit that line. Leave it unset and every pull takes `latest`, which moves under you.

| | where the images come from |
|---|---|
| `./deploy/up.sh <units…>` | pulls `ghcr.io/listen-fire/*` at your pinned tag (the default) |
| `./deploy/up.sh <units…> --build` | builds them from this checkout instead |
| `./deploy/up.sh <units…> --no-build` | uses the images already on this machine, pulling and building nothing |

Building from source is the right answer when you have changed the code, or on an architecture no published image covers. A source build is stamped `dev` rather than a version number, because nothing tagged it.

**Where the running version shows.** `GET /healthz/workers` reports it as `version`, unauthenticated, alongside the units this process mounts; the web UI shows it under **Settings → About**. Both read the same value out of the running api process, so they cannot disagree with each other, and neither can be stale the way a page served by an older web build can.

[UPGRADING.md](UPGRADING.md) is what to do when you move from one tag to the next.

**The contracts have versions of their own.** Beside the release tag, the five contracts the movement core speaks (the catalog snapshot, the parked run state, the engine's host families, the adapter protocol and the language) each carry an integer version, and a release states which of each it supports and deprecates. [`docs/contracts/`](../docs/contracts/README.md) is the index. It matters when you run something against this release from outside it: a remote adapter (adapter protocol 2), or your own host for the engine.

## Ports

| service | host port | when |
|---|---|---|
| web UI | 8080 | always |
| API | 8081 | always |
| operator console | 8082 | only with `core` |
| stand-in third parties | 8083, bound to `127.0.0.1` | only in demo mode |

Postgres, Redis and the bundled object store publish no host port at all, so a self-hosted stack never collides with anything else on the machine. The stand-in third parties are always bound to `127.0.0.1`, whatever the rest of the stack is bound to: their email outbox holds live single-use login links, and anything that can read one is signed in. Change the published ports with `WEB_PORT`, `API_PORT`, `ADMIN_PORT` and `FAKE_CHANNELS_PORT_HOST`, in `deploy/.env` — which `up.sh` reads too, and a shell value still wins over both.

**`LISTEN_FIRE_BIND` is which host address those ports answer on**, and it applies to the web app, the API and the admin console alike. Unset it binds every interface, which is what a trial wants. Set it to `127.0.0.1` for a deployment behind a reverse proxy on the same box: the proxy reaches the stack and nothing else can, so the firewall stops being the only thing standing between the internet and a plain-HTTP port. The port variables are numbers — an address belongs in `LISTEN_FIRE_BIND`, and `up.sh` refuses a port that carries one rather than letting compose fail on a mapping it cannot explain.

The browser only ever talks to the web UI's own origin: the web container proxies API calls to the API container over the internal network. That is why the image bakes in no API hostname, and why one image runs anywhere.

## What the installation generates for itself

On its very first boot, before anything else starts, Listen-Fire mints every secret this installation will ever use and writes them into a Docker volume called `listen-fire-config`: the database password, the session-signing secret, both encryption keys, the team id, the API key, and the signing secrets for outbound webhooks and document links. You never see them in a file on disk, and no container image carries them.

One value in that volume is not one of those secrets: the bundled object store's root password. Nothing is encrypted under it, so it is minted separately, on any boot that finds it missing, and an installation that loses it re-mints it and carries on.

**Back that volume up, and never regenerate it.**

```bash
docker run --rm -v listen-fire_listen-fire-config:/config -v "$PWD:/out" \
  node:22.20.0-slim tar czf /out/listen-fire-config-backup.tgz -C /config .
```

Three of those values are one-way doors, which is why the generator refuses to overwrite a config volume that already exists:

- Rotating either encryption key makes every stored third-party credential **permanently unreadable**. Every connection has to be made again by hand, which for the systems you register yourself means every user re-authorising.
- Rotating the session secret signs everybody out.
- Rotating the API key signs every web session out on a single-tenant installation, by design: the key is the session.

To read one of the generated values — the API key, the admin email — ask a container to source them for you. Note that `docker compose exec` does **not** work here: the secrets are loaded by the container's entrypoint, and `exec` runs beside it rather than through it.

```bash
docker compose run --rm --no-deps --entrypoint /usr/local/bin/with-generated-env api \
  sh -c 'printf "%s\n" "$LISTEN_FIRE_API_KEY"'
```

**`LISTEN_FIRE_API_KEY` is the credential only on a single-tenant installation.** It is generated in every shape, but with `core` mounted nothing accepts it: core validates sessions and api-key rows in its own database, and the generated key is neither, so presenting it is a 401. On a `core` installation the credential is the admin account — `LISTEN_FIRE_BOOTSTRAP_USER_EMAIL` from the same volume, read the same way — who signs in by emailed link, and mints api keys from the UI once signed in. `up.sh` prints whichever of the two applies to the shape you started.

## What you configure

`deploy/.env` is the human half — copy it from `deploy/.env.example`. It is read relative to the compose file, so it applies whichever directory you run `docker compose -f deploy/docker-compose.yml` from.

**A model key is what buys you agents**, and `ANTHROPIC_API_KEY` or `KNOWLEDGE_LLM_API_KEY` is enough. Every chat call names a Claude model, so `OPENAI_API_KEY` alone buys agents only with a `MODEL_MAP` that sends the Claude names to `openai`. Without one the stack starts and serves — the graph, the CRM writes, the query surfaces and the whole of core need no model — and agents, extraction and the arbitration of conflicting facts fail at the moment they are asked for, each naming the key it wanted. `init` warns at every boot and so does the API, so it is not something you find out from a user. Nothing in this file is a hard requirement for starting.

**`MODEL_MAP` decides which vendor answers each model name.** Every model call in the product names a model from a fixed list (Claude names such as `claude-sonnet-5`, OpenAI names such as `whisper-1`, `text-embedding-3-large`, `gpt-image-1`). Left unset, each name goes to its own vendor under its own name, with the keys above. `MODEL_MAP` is a JSON object that sends a name somewhere else: the key is the model name, the value is `provider/wire-model`, where the provider is one of `anthropic`, `vertex` (Claude on Google Cloud), `openai` or `gemini` (Gemini on Google Cloud) and the wire model is that vendor's own spelling. Boot refuses a map with a name the product does not use, a provider outside those four, a provider that cannot do what the name is for (Claude cannot transcribe), a mapped provider with no credentials, or an embedding line whose model cannot produce the vector width its database column stores. It does not refuse a vendor key that nothing uses any more.

Three maps cover most deployments. Each is written on one line in `deploy/.env`; they are spread out here to read.

**1. Vendor keys: no map.** Leave `MODEL_MAP` unset. Claude names go to Anthropic on `ANTHROPIC_API_KEY`; `whisper-1`, the two embedding models and `gpt-image-1` go to OpenAI on `OPENAI_API_KEY`. Either key can be missing: the stack boots, and each call that needs the missing one fails naming it.

**2. Everything on OpenAI.** Set `OPENAI_API_KEY`, leave `ANTHROPIC_API_KEY` unset, and send every Claude name to a GPT model. Transcription, embeddings and image generation are OpenAI's own names already, so they need no line.

```json
{
  "claude-fable-5-1": "openai/gpt-5",
  "claude-opus-5": "openai/gpt-5",
  "claude-opus-4-8": "openai/gpt-5",
  "claude-opus-4-7": "openai/gpt-5",
  "claude-opus-4-6": "openai/gpt-5",
  "claude-sonnet-5": "openai/gpt-5",
  "claude-haiku-4-5": "openai/gpt-5-mini",
  "claude-haiku-4-5-20251001": "openai/gpt-5-mini"
}
```

**3. Everything on Gemini, through the Google service account.** Set the four Google service account variables (`GOOGLE_PRIVATE_KEY`, `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PROJECT_ID`, `GOOGLE_PROJECT_LOCATION`) and no vendor key. Every capability moves: chat, transcription, embeddings and image generation.

```json
{
  "claude-fable-5-1": "gemini/gemini-3.1-pro-preview",
  "claude-opus-5": "gemini/gemini-3.1-pro-preview",
  "claude-opus-4-8": "gemini/gemini-3.1-pro-preview",
  "claude-opus-4-7": "gemini/gemini-3.1-pro-preview",
  "claude-opus-4-6": "gemini/gemini-3.1-pro-preview",
  "claude-sonnet-5": "gemini/gemini-3.1-pro-preview",
  "claude-haiku-4-5": "gemini/gemini-3.8-flash",
  "claude-haiku-4-5-20251001": "gemini/gemini-3.8-flash",
  "whisper-1": "gemini/gemini-3.8-flash",
  "text-embedding-3-large": "gemini/gemini-embedding-001",
  "text-embedding-3-small": "gemini/gemini-embedding-001",
  "gpt-image-1": "gemini/gemini-3.1-flash-image-preview"
}
```

The Google project needs the Agent Platform API (`aiplatform.googleapis.com`) enabled. Every Gemini call, image generation included, is addressed in `GOOGLE_MODEL_REGION` (default `global`).

**Claude on Google Cloud** keeps Claude and moves it off the Anthropic key: set the four Google service account variables (`GOOGLE_PRIVATE_KEY`, `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PROJECT_ID`, `GOOGLE_PROJECT_LOCATION`), optionally `GOOGLE_MODEL_REGION` (default `global`, where both Claude on Vertex and Gemini are addressed), and this map, written on one line in `deploy/.env`:

```json
{
  "claude-fable-5-1": "vertex/claude-fable-5-1",
  "claude-opus-5": "vertex/claude-opus-5",
  "claude-opus-4-8": "vertex/claude-opus-4-8",
  "claude-opus-4-7": "vertex/claude-opus-4-7",
  "claude-opus-4-6": "vertex/claude-opus-4-6",
  "claude-sonnet-5": "vertex/claude-sonnet-5",
  "claude-haiku-4-5": "vertex/claude-haiku-4-5@20251001",
  "claude-haiku-4-5-20251001": "vertex/claude-haiku-4-5@20251001",
  "whisper-1": "gemini/gemini-3.8-flash",
  "text-embedding-3-large": "gemini/gemini-embedding-001",
  "text-embedding-3-small": "gemini/gemini-embedding-001",
  "gpt-image-1": "gemini/gemini-3.1-flash-image-preview"
}
```

Google spells a Claude model whose name carries a date with the date behind an `@`, which is why the Haiku lines differ. Before switching, in the Google project: enable the Agent Platform API (`aiplatform.googleapis.com`), and switch on each Claude model you use, in Model Garden. Vertex has no hosted page fetching, so the web research step falls back to its own page reader, which needs `BRIGHT_DATA_ACCESS_TOKEN` and `BRIGHT_DATA_UNLOCKER_ZONE`.

**Transcription, embeddings and image generation follow the map too**, one name each. OpenAI serves all three under their own names; Gemini serves all three under the wire model the line names.

| capability | model name | on `openai` | on `gemini` |
|---|---|---|---|
| transcription (voice notes and audio attachments) | `whisper-1` | Whisper; the audio is uploaded as a file | a Gemini model given the audio inline, up to 7 MB per file, in the formats Gemini lists (Ogg, MP3, M4A, WAV, WebM, FLAC, AAC, PCM) |
| embeddings, 3072 wide (`knowledge.raw_text.embedding`, `knowledge.raw_text_part.embedding`) | `text-embedding-3-large` | `text-embedding-3-large` (up to 3072) | `gemini-embedding-001` (128 to 3072), one text per request, 2048 tokens each at most |
| embeddings, 256 wide (`knowledge.extraction_fact.embedding`) | `text-embedding-3-small` | `text-embedding-3-small` (up to 1536) | `gemini-embedding-001` |
| image generation | `gpt-image-1` | GPT Image 1, at the size and quality asked for | a Gemini image model, in `GOOGLE_MODEL_REGION` like every other Gemini call; a size or quality in the request is refused |

An embedding line must name a model the product knows the widths of, and one wide enough for the column: `"text-embedding-3-large": "openai/text-embedding-3-small"` is refused at boot, because that model tops out at 1536 and the column stores 3072. Vectors written by one vendor are not comparable with vectors written by another, so moving an embedding line on a deployment that already has vectors means re-embedding what is stored.

**`EXTRACTION_TIERS` decides what each extraction tier buys.** An automation's extraction asks for a tier, `quick`, `careful` or `thorough`, and the deployment decides which model answers it and how hard that model thinks. Left unset, every tier is `claude-sonnet-5`: `quick` at effort `low`, `careful` at `high`, `thorough` at `xhigh`. An extraction that names no tier is not configurable: its model is chosen by how many kinds of record it reads (`claude-opus-4-7` or `claude-sonnet-5`), at effort `low`. `EXTRACTION_TIERS` is a JSON object from tier to `{ "model": …, "effort": … }`; a tier or a field it leaves out keeps the default.

```json
{ "careful": { "model": "claude-opus-5", "effort": "medium" }, "quick": { "effort": "medium" } }
```

- The model is a model name from the product's list, and `MODEL_MAP` still decides which vendor answers it.
- Effort is one of `low`, `medium`, `high` or `xhigh`; each vendor gets its nearest control, and a vendor with none refuses the call.
- `high` and `xhigh` get a 64k output ceiling, because thinking at those depths comes out of the same ceiling as the answer.
- Boot refuses a tier that is not one of the three, a field that is not `model` or `effort`, a name that is not a chat model, and a model this deployment cannot call (no credentials for wherever `MODEL_MAP` sends it).
- The defaults cap effort low on purpose: production extractions at the models' own default depth spent their whole output on thinking. Raise it knowing that.

**Upgrading a deployment from before `MODEL_MAP`.** Three things behave differently with no map set:

- The system, movement and ontology agents used to run on GPT 5 when `KNOWLEDGE_AGENT_PROVIDER` was unset. They now run on Claude (`claude-sonnet-5`). To keep them on GPT, map `claude-sonnet-5` to `openai/gpt-5`.
- Image generation used to go to Gemini whenever the Google service account was set, and to DALL·E 3 otherwise. OpenAI shut DALL·E 3 down on 2026-05-12, so the image model is now `gpt-image-1`, which goes to OpenAI. To keep Gemini images, add `"gpt-image-1": "gemini/gemini-3.1-flash-image-preview"`. A map that names `dall-e-3` is refused at boot, because that name is no longer in the product's list.
- `MODEL_ROUTE`, `ANTHROPIC_MODEL_ROUTE`, `OPENAI_MODEL_ROUTE` and `KNOWLEDGE_AGENT_PROVIDER` are no longer read. A deployment that set `MODEL_ROUTE=google` needs the Claude on Google Cloud map above, or the third map for Gemini.

Usage rows now name the provider that served each call (`anthropic`, `vertex`, `openai`, `gemini` or `jev`) rather than `google`, the wire model in `model`, and the model name the product asked for in `preferred_model`.

**The map moves one name at a time**, so a deployment can keep Claude on its own Anthropic key while sending only the OpenAI names to Gemini: map just those names, keep `ANTHROPIC_API_KEY`, and set the Google service account. The knowledge agents are no exception: they name `claude-sonnet-5` (the unified agent an Opus name), and run wherever the map sends that name.

**Web research searches with its own service off the Claude doors.** Only `anthropic` and `vertex` run hosted web search. When the map sends the research model to `openai` or `gemini`, the model's searches are answered by the product's own web search service instead (Google Programmable Search through `GOOGLE_CUSTOM_SEARCH_API_KEY` and `GOOGLE_CX`, or Bright Data with `WEB_SEARCH_PROVIDER=brightdata`), and its page reads by its own page reader as on Vertex.

**Set your real URLs before you register anything or send anything.** `API_BASE_URL` and `WEB_BASE_URL` are where this installation is reachable from the internet, and both are used to build links that end up in other people's inboxes and in other systems' webhook registrations. They also decide cookie security: the session cookie is marked `Secure` only when those URLs are `https`, because a `Secure` cookie on a plain-http LAN address is set, silently dropped by the browser, and the person is bounced back to the login they just completed. Behind TLS, set them to your https URLs; on a plain-http trial, leave them http.

**`OAUTH_REDIRECT_BASE_URL` is your WEB origin**, not the API's. The consent screen returns the person to `<OAUTH_REDIRECT_BASE_URL>/<system>/callback`, and those pages are served by the web app; the API does not serve them at all. The compose file defaults it to `WEB_BASE_URL`, so the single-host shape is already right — set it explicitly only when the web app answers on a different origin from the one you gave `WEB_BASE_URL`.

`EXPOSED_FILE_PUBLIC_BASE_URL` is the same pair pointing the other way: a third party fetches an exposed file's bytes from the **API**, so the compose file defaults it to `API_BASE_URL`. Off compose it is worth setting by hand, because the code's own fallback is `OAUTH_REDIRECT_BASE_URL` — the web origin — and then a localhost literal.

Integration credentials are all optional. An OAuth connector whose client id and secret are unset is not offered in the catalogue at all, so nobody can start a connection that would fail.

**Name the things a third party renders.** The product name is fixed, but the name a Slack workspace shows and the name Meta prints in a WhatsApp template belong to whoever registered that app — and that is you. `SLACK_APP_DISPLAY_NAME` and `WHATSAPP_APP_DISPLAY_NAME` are those two names, each defaulting to `Listen-Fire`. `SUPPORT_EMAIL` is the third: where someone with a problem is told to go. It has no default, and unset means this installation publishes no address at all rather than sending people to an inbox that will not read them.

## First boot

Three things happen in order, once, and each is visible in the log.

1. **Secrets are minted** into `listen-fire-config` (above). This step warns, at every boot, if no model key is configured and you did not ask for a demo.
2. **Migrations run to completion** as a separate one-shot service before the API starts, so a restart never races the schema. If they fail, the API does not start at all.
3. **On a `core` installation, the first account is provisioned** against the empty database: your team, your admin user, and an internal identity that unauthenticated routes run as. It is all-or-nothing — a half-provisioned database is no longer empty and would never be provisioned again — and it is skipped forever once the installation has people in it.

The symptom worth recognising: an installation whose internal identity row is missing answers *"Invalid or expired session"* on every public route, which is every route login goes through. That is an unprovisioned installation seen from outside, not a stale cookie, and the boot log says so.

Papercut, stated plainly: **the first account is not a platform administrator**, so it cannot reach the operator console. Everything in the product itself works; only that console is out of reach, and there is no supported way to grant the flag from outside today.

## Signing in

**Single-tenant (no `core`).** `up.sh` prints the generated API key. Paste it into the web UI's login page, and use the same key as a `Authorization: Bearer …` token for the REST and agent-facing surfaces. Two things follow from the key being the whole credential: choose a long random one if you ever replace the generated key by hand, because the login door has no rate limit; and if the web UI cannot reach the API, its login page cannot know it is a single-tenant installation and will not offer the key form until the API answers.

**With `core`.** People sign in by email — a single-use link, or a password. In production the link is genuinely emailed, so **login does not work at all until a mail provider is configured** — either `RESEND_API_KEY` (preferred, and it wins when both are set), or `MAILGUN_API_KEY` with `MAILGUN_SENDING_DOMAIN`, and in both cases `OUTBOUND_EMAIL_FROM`. This is the one place where absent mail is not a degradation but a locked door.

**Day one is the exception, and `up.sh` handles it.** The first link is what you would sign in to configure mail WITH, so `up.sh` prints one at the end of every `core` run: in a demo it reads the link out of the stand-in mail outbox, and on a real installation it asks for one and reads the row back out of the database, where the link is stored in the clear. Single-use, good for an hour, and to be treated as a live session — anyone who reads it is signed in as that admin. A stack brought up with `docker compose` rather than `up.sh` can mint one by hand; see the recipe in [`guides/gcp-vm.md`](guides/gcp-vm.md).

## Demo mode

`--demo` adds stand-in Attio, Slack, Airtable and an email outbox, and seeds a sample dataset: a starting model for venture dealflow, a graph of sample organisations, one working automation and one valuation case. Each piece is skipped when its unit is not mounted, so the same demo is correct for every combination. It also runs the API in non-production mode, which is what puts login email in the fake outbox instead of a mail provider.

Demo mode is a way to look at Listen-Fire, not a security posture. Do not expose it, and do not grow a real installation out of one.

## True in every shape

- **The background loops run inside the API.** There is no worker deployment to add. Automations' work can be driven from outside the process instead (see "Deployment shapes" below); every other unit's loops still need an always-on process, and stop with it.
- **Prefer one instance until you need more.** Two or more are safe — automations' drain runs on every instance, each run stepped under its own lease, and every other unit's loops take a lock, so they run on exactly one instance — but you lose the unambiguous reading of a worker reporting that it did not start here, which on a single instance means "wedged, page me".
- **`GET /.well-known/health-check` answers `201`.** That is its contract. A platform health check that defaults to expecting exactly `200` will drain a perfectly healthy target.
- **Two database roles must exist before the first migration**, and both paths create them for you. The migration set grants to `agent` and `readonly`, and a database without them dies on an early migration having built almost nothing. The bundled Postgres creates them from `postgres-init/00-roles.sql` on an empty data directory; on a managed database the migration runner runs that same file itself before it applies anything, which needs the connecting user to hold `CREATEROLE` — a managed provider's database owner does. **Run the file by hand only when the runner tells you to**, which it does, having applied nothing, when the user in `DATABASE_URL` is neither a superuser nor able to create roles. The bundled image is `pgvector/pgvector:pg16` because the migration set is monolithic.
- **The migration set is monolithic.** It creates every unit's tables whatever you mount, so a `psql` prompt shows tables you have no unit for. They stay empty. The practical consequence is that every installation needs the union of the extensions — `vector`, `pg_trgm`, `citext` — even one whose own tables need none of them.
- **`API_BASE_URL` must be stable forever.** Answer links, file links, callbacks and every webhook you register with a third party are absolute at it, and by the time you want to change the hostname they are in other people's inboxes and other systems' configuration. There is no rewrite mechanism and there cannot be one.
- **File storage is an S3-compatible bucket, and there is no local-filesystem driver.** Compose bundles one — a MinIO on a volume, wired up for you — so a stack that has named no object store of its own still handles files. Two honest limits on the bundled one: it is reachable only on the compose network, so a presigned link handed to a browser or a third party does not resolve, and it is one container on one disk. A deployment that hands out file links points `AWS_S3_ENDPOINT` at a real object store (AWS, Cloudflare R2, GCS through its S3 API, Supabase), which is also what parks the bundled one — see "Bringing your own datastores". With nothing configured at all the process boots normally and only the file-touching steps fail, naming what they wanted. `AWS_S3_FORCE_PATH_STYLE` is compared to the literal lowercase `true` — `TRUE` and `1` read as false, which is what bites MinIO and Ceph.
- **A proxy in front of the API loses two things**: WebSocket upgrades, which live updates ride, and very long agent requests, which outlive most proxy timeouts. Both should reach the API origin directly.

## Deployment shapes

Automations' background work is rows in one work table (see "Automations" below), and something has to drain it. There are two ways to run that.

### 1. Always-on loop (the default)

Each API instance drains on its own one-second timer (`AUTOMATIONS_DRAIN_MODE` unset or `loop`). A door that enqueues work kicks that loop, so a webhook's run starts at once. Nothing outside the API is involved. This is what compose and the guides run.

### 2. Push-tick

The API runs with `AUTOMATIONS_DRAIN_MODE=external`: no timer, and every drain pass is a `POST /api/v1/system/automations/drain` from a caller the system endpoints accept: by default a key holding the `system` scope, or an identity token (see "Who may call the system endpoints" below). Two things call it:

- **A schedule**, which is what makes timers, cron, polls and the periodic sweeps happen. One tick drains everything due, periodic rows included, so the schedule needs one line, not one per kind. Every minute is enough; the shortest periodic interval is 30 s, so every 30 s keeps the sweeps on time, and a `sleep` wakes at most one tick late.

  ```cron
  * * * * * curl -fsS -X POST -H "Authorization: Bearer $SYSTEM_KEY" -H 'content-type: application/json' -d '{}' https://api.example.com/api/v1/system/automations/drain
  ```

  Or, with no HTTP at all, a scheduled job that runs the drain itself and exits: `node build/scripts/drain_once.js` in the API image (`--limit` and `--max-passes`, as `--limit 5` or `--limit=5`, take the tick's bounds; anything else is refused). It registers the same work the server does, drains until a pass finds nothing more, and prints the result. It exits `0` when the drain went idle, `2` when it stopped at the pass limit with work still due (run it again), and `1` when it could not reach the database or failed to run. It needs the API's environment, `LISTEN_FIRE_PRODUCTS` included, and refuses to run on one that does not mount `automations`.

- **A door's notify**, for latency. Set `AUTOMATIONS_TICK_URLS` (comma-separated drain endpoints: any instance's, or a push endpoint that forwards to one) and `AUTOMATIONS_TICK_KEY` (a `system` scope key). Each enqueue then POSTs a tick to every URL, fire and forget, so a webhook's run starts within a request rather than at the next scheduled tick. Each URL has at most one tick in flight: notifies that arrive meanwhile owe one more tick, sent when the first answers. A tick unanswered after 30 s is given up on (the drain it started carries on). A failed tick is logged at most once a minute per URL and costs only latency: the schedule drains the row anyway. Leave both unset for a pure-schedule deployment, where a door's work waits for the next tick. Setting one without the other fails boot naming both.

On GCP:

| piece | GCP |
|---|---|
| a door's notify | `AUTOMATIONS_TICK_URLS` set to the Cloud Run service's drain endpoint, which any instance answers, with `api_key` among `SYSTEM_AUTH_MODES` (the notifier sends the key). A Pub/Sub push subscription delivering straight to that endpoint is the managed fan-in: give it an OIDC token whose audience is the drain URL and whose service account is on `SYSTEM_AUTH_OIDC_ALLOWED_SUBJECTS`, with `oidc` among the modes |
| the schedule | Cloud Scheduler, an HTTP job POSTing the drain endpoint every minute with an OIDC token the same way (audience the drain URL, its service account allow-listed), or with the `system` key in its `Authorization` header |
| a pure-schedule deployment | a Cloud Run job running `node build/scripts/drain_once.js`, triggered by Cloud Scheduler, with no notify set |

### Who may call the system endpoints

The system endpoints (`/api/v1/system/*`, the drain tick among them) accept whoever one of the configured verifiers accepts. `SYSTEM_AUTH_MODES` names them, comma-separated, asked in that order:

- **`api_key`** (the default): an API key holding the `system` scope, as `Authorization: Bearer lf_…`.
- **`oidc`**: an OpenID Connect identity token as the bearer. It is accepted when it is signed by one of the issuer's published keys, has not expired, names `SYSTEM_AUTH_OIDC_ISSUER` as its issuer and `SYSTEM_AUTH_OIDC_AUDIENCE` as its audience, and its `sub` (or verified `email`) is on `SYSTEM_AUTH_OIDC_ALLOWED_SUBJECTS`. For Google the issuer is `https://accounts.google.com` (tokens naming it as `accounts.google.com`, which Google also issues, are accepted too), the audience is the drain URL, and the subject is the push subscription's or the scheduler job's service account email. An oidc caller may drain; the run listings and the system agent act in a tenant and still need the key.

Naming `oidc` without all three of its settings, or an issuer that is not `https` in production, fails boot naming what is missing. So does `oidc` without `api_key` while `AUTOMATIONS_TICK_URLS` is set, since the notifier sends the key. A refused call answers `403` with each verifier's reason, and the refusal is logged at most once a minute per caller address and verifier; tokens are never logged.

**Bring your own verifier.** An embedder composing its own process can decide differently, for instance mutual TLS behind its own proxy, or its own token service. It implements the interface in [docs/contracts/system-caller.md](../docs/contracts/system-caller.md) and registers it before the server serves:

```ts
import { registerSystemCallerVerifier } from './services/system_auth';

registerSystemCallerVerifier({
  name: 'mtls',
  async verify({ headers }) {
    return headers['x-client-verified'] === 'SUCCESS'
      ? { ok: true, principal: { id: String(headers['x-client-dn']) }, actions: ['drain'] }
      : { ok: false, reason: 'no verified client certificate' };
  },
});
```

Verifiers are asked in registration order; the configured modes register theirs at server start (`installSystemCallerVerifiers`). A verifier sees the raw request headers, so one that trusts a header a proxy sets, as this example does, is only as safe as the proxy: **the proxy must strip any copy of those headers the client sent** before setting its own, or any caller can claim to be verified. Registering a verifier other than `api_key` also turns on the deferral: a system request the API's own authentication refused goes on to the verifiers instead of being answered there.

What push-tick does not change: **every other unit's loops still need an always-on process**, because each holds its unit's advisory lock and polls on a timer. With every product mounted those are knowledge's mutation outbox drainer (`knowledge.mutation_outbox`) and property arbitration (`knowledge.property_arbitration`), valuations' change outbox (`valuations.change_outbox`) and outbound delivery (`valuations.outbound_delivery`), and asks' settle-notification delivery (`asks.ask_webhook_delivery`, which runs only under webhook delivery). Core's first-boot provisioning also runs under its lock at boot. Where knowledge and automations share a process under `local` delivery, a knowledge mutation reaches automations' listeners through that process's outbox drainer. So a deployment that scales the API to zero must mount only `automations` (and `core`, which has no loop) there, and run the other products in a process that stays up. Live run updates ride a WebSocket, which needs an instance up while someone is watching.

## Bringing your own datastores

Postgres, Redis and the object store come bundled, and each one can be moved to a managed service **on its own**, by naming yours in `deploy/.env` and changing nothing else. The bundled service then stops being part of the composition: it is not started, not pulled, and not in `docker compose config`. There is no compose file to edit and no second stack to maintain.

| store | bundled as | name yours with | then the bundled one |
|---|---|---|---|
| database | `postgres`, a `pgvector/pgvector:pg16` on the `pgdata` volume | `DATABASE_URL` (and `DATABASE_URL_READONLY`, which follows it when you have no replica) | leaves the composition |
| cache and counters (optional) | `redis`, on the `redisdata` volume | `MESSAGE_QUEUE_REDIS_HOSTNAME` and `MESSAGE_QUEUE_REDIS_PORT` | leaves the composition |
| object store | `minio`, on the `miniodata` volume | `AWS_S3_ENDPOINT`, with the four `AWS_*` values beside it | leaves the composition |

**Why it is one variable and not two.** The presence of that variable is both what the process connects to and what compose reads to decide whether to start a bundled service, so the two cannot disagree. `up.sh` prints which stores are bundled and which are yours on every start, so a `DATABASE_URL` you forgot was exported in your shell is visible rather than mysterious.

Each move has a runbook in your platform's guide — [GCP](guides/gcp-vm.md), [AWS](guides/aws.md), [Render](guides/render.md) — because moving a store is mostly moving its data. What is true of each of them wherever you are:

**The database.** Postgres 16 with `vector`, `pg_trgm`, `citext`, `pgcrypto`, `unaccent` and `btree_gin`; the migration set is monolithic, so every installation needs the union whatever it mounts. **Run [`postgres-init/00-roles.sql`](postgres-init/00-roles.sql) against it, as a superuser, before anything else** — the compose Postgres runs that file from an init hook and a managed database has none, and more than a hundred grants across the migration history fail without those two roles. `DATABASE_URL_READONLY` must be set even without a replica; leave it unset here and it follows `DATABASE_URL`, which is what it must be either way. The api holds session-level advisory locks, one long-lived connection per mounted unit other than automations, so **a pooler in transaction mode breaks the worker guarantee**: session-level pooling only. Budget five long-held connections plus the pools.

**Redis.** Host and port, with no username, password, TLS or URL form anywhere in the client, so a managed Redis that requires AUTH or in-transit encryption cannot be reached at all through these two variables. Use a private network and let that be the boundary. Redis is optional: with no hostname set the API never connects to one (the composition always sets it, to the bundled `redis`, unless you name yours). Without it, the runaway-loop counters live in each API process's memory, so several instances each count only their own firings; the icon cache is off, so every icon is fetched upstream; and in-flight MCP OAuth state is not shared between instances or kept across a restart. Nothing has to be moved when you switch: what lives there is core's in-flight MCP OAuth state, which costs a person a re-consent, and automations' runaway-loop counters, which fail **open**. Both are rebuilt by use.

**The object store.** Any S3-compatible bucket: set `AWS_S3_ENDPOINT`, `AWS_DOCUMENT_S3_BUCKET`, `AWS_REGION`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` together, and `AWS_S3_FORCE_PATH_STYLE=true` only for a store that needs path-style addressing. On AWS itself leave the endpoint unset. Objects have to be copied across: the bundled store's are in the `miniodata` volume and the `listen-fire` bucket, and any S3 client that speaks to both ends will move them. Do it before you flip the variable, because links already handed out are absolute at the old origin.

**One store at a time is the point.** Moving the database and leaving Redis and the object store bundled is a supported shape, and so is every other combination.

## Asks

Your system creates a question over HTTP, a person answers it at a link that needs no account, and the answer comes back to you.

`ASKS_SETTLE_DELIVERY` decides how it comes back, and there is exactly one path — delivering both ways would announce one answer twice.

| value | what happens |
|---|---|
| `local` | The answer is handed to the automation engine in the same process. Correct only when `automations` is mounted here to be that engine. |
| `webhook` | Every settled question POSTs to the callback URL you gave when you created it: signed, retried six times over about fifteen hours, then given up on. |

`up.sh` sets `local` when `asks` and `automations` are both in the unit list and `webhook` otherwise, so you never have to choose. The signing secret is generated on first boot, so a standalone installation can deliver from the moment it starts.

Verify a delivery by recomputing `x-asks-signature: sha256=<HMAC-SHA256 of the raw request body>`. Without a signing secret, deliveries are **held** — not attempted, not dropped — and the health surface says so. `GET /api/v1/asks/health` reports the delivery mode and the pending and failed counts.

**Answer links cannot be moved.** They are absolute at `API_BASE_URL` and they are already in somebody's inbox.

**A standalone asks installation is API-only.** Asks has no pages of its own — the answer link is served by the API, and the surface for watching and answering questions in the UI belongs to `automations`. So naming `asks` on its own gives you an HTTP surface and nothing to open in a browser; add `automations` if you want the UI.

## Valuations

Legal entities, investments, transactions, assets, prices and events, plus a compute endpoint that turns those rows into a holding's value on a date, in a currency you choose.

Every resource under `/api/v1/valuations/` has the same shape — list, read, create, update, delete — across `legal-entities`, `investments`, `transactions`, `assets`, `asset-transfers`, `prices` and `events`. Higher-level moves (a funding round, a share split, dividends, a wind-down) are single posts under `/api/v1/valuations/commands/`, and `POST /api/v1/valuations/compute` values a set of investments as of a date.

Changes go out through subscriptions **you register over the API**, not through a deployment-wide setting. The secret is yours, per destination: you generate it, Listen-Fire stores it and signs with it, and the signature is a bare hex digest with no prefix. Registration is idempotent by URL, event types are rejected at registration rather than becoming a subscription that never fires, and a failing destination is retried five times on an escalating backoff. The destination URL is read through the subscription at delivery time, so deleting a subscription stops its backlog in the same breath.

**Multi-currency valuation has no supported way to load exchange rates yet.** Rates are reference data: `/api/v1/valuations/exchange-rates` lists and filters them and nothing writes them, and the bundled command that fills the table resolves an acting user against the accounts tables, which a single-tenant installation does not have. If every holding and every valuation you ask for use one currency, none of this applies to you. If they do not, plan on loading the rate table over SQL until this is fixed.

## Knowledge

A store for the things you track and how they relate — entities, their properties, and the edges between them, over a model you define. The same store answers on two paths, and the split is deliberate rather than historical.

| path | speaks | for |
|---|---|---|
| `/api/v1/knowledge/…` | **names** — `Company`, `headquartered in` | people and agents: the model, natural-language queries, raw queries, CSV import and export |
| `/api/v1/knowledge/graph/…` | **ids only** | programs: nodes, upserts, matching, edges, deduplication rules, subscriptions |

A name is renameable, so a program that routed by one would silently stop matching the day somebody renamed a type. Integrations should use the id path and store ids. There is also an agent connector at `/api/v1/mcp/knowledge`, on the same credential.

**A store with no model key is a supported deployment, not a broken one.** Creating types, writing nodes and edges, querying, matching and CSV round-trips never call a model. One thing waits for a key: a property type can declare that conflicts between sources are settled by reading all the evidence rather than by taking the newest write. With no key, that worker keeps ticking, leaves every contested property **holding** the value that landed rather than guessing, and reports `"no model key configured"` as its reason. Losing arbitration is visible; it is never silent.

### Where graph changes go

Every write to the graph enqueues an event, and `KNOWLEDGE_MUTATION_DELIVERY` decides how it leaves. A deployment has exactly one path — delivering both ways would fire a downstream listener twice off one write.

| value | what happens |
|---|---|
| `local` | Handed to a consumer in the same process. That consumer exists only when `automations` is mounted here. |
| `webhook` | Delivered to the subscriptions you register over the API. With none registered, events drain quietly to nobody, which is the right shape for a store nothing is listening to yet. |

The CODE default is `local` — right for the composed deployment, wrong for a knowledge-only one, where every graph write's event would fail delivery and retry on a backoff. `up.sh` sets `webhook` unless `automations` and `knowledge` are BOTH mounted in the same process, so you never have to think about it; `KNOWLEDGE_MUTATION_DELIVERY` in `deploy/.env` overrides it if you must.

Subscriptions are registered at `/api/v1/knowledge/graph/webhooks`; an empty event-type list means every type, registration is idempotent by URL, and a secret is generated and returned if you supply none. Verify with a bare hex HMAC-SHA256 of the raw body. Registering a subscription while delivery is `local` is refused at the door with an explanation rather than accepted into silence. `GET /api/v1/knowledge/graph/health` reports the delivery mode, the outbox depth and last error, and whether a model key is configured.

Entity matching is exact (case-folded) plus trigram similarity — a model key is not what makes it work, and there is no vector search over the graph.

## Automations

An automation is a small program over your real systems: something happens — a schedule fires, a message arrives, a record changes — and it reads, decides, writes, and where it needs a person, stops and asks one.

**The long pole is not this file.** What your automations can reach depends on which third-party apps you register, and two of those have review queues you do not control. Start that work at the beginning of a project, not the end.

| tier | what it costs you | which systems |
|---|---|---|
| **Nothing to configure** | already working | schedules and cron, manual runs, questions to a person, the knowledge graph, plain HTTP requests, inbound webhooks. Email and WhatsApp also work as things an automation *listens to*. |
| **Your users paste a credential** | nothing to register | Affinity, Granola, Attio, and a remote adapter server you host yourself |
| **You register your own app** | see below | Slack, Attio, Airtable, Google Sheets and Drive, Gmail, Dropbox, Telegram, WhatsApp, Mailgun or Resend |

Gmail shares the Google OAuth client Sheets and Drive already use, so it costs you no extra app — but its scopes are restricted at Google, so read "Gmail" below before assuming the consent screen you have will carry them.

Airtable is in the third tier only: it is OAuth-only in this build, with no key-entry form. Attio is in both, and the app you register decides which: with `ATTIO_CLIENT_ID` / `ATTIO_CLIENT_SECRET` set your users sign in through Attio, and without them they paste a workspace access token instead.

**Cap what one run may spend.** `MOVEMENT_MAX_RUN_COST_USD` is a dollar amount: once a single automation run has spent that much on model calls and paid services, the run pauses. The part of it about to make a priced call stops just before that step, and every other part finishes the step it is in and stops. Nothing is thrown away. The run shows as paused, with what it spent and the cap (the runs page, and `checkRun` for an agent), and a `Run Paused` platform event fires for any automation listening for it. It stays paused until someone resumes it (the Resume button on the runs page, or the `resumeRun` tool): every stopped part carries on from where it stopped, and the run's usage resets, so it may spend up to the cap again. A part of the run that was waiting for an answer, a timer or a reply keeps waiting; if that arrives while the run is paused, it is taken and the part then stops until the run is resumed. A rehearsal, and a fired callback's body, cannot pause: they fail at the cap instead, saying the cap, what was spent and how to raise it. The cap is not mandatory, but it is encouraged: an automation that loops is still making honest progress, call after call, and nothing else stops it. Pick a figure well above what your largest honest run costs (each run's cost is on its record). What counts:

- Every model call made on the run's behalf: extraction, `AI(…)`, plugins that call a model, the entity judge (including Jev), embeddings, image generation on OpenAI and transcription on Gemini. Each is priced from the same table the usage records use; a model that table has no price for counts as free, and the API logs a warning naming it.
- Page fetches through Bright Data's Web Unlocker (the `fetch_url`, `vc_url_retrieval` and research plugins), at $1.50 per 1,000 requests; a JavaScript-rendered retry is a request of its own.
- Any plugin that reports a price for its own work. A plugin that can cost money is not started once the run has spent the cap.
- Not counted: web searches (Google Programmable Search or Bright Data SERP), LinkedIn profile lookups through Bright Data, OCR, OpenAI transcription and Gemini image generation, none of which is priced yet, and third-party API calls such as Affinity's, which have their own limit (`AFFINITY_MAX_CALLS_PER_RUN`).
- The count is per run: a run that waits for an answer, a timer or an event and then resumes carries on from what it had already spent. Only resuming a run paused at the cap resets it. A run started by another run counts on its own. Runs already in flight can overshoot by the calls they had already started, and branches of one run that resume at the same moment each start from what the run had recorded, so the cap bounds spend rather than fixing it to the cent.
- Each run's record says what it spent and where: `costUsd` and `runCostUsd` on each step (that step, and the run so far) and `costBySource` in microdollars by model, service or plugin.

Unset means no cap. A value that is not a positive number fails boot naming the variable.

**Bound how deep one run's calls may nest.** An automation's functions may call themselves, directly or through each other. `MOVEMENT_MAX_CALL_DEPTH` is how many calls deep one run may nest; each level of a recursion is one. A run that would go deeper fails, and its failure names the chain of calls (`intake → walk → walk → …`), so a recursion that never reaches the case that ends it stops instead of running on. A `MAP` or `FILTER` set to ignore or warn about failing items does not swallow it. Items of one `MAP` run side by side, so each counts its own depth. The default is 32. Raise it only for an automation that honestly walks something deeper; a value that is not a positive whole number fails boot naming the variable.

**Writes from different runs wait for each other.** Two runs writing the same record, or the same record type by `unique by`, take turns through a Postgres advisory lock. `MOVEMENT_WRITE_LOCK_TIMEOUT_MS` is how long a write waits for another run's lock before its step fails with `write lock timeout: <name>`; the default is 60000 (one minute). Two runs that each hold what the other wants fail the same way rather than hang. Each running segment that writes holds one Postgres connection of its own for its locks, outside the shared pool: count one per in-flight segment (bounded by the drain limit, 10 by default and at most 100 per external tick, plus firings on request paths) when sizing `max_connections`. A value that is not a positive whole number fails boot naming the variable.

**What the Rust engine would refuse, counted on your runs.** Automations run on the TypeScript engine unless `MOVEMENT_ENGINE=rust`. Each run it runs is also shown to the Rust engine's admission, which only reads the program and says whether it would start it, and if not, why; nothing in the run changes, and nothing outside it is asked. `GET /api/v1/system/engine-stats` (the system key) answers this process's counts under `runs.dryRun`: `sampled` runs asked about, `admitted` the ones Rust would have started, `first` the refused ones by the first reason Rust gives, `all` by every reason it gives, and `byVersion` the same by the language version each automation is pinned to. Once a minute each process also writes its day's counts, with the automation ids each reason blocked, into the operator event store; `pnpm engine:refusals --days N` (N up to 14, the store's retention; `--json` for machine output) sums them into one table, the reason blocking the most runs first. Reasons, versions and ids only: no automation text or data is kept. Each run's row also records the engine that ran its latest segment and the first reason Rust's admission gave for not running it (`engine`, `engine_reason` in the operator run views `tg-runs`; the reason is `admitted` when Rust would take it or ran it, `shim_fault` when the Rust engine faulted in the shim (not an admission reason), and empty when the dry run was skipped by sampling or faulted). A rehearsal is not counted. What it costs per run: the run's event and catalog are serialised, a fresh WebAssembly instance is opened, and the program and its plugins are parsed once more; about a millisecond, a few at the 99th percentile, and `runs.dryRun.durationMs` in engine-stats shows this process's recent figures. Because every run now also opens a WebAssembly instance, memory and garbage collection under heavy load grow with the run rate: `MOVEMENT_ENGINE_DRY_RUN_EVERY=N` asks about one run in N instead, and `0` turns it off.

Redis holds the runaway-loop guard's counters. The guard fails **open** if Redis is unreachable — automations keep running unguarded rather than stopping. With `MESSAGE_QUEUE_REDIS_HOSTNAME` unset the API never connects: the counters are kept in the process's memory instead, exact for one instance and per-instance when several run. Compose names the bundled Redis, so this matters only off compose.

Automations' background work (the schedule runner, the poll driven listeners, the Airtable subscription refresh, the expired file sweep, the resumes of an automation parked on an answer or on a timer, and the sweep that fails a run whose process died mid-step) is rows in one work table, run by one drain worker. **Automations may run on several instances at once.** The drain takes no lock: work rows are claimed with leases, and each run is stepped under its own lease (on `trigger_run`), so two instances never step one run together. A run that another instance is stepping is retried, not failed (a wake a few seconds later, a timer five seconds later, a callback tap answered `202` and run from a queued row, an operator's resume answered `409`). Run every instance in `loop` mode, or every instance in `external` mode with the scheduler calling any of them; ticks may overlap. Work held by a process that dies is picked up when its lease expires, and a run that process left running is marked failed within about a minute and a half. By default the drain runs on an in-process timer. Set `AUTOMATIONS_DRAIN_MODE=external` to turn that timer off and have a scheduler call `POST /api/v1/system/automations/drain` with a `system` scope key instead. In that mode nothing else drains: a door only enqueues, and any instance answers the tick (optional body `{"limit": 10, "maxPasses": 20}`, at most 100 and 50; each call drains until idle and answers `{claimed, ran, recovered, failed, deferred, claimFailed, stopped}`, where `stopped` is `idle`, `pass_limit` (more may be due) or `claim_failed`). Automations has no health route of its own; the drain reports through `/healthz/workers` in both modes. In `external` mode each tick is the drain's pulse, so a scheduler that stops calling shows there as a stale tick on the instance it calls. The boot log names the mode (`[startup] automations.drain: drain mode "loop"` or `"external"`). "Deployment shapes" above covers the scheduler, a door's notify (`AUTOMATIONS_TICK_URLS`, `AUTOMATIONS_TICK_KEY`) and the drain-once job.

### Connecting Claude

Claude adds Listen-Fire as a custom connector, not from a directory listing — this installation isn't in one. In Claude, open Settings → Connectors, choose "Add custom connector", and paste `<API_BASE_URL>/api/v1/mcp/automation`. Claude then sends the person back to this installation to sign in, and that sign-in is OAuth through `core` — so `core` must be in the unit list, and its login working, before anyone can connect.

The onboarding screen shows these steps and the exact URL to paste; nobody needs to read them here. `NEXT_PUBLIC_CLAUDE_DIRECTORY_URL` is for the opposite case — a deployment actually listed in Claude's connector directory — and is not something a self-host sets; leave it unset so the paste-the-URL steps show instead of a directory link that goes nowhere.

### What a single-tenant installation cannot do

Four things bind to a **person** rather than to a credential, and refuse a machine credential with a message naming the fix rather than inventing a user: connecting a credential to a third-party system, granting access to a specific file or folder, linking a WhatsApp number, and confirming its code. Starting a new conversation with the authoring agent refuses for the same reason; continuing an existing one works.

The consequence, bluntly: **a single-tenant installation can register the third-party apps but cannot attach anybody's account to them.** Connecting accounts needs `core` in the unit list.

## Core

Accounts, teams, invitations, login, and the OAuth server that lets an agent connect to this installation on a person's behalf. You run it as soon as more than one human needs an account of their own; that is the whole decision.

**On its own, core serves nothing to use.** A core-only installation can invite people and sign them in, and nothing else. It is a sensible base and a strange destination.

**Sign-in is invited-only.** There is no self-serve signup: an address that is neither an existing account nor a pending invitation is refused with "Ask an admin of your team to add you." An admin adds an address on `/settings/team` and that is the whole act — nothing is emailed, and the person joins the first time they sign in with it. Removing a member ends their memberships and kills their live sessions; re-adding the address lets them back in.

Login is by emailed link or by password, and both need working mail — see "Signing in". Google and Microsoft sign-in buttons appear only if you configure their client ids, and they are configured **on the API only**: `GOOGLE_AUTH_CLIENT_ID` with `GOOGLE_AUTH_CLIENT_SECRET`, and `MICROSOFT_CLIENT_ID`. The login page asks the API which providers exist (`GET /api/public/config`, unauthenticated because it is the page nobody has a session on yet) and draws a button only for an id that is there — so the button and the token check read the same value and cannot disagree. The Google client is a web-application OAuth client whose authorised JavaScript origin is `WEB_BASE_URL`; sign-in uses the token flow, so it needs no redirect URI.

Redis is what makes the agent connect flow survive a restart: somebody clicks connect, consents, and their agent then exchanges a code for a token, which has to outlive whatever happens to the process in between. Held only in memory, an in-flight connection dies at a deploy and the exchange fails *after* the person has already consented, which is felt as a connect button that needed pressing twice.

If you terminate TLS at a proxy that does not forward the original host, set `PUBLIC_URL` to the API's own origin: it is what the agent connector advertises as its issuer, and a wrong one sends connectors to the wrong place.

The operator console (port 8082) is a platform-administration surface and only makes sense with `core`. The first provisioned account cannot reach it — see "First boot".

## Registering your own third-party apps

Every one of these is a **new** app of yours. None of your users' existing connections carry over: a stored credential authenticates to the app that issued it, so each person re-authorises individually against yours.

Throughout, `API_BASE_URL` is the API's public origin and `OAUTH_REDIRECT_BASE_URL` is the **web** app's origin.

### Slack

A Slack app in your own workspace or organisation. Same-day for an app installed only where you control the workspace; Slack's public directory review is weeks, and you need it only to distribute beyond your own organisation.

Set `SLACK_MOVEMENTS_CLIENT_ID`, `SLACK_MOVEMENTS_CLIENT_SECRET`, `SLACK_MOVEMENTS_SIGNING_SECRET`, `SLACK_MOVEMENTS_STATE_SECRET` and `SLACK_MOVEMENTS_REDIRECT_URI` — all five together, or the connector does not wire up.

The app is yours, so its name is too: `SLACK_APP_DISPLAY_NAME` is what this installation calls it when it speaks about it, and it defaults to `Listen-Fire`. Set it to whatever you named the app in Slack.

| Slack setting | value |
|---|---|
| Event Subscriptions → Request URL | `<API_BASE_URL>/api/public/slack/events` |
| Interactivity & Shortcuts → Request URL | `<API_BASE_URL>/api/public/slack-actions` |
| OAuth & Permissions → Redirect URL | exactly what you put in `SLACK_MOVEMENTS_REDIRECT_URI` |

Slack is the one system whose redirect you control outright: the value is passed through verbatim rather than derived, so set it to `<WEB_BASE_URL>/slack/callback` and paste exactly that.

An automation that listens to a workspace through its own subscription gets a second inbound door at `<API_BASE_URL>/api/public/webhook-sync/slack/<subscription id>`, pasted by hand because Slack has no API for registering one.

**Sharp edge.** The signing secret is what proves an event came from Slack. Unset, the door is fail-closed **everywhere** — every inbound event rejected, in production and out of it, because a staging box on the public internet is as reachable as a production one. The single exception is deliberate: `ALLOW_UNSIGNED_WEBHOOKS=true` accepts unsigned deliveries, is ignored outright in production, and warns loudly the first time it applies.

### Attio and Airtable

An OAuth integration in each vendor's developer settings. Hours, no review. Set `ATTIO_CLIENT_ID` / `ATTIO_CLIENT_SECRET` and `AIRTABLE_CLIENT_ID` / `AIRTABLE_CLIENT_SECRET`; the redirect URLs are `<OAUTH_REDIRECT_BASE_URL>/attio/callback` and `<OAUTH_REDIRECT_BASE_URL>/airtable/callback`.

Attio's pair is optional. Leave it unset and the connect form asks for a workspace access token, which a workspace admin creates under Workspace settings then Developers; the form lists the scopes to grant it. Everything downstream is identical — an access token authenticates exactly like an OAuth one.

Record-change subscriptions register themselves. When an automation that listens to one of these is saved, Listen-Fire subscribes with the team's own credential at `<API_BASE_URL>/api/public/webhook-sync/<system>/<subscription id>` — nothing to paste, and re-saving after a hostname change re-registers everything.

### Google Sheets and Drive

A Google Cloud project, a consent screen, and a web-application OAuth client. Set `GOOGLE_INTEGRATIONS_CLIENT_ID` / `_CLIENT_SECRET`; the redirect is `<OAUTH_REDIRECT_BASE_URL>/google-integrations/callback`.

Days to weeks. Drive scopes are sensitive or restricted depending on what your automations do, which means Google's verification review and, depending on scope and user count, an independent security assessment. Until you are verified the consent screen warns people and the app is capped at a handful of test accounts you enumerate by hand.

Neither pushes anything: both are read on a schedule or on demand. Beyond re-authorising, each person also re-grants the specific files and folders an automation may touch, which is one of the four person-bound surfaces above.

### Gmail

One mailbox per connection, and two ways to reach it. `GMAIL_CONNECT_METHOD` picks; unset means `oauth`.

**Signing in as the mailbox (`oauth`, the default).** Somebody signs in to Google as the mailbox itself, and Google hands back a token that works for that one address and no other. By default it uses the SAME OAuth client as Sheets and Drive — one client, one project, a different scope set — so there is no second app to register; set `GMAIL_OAUTH_CLIENT_ID` / `_SECRET` to put Gmail on a client you registered for it instead, which is worth doing when you want Gmail's restricted scopes on their own consent screen and verification. Add `<web origin>/gmail/callback` to whichever client's authorised redirect URIs, and list the Gmail scopes on its consent screen: `https://www.googleapis.com/auth/gmail.readonly` always, and `https://www.googleapis.com/auth/gmail.send` when `GMAIL_SEND_ENABLED=true`.

**Pasting a refresh token.** Beside the sign-in button, the same connect form takes a refresh token directly — for a Workspace admin who would rather authorise the mailbox themselves than hand the browser to whoever is connecting. It must be a token the OAuth client this server is configured with issued, because that is the client the box redeems it through; a token from another client, or one the account has revoked, is refused on the form. Nothing else is typed: the mailbox address and what it may do are read back from Google, the allowlist applies as usual, and what gets stored is identical to a signed-in connection.

Gmail's scopes are RESTRICTED at Google, which is the thing to plan around. Keep the consent screen **Internal** — Workspace users only — and the restriction does not apply: minutes of work, no review. Make it External and the app needs Google's verification, including a third-party security assessment; until that passes, an unverified External app's refresh tokens expire after **seven days**, so every connected mailbox stops working each week.

**Delegation (`delegated`).** The deployment's service account acts as an address it never signed into. No consent screen and no verification: enable the Gmail API in the same Google Cloud project as the runtime service account, then have a Workspace admin add that account's client id under Security, then API controls, then Domain wide delegation, with the read scope and, to send, the send scope too. One admin step, minutes. A team then connects by TYPING the mailbox address, which must be a real user or shared mailbox (a group address has no inbox to read); the form calls Google as that mailbox before saving, so a delegation that was never granted is corrected on the form rather than in a run a week later.

**`GMAIL_MAILBOX_ALLOWLIST` is policy, and what an unset one means depends on the method.** Set, it is enforced either way: only the addresses it names can be connected or used, at connect time and on every run afterwards. Unset, under `oauth` there is no restriction — Google already confined each token to the mailbox that signed in — while under `delegated` nothing is restricting anything, since that grant covers EVERY mailbox in the Workspace, so an unset list refuses every mailbox rather than defaulting to "every mailbox is fine."

Sending is off unless `GMAIL_SEND_ENABLED=true`. Under `oauth` that flag decides whether the consent even asks for the send scope, so turning it on later means reconnecting the mailbox; a mailbox that never got the scope refuses a send outright, saying so, with reads unaffected. Under `delegated` the two scopes are granted independently by the admin and each is checked independently — a mailbox can read without being able to send, or the reverse.

Automations can search the mailbox, run when mail arrives, and send or reply as it — and can never label, archive, delete or draft. Mail is POLLED about once a minute, so there is no Pub/Sub topic, no push endpoint and no weekly watch to renew.

This is separate from the inbound email address, which keeps arriving through whichever mail provider is configured, and from sign-in links and product email, which keep going out through Resend or Mailgun.

### Dropbox

An app in the Dropbox console, `DROPBOX_CLIENT_ID` / `DROPBOX_CLIENT_SECRET`, redirect `<OAUTH_REDIRECT_BASE_URL>/dropbox/callback`. Hours to create; a development app is capped at a few linked accounts until you apply for production status, which is a review measured in days.

### Telegram

Your own bot, from BotFather, in minutes. `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`.

You register the webhook yourself through Telegram's `setWebhook`, pointing at `<API_BASE_URL>/api/public/telegram/builtin` with the secret token set to the same value; an automation using its own bot gets the per-subscription door at `<API_BASE_URL>/api/public/webhook-sync/telegram/<subscription id>` instead. That header is the only thing proving a delivery came from Telegram, and the door is fail-closed everywhere without it.

The bot's @username is new and public. Anyone who keeps messaging the old one is talking to somebody else's bot.

### WhatsApp

A Meta app, a WhatsApp Business Account and a phone number on it. **Weeks** — business verification is a document review on Meta's side, and the number cannot carry traffic until it clears. This is the longest lead time in the document; start it first.

`WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_MOVEMENTS_PHONE_NUMBER_ID`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_WEBHOOK_SECRET`. Set `WHATSAPP_MOVEMENTS_NUMBER` too — the number in full international format (`+447700900000`), which is what the authoring agent quotes and what the settings page offers to verify against; leave it unset and neither names a number. Also `PHONE_VERIFICATION_SECRET`, which peppers the stored hash of the six-digit verification code — without one only you know, a leaked row yields the code by exhaustive search, and in production verification fails naming it.

In the Meta app's webhook configuration, set the callback URL to `<API_BASE_URL>/api/public/whatsapp/webhook` and the verify token to the same string as `WHATSAPP_WEBHOOK_VERIFY_TOKEN`; Meta calls it with a GET to confirm before delivering anything. Exactly one Meta app should be subscribed to the WhatsApp Business Account — a second one signs with a different app secret, and every delivery from it is refused with a 401 that the log explains.

The authentication template is registered with Meta per deployment, and Meta substitutes an app name into the code it sends. `WHATSAPP_APP_DISPLAY_NAME` is that name, defaulting to `Listen-Fire`; set it to match the template you registered, so the message a recipient reads names your app rather than someone else's.

`WHATSAPP_LINK_VERIFICATION` decides how a user proves a number is theirs. The default, `otp`, sends a code through that template and links the number once the code comes back. `trust` links a signed-in user's number the moment they enter it: no authentication template, no code sent, and so no `PHONE_VERIFICATION_SECRET` in use. Everything else still applies: `WHATSAPP_WEBHOOK_SECRET` and the verify token so inbound messages are accepted, the phone-number ids so they are routed, and `WHATSAPP_ACCESS_TOKEN` for replies and for fetching a message's attachments. A number already linked to another account is refused under either setting. The trade-off: anyone with an account on the deployment can claim any number, and that number's messages then run that account's automations, which suits a self-host serving one organisation and not a shared one.

One outbound path runs through a separate messaging provider (`TWILIO_NUMBER`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`). With any of them unset, production sends nothing and says so in the log rather than pretending to deliver.

A new number means every conversation starts fresh; counterparty threads do not carry over.

### Email, through Mailgun or Resend

Pick one. Both carry mail in both directions, and configuring both is not a way to have two — Resend wins, for inbound and outbound alike, because a deployment must have exactly one answer to where its mail comes in. The boot log says which one it settled on.

Either way you also set `INBOUND_EMAIL_ADDRESS` — the address automations receive on, local part and domain, e.g. `inbox@yourdomain.com`. There is no default: a default would have your automations tell their authors to forward mail to somebody else's inbox. An automation that listens for email while it is unset is reported as unverified rather than quietly never firing.

**Mailgun.** A domain and an inbound route on it. Hours, gated on DNS propagation. `MAILGUN_API_KEY`, `MAILGUN_SENDING_DOMAIN`, `OUTBOUND_EMAIL_FROM`, and optionally `OUTBOUND_EMAIL_FROM_NAME`, `OUTBOUND_EMAIL_BCC` and `MAILGUN_API_BASE_URL` (the region endpoint defaults to Mailgun's EU host; a US-region account must set `https://api.mailgun.net`). Create a route that forwards to `<API_BASE_URL>/api/mailgun/callback`. The signature on that delivery is checked against the API key, so inbound mail needs the key even if you never send a message. The inbound route must be on `MAILGUN_SENDING_DOMAIN`: attachments are fetched, with the key, only from that domain's stored messages.

**Resend.** A verified domain with an MX record pointing at Resend, and a webhook. `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `OUTBOUND_EMAIL_FROM`, and optionally `OUTBOUND_EMAIL_FROM_NAME` and `OUTBOUND_EMAIL_BCC`. Subscribe a webhook to `email.received` and point it at `<API_BASE_URL>/api/resend/callback`; the `whsec_…` secret Resend shows you is `RESEND_WEBHOOK_SECRET`. Resend's webhook carries only ids, so the API fetches the body and the attachments with the key — inbound needs it as much as sending does.

Sending needs the from-address plus a provider's credentials in full; missing any of them, production gets a loudly-failing sender rather than mail that quietly evaporates.

Nothing to re-authorise — but any address automations used to receive on is now a different address, so whoever mails into it has to be told.

### Cutover cannot be fully parallel-run

Automations driven by a schedule or a poll can genuinely run on both the old and the new stack at once and be compared run for run. Event-driven ones cannot: a Slack event, a Telegram update or a WhatsApp message is delivered to exactly one registered app, so "parallel" for those means one side is dark. Parallel-run the schedule- and poll-driven automations for a week, then cut the event-driven ones over one system at a time.

## Health

| endpoint | auth | what it tells you |
|---|---|---|
| `GET /.well-known/health-check` | none | the process is up, answering `201`. This is what a platform probe should call. |
| `GET /healthz/workers` | none | the release this process is running (`version`), every background loop this installation runs, whether this process started it, its last tick, and a reason for any deliberately idle one. |
| `GET /api/v1/valuations/health` | API key | outbound delivery health, with error text |
| `GET /api/v1/knowledge/graph/health` | API key | graph delivery mode, outbox depth, and whether a model key is configured |
| `GET /api/v1/asks/health` | API key | delivery mode plus pending and failed counts |

`/healthz/workers` is unauthenticated by design — the operator of a self-hosted installation is whoever can reach the process — and carries no free text, deliberately, because a delivery error would name a customer's webhook URL.

Two readings to get right before you alert on it. A unit you do not run contributes **no rows**: absence is the answer, not an error. And a mounted loop reporting that it did not start here means either "another instance holds the lock" or "wedged and never started here" — unambiguous only because you kept it to one instance.

## Upgrading

Snapshot the database, change `LISTEN_FIRE_VERSION` in `deploy/.env`, pull, and start:

```bash
# from deploy/ — the full runbook, including the rollback, is UPGRADING.md
docker compose pull
docker compose up -d
```

Migrations run as a one-shot service before the new API starts. They are forward-only and applied by file name; **back up your database before an upgrade, because there is no down-migration path.** The config volume is untouched by an upgrade — it is generated once and never rewritten.

[UPGRADING.md](UPGRADING.md) has the whole procedure: what to snapshot, how to check the new version is the one running, the smoke checks, and how to roll back. [CHANGELOG.md](../CHANGELOG.md) lists what each release changed, including the settings and migrations it brings.

## Stopping and removing

```bash
# from deploy/ — stop everything, keep the data
docker compose down

# stop everything AND destroy it: database, redis, the object store, and the
# config volume
docker compose down -v
```

**A `down` stops what its profiles name, and nothing else.** That is why the profile list belongs in `COMPOSE_PROFILES` in `deploy/.env` rather than on the command line: a `--profile` flag replaces that list on older Docker Compose versions, and a `down` that names fewer profiles than the `up` did leaves the rest running for the next start to inherit. A stack started by `up.sh` is the case where the profiles are on the command line rather than in the file, so `up.sh` prints the matching `down` for the shape it started; use that one.

`down` keeps every volume, so starting again resumes the same installation. **`down -v` also destroys `listen-fire-config`**, which is the volume the section above says must never be regenerated: the encryption keys go with it, and every stored third-party credential in a database you restore afterwards is then permanently unreadable. It destroys `miniodata` too, which is every file the bundled object store holds. Use `down -v` to throw an installation away, never to restart one — and if you only meant to reclaim the disk, back the config volume up first.

## Moving a team in or out

Three commands move one team's data between installations without touching anyone else's: an export writes a portable bundle, an import loads one into a target, and a delete removes a team and everything belonging to it. Together they are how an offboarding, a move to your own infrastructure, or a copy into staging actually gets done.

Run them through the same wrapper that loads the generated secrets, with a directory mounted for the bundle:

```bash
docker compose run --rm -v "$PWD/bundles:/bundles" \
  --entrypoint /usr/local/bin/with-generated-env api \
  sh -c 'pnpm cli export-team --team <uuid> --out /bundles/acme'
```

`--products` narrows what is carried (it defaults to all five), `--without-history` omits run, message and delivery history — the bulkiest and most sensitive part of a bundle — and `--database-url` overrides the database, so you can point one at a database whose application half cannot even boot, which is the state an offboarding tends to find things in. `import-team --in <dir>` and `delete-team --team <uuid> --confirm` take the same shape.

**A bundle is a plain directory**: a manifest plus one file per table, every value in Postgres's own text representation, so numerics, timestamps, JSON, arrays and enums cross unchanged and the files stay readable before you hand them to anybody. The manifest records each table's columns, its row count and a digest that the import checks before trusting a single row. Two exports of unchanged data are byte-identical but for the line naming when they ran.

**Import refuses rather than guesses.** A target at a different migration point, a carried table missing a column there, or the team already having rows there each stop it before anything is written — a row whose id matches but whose contents differ is either an edit on the target or a stale export, and only a person knows which. Deleting the team and importing again is the supported way to redo one. Ids are never re-minted, which is what lets automations, subscriptions and graph edges keep resolving on the other side, and the load runs with database triggers suppressed, so the audit trail does not attribute the tenant's whole history to whoever ran the import and the outboxes do not re-deliver carried rows as though they had just happened.

**Credentials arrive as shells.** Read this before importing anything with automations in it. A connection's id, name and type cross intact, so every trigger and subscription that references it still resolves — but the secret does not. It is bound by encryption to the source installation's key, and for any app you registered yourself it authenticates against the source operator's registration, so it would be worthless against yours however it were carried. Each shell is stamped as needing reconnection, and an automation that reaches for one fails by name rather than with an opaque decryption error. Afterwards you have two jobs: reconnect every connection against your own app registrations, and re-save every listening trigger so it registers a fresh subscription at the new hostname.

**Not carried, and why.** The audit trail (it records writes against the source database); the undelivered outboxes (events addressed to the source's subscribers — carrying them would fire the target's listeners for writes it never saw); live single-use capabilities and codes minted for the source origin; a pasted model key and the handle on the source operator's own app registration. One genuine gap rather than a policy choice: the table behind temporarily exposed files carries no team and no owner, so there is no expression that selects one tenant's rows out of it — it can be neither exported nor purged per team. Those rows expire on their own and their URLs are absolute at the source origin, so they are dead at cutover anyway.

**Two asymmetries worth knowing.** Currency reference data travels with the bundle even though it belongs to the installation rather than the team, because a fresh target has none and the team's own prices point at it; if the target already has its own copy, that copy wins, and a team deletion never removes it. And a person who also belongs to another team is spared by a delete, along with their contact rows — a person is not one team's property — which is one reason the executed row count is usually lower than the dry run's.

A delete without `--confirm` only reports what would go. `--confirm` is the whole opt-in. It reaches the usage tables too, so an offboarding does not leave history behind, and it derives its order from the database's own foreign keys rather than a hand-maintained list — the deletion succeeding is itself the proof the order was right.

WhatsApp is the exception to `--products`: its tenancy is only expressible through the accounts tables, so exporting without `core` declines those tables by name rather than emitting them empty.

## Verifying an installation

`deploy/smoke.sh` boots five stacks from clean Docker state, asserts health, the capability answer, login by both doors and that the product pages render, and tears each one down with its volumes before the next — so the first-boot path is what is actually under test. Four of them vary which units run. The fifth varies where the database is: a second Postgres joins the composition under a name of its own, `DATABASE_URL` names it, and the assertions are that no bundled `postgres` container exists and that the schema landed in the other database. It builds four images and five stacks, so budget about twelve minutes rather than seconds.

## Environment reference

Everything here is set by you, in `deploy/.env`. Nothing in this table is generated, and nothing generated belongs in this file.

| variable | required | unset behaviour |
|---|---|---|
| `ANTHROPIC_API_KEY` | no, but agents need one | the key the agents use, and the fallback for the graph's arbitration. Absent, `init` and the API warn at boot and every model-backed call fails naming it |
| `KNOWLEDGE_LLM_API_KEY` | no | falls back to `ANTHROPIC_API_KEY`; with neither, contested properties hold their value and the queue grows, visibly |
| `KNOWLEDGE_LLM_MODEL` | no | `claude-opus-5`. Must be a model name the product uses; boot refuses any other. Where it goes follows `MODEL_MAP`, and `KNOWLEDGE_LLM_API_KEY` applies only when that is Anthropic's own API |
| `OPENAI_API_KEY` | only for names the map leaves at OpenAI | the key for OpenAI's own names: transcription, embeddings and image generation, plus any chat name the map sends to `openai`. Absent, each fails naming it when asked for |
| `OPENAI_ORGANIZATION` | no | none — no `organization` is sent, and OpenAI uses the key's own default org |
| `MODEL_MAP` | no | empty — every model name goes to its own vendor under its own name. A JSON object from model name to `provider/wire-model` sends names elsewhere; see "What you configure" for three worked maps (vendor keys, everything on OpenAI, everything on Gemini) and the Claude on Google Cloud one. Boot refuses a map it cannot serve |
| `EXTRACTION_TIERS` | no | empty — `quick`, `careful` and `thorough` are `claude-sonnet-5` at effort `low`, `high` and `xhigh`. A JSON object from tier to `{ "model", "effort" }` reassigns them; see "What you configure". Boot refuses a model this deployment cannot call |
| `MOVEMENT_MAX_RUN_COST_USD` | no, but encouraged | no cap — an automation run may spend any amount on model calls and paid services. A positive number of US dollars (e.g. `5`) pauses a run at its next priced call once it has spent that much, across every wait, until someone resumes it; see "Automations". Boot refuses anything that is not a positive number |
| `MOVEMENT_MAX_CALL_DEPTH` | no | 32 — how many calls deep one automation run may nest (each level of a recursion is one). A run that would go deeper fails, naming the chain of calls; see "Automations". Boot refuses anything that is not a positive whole number |
| `MOVEMENT_WRITE_LOCK_TIMEOUT_MS` | no | 60000 — how many milliseconds a write waits for another run's lock on the same record (or record type, for `unique by`) before its step fails with `write lock timeout: <name>`; see "Automations". Boot refuses anything that is not a positive whole number |
| `MOVEMENT_ENGINE` | no | `ts` — automation runs use the TypeScript engine. `rust` sends every run to the Rust engine first; what it refuses runs on the TypeScript engine unless `MOVEMENT_ENGINE_FALLBACK=none`. Boot refuses any other value |
| `MOVEMENT_ENGINE_FALLBACK` | no | `ts` — a run the Rust engine refuses runs on the TypeScript engine. `none` fails that run instead, with the reason in its failure (`the Rust engine does not run this movement (<reason>) …`): set it once the refusals report is empty, resume reasons included, so a refusal is an error and not a silent slow path. Under `none`, any Rust refusal or decline of a run, a resume, a race settlement or a callback firing fails the run with the reason. The admission dry run does not yet cover race settlements and callback firings, so the "refusals report is empty" precondition cannot be verified for those two routes until it does. Needs `MOVEMENT_ENGINE=rust`; boot refuses `none` otherwise, and any value but `ts` or `none` |
| `MOVEMENT_ENGINE_DRY_RUN_EVERY` | no | 1 — every automation run the TypeScript engine runs is also shown to the Rust engine's admission, and what it would refuse is counted; see "Automations". N asks about one run in N; 0 turns it off. Boot refuses anything that is not a whole number |
| `AUTOMATIONS_DRAIN_MODE` | no | `loop` — each instance drains automations' work on its own timer. `external` turns the timer off, and every pass is a call to the drain endpoint; see "Deployment shapes". Boot refuses any other value |
| `AUTOMATIONS_TICK_URLS` / `AUTOMATIONS_TICK_KEY` | no | in `external` mode, a door's work waits for the next scheduled tick. Set both (comma-separated drain endpoint URLs, and a `system` scope key) to have each enqueue POST a tick to every URL; half the pair fails boot naming both. Ignored in `loop` mode |
| `SYSTEM_AUTH_MODES` | no | `api_key` — the system endpoints accept a `system` scope key. A comma-separated list of `api_key` and `oidc`; see "Who may call the system endpoints". Boot refuses any other mode |
| `SYSTEM_AUTH_OIDC_ISSUER` / `SYSTEM_AUTH_OIDC_AUDIENCE` / `SYSTEM_AUTH_OIDC_ALLOWED_SUBJECTS` | with `oidc` | the issuer whose keys sign the tokens (`https://accounts.google.com`), the audience they must name (the drain URL), and the comma-separated subjects or verified emails allowed. Boot refuses `oidc` without all three |
| `GOOGLE_MODEL_REGION` | no | `global` — where models are addressed on Google Cloud, for both the `vertex` (Claude) and `gemini` providers. `GOOGLE_PROJECT_LOCATION` is separate and stays the location OCR uses |
| `GEMINI_BASE_URL` | no | unset — every call the map sends to `gemini` (chat, transcription, embeddings, images) goes to Google Cloud, signed with the service account. Set it only to point those calls at a stand-in such as the dev loop's fake Gemini (`http://localhost:<fake channels port>/gemini`); a redirected client sends a placeholder key instead of a Google token |
| `GOOGLE_PRIVATE_KEY` / `GOOGLE_CLIENT_EMAIL` / `GOOGLE_PROJECT_ID` | when the map names `vertex` or `gemini`, or for OCR | the deployment's one Google service account. `GOOGLE_PROJECT_LOCATION` (default `europe-west1`) joins these for OCR |
| `GOOGLE_CLIENT_ID` / `GOOGLE_OCR_PROCESSOR_ID` / `GOOGLE_STORAGE_BUCKET_NAME` | only for OCR | OCR boots unconfigured, so a PDF past its own text layer fails naming what it wanted |
| `GMAIL_OAUTH_CLIENT_ID` / `GMAIL_OAUTH_CLIENT_SECRET` | no | Gmail signs in through the `GOOGLE_INTEGRATIONS` client. Set BOTH to give Gmail an OAuth client of its own; half a pair fails boot, since Google refuses an exchange carrying an id without its secret |
| `GMAIL_CONNECT_METHOD` | no | `oauth` — a Google sign-in as the mailbox, through the same client Sheets and Drive use. `delegated` instead has the service account act as the address, granted once by a Workspace admin; anything else fails boot naming the variable and the two values |
| `GMAIL_SEND_ENABLED` | no | a connected mailbox reads and never sends. `true` adds the send scope — under `oauth` to what the consent asks for, so an already-connected mailbox is reconnected to gain it |
| `GMAIL_MAILBOX_ALLOWLIST` | required under `GMAIL_CONNECT_METHOD=delegated` | set, only the mailboxes it names may be connected or used, under either method. Unset: no restriction under `oauth` (Google confines each token to the mailbox that signed in), and every mailbox refused under `delegated` (that grant covers the whole Workspace, so there is nothing else drawing the line) |
| `WEB_SEARCH_PROVIDER` | no | `google` — the LinkedIn activity research and the website research search through Google Programmable Search. `brightdata` switches both to Bright Data's SERP API instead (Google's own results, fetched a different way); anything else fails boot naming the variable and the two values. Google is discontinuing "search the entire web" in Programmable Search on 2027-01-01 |
| `GOOGLE_CUSTOM_SEARCH_API_KEY` / `GOOGLE_CX` | with `WEB_SEARCH_PROVIDER=google` (the default) | without both, the two web-search plugins can't run and every record they were pointed at comes back unenriched |
| `BRIGHT_DATA_SERP_ZONE` | with `WEB_SEARCH_PROVIDER=brightdata` | its own zone — a Bright Data account keeps SERP as a separate product from the Web Unlocker zone `BRIGHT_DATA_ACCESS_TOKEN`/`BRIGHT_DATA_UNLOCKER_ZONE` use for page fetching |
| `BRIGHT_DATA_SERP_PER_MINUTE` | no | `14` — how many Bright Data SERP requests one API process sends per minute, retries included. Searches beyond it wait their turn rather than being sent and refused: Bright Data throttles a zone whose success rate drops, with a 429 naming the rate it will accept, and `14` is the rate it named in production. Raise it only if your zone's limit is higher. Anything but a positive whole number fails boot naming the variable |
| `LISTEN_FIRE_TEAM_NAME` | no | `Acme`. Read only on first boot, into the generated config |
| `LISTEN_FIRE_ADMIN_EMAIL` | recommended with `core` | `admin@listen-fire.local` — the address the first account is provisioned with, and the one that receives login links |
| `SLACK_APP_DISPLAY_NAME` | no | `Listen-Fire` — the name your Slack app shows in a workspace, which is yours to pick because the app is yours |
| `WHATSAPP_APP_DISPLAY_NAME` | no | `Listen-Fire` — the app name Meta substitutes into the WhatsApp authentication template you registered |
| `WHATSAPP_LINK_VERIFICATION` | no | `otp` — linking a WhatsApp number sends it a code, and the link counts once the code comes back. `trust` links a signed-in user's number at once with no code (see "WhatsApp"); anything else fails boot naming the variable and the two values |
| `SUPPORT_EMAIL` | no | no address is published: anything that would point someone at support says nothing rather than inventing an inbox |
| `API_BASE_URL` | yes in production | `http://localhost:8081`. Must be stable forever; also decides cookie security with the one below |
| `WEB_BASE_URL` | yes in production | `http://localhost:8080`. Where login links point |
| `OAUTH_REDIRECT_BASE_URL` | only if the web app is on a different origin from `WEB_BASE_URL` | compose defaults it to `WEB_BASE_URL`, which is where those callback pages are served |
| `EXPOSED_FILE_PUBLIC_BASE_URL` | only off compose | compose defaults it to `API_BASE_URL`. The code's own fallback is `OAUTH_REDIRECT_BASE_URL` and then a localhost literal — the one URL default that degrades quietly |
| `LISTEN_FIRE_DEMO` | no | `0`. `--demo` sets `1`, which is what wires the stand-in third parties to the installation and lets the sample dataset be seeded. Not something to turn on by hand on a real installation |
| `PUBLIC_URL` | only behind a host-rewriting proxy | the agent connector's issuer origin is derived from the request |
| `NEXT_PUBLIC_CLAUDE_DIRECTORY_URL` | no, and not for a self-host | unset. A build-time value on the web app, set only for the one deployment listed in Claude's connector directory; unset shows the paste-the-URL custom-connector steps instead |
| `WEB_PORT` / `API_PORT` / `ADMIN_PORT` / `FAKE_CHANNELS_PORT_HOST` | no | 8080 / 8081 / 8082 / 8083. Numbers only |
| `LISTEN_FIRE_BIND` | no | every interface. `127.0.0.1` publishes the three apps to loopback only, for a reverse proxy on the same box |
| `KNOWLEDGE_MUTATION_DELIVERY` | no | derived from your unit list by `up.sh`; the code's own default is `local`. An unrecognised value fails the boot rather than picking one |
| `ASKS_SETTLE_DELIVERY` | no | as above |
| `COMPOSE_PROFILES` | only without `up.sh` | nothing optional runs, INCLUDING the bundled datastores. `postgres,redis,minio` is the shipped line; add `admin` for the operator console and `demo` for the stand-ins. Read by `docker compose` itself, from `deploy/.env` |
| `LISTEN_FIRE_PRODUCTS` | only without `up.sh` | every unit. An unknown name fails the boot |
| `LISTEN_FIRE_PRINCIPAL` | only without `up.sh` | `core`. Must agree with whether `core` is in the unit list, checked in both directions |
| `LISTEN_FIRE_SCOPES` | no | `*` — the API key grants everything. Narrow it to what a key actually needs |
| `LISTEN_FIRE_ACCESS` | no | `write`; `read` makes the key read-only |
| `LISTEN_FIRE_ALLOW_ANONYMOUS` | no | `false`. `true` removes the key requirement entirely — only on an API nothing else can reach |
| `DATABASE_URL` | only with your own database | the bundled Postgres, whose URL is generated on first boot. Setting it also takes that service out of the composition |
| `DATABASE_URL_READONLY` | no | follows `DATABASE_URL`. Set it only for a real read replica; it is never allowed to be absent, which is why it is defaulted rather than required |
| `MESSAGE_QUEUE_REDIS_HOSTNAME` / `_PORT` | only with your own Redis | the bundled Redis, `redis:6379` on compose. Off compose, unset means no Redis at all: nothing connects, loop-guard counts stay per process, icons are not cached, MCP OAuth state stays in the process. Setting the hostname also takes the bundled service out of the composition. Host and port only: no URL, no AUTH, no TLS |
| `OUTBOUND_EMAIL_FROM` plus one provider's credentials | yes with `core` in production | no mail is sent, so nobody can log in |
| `RESEND_API_KEY` / `RESEND_WEBHOOK_SECRET` | with Resend | Mailgun is used instead, if it is configured |
| `MAILGUN_API_KEY` / `MAILGUN_SENDING_DOMAIN` | with Mailgun (the domain also gates inbound attachments: only its stored messages are fetched) | as above, in reverse |
| `MAILGUN_API_BASE_URL` | US-region Mailgun accounts | Mailgun's EU host |
| `INBOUND_EMAIL_ADDRESS` | to receive mail at all | none — an automation listening for email is reported unverified |
| `OUTBOUND_EMAIL_FROM_NAME` / `OUTBOUND_EMAIL_BCC` | no | no display name; no archive copy |
| `AWS_S3_ENDPOINT` | only with your own object store | the bundled MinIO, `http://minio:9000`. Setting it also takes that service out of the composition, and leaves the four below to you. Unset it for AWS S3 itself only if you are also naming your own key |
| `AWS_DOCUMENT_S3_BUCKET` / `AWS_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | with your own object store | the bundled MinIO's bucket, region and generated root credential. With your own endpoint it is all four together or no storage at all, and file-touching steps fail naming them |
| `AWS_S3_FORCE_PATH_STYLE` | MinIO and Ceph | on for the bundled store, off for yours — and only the literal lowercase `true` turns it on |
| `ALLOW_UNSIGNED_WEBHOOKS` | no | inbound doors stay fail-closed. `true` only on a machine nothing else can reach; ignored in production |
| `SENTRY_DSN` | no | no error reporting |
| `LISTEN_FIRE_PREVIOUS_VERSION` | no | written by `up.sh`, not set by hand — the one rollback target its post-success image pruning keeps alongside the tag just started. See UPGRADING.md, "Disk" |

The per-system credentials for Slack, Attio, Airtable, Google, Dropbox, Telegram, WhatsApp and Twilio are listed with what they do in "Registering your own third-party apps". Every one is optional, and an unset OAuth pair means that system is simply not offered — except Attio's, where it means Attio connects with a pasted access token instead. Gmail rides the Google pair above by default, takes its own `GMAIL_OAUTH_CLIENT_ID` / `_SECRET` when you set one, and under `GMAIL_CONNECT_METHOD=delegated` uses the deployment's service account instead. Its own variables are `GMAIL_CONNECT_METHOD`, `GMAIL_SEND_ENABLED` and `GMAIL_MAILBOX_ALLOWLIST` — see "Gmail" above.

Generated on first boot and read from the config volume, never from this file: the database URLs, the session-signing secret and its audience, both encryption keys, the outbound-webhook and document-link signing secrets, the team id and name, the user id, the API key, the first account's email, and the bundled object store's root password.

## Running it somewhere other than compose

`guides/` translates this runbook onto specific platforms — [a GCP VM](guides/gcp-vm.md), [Render](guides/render.md), [Vercel plus a container](guides/vercel-plus-container.md), [AWS](guides/aws.md) — covering what changes when there is no one-shot migration service and no init hook to create the database roles for you. [`guides/byo-auth.md`](guides/byo-auth.md) is the other kind of substitution: pointing Listen-Fire at your own identity system instead of the two that ship.

Off compose, the secrets this installation generates for itself are yours to supply and to keep: mint them once, store them where you store secrets, and never rotate the encryption pair.
