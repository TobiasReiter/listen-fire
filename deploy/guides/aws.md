# Listen-Fire on AWS

ECS Fargate for the API, RDS for the database, ElastiCache for Redis, S3 for storage, an Application Load Balancer in front. One task, one service, no scale-to-zero.

This is topology and gotchas, not ClickOps. Every AWS console screen described step by step here would be wrong within a quarter, and you almost certainly want this in Terraform or CDK anyway. What follows is the set of decisions that are actually about Listen-Fire rather than about AWS, and the three or four places where a reasonable AWS default is the wrong answer.

Read [`deploy/SELF_HOSTING.md`](../SELF_HOSTING.md) first — it is the runbook for every shape. This guide translates it onto AWS; it does not replace it.

**What a datastore needs is written once, in [`SELF_HOSTING.md`](../SELF_HOSTING.md), "Bringing your own datastores"**: the extensions and the roles file for Postgres, the no-AUTH-no-TLS shape of the Redis client, the five variables an S3-compatible store takes, and the fact that each store moves on its own. On compose those same variables also park the bundled service; here every store is external from the start, so what follows is only what is specifically AWS about them.

---

## The shape

| # | What | AWS | Notes |
|---|---|---|---|
| 1 | the API and its workers | **ECS Fargate**, one service, **desired count 1** | the only always-on process |
| 2 | the database | **RDS Postgres 16** | the migration runner creates the two roles it needs |
| 3 | Redis | **ElastiCache for Redis** | no AUTH, no in-transit encryption — read below |
| 4 | object storage | **S3**, native | no `AWS_S3_ENDPOINT` |
| 5 | the front door | **ALB** | WebSocket support is native; the health check needs 201 |
| 6 | the web app | Amplify, a second Fargate service, or Vercel | a Next.js app, not in the image |

## 1. RDS, before anything else

Postgres 16, and it is the one datastore whose setup order matters: the roles file goes in before the first migration. The migration set creates six extensions — `vector`, `pg_trgm`, `citext`, `pgcrypto`, `unaccent` and `btree_gin` — and it is monolithic, creating all five schemas whatever `LISTEN_FIRE_PRODUCTS` says, so every shape needs all six even for schemas it will never read. RDS ships `pgvector` on modern Postgres versions; confirm it is available for the exact engine version you pick before you build anything on top.

Two roles, `agent` and `readonly`, must exist before the first migration: the migration set carries 51 `GRANT … TO agent` / `TO readonly` statements, the first of them early enough that a database without the roles dies having built almost nothing.

**The migration runner creates them for you**, from `deploy/postgres-init/00-roles.sql`, before it applies anything — as long as the user in `DATABASE_URL` can create roles. Point the migration step at the instance's **master user** and it can; a least-privilege application user cannot, and the runner then stops having applied nothing and tells you to run this as the master user:

```bash
psql "$DATABASE_URL" -f deploy/postgres-init/00-roles.sql
```

`agent` is created deliberately powerless — no `BYPASSRLS`, because managed databases often refuse to grant it and the design does not want it.

`DATABASE_URL_READONLY` must be set. With no read replica, set it equal to `DATABASE_URL`; it is not optional and boot fails without it. If you do run a replica, that is what the variable is for.

## 2. ElastiCache

Point the API at it with `MESSAGE_QUEUE_REDIS_HOSTNAME` and `MESSAGE_QUEUE_REDIS_PORT`. There is no `REDIS_URL`; the code never reads one.

**Create the cluster with AUTH disabled and encryption-in-transit off.** The client is constructed from a hostname and a port and nothing else — no username, no password, no TLS — so a cluster with a Redis AUTH token or in-transit encryption cannot be reached through these two variables at all. Inside a private subnet with a security group that only the API task can reach, that is a defensible posture; outside one it is not, so keep the cluster off the public internet and let the network be the boundary.

What breaks without Redis: core's in-flight MCP OAuth state (a connect that spans a deploy fails after the user has consented), and automations' runaway-loop guard, which fails **open** if Redis is unreachable — automations keep running unguarded rather than stopping. A production process with the two variables unset throws the first time it reaches for the pool.

## 3. S3

Native, and this is the one place where being on AWS genuinely simplifies things.

Set `AWS_DOCUMENT_S3_BUCKET`, `AWS_REGION`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` — all four or none. **Leave `AWS_S3_ENDPOINT` unset**; it exists to point the same adapter at R2, MinIO, SeaweedFS or Supabase Storage, and setting it on AWS only gives you a way to get it wrong. Leave `AWS_S3_FORCE_PATH_STYLE` unset too — it is compared to the literal lowercase `true`, and it exists for MinIO, SeaweedFS and Ceph.

There is no local-filesystem storage driver, deliberately: serving a file to an unauthenticated third party is a signed byte-serving route, which is a build rather than a config switch. Without storage configured the process boots normally and only file-touching steps fail, naming the variables they wanted.

**On task-role credentials.** The code reads the four variables; if you would rather the task assume an IAM role than carry an access key, verify that path end to end before you rely on it, because "all four or none" is what the configuration check enforces.

## 4. ECS Fargate

**One task. Desired count 1. No autoscaling policy.**

Two tasks are *safe* — each product's workers take a per-product advisory lock, so every background loop runs on exactly one instance — but you lose the unambiguous reading of `startedHere: false` on `/healthz/workers`, which on a single task means "wedged, page me" and on two could also mean "the other task holds the lock". Only the workers that keep a heartbeat can tell those apart.

**Do not add a separate worker service.** The background loops run inside the API process. A second service on the same image would contend for the same locks and buy you nothing.

**Build the image from the repository root**, not from `deploy/`:

```bash
docker build -f deploy/Dockerfile -t listen-fire-api .
```

The Dockerfile says so in its own header, and a build context set to `deploy/` cannot see `package.json`. Push it to ECR; it runs `node build/server.js` and listens on 3000.

**Migrations are a separate one-shot run that must finish before the new task serves.** The compose file expresses this as a service that must exit 0 first; ECS has no equivalent, so it is a step in your deploy pipeline: a `RunTask` on the same image with the command

```
pnpm schema:migrate "$DATABASE_URL"
```

waited on to exit 0 before the service is updated. The migration runner takes the database as an **argument** and does not read the ambient environment, which is why the URL is passed explicitly. Migrations are forward-only, applied by file name, tracked in `_migrations.migrations`; back up before an upgrade, because there is no down-migration path.

**Sizing.** Roughly 1–2 GB of memory for a single-product API at rest, around 2 GB for the composed shape, plus your database. Give the task more than the floor: the authoring agent and the extraction paths are the spiky ones.

**Secrets.** Off compose, nothing mints these for you — the compose stack generates its own on first boot, and on ECS you supply them (`SELF_HOSTING.md`, "What the installation generates for itself", lists the set). `ENCRYPTION_MASTER_KEY` and `ENCRYPTION_SALT_BASE64` belong in Secrets Manager or SSM Parameter Store, injected as task secrets, and they must be **backed up somewhere separate from the database**. They encrypt every stored third-party credential; without the original values every stored connection is unreadable and has to be made again by hand — which, for the adapters you registered yourself, means every user re-authorising.

## 5. The load balancer

An **Application Load Balancer**. Not a Network Load Balancer, unless you are prepared to terminate TLS yourself and you know what you are giving up.

**Health check path: `/.well-known/health-check`. Set the success code to `201`.** This is the gotcha that costs an afternoon: the endpoint answers 201 by contract, ALB target groups default to expecting 200, and a target that answers 201 against a `200` matcher is drained as unhealthy while being perfectly fine. The matcher field accepts a range or a list — `200-299` is also correct, and the point is only that the default is wrong.

**WebSockets need nothing special.** ALB carries protocol upgrades natively. What it does need is a long enough **idle timeout**: the default of 60 seconds will drop live-run subscriptions and cut authoring-agent requests off mid-flight. Raise it — several minutes — and remember that the client connects to the API origin directly rather than through the web app, so the API's own hostname and TLS certificate are what matter.

**Stickiness is not required** and should not be enabled as a substitute for the single-task rule. The advisory locks are what make the worker guarantee, not session affinity.

**`API_BASE_URL` must be stable forever.** Put a real domain and an ACM certificate on the listener before you register any webhook or send any link. Every inbound webhook you register with a third party is built from that hostname, and every capability link Listen-Fire hands out — an approval link, a file link, a callback — is absolute at it and already sitting in somebody else's inbox. Renaming it later breaks both and there is no rewrite mechanism.

## 6. Networking

The task belongs in private subnets with a NAT gateway or VPC endpoints for its outbound traffic — it makes real outbound calls to whatever third-party systems your automations reach, plus the model APIs. RDS and ElastiCache belong in private subnets too, reachable only from the task's security group. Only the ALB faces the internet.

Inbound webhook doors are the reason the ALB is public: Slack events, Slack interactivity, Telegram updates, the WhatsApp callback, the Mailgun inbound route, and the per-subscription webhook-sync doors all land on `API_BASE_URL`. That set is the whole of what has to be publicly reachable; [`SELF_HOSTING.md`](../SELF_HOSTING.md), "Registering your own third-party apps", lists each door with the exact path.

## 7. The web app

A Next.js application in `apps/web`, deployed separately from `deploy/Dockerfile` — that image is the API and its workers. `deploy/Dockerfile.web` builds the web app itself (target `web`) if you want it in a container.

Anywhere that runs Node will do: AWS Amplify Hosting, a second Fargate service behind the same ALB on a different hostname, or Vercel (see `vercel-plus-container.md`, whose URL-triangle section applies unchanged here). It needs to be told where the API is: `API_INTERNAL_URL` makes its own server proxy `/api/*` to that origin at run time and keeps the browser same-origin, while `NEXT_PUBLIC_API_URL` bakes the API origin into the client bundle and needs the API's CORS to allow the web origin.

You need it if you run `core` — login links point at it, and without it nobody can sign in — and you need it to complete any OAuth connection, because the callback paths are pages in the web app that hand the authorization code back to the API. `OAUTH_REDIRECT_BASE_URL` is therefore the **web** app's origin, not the API's; getting that backwards sends every consent screen to a 404 after the user has already granted access.

## 8. Observability

`/healthz/workers` is the surface worth alerting on, and it is unauthenticated by design — the operator of a self-hosted deployment is whoever can reach the process. It carries no free text, deliberately: a delivery error would name a customer's webhook URL.

Two readings to get right before you page anyone. A product you do not mount contributes **no rows** — absence is the answer, not an error. And `startedHere: false` on a mounted worker means "wedged" only because you kept the task count at one; see §4.

Each unit that has one also has an authenticated health route with the error detail on it — `/api/v1/valuations/health`, `/api/v1/knowledge/graph/health`, `/api/v1/asks/health`. Automations has none and reports through the worker surface alone.

Set `SENTRY_DSN` if you use Sentry; unset means no error reporting, and nothing else changes.
