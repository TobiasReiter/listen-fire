# The contracts

The movement core speaks five contracts. Each is written down here with an integer version of its own, independent of the release tag and of the others, so an embedder, an adapter vendor or a second engine can say exactly what it speaks.

| contract | document | current | supported | deprecated | on the wire |
|---|---|---|---|---|---|
| catalog-snapshot | [catalog-snapshot.md](catalog-snapshot.md) | 1 | 1 | none | `contractVersion` on the snapshot |
| park-state | [park-state.md](park-state.md) | 1 | 1 | none | `version` on the state |
| host-families | [host-families.md](host-families.md) | 1 | 1 | none | `hostFamiliesVersion` on `segment.open` |
| adapter-protocol | [adapter-protocol.md](adapter-protocol.md) | 2 | 2 | none | `protocolVersion` on every request and the manifest |
| language-versions | [language-versions.md](language-versions.md) | 3 | 1, 2, 3 | none | `languageVersion` beside every program |

- **This table is this release's.** A release states, contract by contract, the version it writes, the versions it reads, and the ones it will stop reading.
- **The table is held equal to the code.** `CONTRACTS` (`packages/engine-contracts/versions.ts`) is test-held equal to this table, and each document's version line to its constant (`CATALOG_SNAPSHOT_VERSION`, `PARK_STATE_VERSION`, `HOST_FAMILIES_VERSION`, `MANIFEST_PROTOCOL_VERSION`, `CURRENT_LANGUAGE_VERSION`).

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

A host recording is one entry into the engine as data: what it was handed, every request it made of its host in order with the answer each got, and how it ended. The format is the zod schema in `packages/engine-contracts/conformance/recording.ts`:

```ts
{
  kit: 'host';
  version: 1;                          // the recording format's own version
  entry: 'run' | 'resume' | 'settleRace' | 'callbackBody';
  clock: string;                       // the instant the clock read throughout the entry
  input: RunInput | ResumeInput | SettleRaceInput | CallbackBodyInput;  // with its languageVersion
  methods: string[];                   // every host method the recorded host served
  requests: Array<{ family: string; method: string; args: unknown } & ({ answer?: unknown } | { error: { class: string; code?: string; message: string } })>;
  result?: unknown;                    // exactly one of result and failure
  failure?: { class: string; code?: string; message: string };
}
```

- **`family` and `method`** are a manifest family and one of its methods (`park.sink` and `commitTimerPark`). `args` is the method's one request object, `answer` its answer (absent from a method that answers nothing), `error` what the host threw.
- **`methods`** matters because a host may leave out an optional family or method, and the engine behaves differently without it (no park sink: a run that parks raises). A replay serves exactly these.
- **`clock`** matters because the engine reads the wall clock for a sleep's wake time and a callback's expiry. A recording is made with the clock held still for the whole entry, and a replay holds it at the same instant.

**Replaying.** An engine under replay is handed the recorded input and a host that answers from the recording. It conforms when:

- every request it makes has a recorded counterpart: the earliest recorded request not yet served with the same family, method and canonical args (keys sorted, undefined dropped);
- every recorded request is made;
- it ends the same way: the same result as canonical JSON, or a failure with the same class, code and message.

The first divergence is named: the request with no counterpart and the nearest recorded one, the recorded request never made, or the path where the results first differ. The rules are `packages/engine-contracts/conformance/replay.ts`.

**Replaying ours against your engine or host.** Our corpora are `apps/api/src/services/movement_engine/conformance/__fixtures__/engine-runs.v1.json` and `.v2.json`, one recording per line: every distinct entry the v1 and v2 engine corpora make. Each line replays on its own.

- To test an engine: hand it each recording's input and a host built from `RecordedConversation` (it answers by the matching rule), then judge with `verdictOf`.
- To test a host over a wire: our HTTP host double is the model. It serves `POST /host/<family>/<method>` with the request object as the body, and answers `{ "answer": … }`, `{}` for a method that answers nothing, or `{ "error": { class, code?, message } }`; a request the recording lacks answers 409 `{ "divergence": "…" }` (`http_host_double.ts`).
- Ours runs every recording against three targets on each change: the TypeScript engine in process, the Rust engine through its shim, and the TypeScript engine against the HTTP double (`conformance/__test__/engine_runs.v<n>.unit.test.ts`). The Rust target takes only the recordings its shim routes and runs whole, and skips the rest with the reason.

**Recording your own host.** Wrap any `EngineHost` with the recorder (`apps/api/src/services/movement_engine/conformance/recorder.ts`, `recordEntry`). It hands the engine and the host each other's own values, keeps JSON copies, and refuses a request or answer JSON cannot carry. To re-harvest ours:

```bash
cd apps/api && pnpm harvest:engine-runs
```

This records both corpora (`UPDATE_ENGINE_RUNS=1 pnpm test:conformance:v<n>`), then keeps only the recordings that replay on the TypeScript engine, in process and over the HTTP double. It prints each one it drops. A dropped run depended on something a recording cannot carry:

- its test's own module mocks;
- an id the engine minted at random (an extraction's resource ids), which is most of them;
- the host's timing (a cancel racing calls still in flight, which a slower host answers later).

### The language kit: checked programs

Every program the test suites check, with its catalog snapshot, language version and full diagnostics. `pnpm language:conformance <checks.json>` replays a corpus against the checker, ours or your own. See [`packages/movement-lang/conformance/README.md`](../../packages/movement-lang/conformance/README.md).

### The adapter kit

Arrives with the adapter conformance command, which runs a vendor's server through the adapter protocol.
