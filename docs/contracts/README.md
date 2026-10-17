# The contracts

The movement core speaks six contracts. Each is written down here with an integer version of its own, independent of the release tag and of the others, so an embedder, an adapter vendor or a second engine can say exactly what it speaks.

| contract | document | current | supported | deprecated | on the wire |
|---|---|---|---|---|---|
| catalog-snapshot | [catalog-snapshot.md](catalog-snapshot.md) | 1 | 1 | none | `contractVersion` on the snapshot |
| park-state | [park-state.md](park-state.md) | 2 | 1, 2 | none | `version` on the state |
| host-families | [host-families.md](host-families.md) | 1 | 1 | none | `hostFamiliesVersion` on `segment.open` |
| adapter-protocol | [adapter-protocol.md](adapter-protocol.md) | 2 | 2 | none | `protocolVersion` on every request and the manifest |
| language-versions | [language-versions.md](language-versions.md) | 5 | 1, 2, 3, 4, 5 | none | `languageVersion` beside every program |
| system-caller | [system-caller.md](system-caller.md) | 1 | 1 | none | none: an in-process interface |

- **This table is this release's.** A release states, contract by contract, the version it writes, the versions it reads, and the ones it will stop reading.
- **The table is held equal to the code.** `CONTRACTS` (`packages/engine-contracts/versions.ts`) is test-held equal to this table, and each document's version line to its constant (`CATALOG_SNAPSHOT_VERSION`, `PARK_STATE_VERSION`, `HOST_FAMILIES_VERSION`, `MANIFEST_PROTOCOL_VERSION`, `CURRENT_LANGUAGE_VERSION`, `SYSTEM_CALLER_VERSION`).

## How a version moves

The rule mirrors the language's ([language-versions.md](language-versions.md)):

- **An addition a reader can ignore keeps the version.** A new optional field, or a new optional method or family, whose absence means what it meant before.
- **A change in meaning bumps it.** A field removed or renamed, a field whose meaning changed, a required field added, an answer reshaped.
- **A break lands as a conditional, never a fork.** The writer sends the new version; a reader that reads both branches on the version at the point of difference. Never a second reader, a second host interface or a second engine.
- **An unsupported version is refused at the boundary, loudly.** The refusal names the contract, the version it was handed and the versions it reads. It is never read as though it were the current version.
- **Deprecation comes first.** A version leaves the supported set only after a release that lists it as deprecated, and the CHANGELOG entry for the break names the contract, the version and why.

## Each document

Every contract document carries the same three things: its version on a line of its own at the top (`Version: N`), the JSON shapes as TypeScript-ish type blocks, and a "Changes" list, newest first.

## Conformance kits

A contract written down is a claim; a kit is how you check it. Each kit is data plus a runner, so it works against your implementation as well as ours.

### The host kit: recorded engine runs

A host recording is one entry into the engine as data: what it was handed, every request it made of its host in the order it made them, with the answer each got and the requests already answered when it was made, and how it ended. The format is the zod schema in `packages/engine-contracts/conformance/recording.ts`:

```ts
{
  kit: 'host';
  version: 2;                          // the recording format's own version
  entry: 'run' | 'resume' | 'settleRace' | 'callbackBody';
  input: RunInput | ResumeInput | SettleRaceInput | CallbackBodyInput;  // with its languageVersion
  methods: string[];                   // every host method the recorded host served
  requests: Array<
    { family: string; method: string; args: unknown; after: number[] } &
    ({ answer?: unknown } | { error: ThrownError })
  >;
  result?: unknown;                    // exactly one of result and failure
  failure?: ThrownError;
}
```

- **`family` and `method`** are a manifest family and one of its methods (`park.sink` and `commitTimerPark`). `args` is the method's one request object, `answer` its answer (absent from a method that answers nothing), `error` what the host threw (a method that throws rather than rejecting is recorded the same way).
- **`after`** lists the requests, by index into `requests`, the host had already answered when this one was made, less those another of them implies (one answered before a listed request was made). In a run with nothing concurrent it is the request before.
- **`methods`** matters because a host may leave out an optional family or method, and the engine behaves differently without it (no park sink: a run that parks raises). A replay serves exactly these.
- **Time and ids are answers.** The engine reads no clock and mints no id of its own (`clock.now`, `ids.mint`, [host-families.md](host-families.md)), so a recording holds every instant and id the entry used.
- **An error** is the error envelope, `ThrownError` (`{ class, code?, message }`), defined with the three classes the engine branches on under "Failure" in [host-families.md](host-families.md#conventions). A replay rebuilds those three as themselves and throws any other as an `Error` under its recorded name.

**Replaying.** An engine under replay is handed the recorded input and a host that answers from the recording. It conforms when:

- every request it makes has a recorded counterpart: the earliest recorded request not yet served with the same family, method and canonical args (keys sorted, undefined dropped);
- a request is served only once every request in its counterpart's `after` has been served. A request made sooner than the recording made it waits for those; concurrency is allowed, and branches may interleave differently from the recording. Equal requests answered alike are interchangeable: when two concurrent branches make the same request in the other order, the one answered first takes the earlier slot, and the other may take the later slot without waiting on what the later slot was recorded after. A request that waits on one the replay never makes (the engine waits for its answer before making it) is a causal reordering: once the replay has made no progress for two quiet spells, it diverges, naming both requests;
- every recorded request is made;
- it ends the same way: the same result as canonical JSON, or a failure with the same class, code and message.

A divergence over a request with no recorded counterpart also carries that request in full (`unmatched` on the verdict). The first divergence is named: the request with no counterpart and the nearest recorded one, the request reordered and the one it waited on, the recorded request never made, or the path where the results first differ. The rules are `packages/engine-contracts/conformance/replay.ts`.

**Replaying ours against your engine or host.** Our corpora are `apps/api/src/services/movement_engine/conformance/__fixtures__/engine-runs.v1.json` and `.v2.json`, one recording per line: every distinct conversation the v1 and v2 engine corpora have (the entry, its input and its requests). Each line replays on its own.

- To test an engine: hand it each recording's input and a host built from `RecordedConversation` (it answers by the matching rule), then judge with `verdictOf`.
- To test a host over a wire: our HTTP host double is the model. It serves `POST /host/<family>/<method>` with the request object as the body, and answers `{ "answer": … }`, `{}` for a method that answers nothing, or `{ "error": { class, code?, message } }`, always with status 200: a host's thrown error is an answer, carried in the envelope. A request the recording lacks, or one made out of its order, answers 409 `{ "divergence": "…" }` (`http_host_double.ts`). Transport failures are not modelled, and the double does not advertise the methods it serves: both halves are built from the recording's `methods`.
- Ours runs every recording against three targets on each change: the TypeScript engine in process, the Rust engine through its shim, and the TypeScript engine against the HTTP double (`conformance/__test__/engine_runs.v<n>.unit.test.ts`). The Rust target takes only the recordings its shim routes and runs whole, and skips the rest with the reason.

**Recording your own host.** Wrap any `EngineHost` with the recorder (`apps/api/src/services/movement_engine/conformance/recorder.ts`, `recordEntry`). It hands the engine and the host each other's own values, keeps JSON copies, and refuses a request or answer JSON cannot carry, and any request made after the entry ended. To re-harvest ours:

```bash
cd apps/api && pnpm harvest:engine-runs
```

This records both corpora (`UPDATE_ENGINE_RUNS=1 pnpm test:conformance:v<n>`) with the tests' own wall clock held at one instant and their own random UUIDs numbered per test file (the inputs a test builds and the ids its host invents), so two harvests write the same bytes. It then checks that every recording replays on the TypeScript engine, in process and over the HTTP double. A recording that does not fails the harvest, naming it and its first divergence, unless a known reason accounts for it (`UNPORTABLE` in `conformance/__test__/engine_runs_replay.ts`, each reason with its exact count per corpus); those are dropped from the fixture.

### The language kit: checked programs

Every program the test suites check, with its catalog snapshot, language version and full diagnostics. `pnpm language:conformance <checks.json>` replays a corpus against the checker, ours or your own. Ours is assembled by `pnpm checks:corpus` (in `packages/movement-lang`) into `target/checks/checks.json`, because the repository pins each program by a hash of its text and the text lives in its test. See [`packages/movement-lang/conformance/README.md`](../../packages/movement-lang/conformance/README.md).

### The adapter kit

`pnpm adapter:conformance` runs a vendor's server through the adapter protocol and reports each check. See step 1, "Run the conformance CLI against your server", of [Build your first adapter](adapter-protocol.md#build-your-first-adapter).
