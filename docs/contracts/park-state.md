# The park state

Version: 1

When a flow parks (on a timer, an await, a limit, or a callback's captured continuation), the engine writes everything a resume needs to rebuild the scopes the leaf was parked in as one JSON value, `ParkedScopeState`. A host stores it, through `park.sink` or `park.callbacks.mint` ([`host-families.md`](host-families.md)), and hands it back byte for byte on resume. **A host never reads inside it.** The contract an embedder serves is the persistence `park.sink` describes; this document is the value it persists, which engines read.

- **The type:** `ParkedScopeState` and its descriptors (`packages/engine-contracts/park_state.ts`).
- **Written and read by:** the TypeScript engine (`movement_engine/serialize.ts` and the resume path in `run.ts`) and the Rust engine (`crates/movement-engine/src/park.rs`), which reads and writes the same version, every member included; a state either engine parked resumes on the other (the Rust engine refuses, by name, only the two binding kinds it does not rehydrate yet, `blockMeta` and `localShape`, which the TypeScript engine then resumes).
- **Tied to the pin:** a state is read against the exact source and language version its run is pinned to. Addresses, closures, walks and node declarations are re-read against that program, so the same state under another source is not a park.

## Versions

- **The version is an integer**, the state's own `version` member, held by `PARK_STATE_VERSION`. This release reads and writes version 1 only ([the index](README.md)). A state of any other version, or one that names none, is refused before anything is rehydrated from it (`refuseUnsupportedParkStateVersion`): every writer has always stamped the version.
- **What bumps it:** a change a current reader would misread. A descriptor removed or renamed, a member whose meaning changed, or a member a resume cannot do without. An optional member whose absence means exactly what a park written before it meant keeps the version: every park written before it still reads.
- **How a break lands:** the engine writes the new version and reads both, branching on `version` at the point of difference, for as long as a parked run written under the old one may still be waiting. The old version's fixtures stay in the engine corpora and must resume.
- **Why version 1 still holds.** Five members were added after version 1 was first written: `presenceBind`, `until`, `frames`, `suspended` and `journal`. Each is optional, and its absence means what a park written before it meant: no presence marker, a plain sleep, an address that never left the movement's own body, an ordinary park, nothing to replay. The readers treat each that way (`state.frames ?? []`, `state.journal !== undefined`, `state.until === true`, …). So every version 1 park written before them is read correctly by the current reader, and the version did not move.

## The shape

The shapes are TypeScript-ish: `x?: T` may be absent.

```ts
interface ParkedScopeState {
  version: 1;
  address: string;                   // the parked statement's lexical address (`s0.b1.s0`): the resume's entry
  bindingName: string | null;        // what a step-past resume binds the answer to; null for a value-less statement
  scopeChain: SerializedScope[];     // root first: the bindings feeding the parked statement (the innermost body's, when `frames` is present)
  presenceBind?: boolean;            // added: `expired = await sleep(…)` binds `true` at wake
  until?: boolean;                   // added: an `await until(…)` timer park, resumed by re-entering
  frames?: SerializedFrame[];        // added: the bodies the address passes into, outermost first
  suspended?: true;                  // added: an engine-initiated suspension, re-run on resume
  journal?: SerializedCallEvent[];   // added: the parked statement's finished calls, replayed on re-run
}

interface SerializedScope { bindings: Record<string, BindingDescriptor> }

interface SerializedCallEvent {
  index: number;                     // the k-th call the statement made
  value: BindingDescriptor | null;   // what it handed back
  next: number;                      // the statement's call count after it
}

type SerializedFrame =
  | { kind: 'call'; index: number; next: number; callee: string; journal: SerializedCallEvent[]; scopeChain: SerializedScope[] }
  | { kind: 'member'; index: number; next: number; member: number; op: CollectionOpExpression; journal: SerializedCallEvent[]; scopeChain: SerializedScope[] }
  | { kind: 'arm'; arm: number; body: ClosureExpression };
```

`BindingDescriptor` is a tagged union, one variant per kind of value a scope can hold: `event`, `instance`, `handle`, `extractRoot`, `extractPosition`, `sourcePosition`, `resource`, `blockMeta`, `positions`, `tuple`, `closure`, `value`, `recordValue`, `callback`, `shape`, `localShape`, `movement`, `shapePosition`, `nodePosition`, `nodeRef`, `lazyWalk` and `opaque`. Each variant's members are in `park_state.ts`. Three rules govern them:

- **Data is carried as data.** A value, a record's fields, a file descriptor (`FileRef`, never its bytes) and a minted callback's id and link are plain JSON. A data payload is never read as a binding, whatever keys it carries: only a descriptor's own tag makes one.
- **A file is said to be one.** A file the run held parks as its descriptor, and the descriptor that carries it says it is a file: a value's `{ kind: 'file', file }` (a `ValueDescriptor`, so a value holding a file parks as `recordValue`), a resource's `fileRef` slot, and, beside a record's `fields`, `fileFields` — each field that holds a file, as its value descriptor. A resume makes those files again and nothing else: a `data` payload, or a field no `fileFields` names, is data whatever keys it carries, `__brand: "FileRef"` included. A park written before files were said to be holds a file as plain data, and resumes it as data.
- **Live things are carried as identities.** An adapter instance is its type, credential name and construction config, re-resolved on resume, and its schema is fetched afresh. A stored traversal is its recipe (head, captured scope, mapping), walked again when read: a run that parked for a day sees the source as it is now.
- **Code is carried as a name, or as its syntax tree.** A shape or movement declared at file scope is its name, found again in the re-parsed program. A closure's body, a body-local declaration, a collection op and a run-time arm travel as their syntax tree, which the version pin keeps identical. A collection op called inside an expression (language version 3) is the tree of the call as the slot's text reads it, and is found again by its span among the calls its statement's expressions nest.

Members added to a descriptor after it was first written are optional in the same way as the five above (`fieldOrder`, a node's `id`, a landed edge's `landing`, a node's `landedOn`: the edge of a run-built node it landed on, which lets `write e { … }` update it in place after the resume; `fileFields` on a node, a shape position and an extraction's emission). Spellings a park written earlier still carries are read too (a file source's `ownerAdapterType`, a landing's `landingShape`, a resource's unbranded `fileRef`). A descriptor's `__brand: "FileRef"` is written as its spelling, and no reader branches on it.

## Park reasons

Beside the state, a host records why a leaf waits. The core owns three reasons: `timer`, `await` and `limit` (`CORE_PARK_REASONS`). Any other reason is a unit's own, carried as an opaque string.

## Changes

- **Version 1.** The first and only version. Since it was first written it has gained, each optional with its absence meaning the earlier behaviour: `presenceBind` (a presence marker bound at wake), `until` (a recurring-clock timer park), `frames` (parks inside a called body, a collection op's member, or a run-time arm), and `suspended` with `journal` (engine-initiated suspensions that replay finished calls). Descriptors have gained `recordValue`, `nodeRef`, a node's `id`, the kept field orders, the `file` value descriptor and `fileFields` (PLAN-07A Task 4d: a file is said to be one, never recognised by its keys), a node's `landedOn` (the edge of a run-built node it landed on), and a handle's `old` / `oldIsSelf` (the record before its write, `-[:@old]->`, language version 4 on) with its record's `foundData` and `snapshot` on the same terms. Only a version 4 run writes the last four, and both engines write and read them alike (`crates/movement-engine/src/park.rs`, since PLAN-07A Task 4c).
