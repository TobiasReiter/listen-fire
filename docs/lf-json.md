# `lf --json`

Add `--json` to a command an agent inspects or drives and stdout is one JSON
document (one line). Human output without the flag is unchanged. Exit codes are
the same either way (`check`: 1 on any error; runs: 1 when any run failed).
A failure of the command itself is `{"error": "<message>"}` on stdout, exit 1.
Usage mistakes (a missing argument) still print to stderr, exit 2.

Keys are camelCase. A value that does not apply is `null`, never absent.

## `lf check --json`

```json
{ "ok": true, "files": 1, "errors": 0,
  "diagnostics": [{ "code": "MOV_PARSE", "severity": "error", "file": "/abs/movements/a.mvt",
    "span": { "line": 1, "column": 1, "endLine": 1, "endColumn": 9 },
    "message": "…", "fixes": [] }] }
```

- `severity`: `error`, `warning` or `info`. `ok` is true when no diagnostic is an error.
- `fixes`: the checker's exact rewrite (as `lf upgrade` applies it), at most one; empty when it offers none.
- A credential a movement imports that the secrets lack is a diagnostic, code `MISSING_CREDENTIAL`.

## `lf catalog --json`

The catalog snapshot (`{ "contractVersion", "adapters", … }`), as `lf catalog` already prints it.
When credentials are missing: `{ "error", "missingCredentials": [diagnostic…] }`, exit 1.

## `lf run <movement>`, `run --event`, `run --poll`, `run --webhook`, `resume [<run-id>]`

```json
{ "ok": true, "redelivered": ["…"],
  "runs": [{ "runId": "…", "file": "hello", "movement": "hello", "entry": "fired",
    "status": "completed", "writes": 0, "dryRunWrites": null, "traceEntries": 0, "error": null }] }
```

- `entry`: `fired`, `resumed` or `called`. `status`: `completed`, `parked`, `failed` or `leaseLost`.
- `ok` is false when any run failed. `dryRunWrites` is an array only under `--dry-run`.
- `redelivered`: lines for listens that had already seen the event's idempotency key.
- `resume` with nothing parked: `runs` is empty.

## `lf call <callback-id> [--body f]`

```json
{ "ok": true, "callback": "…", "result": "recorded", "message": null, "queued": false, "runs": [<run>] }
```

`result`: `recorded`, `refused` (`message` says why), `notFound`, `closed` or `expired`. `queued`: another lf process steps the run and runs the body. `runs` as above.

## `lf cancel <run-id> [--reason t]`

`{ "ok": true, "runId": "…", "result": "cancelled" }`; `result` is `cancelRequested` when another lf process is stepping the run. A run that is neither running nor parked is an `{"error"}`.

## `lf runs --json`

`{ "runs": [{ "runId", "file", "movement", "status", "startedAt" }] }`, most recent first (50).

## `lf runs show <run-id> --json`

```json
{ "run": { "runId", "file", "movement", "status", "startedAt", "firedAt", "languageVersion",
  "event": {…}, "writes": 0, "error": null, "outcome": {…},
  "costMicrodollars": 0.0, "traceEntries": 0, "trace": [ … ],
  "parked": [{ "address": "…", "reason": "timer", "wakeAt": "…" }],
  "cancelRequested": false, "cancelReason": null } }
```

- `event`: the event that fired the run. `outcome`: what the store recorded when the run last settled.
- `trace` is `null` when the run's store cannot hand entries back (a store module over its wire); `traceEntries` is always the count.
- `parked`: what the run waits on now; empty unless `status` is `parked`.
- `lf runs show <id>` without `--json` prints the same document, indented.

## `lf connect --json`

`{ "modules": [{ "name", "kind", … }] }`. `kind` is `external` (`state`, `how`, `installSetUp`, `install`, `credentials`: names), `core` (`slot`, `state`, `setUp`, `setupNote`) or `package` (`state`: `not installed`). Names only; no secrets.

## `lf credential list --json`

`{ "credentials": [{ "name", "module", "binding", "declaredCredential", "kept", "expiresAt" }] }`.
`binding`: `install`, `credential` or `legacy`; `declaredCredential` is set for `credential`. `kept`: the secrets file path and/or `environment`. `expiresAt`: a token's expiry or `null`. Never a value.
