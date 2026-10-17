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
| Wall clock per segment, waits included | run host | 900 s (lf) | lf: `MOVEMENT_MAX_SEGMENT_SECONDS` | `MOVENG_LIMIT_WALL_CLOCK` |
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

lf reads each engine limit from the environment, as it reads the call depth: `MOVEMENT_MAX_STEPS`, `MOVEMENT_MAX_TEXT_BYTES`, `MOVEMENT_MAX_COLLECTION_ITEMS`, `MOVEMENT_MAX_RESULT_BYTES`. A value that is set but is not a positive whole number refuses the run; it is never read as no limit.

## How each is kept

- **Steps are the CPU bound.** The engine reads no clock (it runs as WASM, and must stay deterministic), so it counts work instead: one step per statement, one per expression evaluated. Members of a collection op are expressions, so a loop over a list pays per member.
- **The wall clock is the host's.** The engine hands control back to its host at every statement (the cancel gate asks the host). So the host checks its deadline between requests, and the step budget bounds the work between two of them. Past the deadline the host drops what is still in flight rather than wait for it.
- **Sizes are checked on every value an expression produces.** A value is checked for its own size, not its members' (each member was checked when it was produced). So a text doubled in a loop fails as soon as it passes the limit.
- **The result size is checked once, as the segment ends.** It replaces the result with the limit error; the cost lines still go back, because that money is spent.
- **Call depth was already there.** Only named calls nest; an expression makes no call.

## The cost cap is the same on every host

- The engine holds the run's spend account (prior spend, plus this segment's charges).
- Every priced host call is handed the remaining budget, and reports what it spent.
- A model call (`AI()`, `extract`, the identity judge) and a priced plugin are refused by the engine itself once the run has spent its cap. The host is never asked. Before this release a model call relied on the host refusing past its budget, so a host that ignored the budget could overspend.
- A call already under way can overshoot the cap by what that one call costs. The next priced call is refused.
- Module calls are not priced. A module that spends money on a paid service is not counted against the cap unless it is a priced plugin.

## A movement reaches the network only through modules

Reviewed for this release:

- **The engine makes no request of its own.** It has no network code: everything it needs it asks its host for, by family (adapters, llm, files, park, trace, clock, ids, check, log, lookup, locks, control).
- **No family takes a URL from the movement.** Adapter calls go to the module the movement imported. Model calls go to the host's configured provider. Plugins go to the plugin's module.
- **A file's bytes are fetched only from a URL a module gave.** A file value names its owner module and handle; lf asks that module to resolve it, and fetches the URL the module answered. A movement can forge a file value, but only the named module decides what is fetched.
- **A stored document is read only inside the project's own folder.** A handle with `..` or an empty part is refused, and a handle outside the team's folder is not this project's.
- **lf's other outbound requests are the host's, not the movement's:** a credential's token refresh, a provider's OAuth exchange, the model provider.

## Not covered

- **Memory as a whole.** The size limits bound each value, not their sum. A movement could still hold many values each under the limits; the step budget bounds how many it can build.
- **One step's own work.** A single step can still do work proportional to its input (sorting a list of a million). The collection limit bounds that input.
- **The TypeScript host's wall clock.** A TypeScript host sets the engine limits on the run's input (`RunInput.limits`), but keeps no wall clock of its own yet.
