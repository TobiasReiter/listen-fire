# Listen-Fire on a Google Cloud VM

One Compute Engine VM running the compose stack, behind a reverse proxy with TLS. That is the whole architecture, and it is the same `docker compose` every other self-hoster runs.

It is the honest shape because the API is one long-running process: its schedulers, resume loops and delivery workers live inside it, its live-update fan-out is an in-process emitter, and its restart sweep assumes it is the only instance. Cloud Run can host that, with minimum and maximum instances both pinned to one and CPU always allocated, but then nothing Cloud Run exists for is available and the bill is a permanent instance either way. A VM says the same thing without the ceremony.

Read [`deploy/SELF_HOSTING.md`](../SELF_HOSTING.md) first. It is the runbook for every shape, and this guide only translates it onto Google Cloud.

Then, when you want a managed datastore, the second half of this page is a runbook per store. Postgres, Redis and the object store move independently, and each move is data plus one variable. Nothing about the VM changes.

---

## The shape

| # | What | On GCP | Notes |
|---|---|---|---|
| 1 | everything | one **Compute Engine VM**, `e2-standard-2` or larger | the API, the web app, and the bundled datastores |
| 2 | the data | a **persistent disk** mounted under Docker's data root | the database, the object store and the config volume all live there |
| 3 | the front door | **nginx or Caddy on the VM**, TLS on 443 | two hostnames, one for the web app and one for the API |
| 4 | backups | **disk snapshot schedule** plus a `pg_dump` to a bucket | the snapshot is the machine, the dump is the database |
| 5 | DNS | two A records at the VM's static external IP | `API_BASE_URL` is permanent, so choose the API's name carefully |

## 1. The VM

**`e2-standard-2` (2 vCPU, 8 GB) is the floor.** Memory is the lever, not CPU. The API alone wants 1 to 2 GB at rest and more on an extraction or an authoring-agent request, and the bundled Postgres, Redis, object store (SeaweedFS) and the web app sit beside it on the same machine. `e2-medium` (4 GB) runs a demo and runs out of memory under real use. Move up to `e2-standard-4` before you move anything off the box, because it is one line and a reboot.

**Boot image: Debian 12, or Container-Optimized OS.** Debian is the easier first VM: `psql`, `gcloud` and a reverse proxy install as packages, and the runbooks below use all three on the machine itself. Container-Optimized OS is the smaller attack surface, updates itself, and ships Docker already, but it has no package manager, so anything the runbooks call for has to run in a container. Either works. Install Docker Engine and the Compose plugin on Debian from Docker's own repository; the version in Debian's archive is older than this stack expects.

**Give it a static external IP** and put both hostnames on it before you configure anything else, for the reason in section 3.

**Reserve nothing else on the machine.** The stack publishes 8080, 8081 and 8082 for your proxy to reach; those ports must be free.

**Check that you can actually get a shell before you need one.** `gcloud compute ssh` uses OS Login wherever it is turned on, and OS Login refuses an account that belongs to a different organisation than the project until somebody grants it `roles/compute.osLoginExternalUser` **on that external organisation** — which is not a role a project owner can grant themselves. The symptom is a permission error on `importSshPublicKey` at the moment of the first connection, long after the VM exists. Either arrange that role, or turn OS Login off for this instance and use metadata keys:

```bash
gcloud compute instances add-metadata listen-fire --zone <zone> \
  --metadata enable-oslogin=FALSE
```

## 2. The disk the data lives on

Every piece of state is a Docker named volume: `pgdata`, `redisdata`, `objectstoredata` and `listen-fire-config` (plus `miniodata` on an installation that ran the bundled MinIO before SeaweedFS replaced it — see SELF_HOSTING.md, "Upgrading from the bundled MinIO"). They all live under Docker's data root, so putting that directory on its own persistent disk puts all of them there at once, and lets the disk be snapshotted and resized without touching the VM.

Attach a `pd-balanced` disk (100 GB is a reasonable start; it grows online), format it once, and mount it at `/var/lib/docker` **before Docker first starts**. Add it to `/etc/fstab` with `discard,defaults,nofail` so a missing disk does not stop the machine from booting, and turn **auto-delete off** on the attachment so deleting the VM does not delete the data.

Attach it with a `--device-name`, because that name — not the kernel's `/dev/sd*` ordering, which moves — is how the disk is addressed on the machine:

```bash
# on the VM, once, BEFORE installing Docker. `data` is the --device-name.
DEV=/dev/disk/by-id/google-data
sudo mkfs.ext4 -m 0 -E lazy_itable_init=0,lazy_journal_init=0,discard -F "$DEV"
sudo mkdir -p /var/lib/docker
UUID=$(sudo blkid -s UUID -o value "$DEV")
echo "UUID=$UUID /var/lib/docker ext4 discard,defaults,nofail 0 2" | sudo tee -a /etc/fstab
sudo mount /var/lib/docker
```

By UUID rather than by device path, for the same reason.

**Docker's data root is no longer all of Docker's data.** Docker 29 stores images through containerd, whose own root is `/var/lib/containerd` — *outside* `/var/lib/docker` and therefore on the boot disk, not on the disk you just attached. The named volumes, which are the state that matters, are still under `/var/lib/docker/volumes` and are still on the data disk and still in its snapshots. What is on the boot disk is the images, and one release of this stack is about 5 GB of them, kept alongside every release you have not pruned. A 30 GB boot disk holds roughly four upgrades before it fills, and a full boot disk stops Docker rather than degrading it. Either give the boot disk room and `docker image prune -a` after each upgrade, or put containerd on the data disk too:

```bash
sudo systemctl stop docker containerd
sudo mkdir -p /var/lib/docker/containerd-root
sudo mv /var/lib/containerd/* /var/lib/docker/containerd-root/ 2>/dev/null || true
echo "/var/lib/docker/containerd-root /var/lib/containerd none bind 0 0" | sudo tee -a /etc/fstab
sudo mount /var/lib/containerd
sudo systemctl start containerd docker
```

`docker info` reports the data root, but confirm the image store separately — `sudo du -sh /var/lib/containerd` is the number that tells you which disk your images are on.

On Container-Optimized OS the stateful partition already holds `/var/lib/docker`; there the equivalent is to grow the boot disk rather than attach a second one.

**`listen-fire-config` is the volume that must survive everything.** It holds the encryption keys every stored third-party credential is encrypted under, and a database restored without the matching config volume is unreadable. Back it up separately, as well as in the disk snapshot: [`SELF_HOSTING.md`](../SELF_HOSTING.md), "What the installation generates for itself", has the one-line `tar` for it.

## 3. TLS, and why the API needs its own hostname

**Two hostnames, two DNS records, one IP.** `app.example.com` for the web app and `api.example.com` for the API. The API is not something the web app hides behind: the browser opens a WebSocket straight to the API origin for live run updates, and authoring-agent requests run longer than a proxy in front of the web app will hold a connection open. Both go to the API's own name.

**`API_BASE_URL` must be stable forever.** Every webhook you register with a third party and every capability link the product hands out is absolute at it, and by the time you want to rename it those URLs are in other people's inboxes and other systems' configuration. There is no rewrite mechanism.

Terminate TLS on the VM with nginx or Caddy, proxying `app.example.com` to `127.0.0.1:8080` and `api.example.com` to `127.0.0.1:8081`. Two settings are not defaults:

- **WebSocket upgrades must pass through** on the API host. In nginx that is `proxy_http_version 1.1` with the `Upgrade` and `Connection` headers set.
- **Raise the proxy read timeout** on the API host, to several minutes. The default of 60 seconds cuts off live subscriptions and long agent requests.

**Both of those are Caddy defaults**, which is the reason to prefer it here: Caddy proxies an upgrade transparently and imposes no response timeout of its own, and it obtains and renews the certificates without a second tool. The whole configuration is the two sites:

```
app.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8080
}

api.example.com {
	reverse_proxy 127.0.0.1:8081
}
```

Caddy redirects `:80` to `:443` for both names on its own. It obtains a certificate on the first request for a name, so **the A records must resolve before you start it** — a name that does not resolve yet spends failed ACME attempts against Let's Encrypt's rate limit rather than waiting politely.

The health probe is `GET /.well-known/health-check`, and **it answers `201`**, which is its contract. Anything that checks for exactly `200` will report a healthy stack as down.

**Firewall: 80 and 443 from anywhere, and nothing else.** The public surface is deliberate rather than incidental: inbound webhook doors for Slack events, Slack interactivity, Telegram, WhatsApp and your mail provider all land on `API_BASE_URL`, and they come from those vendors' addresses rather than yours. Port 22 is best reached through IAP TCP forwarding rather than opened.

**Bind the stack's own ports to loopback**, so the firewall is not the only thing standing between the internet and a plain-HTTP port. One line does all three apps:

```
LISTEN_FIRE_BIND=127.0.0.1
```

The proxy reaches them on `127.0.0.1`, and nothing else can. `WEB_PORT`, `API_PORT` and `ADMIN_PORT` stay plain numbers — an address written into one of them is a configuration error now, and `up.sh` says so by name rather than letting compose fail on `0.0.0.0:127.0.0.1:8081:3000`.

`deploy/.env` wins over `up.sh`'s defaults, so this line binds whichever way the stack is started. Keep the firewall rule below anyway: a bind address is one layer, not the plan.

Once TLS is on, set `API_BASE_URL` and `WEB_BASE_URL` to the `https` names. They also decide cookie security: the session cookie is marked `Secure` only when those URLs are `https`, and a `Secure` cookie on a plain-http address is set, dropped by the browser, and the person is bounced back to the login they just completed.

## 4. Bringing it up

```bash
git clone <this repo> && cd <this repo>/deploy
cp .env.example .env
```

In `.env`, at minimum:

```
ANTHROPIC_API_KEY=…
LISTEN_FIRE_VERSION=v0.1.0
LISTEN_FIRE_PRODUCTS=core,automations
LISTEN_FIRE_PRINCIPAL=core
API_BASE_URL=https://api.example.com
WEB_BASE_URL=https://app.example.com
LISTEN_FIRE_BIND=127.0.0.1
LISTEN_FIRE_TEAM_NAME=Acme
LISTEN_FIRE_ADMIN_EMAIL=you@example.com
COMPOSE_PROFILES=postgres,redis,objectstore,admin
```

**A model key is what buys you agents**, and any one of `ANTHROPIC_API_KEY`, `KNOWLEDGE_LLM_API_KEY` or `OPENAI_API_KEY` is enough. Without one the stack starts and serves, and agents, extraction and the arbitration of conflicting facts fail at the moment they are asked for — `init` warns at every boot and so does the API. On `v0.1.0` it was a hard refusal: `init` exited 1 and nothing started at all, so a stack could not come up before you had a key.

**Consider capping what one automation run may spend on models** with `MOVEMENT_MAX_RUN_COST_USD=<dollars>`. It is not mandatory, but it is encouraged: a looping automation is otherwise stopped by nothing. See "Automations" in [`SELF_HOSTING.md`](../SELF_HOSTING.md).

**`LISTEN_FIRE_TEAM_NAME` and `LISTEN_FIRE_ADMIN_EMAIL` are read once, on the very first boot.** `init` copies them into the config volume as `LISTEN_FIRE_BOOTSTRAP_TEAM_NAME` and `LISTEN_FIRE_BOOTSTRAP_USER_EMAIL` and then never rewrites that file again — editing either line later changes nothing. Get them right before the first `up`, or the team is called `Acme` for the rest of its life.

Then, from `deploy/`:

```bash
docker compose pull
docker compose up -d
```

**`docker compose` is the plain way to run this, and `up.sh` no longer fights it.** `up.sh` supplies `API_BASE_URL`, `WEB_BASE_URL`, the three ports and `LISTEN_FIRE_BIND` only as defaults for an installation that names none, so the values above survive a run through it. It is still the trial door — what it adds is working out the unit composition for you, which you have already written down here.

**`LISTEN_FIRE_VERSION` is what this installation runs**, and it moves only when you edit that line. Leave it unset and every pull takes `latest`, which moves under you.

**Login needs a mail provider** on an installation with `core`: the sign-in link is genuinely emailed, so `OUTBOUND_EMAIL_FROM` plus one complete provider — either `RESEND_API_KEY`, or `MAILGUN_API_KEY` **and** `MAILGUN_SENDING_DOMAIN` together — is not optional. A half-set Mailgun pair is the same as no provider at all: the adapter logs that it is unconfigured, the send returns false, and the link is never delivered. Nobody can sign in until it is set.

**Signing in on day one, before mail is configured.** The link is minted whether or not it can be sent, and it is stored in the database in the clear, so an operator with a shell on the box can read the one they just asked for. This is the bootstrap path — the way to get into a fresh installation and add a mail provider from the settings page — and not something to keep doing.

**`up.sh` does this for you** on any shape with `core`, and prints the link at the end of its run. The recipe below is for a stack brought up with `docker compose`, or for a second link later:

```bash
# from deploy/, as the bootstrap address in LISTEN_FIRE_ADMIN_EMAIL
EMAIL=you@example.com
curl -fsS -X POST "http://127.0.0.1:8081/api/public/auth/requestMagicLink" \
  -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\"}"
TOKEN=$(docker compose exec -T postgres psql -U listenfire -d listenfire -tAc \
  "select token from core.magic_link_token order by created_at desc limit 1")
echo "$WEB_BASE_URL/magic?token=$TOKEN"
```

The link is single-use and **good for one hour** — the row and the token inside it are stamped from one number, so that is the whole of it. (On `v0.1.0` they were two numbers, 5h on the row and 1h on the token, and a link in between failed as a server error rather than as the "invalid or expired token" the code means to return. Mint the link when you are ready to click it, on any version.)

Treat it as a live session: anyone who reads it is signed in as that admin.

Long-running services carry `restart: unless-stopped`, so the stack comes back after a reboot as long as Docker starts at boot (`systemctl enable docker`). The one-shot services that mint secrets and run migrations do not restart, which is what they should do. Nothing here needs a systemd unit of its own.

**On `v0.1.0` the bundled datastores are the exception, and they need fixing by hand.** That release's `postgres` and `redis` services carry no restart policy at all, so a reboot leaves them stopped while everything in front of them comes back. What that looks like is worse than an outage that announces itself: `GET /.well-known/health-check` still answers `201`, `/api/public/capabilities` still answers `200`, and the sign-in route answers `401 Invalid or expired session` — which reads as a credential problem rather than as a database that is not running. `/healthz/workers` is the surface that tells the truth, with `startedHere: false` on every loop. Later releases carry the policy in the file; on `v0.1.0`, set it on the containers:

```bash
docker update --restart unless-stopped listen-fire-postgres-1 listen-fire-redis-1
```

That override is a property of the containers, not of the file, so re-apply it whenever compose recreates them — or upgrade, which is what actually ends the problem.

**Reboot the machine once, deliberately, before you put anything on it.** It is the only way to find out what actually comes back, and it is worth doing on a release that has the policy too.

## 5. Backups

**Two backups, because they protect different things.**

A **snapshot schedule** on the data disk is the machine: the database files, the object store, and the config volume with the encryption keys. Attach a resource policy to the disk with a daily schedule and a retention you can live with. Restoring it is creating a disk from the snapshot and attaching it to a VM.

The policy is regional and the disk is zonal, so the two must name the same region:

```bash
gcloud compute resource-policies create snapshot-schedule listen-fire-data-daily \
  --region <region> --daily-schedule --start-time 02:00 \
  --max-retention-days 14 --on-source-disk-delete keep-auto-snapshots

gcloud compute disks add-resource-policies listen-fire-data \
  --zone <zone> --resource-policies listen-fire-data-daily
```

`--on-source-disk-delete keep-auto-snapshots` is the half that makes it a backup: without it, deleting the disk deletes its snapshots with it. Confirm the attachment on the disk itself (`gcloud compute disks describe listen-fire-data --format='value(resourcePolicies)'`) rather than on the policy — a policy can exist attached to nothing.

A **`pg_dump`** is the database on its own, which is what an upgrade rollback needs and what a snapshot is clumsy for:

```bash
# from deploy/
docker compose exec -T postgres pg_dump -U listenfire -Fc listenfire \
  > listenfire-$(date +%Y%m%d-%H%M).dump
gsutil cp listenfire-*.dump gs://your-backup-bucket/
```

Run it on a cron, and run it by hand before every upgrade. Once the database is on Cloud SQL, its own automated backups and point-in-time recovery replace this and the `exec` no longer has a container to reach.

## 6. Upgrading

The runbook is [`UPGRADING.md`](../UPGRADING.md) and it is the same everywhere: snapshot the database, edit `LISTEN_FIRE_VERSION` in `deploy/.env`, `docker compose pull && docker compose up -d`, check that `/healthz/workers` reports the version you asked for, and roll back by restoring the snapshot and re-pinning the previous tag. Migrations run as a one-shot service to completion before the new API starts, and they are forward-only.

Do it on a copy first. A VM created from yesterday's snapshot is a copy.

---

# Moving a datastore to a managed service

The three sections below are independent. Move the database and leave Redis and the object store bundled, or any other combination; nothing here assumes you will do all three, and nothing about the VM changes when you do.

Each one is the same two steps: move the data, then name the new store in `deploy/.env`. Naming it is the whole switch. The bundled service leaves the composition on the next `docker compose up -d`, because its compose profile is keyed on that variable being absent. What each store needs in general is in [`SELF_HOSTING.md`](../SELF_HOSTING.md), "Bringing your own datastores"; below is only what is specifically Google Cloud.

Run `docker compose up -d --remove-orphans` after each flip, so the parked container is removed rather than left running beside its replacement.

## Cloud SQL for PostgreSQL 16

**Create the instance** with PostgreSQL 16, a **private IP on the same VPC** as the VM, and no public IP. A private IP is simpler than the Cloud SQL Auth proxy here: the API is a container on a Docker bridge network, and it reaches a VPC address through the VM's own routing with nothing to install.

**Confirm the six extensions first.** The migration set creates `vector`, `pg_trgm`, `citext`, `pgcrypto`, `unaccent` and `btree_gin`, and it is monolithic, so every installation needs all six whatever units it mounts. All six are on Cloud SQL's supported-extensions list for PostgreSQL 16 (checked 2026-09-09); check it again against your instance before you build anything on top, because the alternative is discovering it halfway through a first migration.

**Run the roles file before anything else touches the database**, as the `postgres` user:

```bash
psql "postgresql://postgres:…@10.x.x.x:5432/listenfire" \
  -f deploy/postgres-init/00-roles.sql
```

The migration set carries more than a hundred `GRANT … TO agent` and `TO readonly` statements, the first early enough that a database without those roles dies having built almost nothing. Compose runs that file from the bundled Postgres image's init hook; **a managed database has no such hook.** Run it as the instance's `postgres` user, which is a `cloudsqlsuperuser` and can create roles; a least-privilege application user cannot. What it creates needs no elevated attribute of its own: `agent` is deliberately powerless, with no `BYPASSRLS`, because Cloud SQL would refuse to grant it and the design does not want it.

**Move the data.** Stop the API so nothing writes during the copy, dump, restore, and leave the old container in place until you have checked the new one:

```bash
# from deploy/
docker compose stop api
docker compose exec -T postgres pg_dump -U listenfire -Fc listenfire > move.dump
pg_restore -d "postgresql://postgres:…@10.x.x.x:5432/listenfire" --no-owner move.dump
```

`--no-owner` because the roles that own objects in the bundled database are not the roles that will own them in Cloud SQL. Restore into a database that already has the roles file applied and is otherwise empty.

**Then flip the switch**, in `deploy/.env`:

```
DATABASE_URL=postgresql://listenfire:…@10.x.x.x:5432/listenfire
```

Leave `DATABASE_URL_READONLY` unset unless you have a genuine read replica: on compose it follows `DATABASE_URL` when unset, and the process is never allowed to see it absent. If you do run a replica, that is what the variable is for.

**Session-level pooling only.** The API takes a Postgres advisory lock per mounted unit and holds it on a dedicated session for the life of the process, which is what guarantees each background loop runs on exactly one instance. A pooler in transaction mode hands those sessions around between clients and the guarantee is gone, silently. Cloud SQL's own connection pooling, PgBouncer or any other pooler must be in session mode, or absent.

**Count the connections.** Roughly six long-held connections for the locks, plus the read and write pools, plus whatever you connect with by hand. A `db-f1-micro` instance's connection limit is small enough to matter; check the instance's `max_connections` against that before you size down.

Once the API is answering against Cloud SQL, `docker volume rm listen-fire_pgdata` reclaims the old data. Not before.

## Memorystore for Redis, Basic tier

**Basic tier, AUTH disabled, TLS disabled, on the same VPC** as the VM, with no public address.

That is not a shortcut, it is the only reachable configuration: the client is built from a hostname and a port and nothing else. There is no username, no password, no TLS and no URL form anywhere in it, so an instance with AUTH or in-transit encryption on cannot be spoken to through these two variables at all. Private network access is the boundary. Standard tier adds replication and costs more; nothing here needs it, for the reason below.

**Nothing has to be moved.** Everything in Redis is rebuilt by use, and the two things that live there are worth knowing by name:

- **Core's in-flight MCP OAuth state.** A connection someone is in the middle of authorising, at the moment you switch, fails after they have consented. They start it again. Nothing else is affected.
- **Automations' runaway-loop counters.** The guard that stops an automation triggering itself in a cycle. It fails **open**: with Redis unreachable, automations keep running unguarded rather than stopping. This is why an empty cache is fine and an unreachable one is not.

There is no persistence to preserve and no keyspace to export. Flush nothing, copy nothing.

**Flip the switch**, in `deploy/.env`:

```
MESSAGE_QUEUE_REDIS_HOSTNAME=10.x.x.x
MESSAGE_QUEUE_REDIS_PORT=6379
```

Then `docker volume rm listen-fire_redisdata` once the API is answering.

## Cloud Storage, through the S3-compatible XML API

Cloud Storage speaks S3 well enough for the API's storage adapter, which is a plain S3 client: put, get, delete and presign, with a configurable endpoint. There is no GCS-native code path and none is needed.

**Create the bucket** in the same region as the VM, with uniform bucket-level access, and no public access.

**Create an HMAC key** for a service account that has `roles/storage.objectAdmin` on that bucket, and nothing wider. The access id and secret it gives you are what the S3 client authenticates with; a GCP service-account JSON key is not usable here.

**Move the objects.** Both ends speak S3, so one tool talks to both. From the VM, in `deploy/`, with the bundled object store still running:

```bash
docker run --rm --network listen-fire_default \
  -v listen-fire_listen-fire-config:/config:ro --entrypoint sh rclone/rclone:1.75.1 -c '
  export RCLONE_CONFIG_SRC_TYPE=s3 RCLONE_CONFIG_SRC_PROVIDER=SeaweedFS \
    RCLONE_CONFIG_SRC_ENDPOINT=http://objectstore:8333 RCLONE_CONFIG_SRC_ACCESS_KEY_ID=listenfire \
    RCLONE_CONFIG_SRC_SECRET_ACCESS_KEY="$(cat /config/objectstore_password)" \
    RCLONE_CONFIG_DST_TYPE=s3 RCLONE_CONFIG_DST_PROVIDER=GCS \
    RCLONE_CONFIG_DST_ENDPOINT=https://storage.googleapis.com \
    RCLONE_CONFIG_DST_ACCESS_KEY_ID=<hmac-access-id> RCLONE_CONFIG_DST_SECRET_ACCESS_KEY=<hmac-secret> &&
  rclone copy src:listen-fire dst:<your-bucket> -v && rclone check src:listen-fire dst:<your-bucket> --one-way'
```

(Still on the bundled MinIO from an older release? Its files are in `miniodata`, not the bundled store: start it with `legacy-minio.yml` and use `http://minio:9000`, provider `Minio` and `/config/minio_password` as the source instead — SELF_HOSTING.md, "Upgrading from the bundled MinIO".)

`gsutil -m rsync -r` does the same job if you would rather copy the objects out of the volume to the VM's disk first and push them up from there. Either way, do it before you flip the variable: links already handed to a third party are absolute at the old origin and do not follow the data.

**Flip the switch**, in `deploy/.env`:

```
AWS_S3_ENDPOINT=https://storage.googleapis.com
AWS_DOCUMENT_S3_BUCKET=your-bucket
AWS_REGION=auto
AWS_ACCESS_KEY_ID=<hmac-access-id>
AWS_SECRET_ACCESS_KEY=<hmac-secret>
```

All five together. **Leave `AWS_S3_FORCE_PATH_STYLE` unset**: it exists for MinIO, SeaweedFS and Ceph, it is compared to the literal lowercase `true`, and Cloud Storage does not need it.

**Do not upgrade `@aws-sdk/client-s3` without re-testing an upload against this bucket.** The version pinned here, `3.649.0`, predates the SDK release that started sending integrity-checksum headers on every request by default, and Cloud Storage's XML API rejects those. A routine dependency bump breaks uploads to GCS and to nothing else, so it will not look like a storage change.

Moving to Cloud Storage is also what makes file links work for people outside the VM. The bundled object store is reachable only on the compose network, so a presigned link handed to a browser or a third party does not resolve; a Cloud Storage presigned URL does.

Then `docker volume rm listen-fire_objectstoredata` (and `listen-fire_miniodata`, if you have one) once you have confirmed a file downloads.
