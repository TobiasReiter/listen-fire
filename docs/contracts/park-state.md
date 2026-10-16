# The park state

Version: 2

When a flow parks (on a timer, an await, a limit, or a callback's captured continuation), the engine writes everything a resume needs to rebuild the scopes the leaf was parked in as one JSON value, `ParkedScopeState`. A host stores it, through `park.sink` or `park.callbacks.mint` ([`host-families.md`](host-families.md)), and hands it back byte for byte on resume. **A host never reads inside it.** The contract an embedder serves is the persistence `park.sink` describes; this document is the value it persists, which engines read.

- **The type:** `ParkedScopeState` and its descriptors (`packages/engine-contracts/park_state.ts`).
- **Written and read by:** each engine its own version. The TypeScript engine (`movement_engine/serialize.ts` and the resume path in `run.ts`) runs language versions 1–4 and writes and reads version 1. The Rust engine (`crates/movement-engine/src/park.rs`, `resume.rs`, `code.rs`) runs language version 5 on and writes and reads version 2. Neither reads the other's: a run never changes engine, so its parks never do.
- **Tied to the pin:** a state is read against the exact source and language version its run is pinned to (`trigger_run.movement_version_id`; a version row is never changed, an edit mints a new one). Addresses are re-read against that program, and in version 2 so is every piece of code the state names. The libraries the run linked are pinned by the state itself (`libraries`): a resume reads them from there, never from what the team has saved since.

## Versions

- **The version is an integer**, the state's own `version` member; `PARK_STATE_VERSION` is the current one, 2. This release reads and writes versions 1 and 2, each on its own engine ([the index](README.md)). A state of any other version, or one that names none, is refused before anything is rehydrated from it (`refuseUnsupportedParkStateVersion`): every writer has always stamped the version.
- **What bumps it:** a change a current reader would misread. A descriptor removed or renamed, a member whose meaning changed, or a member a resume cannot do without. An optional member whose absence means exactly what a park written before it meant keeps the version: every park written before it still reads.
- **How a break lands:** the engine writes the new version and reads both, branching on `version` at the point of difference, for as long as a parked run written under the old one may still be waiting. The old version's fixtures stay in the engine corpora and must resume.
- **Why version 1 still holds.** Five members were added after version 1 was first written: `presenceBind`, `until`, `frames`, `suspended` and `journal`. Each is optional, and its absence means what a park written before it meant: no presence marker, a plain sleep, an address that never left the movement's own body, an ordinary park, nothing to replay. The readers treat each that way (`state.frames ?? []`, `state.journal !== undefined`, `state.until === true`, …). So every version 1 park written before them is read correctly by the current reader, and the version did not move.

## The shape

The shapes are TypeScript-ish: `x?: T` may be absent. The two versions differ only in how they carry code (`ParkedCode` in `park_state.ts`: `CodeAsTree` for 1, `CodeByPlace` for 2) and in version 2's `libraries`; every other member is the same.

```ts
interface ParkedScopeState {
  version: 1 | 2;
  address: string;                   // the parked statement's lexical address (`s0.b1.s0`): the resume's entry
  bindingName: string | null;        // what a step-past resume binds the answer to; null for a value-less statement
  scopeChain: SerializedScope[];     // root first: the bindings feeding the parked statement (the innermost body's, when `frames` is present)
  presenceBind?: boolean;            // added: `expired = await sleep(…)` binds `true` at wake
  until?: boolean;                   // added: an `await until(…)` timer park, resumed by re-entering
  frames?: SerializedFrame[];        // added: the bodies the address passes into, outermost first
  suspended?: true;                  // added: an engine-initiated suspension, re-run on resume
  journal?: SerializedCallEvent[];   // added: the parked statement's finished calls, replayed on re-run
  libraries?: ParkedLibrary[];       // version 2: every library the run linked, pinned
}

type ParkedLibrary =                 // version 2
  | { path: string; source: string } // its text, where the host keeps no source store
  | { path: string; hash: string };  // the hash the host's `park.sources` keeps its text by

interface SerializedScope {
  bindings: Record<string, BindingDescriptor>;
  id?: number;                       // added: its number, when a closure holds it by reference
  parent?: ScopeLink;                // added: with `id`, the scope it is nested in
}

type ScopeLink =                     // where a closure's scope is (body closures hold it by reference)
  | { kind: 'scope'; id: number; parent?: ScopeLink; bindings: Record<string, BindingDescriptor> }
  | { kind: 'scopeRef'; id: number }
  | { kind: 'file'; file?: string };

interface SerializedCallEvent {
  index: number;                     // the k-th call the statement made
  value: BindingDescriptor | null;   // what it handed back
  next: number;                      // the statement's call count after it
}

type SerializedFrame =
  | { kind: 'call'; index: number; next: number; callee: string; journal: SerializedCallEvent[]; scopeChain: SerializedScope[] }
  | { kind: 'member'; index: number; next: number; member: number; op: CollectionOpExpression | { span: Span }; journal: SerializedCallEvent[]; scopeChain: SerializedScope[] }
  | { kind: 'arm'; arm: number; body: ClosureExpression | CodePlace };

// Version 1 carries code as its syntax tree (a closure's `closure`, a lazy walk's
// `head` and `mapping`, a `localShape`'s `declaration`, a frame's `op` and `body`);
// version 2 as its place in the pinned program, an op as its span.
type CodePlace = string;             // an AST path: `/statements/2/body/0/value/closure`, `@lib~1deals/statements/0`
```

`BindingDescriptor` is a tagged union, one variant per kind of value a scope can hold: `event`, `instance`, `handle`, `extractRoot`, `extractPosition`, `sourcePosition`, `resource`, `blockMeta`, `positions`, `tuple`, `closure`, `value`, `recordValue`, `callback`, `shape`, `localShape`, `movement`, `fileClosure`, `shapePosition`, `nodePosition`, `nodeRef`, `handleRef`, `lazyWalk` and `opaque`. Each variant's members are in `park_state.ts`. Three rules govern them:

- **Edge order in a stored copy plan is not significant (Henry, 2026-10-14).** A graph spread's copy plan (`{ fields, edges }`, as a parked closure holds it) names its edges in whatever order the engine wrote them: the TypeScript in declaration order, the Rust engine in sorted order. The park is otherwise byte-equal across engines; here only the SET of edge names (with each edge's own plan) is the contract, so a state parked by either engine resumes on either.
- **Data is carried as data.** A value, a record's fields, a file descriptor (`FileRef`, never its bytes) and a minted callback's id and link are plain JSON. A data payload is never read as a binding, whatever keys it carries: only a descriptor's own tag makes one.
- **A file is said to be one.** A file the run held parks as its descriptor, and the descriptor that carries it says it is a file: a value's `{ kind: 'file', file }` (a `ValueDescriptor`, so a value holding a file parks as `recordValue`), a resource's `fileRef` slot, and, beside a record's `fields`, `fileFields` — each field that holds a file, as its value descriptor. A resume makes those files again and nothing else: a `data` payload, or a field no `fileFields` names, is data whatever keys it carries, `__brand: "FileRef"` included. A park written before files were said to be holds a file as plain data, and resumes it as data.
- **One thing is written once.** A run-built node, and a write handle, held in two places (two names, a closure's capture, a record's `-[:@old]->`) is written the first time and referenced after (`nodeRef`, `handleRef`), so a resume holds one: an in-place write through one name is read through the other. A node is numbered as it is written (`id`); a handle only when a second sighting needs it, its first descriptor then carrying the `id`, so a state holding each handle once is written as before.
- **Live things are carried as identities.** An adapter instance is its type, credential name and construction config, re-resolved on resume, and its schema is fetched afresh. A stored traversal is its recipe (head, captured scope, mapping), walked again when read: a run that parked for a day sees the source as it is now.
- **Code is carried as a name, or as its place in the program (version 2; version 1 carries its syntax tree).** A shape or movement declared at file scope is its name, found again in the re-parsed program — in the library its `file` names, when it is a library's. A closure bound at a file's top level is its name (`fileClosure`), found again in that file: it holds its file's scope by reference, so neither its body nor that scope is written. A closure's body, a kept walk's head and mapping, a body-local declaration and a run-time arm are their AST path: a JSON Pointer through the parser's tree of the file that wrote it, a library's behind its escaped path (`@lib~1deals/statements/0/body/1/value/closure`), read again through a call nested in an expression from its slot's text (`…/nested/<start>-<end>/value/…`). A movement read as a value is its declaration's path. A collection op is its span, found among the calls its statement makes (its expressions' nested calls included). The pin keeps the root program's text, and `libraries` every library's, so each place holds the code that parked; a place that holds no such code fails the resume, naming it.
- **Libraries are pinned by the park (version 2).** `libraries` lists every library the run linked, not only those its parked code names: a run reads one program, so a branch's export or a member's answer written in one segment means the same code in the segment that reads it. A resume sets these texts in place of the team's saved files before it checks the program. With a host that serves `park.sources` ([host-families.md](host-families.md)), each is named by the hash the store keeps its text by, one stored text shared by every park and run that names it; without one, the park carries the text.

Members added to a descriptor after it was first written are optional in the same way as the five above (`fieldOrder`, a node's `id`, a landed edge's `landing`, a node's `landedOn`: the edge of a run-built node it landed on, which lets `write e { … }` update it in place after the resume; `fileFields` on a node, a shape position and an extraction's emission). Spellings a park written earlier still carries are read too (a file source's `ownerAdapterType`, a landing's `landingShape`, a resource's unbranded `fileRef`). A descriptor's `__brand: "FileRef"` is written as its spelling, and no reader branches on it.

## Park reasons

Beside the state, a host records why a leaf waits. The core owns three reasons: `timer`, `await` and `limit` (`CORE_PARK_REASONS`). Any other reason is a unit's own, carried as an opaque string.

## Changes

- **Version 2 (the Rust engine, language version 5 on; shrink-park, 2026-10-16).** Code is named by its place in the pinned program rather than carried as its syntax tree (a member frame's op by its span), and the state pins the run's libraries (`libraries`, each its text or a `park.sources` hash). A version 1 reader would misread every closure, walk, body-local declaration and frame, so the version moved. The Rust engine writes and reads only version 2; the TypeScript engine, which runs language versions 1–4, writes and reads only version 1, and refuses a version 2 state by name. No version 2 state predates it (language version 5 was unreleased), so nothing waits to be read across the change.

- **Version 1.** The first version, the TypeScript engine's. Since it was first written it has gained, each optional with its absence meaning the earlier behaviour: `presenceBind` (a presence marker bound at wake), `until` (a recurring-clock timer park), `frames` (parks inside a called body, a collection op's member, or a run-time arm), and `suspended` with `journal` (engine-initiated suspensions that replay finished calls). Descriptors have gained `recordValue`, `nodeRef`, a node's `id`, the kept field orders, the `file` value descriptor and `fileFields` (PLAN-07A Task 4d: a file is said to be one, never recognised by its keys), a node's `landedOn` (the edge of a run-built node it landed on), and a handle's `old` / `oldIsSelf` (the record before its write, `-[:@old]->`, language version 4 on) with its record's `foundData` and `snapshot` on the same terms. Only a version 4 run writes the last four, and both engines write and read them alike (`crates/movement-engine/src/park.rs`, since PLAN-07A Task 4c). Then (main's B7, B11, B13, mirrored by the Rust engine): a handle's `id` and the `handleRef` descriptor (one handle two places hold is written once, and a completed branch's export is written by one park, `#return` first), `file` on a `shape` or `movement` descriptor (the library it is declared in; absent, the root program, as a park written before it reads), and the `fileClosure` descriptor (a closure bound at a file's top level, by name, with its library's `file`). Each is optional and new: a park written before them holds none and resumes as it did.
