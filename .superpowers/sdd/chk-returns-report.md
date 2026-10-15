# chk-returns: a function's return inferred from its body

Branch `chk-returns`, from cloud-native 847039e8. Five commits, 3f373615..(this report). Nothing pushed; wasm not rebuilt. TypeScript reference reused from the `checker` worktree (no TypeScript touched).

## Read: outcome

| | base | end |
|---|---|---|
| codes at parity (of 220) | 192 | 206 |
| diagnostics matched (of 15246) | 14836 | 15044 |
| records exact (of 11435) | 11029 | 11207 |
| extra in Rust | 0 | 0 |

- `cargo test -p movement-checker -p movement-engine`: green. `cargo check -p movement-engine --target wasm32-unknown-unknown`: green.
- Codes newly at parity (before → after matched):
  - in my slice: RETURN_TYPE 0→12, RETURN_PLANE_MISMATCH 0→4, NODE_ARG_SHAPE 69→77, BUILTIN_ARG_TYPE 10→20, DICT_KEY_NOT_TEXT 8→12, FOLD_NEEDS_ORDER 93→109, ARITH_NON_NUMERIC 77→79;
  - fell out of typing a bound block (see below): SORT_NEEDS_KEY 0→8, SORT_KEY_ON_SCALAR 0→4, DICT_UNKNOWN_KEY 8→25, AWAIT_NOT_AWAITABLE 8→12, HEAD_NOT_A_POSITION 16→24, RECORD_NOT_A_VALUE 25→29, STDLIB_ARG_NOT_RECORD 23→26.
- Partial gains elsewhere: WRITE_FIELD_TYPE 55→67, ABSENT_REQUIRED 437→457, WRITE_MAY_BE_EMPTY 53→65, COMPARE_TYPE_MISMATCH 43→55, TRAVERSE_UNKNOWN_EDGE 76→104, UNKNOWN_PROPERTY 238→258.

## Read: overlap with the sibling agents

- **chk-rules**: SORT_NEEDS_KEY, SORT_KEY_ON_SCALAR, DICT_UNKNOWN_KEY and AWAIT_NOT_AWAITABLE were already ported. They were missing only because a block bound to a name had no type. If chk-rules ported them again, keep one copy.
- **chk-answers**: some answer-typing misses also closed here, because a closure's or a block's return is now typed. The rest of WRITE_FIELD_TYPE (8) is callback answers (`c.\`stamp\``), which is theirs.

## What changed

- **A return is typed.** Each `return` is typed the way a binding of the same value would be. One function, `bound_types`, now types an assignment, a hoisted nested call, and a returned value.
- **A body has one value.** A body's returns close into one value (`closeReturns`): the first return's type, plus the union of what any return may hold. Returns on two planes (a record and a value) raise RETURN_PLANE_MISMATCH.
- **A movement's call is its inferred return.** The type-only walk keeps what the body returns. A local node it returns is labelled "the value of 'name'". A declared return wins from v3. Before v5, the call also carries what the body may hold.
- **An imported movement shares the library's inference.** The library declaration, its return and its suspend flag are shared, as the TypeScript shares `symbol.movement`.
- **A closure's call is its inferred return**, unless it declares one.
- **A collection op has a value.** MAP, FILTER, REDUCE, GROUPBY and KEYBY now produce what the function returns, collected (before, untyped). A MAP function with no return gives absent slots. GROUPBY and KEYBY keys go through DICT_KEY_NOT_TEXT. REDUCE over an unordered collection raises FOLD_NEEDS_ORDER.
- **A bound block has a value** (`planeOfReturn`): a list of the returned values, or the returned record with its walk order. Before, a bound block was untyped.
- **RETURN_TYPE.** A declared return is held against every return, for movements and closures. The checks are absence, assignability, a record type's keys, a returned record or file hidden in a value (v5), and the structural or system fit of a record.
- **A concise closure call that returns nothing** (`(f) => f()`) is checked as a statement and returns nothing (`conciseCallReturnsNothing`).
- **A write field is typed over its hoisted slot.** This touches the writes family's `write_field_value`: the field's type check now sees a call's return. Under v3 it did not.
- **Code layout.**
  - New module `families/returns.rs` holds the collector, the body's one value and RETURN_TYPE.
  - `ReturnCollector` moved there from calls.rs.
  - `check_body` and the `check_closure_*` functions now return a `Body` (each return, plus the value), not a list of spans.

## Changes to the type core (all additive)

- `types/field.rs`: new `pub fn shows_more_handles(wider, ty)` (`showsMoreHandles`).
- `binding_types.rs`:
  - `type_assigned` is now a thin wrapper;
  - new `bound_types(name: Option<&str>, value, &Bound, scope)`;
  - private `assigned_types`;
  - `type_of_bound_slot` takes `holds_value` (a returned value is read, so a tuple widens);
  - private `collected_types`.
- `checker.rs` `Bound` has two new fields: `closure_returns` and `collected`.
- `families/calls.rs` `Inference` has two new maps: `returned` and `adopted`. New functions: `adopt_movement` and `movement_inferred_return`. `infer_movement` is now public. `movement_return` (arg_fit.rs) now takes `&mut self`.

## Remaining misses (202 in all; none in this slice)

- Answers to polls and callbacks are untyped (chk-answers): ABSENT_REQUIRED 57, WRITE_MAY_BE_EMPTY 36, ENUM_UNKNOWN_VALUE 24, WRITE_FIELD_TYPE 8, and most of UNKNOWN_PROPERTY 28, TRAVERSE_UNKNOWN_EDGE 7 and COMPARE_TYPE_MISMATCH 5.
- Rules not ported (chk-rules): TRANSFORM_HOP_RETIRED 8, ENUM_EMPTY_DOMAIN 8, VALUE_UNLISTED 8, UNTIL_EDGE_WATCHABLE 4.
- CALL_ARG_TYPE 3: an extraction's record read through a hop alias (`found-[e:entry]-> { takes_entry(d: e) }`).
- JSON_OPAQUE 4: an awaited sleep's value, before v5.
- UNKNOWN_TYPE_NAME 2: a declaration in an imported library.

## Not ported, with no misses on the corpus

- **Several closures returned by one body are not merged.** When every return of a body hands back a different closure, the TypeScript merges them (`oneOfClosures`). Here the call is typed by the first closure only.
- **A function named as a value** (`functionAsValue`; the `TODO(calls)` in collection_config.rs). `return made` does not yet carry the function's closure type.
- **Parameter cells** (`asParameter` / `withoutParameter`) do not exist in the Rust core, so a returned parameter needs no stripping.
