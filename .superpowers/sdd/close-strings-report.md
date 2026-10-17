# close-strings report

Branch `close-strings`, from c6171c60. Two commits plus this report.

## 1. Engine text by character — done (7b67fdaa)
- The engine's text is a plain Rust `String`. Length, `split("")`, a spread of a text, CHUNKS and every cut (trace prompt 300, value 200, coercion 80, file bound) count characters; an emoji is 1 and is never cut in two. Order and equality are `String`'s own (order by code point was already in).
- Removed: the in-band UTF-16 form in the engine (lone surrogates held as U+FDD0 + plane-16), its JSON writer, `slice_units`/`split_units`/`find_units`/`includes`, `utf16_len`, the regex's UTF-16 lossy step, the chunker's surrogate-seam logic.
- The boundary: the host's JSON reader turns a lone `\udXXX` escape into U+FFFD (serde_json refuses one). The parser keeps its own UTF-16 form for spans (shared with the TypeScript side, untouched). A literal's text and a map key the parser wrote are made plain where they become values (`js_string::of_program`), so a U+FDD0 in a literal counts 1.
- Oracles: the strings oracle (strings.json, strings_oracle.ts, its test) is retired — it held JavaScript's UTF-16 string model. The stdlib oracle accepts `flat.length`/`flat.split` over an emoji or lone surrogate. The chunks oracle compares only texts whose characters are each one UTF-16 unit (137 of the cut cases skip; its floor lowered from 400 to 350 cut cases, 375 compared).
- Size: movement.wasm 1,266,053 → 1,264,427 B gz (−1,626). movement_parser.wasm unchanged (362,737).
- Docs: CHANGELOG `### close-strings` (end of the v5 sections), migration guide (LENGTH line), handbook (`Text.length` counts an emoji as one character), engine README rows.

## 2. Map-literal key order — not done, by finding
- The engine already keeps insertion order (CHANGELOG already says so).
- The parser reorders keys (JavaScript's index-keys-first order) in one place a program reaches: a `#transform` hop's settings. That hop is refused from version 3 (`MOV_TRANSFORM_HOP_RETIRED`), so no version 5 program reaches it; a version conditional there would be dead code. The catalog's ordering mirrors the host's `JSON.parse` of its own data and stays.
- The checker's dict type for a map literal lists its keys index-first in both checkers (it shows in messages: `{ 2: number, z: text }`, an excess-keys list). Changing it needs the TypeScript checker to stop holding the shape in a JS object; that shape type is shared with adapter schemas. Left at parity. Decision for Henry: accept that a type's printed key order differs from a value's, or ask for the TypeScript dict shape to become ordered.

## 3. Coordinator's extra: `extract_proto_field` — done (43d38822)
- Cause: not a Rust panic. The TypeScript checker built a declared or inline node's schema in a plain object, so a field named `__proto__` was set as the prototype; reading `d.__proto__` then returned `Object.prototype` as the field's type and `mixedTupleMessage` threw (`Cannot read properties of undefined (reading 'filter')`), which surfaced as "does not respell to version 5". Same on c6171c60.
- Fix: the schema's properties and edges are prototype-less objects (the idiom `extractedRecordType` already uses). Test in checker/__test__/check.unit.test.ts (both oracle programs, inline field and declared node walked); it fails without the fix. Both pattern programs now run whole through the real shim.

## Tests
- cargo test -p movement-engine: all pass (lib 148, oracles). clippy -p movement-engine --all-targets clean.
- jest (apps/api) movement_engine/__test__ rust_engine, rust_engine_abi, rust_wire_round_trip, rust_extract, seam_guard, reachability: 6 suites, 106 tests pass (against a locally rebuilt movement.wasm, not committed).
- jest (movement-lang) check.unit `__proto__` tests: 5 pass.
- apps/api code:type-check clean.
- Parity: 172,182 of 172,182 diagnostics, 47,939 of 47,939 records exact, 0 extra (one more record: the pattern program that now respells). checks.json/PARITY.md not committed.

## Shared files touched
- CHANGELOG.md, crates/movement-engine/README.md, docs/language/dancing-wren-migration.md, movement handbook builtins chapter.
- packages/movement-lang/checker/conformance.ts (shapeToSchema), checker/__test__/check.unit.test.ts.
- apps/api/src/services/movement_engine/__test__/rust_wire_round_trip.unit.test.ts (expectations now by character).
- crates/movement-engine/tests/oracle/generate.ts (strings oracle dropped).
