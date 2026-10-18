# Run limits

What keeps a movement someone else wrote from harming the host that runs it. An embedder can let its customers write movements; these are the bounds it relies on.

- Every limit is set by the host, per segment, with a safe default.
- Exceeding one ends the segment with a coded error (`MovementEngineError`, code below).
- Nothing in the movement can forgive or catch a limit error: a collection op's `onError` passes it through.
- No limit changes what a movement means. A movement under its limits runs exactly as before.

## The limits

| limit | kept by | default | the host sets it with | code when exceeded |
|---|---|---|---|---|
| Steps: statements run plus expressions evaluated, per segment | engine | 10,000,000 | `limits.maxSteps` (TypeScript: `RunInput.limits`) | `MOVENG_LIMIT_STEPS` |
| One text's size, in UTF-8 bytes | engine | 16 MiB | `limits.maxTextBytes` | `MOVENG_LIMIT_TEXT_SIZE` |
| One list's members, or one map's keys | engine | 1,000,000 | `limits.maxCollectionItems` | `MOVENG_LIMIT_COLLECTION_SIZE` |
| The segment's result, as JSON text | engine | 64 MiB | `limits.maxResultBytes` | `MOVENG_LIMIT_RESULT_SIZE` |
| Call depth: named calls nested in one run | engine | 32 | `maxCallDepth` | `CallDepthExceeded` (lf prints `MOVENG_CALL_DEPTH`) |
| Wall clock per segment, waits included | run host | 900 s | `MOVEMENT_MAX_SEGMENT_SECONDS` (TypeScript: also `RunInput.maxSegmentSeconds`) | `MOVENG_LIMIT_WALL_CLOCK` |
| Cost per run: model calls and priced plugins | engine and run host | no cap | `spend.capMicrodollars` (lf: `maxRunCostUsd` in lf.yaml) | `RunCostCapExceeded` (the flow suspends where the host can park it) |
| Module calls per run | run host | 2,000 | lf: `REMOTE_ADAPTER_MAX_CALLS_PER_RUN` | `AdapterCallCeilingExceeded` |

```ts
type SegmentLimits = {          // on the segment's input, beside maxCallDepth
  maxSteps?: number;            // whole and positive; absent: the default
  maxTextBytes?: number;
  maxCollectionItems?: number;
  maxResultBytes?: number;
};
```

lf and the TypeScript host read each engine limit from the environment, as they read the call depth: `MOVEMENT_MAX_STEPS`, `MOVEMENT_MAX_TEXT_BYTES`, `MOVEMENT_MAX_COLLECTION_ITEMS`, `MOVEMENT_MAX_RESULT_BYTES`. A value that is set but is not a positive whole number refuses the run; it is never read as no limit. On the TypeScript host a run's own `limits` override the environment's, one limit at a time.

## How each is kept

- **Steps are the CPU bound.** The engine reads no clock (it runs as WASM, and must stay deterministic), so it counts work instead: one step per statement, one per expression evaluated. Members of a collection op are expressions, so a loop over a list pays per member.
- **The wall clock is the host's.** The engine hands control back to its host at every statement (the cancel gate asks the host). So the host checks its deadline between requests, and the step budget bounds the work between two of them. Past the deadline the host feeds the engine nothing more, and no write is cut off half-sent; then the segment fails.
  - lf: what is still in flight gets a five-second grace to finish. After the grace, a read or a model call still waiting is dropped, and a write to an external system (a record created, updated, deleted, linked or unlinked, or an event subscription changed) is waited for to its end.
  - The TypeScript host: the requests already at the host finish first.
- **Sizes are checked on every value an expression produces.** A value is checked for its own size, not its members' (each member was checked when it was produced). So a text doubled in a loop fails as soon as it passes the limit.
- **The result size is checked once, as the segment ends.** It replaces the result with the limit error; the cost lines still go back, because that money is spent.
- **Call depth was already there.** Only named calls nest; an expression makes no call.

## The cost cap is the same on every host

- The engine holds the run's spend account (prior spend, plus this segment's charges).
- Every priced host call is handed the remaining budget, and reports what it spent.
- A model call (`AI()`, `extract`, the identity judge) and a priced plugin are refused by the engine itself once the run has spent its cap. The host is never asked. Before this release a model call relied on the host refusing past its budget, so a host that ignored the budget could overspend.
- A call already under way can overshoot the cap by what that one call costs. The next priced call is refused.
- A module call is priced only by what the module reports it spent (`ctx.spend.charge`, carried back as its answer's `cost`). The host charges that to the run, whether the call succeeded or failed. The cap sees it once the segment the call ran in ends, so a module's spend can overshoot within one segment. A module that reports nothing is not counted.

## A movement reaches the network only through modules

Reviewed for this release:

- **The engine makes no request of its own.** It has no network code: everything it needs it asks its host for, by family (adapters, llm, files, park, trace, clock, ids, check, log, lookup, locks, control).
- **No family takes a URL from the movement.** Adapter calls go to the module the movement imported. Model calls go to the host's configured provider. Plugins go to the plugin's module.
- **A file's bytes are fetched only from a URL a module gave.** A file value names its owner module and handle; lf asks that module to resolve it, and fetches the URL the module answered. A movement can forge a file value, but only the named module decides what is fetched.
- **A stored document is read only inside the project's own folder.** A handle with `..` or an empty part is refused, and a handle outside the team's folder is not this project's.
- **lf's other outbound requests are the host's, not the movement's:** a credential's token refresh, a provider's OAuth exchange, the model provider.

## Measured peaks, and why the defaults stand

Measured 2026-10-18 by instrumenting the engine (a counter beside each check, not kept): every program the repository's tests run on the Rust engine. That is the Rust crates' tests (the oracle and frozen programs, lf, the embedding example), the TypeScript engine package's tests and the platform's `movement_engine` tests (both on the WASM build), 3,378 + 743 + 721 tests. The lf examples were not run: they need a live external system.

| limit | highest observed in one segment | default | default over peak |
|---|---|---|---|
| Steps | 198 | 10,000,000 | about 50,000 times |
| One text | 902 bytes | 16 MiB | about 18,000 times |
| One list or map | 5 members | 1,000,000 | about 200,000 times |
| Result as JSON | 34,396 bytes | 64 MiB | about 2,000 times |
| Wall clock | not measured (the tests run in milliseconds) | 900 s | not applicable |

- The defaults are kept. The corpus is small test programs, so its peaks say only that no repository program comes near a limit.
- Setting each default 10 to 100 times over these peaks would put steps near 20,000 and a list near 500, below ordinary real work (a loop over a few thousand records). A limit that low would refuse legitimate movements.
- A default should be tightened from production runs (the largest real segments), not from tests. Until there are such runs, the defaults stay generous: they stop a runaway, and never a real workload.

## Not covered

- **Memory as a whole.** The size limits bound each value, not their sum. A movement could still hold many values each under the limits; the step budget bounds how many it can build.
- **One step's own work.** A single step can still do work proportional to its input (sorting a list of a million). The collection limit bounds that input.
