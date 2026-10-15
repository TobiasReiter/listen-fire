# chk-nodes: the nodes family on the integrated checker

Branch `chk-nodes`, cut from `checker` at c4b33484. Nothing pushed. The committed wasm was not rebuilt.

## Read: outcome

- Parity (crates/movement-checker/PARITY.md, Rust side run against the existing TS reference):

| | before (c4b33484) | after |
|---|---|---|
| codes at parity | 129 of 220 | 155 of 220 |
| diagnostics matched | 13892 of 15246 | 14374 of 15246 |
| records exact | 10142 of 11435 | 10599 of 11435 |
| extra in Rust | 0 | 0 |
| nodes family matched | 4 of 314 | 270 of 314 |

- `cargo test -p movement-checker`: green (new `tests/nodes.rs`, 5 tests). `cargo check -p movement-engine --target wasm32-unknown-unknown`: green.
- All three `TODO(nodes)` markers are resolved (listens' shape conformance now reads the declared schema, extends folded in).

## Nodes codes, before → after (matched / TS total)

| code | before | after |
|---|---|---|
| NODE_ARG_SHAPE | 0/77 | 69/77 |
| NODE_LINK_SHAPE | 0/32 | 32/32 |
| NODE_EDGE_UNDECLARED | 4/24 | 24/24 |
| NODE_ENTRY_NODE_VALUE | 0/16 | 16/16 |
| NODE_EDGE_DEFERRED, NODE_ENTRY_TYPE | 0/8 each | 8/8 each |
| NODE_ENTRY_DUPLICATE, NODE_LANDING_MISMATCH | 0/4 each | 4/4 each |
| NODE_LINK_BODY | 0/2 | 2/2 |
| GRAPH_FIELD_MISSING | 0/18 | 16/18 |
| GRAPH_FIELD_TYPE | 0/12 | 12/12 |
| GRAPH_ENTRY_KIND, GRAPH_REFERENCE_SHAPE | 0/8 each | 8/8 each |
| GRAPH_FIELD_UNKNOWN | 0/4 | 4/4 |
| GRAPH_SPREAD_NOT_MAP | 0/4 | 2/4 |
| GRAPH_SHAPE, GRAPH_SPREAD_UNTYPED | 0/2 each | 2/2 each |
| EXTENDS_CYCLE / NOT_A_NODE / REDEFINES | 0/9, 0/3, 0/6 | all at parity |
| MEMBERS_NOT_CLOSED | 0/8 | 8/8 |
| UNKNOWN_TYPE_NAME | 0/23 | 11/23 |
| BORROW_UNKNOWN_FIELD / GRAPH / ROOT | 0/12, 0/12, 0/8 | 4/12, 4/12, 4/8 |
| (no corpus cases) BORROW_MALFORMED, GRAPH_COPY_SHAPE, GRAPH_ENTRY_RECORD, GRAPH_SPREAD_RECORD, SHAPE_FIELD_PROTO | 0 | ported except the two *_RECORD refusals |

## Other families this unblocked (matched / TS total)

| code | before | after |
|---|---|---|
| ABSENT_REQUIRED | 379/514 | 406/514 |
| UNKNOWN_PROPERTY | 190/286 | 225/286 |
| TRAVERSE_UNKNOWN_EDGE | 70/111 | 74/111 |
| NARROWING | 60/84 | 84/84 |
| UNREACHABLE_BRANCH | 12/28 | 28/28 |
| WRITE_UNKNOWN_FIELD | 57/77 | 77/77 |
| WRITE_FIELD_TYPE | 41/75 | 50/75 |
| ENUM_UNKNOWN_VALUE | 75/118 | 90/118 |
| UNIQUE_UNKNOWN_FIELD | 23/31 | 31/31 |
| CALL_ARG_TYPE | 0/55 | 18/55 |
| FOLD_NEEDS_ORDER | 85/109 | 93/109 |
| MAP_KEY_OVERWRITTEN | 2/13 | 9/13 |
| PRESENCE_TEST_CONSTANT, USE_BEFORE_BIND | 16/19, 15/19 | both at parity |
| EXTRACT_FIELD_DUPLICATE | 0/10 | 2/10 (the declaration's field/child clash) |

## Remaining nodes misses, and why

- UNKNOWN_TYPE_NAME 12, BORROW_* 20: raised from extraction annotations (`n: <nubmer> "how many"`). The extraction family owns `resolveExtractFieldType`; it should call the new shared `resolve_named_type` (families/nodes.rs). Also one from an imported library's declaration.
- NODE_ARG_SHAPE 8: the argument is a movement call's value (`takes_doc(d: counts(m: e))`, or a name bound to one). Needs movement return typing from the body (calls family / core gap).
- GRAPH_FIELD_MISSING 2, GRAPH_SPREAD_NOT_MAP 2: the spread source is a closure parameter or a list of extracted records; both need extraction typing.

## Type-core changes (all additive)

- `types/declared.rs` (new): `shape_to_schema`, `inherit_schema`, `inherit_declaration`, `declared_instance`, `declared_root_position`, `run_built_landing`, `describe_shape_node`, `surface_not_enumerated`, `Surface` / `schema_surface` / `supplied_surface` / `surface_misfit`, `text_repair`, `schema_type_of`.
- `types/position.rs`:
  - `Instance.declared: bool` — a node declaration's own instance (TS `isDeclaredNode` / `isDeclaredGraphToken`). The one other constructor (binding_types instance typing, tests/types.rs) sets `false`.
  - `LocalEdge` gains `structural`, `deferred`, `references` (TS `LocalEdge` flags). Only the nodes family builds LocalEdges.
- `binding_types.rs`: `position_from_type_ref` resolves `<Doc>` naming a declaration to its root; `extract_graph` is `pub(crate)` and its declared-node branch calls the nodes family.

## Other edits outside nodes.rs

- checker.rs: `Checker.nodes` state; hoist declares each declaration's schema and folds `extends`; the shape statement settles it; node-literal code moved to nodes.rs; `check_call_args_typed` returns each argument's record type; `open_landing` is `pub(crate)`; `RValue::Members` checked.
- calls.rs: `check_call` runs the record-argument fit; MEMBERS readings checked.
- writes: `local_write_target` gains the lazy-edge refusal, the declared flag and the local handle; `known_fields_of` reads a declared position's fields; `check_link_rules` hands a run-local link to the nodes family.
- walks: IS against a declared node narrows to the conforming members and eliminates proven ones; `RuledOut` lost its "unknown" arm.
- listens: shape copy removed; conformance reads the declared schema; `ListenState::movement_info` accessor.
- imports: an imported declaration adopts the library's.

## Deviations (decisions for the controller)

- A declaration settled at its statement gets a new instance only when a field type changed (a borrowed or declared type resolved there). Records typed before that statement keep the earlier instance. TS patches the schema in place, so it has one identity throughout.
- CALL_ARG_TYPE's nominal branch (`positionsMatch` + `systemDifference`) is not ported. It needs system addresses, which this checker does not model (identity is per binding). Porting it now would raise extras on two bindings of the same system.
- A graph entry whose value this checker cannot type, where the shape declares a child node, is read as references of unknown records. TS types those values (a `MAP` of writes) and reads them as references. Without this, two extras appeared.
- A spread with a path (`...a.b`), or one whose source is untyped, is opaque (no keys, no refusal). TS would refuse an untyped source as GRAPH_SPREAD_NOT_MAP.
- GRAPH_ENTRY_RECORD and GRAPH_SPREAD_RECORD are not ported (no corpus cases). A value entry that holds a record somewhere inside is not field-checked.
- The extraction family's agent may port `checkFieldChildNamesApart` too. It now runs from the declaration check (EXTRACT_FIELD_DUPLICATE). Merge so it runs once.

## Commits

f72677f4, cd44f22b, 6e1c0141, then MEMBERS, listens TODOs, declared extraction nodes, IS narrowing, tests (see `git log c4b33484..chk-nodes`).
