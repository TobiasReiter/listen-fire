# movement-engine

The movement engine in Rust. A segment of a run executes inside one WASM
instance and asks its TypeScript host for everything outside the program;
`apps/api/src/services/movement_engine/rust_engine.ts` is the host side.

No language semantics yet: `rustCanRun` (in the shim) admits no program, and
the only entries are the protocol's probes (`echo`, `panic`).

## Modules

| module | what |
|---|---|
| `executor` | a single-threaded async runtime: the segment is one future; a `HostCall` future registers its request and yields; `join_all` keeps several in flight |
| `host` | one request builder per host call, named after the `EngineHost` groups (`adapters`, `llm`, `park`, `control`, `files`, `lookup`, `locks`) |
| `value` | the value model (data, record, list, map, absent), its JSON the parked state's `ValueDescriptor` |
| `abi` | the C ABI: `engine_start`, `engine_answer`, `engine_finish` |

## One artifact

This crate's `.wasm` is the only movement artifact
(`packages/movement-lang/wasm/movement.wasm`): it links in crates/movement-parser,
whose `#[no_mangle]` exports (the parses, the lowering, the catalog query,
`alloc`, `dealloc`, `last_panic`) come through unchanged. The loader
(`packages/movement-lang/wasm/loader.ts`) compiles it once; the parser keeps
one long-lived instance of it, and each engine segment gets a fresh one.

Measured 2026-10-07 (gzip -9):

| artifact | raw | gzipped |
|---|---|---|
| the parser crate alone | 1,182,582 | 321,745 |
| this crate (the parser included) | 1,222,941 | 336,866 |

The engine adds about 15 KB gzipped, so the combined artifact sits well under
the 600 KB warning line. Revisit splitting into two artifacts if the engine's
growth brings the total near it: the browser needs only the parser.

## The protocol

```
engine_start(input)    → Step
engine_answer(id, ans) → Step
engine_finish()
Step = {"pending": [{id, family, method, args}]} | {"done": result}
```

- `pending` lists the requests issued since the previous step. Earlier ones are
  still awaited, so `{"pending": []}` means "waiting on requests in flight".
- Requests may be answered in any order. An answer is `{"value": …}`, `{}` for
  `undefined`, or `{"error": {message, …}}`; an error resolves that request's
  future with an `Err` the segment may handle.
- A dropped request (a race's loser) still accepts its answer, and discards it.
- Status 1 is a protocol misuse, `{"error": {message}}`: input that is not
  JSON, an unknown entry, an id never issued or answered twice, an answer
  after `done`, a second `start` in one instance, or a segment waiting on
  nothing (it could never finish).
- One instance runs one segment. `engine_finish` drops it and every future it
  held; the loader then discards the instance.

Entries (`input.entry`):

| entry | what |
|---|---|
| `echo` | issues each of `requests` (`{family, method, args}`) at once, finishes with `{answers}` in the answer envelope |
| `panic` | panics with `message`: the loader's trap path, provable against the real artifact |

A panic aborts and traps the instance. The parser's panic hook records the
message first; the loader reads it through `last_panic` and throws it, and the
segment is over.

## Building and testing

```bash
scripts/build-movement-wasm.sh    # the artifact, its sha256 and size
cargo test -p movement-engine     # the executor, builders, value model and ABI, natively
```

The TypeScript side: `apps/api/src/services/movement_engine/__test__/rust_engine.unit.test.ts`
(the shim against a scripted double) and `rust_engine_abi.unit.test.ts` (the
committed artifact).
