# Deploying lf to a scale-from-zero platform

The image (`deploy/lf/Dockerfile`, built from the repository root) holds one binary, `lf`, plus the built-in Dealroom and web modules. Two commands make the whole deployment:

The image is node-based and large (about 2.3 GB): the built-in modules are TypeScript and run under node (`serve-module` and tsx) from the pnpm workspace, whose install brings its dev tooling too. That is accepted, since size only costs pull time on a cold start.

- **`lf serve --port $PORT`** is the doors: webhooks at `/hooks/<external>/<install>` and OAuth callbacks. It also drains due work while it is up. Run it as a container behind HTTPS.
- **`lf drain --until-idle --max-seconds N`** is a worker. It claims due work rows, runs them, and exits when none is due or after N seconds. Run it as a job.

The container keeps no state. Everything lives in Postgres, so any container can be stopped or replaced at any time, and any number of workers can drain at once (each row is claimed by one worker, each run stepped by whoever holds its lease).

## Configuration

- The store: the default project's `lf.yaml` names the Postgres store module (`core: { store: "@lf/postgres-store" }`). Its settings come from the environment: `LF_SECRET__POSTGRES_STORE__EXTERNAL=@lf/postgres-store` and `LF_SECRET__POSTGRES_STORE__URL`, the Postgres URL ending `?sslmode=verify-full` (TLS, certificate and host name checked). Set the URL as a platform secret.
- The store's schema: run `lf connect @lf/postgres-store` once (and again after an upgrade) with the same environment. It creates and migrates the store's own `lf` schema and exits.
- `PORT`: the port `serve` listens on (default 8080). `LF_BIND` defaults to `0.0.0.0` in the image (the binary's own default is loopback).
- Credentials for third parties: `LF_SECRET__<CREDENTIAL>__<FIELD>` environment variables.
- `publicUrl` in `lf.yaml`: the HTTPS address the platform gives the serve container, needed for OAuth redirects.
- Your movements: mount or bake your own project folder over `/srv/lf/project` (its `lf.yaml`, `movements/`, `externals/`). The default project has no movements.

## The platform shape

1. Deploy the image as a service running its default command, with minimum instances at least 1 (or 0 if the platform wakes a container on the first request and senders retry webhooks), HTTPS in front, and the store's environment set.
2. Deploy the same image as a job whose command is `lf drain --until-idle --max-seconds 55`, with the same environment. Trigger it:
   - on a schedule (every minute) for timers and awaits to wake, or
   - by queue depth, where the platform can scale jobs on a Postgres query: start one worker per few due rows.
3. A worker that finds nothing due exits at once, so a frequent schedule costs little.

Set `--max-seconds` below the platform's job time limit: it stops claiming new rows after N seconds, and a run in progress finishes its step first.

## Local trial

```bash
docker compose -f deploy/lf/docker-compose.yml up --build
```

Starts Postgres, runs the store's setup, then one `serve` on port 8080 and a drain loop.
