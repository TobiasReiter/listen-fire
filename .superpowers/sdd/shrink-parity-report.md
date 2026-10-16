# shrink-parity report (2026-10-16)

Branch `shrink-parity`, from `cloud-native` at d785c58c. Each change has its own commit. The wasm was not committed.

## Done (each with re-baselined tests, CHANGELOG lines under "shrink-parity", handbook where users see it)

The size column is movement.wasm gzipped, measured cumulatively on each commit (`gzip -9`, built with the build script's flags from a clean export of the commit). The baseline is 1,527,863 bytes.

| item | commit | gz after | saved |
|---|---|---|---|
| 4 one number formatter (the parser's); ryu-js dropped; four checker printers delegate | a7596920 | 1,513,433 | 14,430 |
| 5 Unicode letter/number/ID tables → `char` predicates; regex group names ASCII; marks table kept (generator renamed tests/oracle/marks.ts) | 58184142 | 1,508,981 | 4,452 |
| 6 formula.rs → ONLY quotes its argument's source (carried on the lowered aggregate, `#[serde(skip)]`) | 62015ae6 | 1,507,502 | 1,479 |
| 7 case_mapping.rs → `to_lowercase`/`to_uppercase` | 0bd4a913 | 1,501,397 | 6,105 |
| 8 regex over code points, no Annex B, nesting past 1,000 is malformed | 5f357341 | 1,501,075 | 322 |
| 9 ISO 8601 / RFC 3339 only, no offset means UTC; V8 legacy parser and LocalZone/localZone deleted | fb3139e6 | 1,498,025 | 3,050 |
| small: `builtins` host family removed (Rust and the TS shim route, its contract row and test) | 10f93f20 | 1,495,979 | 2,046 |
| small: dead `number_format` env op (native-only; ICU decimal crates dropped) | 18ffc0e4 | 0 B in wasm | |
| small: ROUND is `f64::round`, toFixed is `{:.N}`, `Number(text)` is trim plus parse, `char::is_whitespace`, `Ord` in place of `utf16_cmp` | 6ba2ea30 | 1,491,970 | 4,009 |

Total: 1,527,863 → 1,491,970 bytes gzipped (35,893 saved; raw 5,295,266 → 5,206,097). That is 80,894 under the 1,572,864 failure line.

Oracles re-baselined, not retired:
- numbers.json: a 17-digit tie may differ only in its last digit, and must read back as the same number.
- case_mapping.json: every text that maps differently holds a Unicode 17 change.
- regex.json: a difference is allowed only for Annex B or astral content.
- dates.json: read in UTC only; a difference is allowed only on texts V8 alone read as dates.
- stdlib.json and strings.json: one named predicate per accepted difference (`accepted_difference` in tests/stdlib_oracle.rs).

## Not done (stopped at the context budget)
- **Item 10: eval-wire JS tags → plain JSON.** The wire (env.rs encode/decode) also carries host requests marked `wire: true`. Changing it needs a matching change to the TS shim's rust_wire.ts, so it should be coordinated with shrink-routes's eval ABI deletion.
- **Item 11: prototype emulation → plain maps.** It touches about 170 sites (js.rs, env.rs, eval.rs, record.rs, collection.rs, extract/validate.rs, write.rs), plus the checker's `__proto__` refusals (names.rs, nodes.rs, extraction.rs).
- **Key order → insertion order.** This is js.rs `object_key_order` and the parser's `util::js::object_key_order`.
- **UTF-16 strings and lone surrogates → Rust `String` with U+FFFD at the boundary.** js_string.rs keeps its in-band escape form (U+FDD0) for now. Only the regex reads the text converted to U+FFFD. chunks.rs still counts UTF-16 units.
- **Parser whitespace and `locale_compare`: deliberately left alone.** The parser serves every version (the browser, and lf for older pins), so changing them needs version conditionals.
- **The TS loader still answers the `number_format` op** (packages/movement-lang/wasm/env_services.ts). Nothing asks for it any more.

## Shared files touched (tell the integrator)
- crates/movement-engine/src/admit.rs (shrink-routes deletes it): the ONLY condition no longer asks the formula spelling, and one test assertion was removed.
- crates/movement-engine/src/lib.rs and env.rs, the eval_expression envelope parts (shrink-routes deletes them): `localZone` removed.
- packages/movement-engine/services/movement_engine/rust_host.ts: the `builtins.function` route, its helper and its imports removed.
- apps/api/src/services/movement_engine/__test__/rust_run.unit.test.ts: one test removed (the regex hand-back).
- docs/contracts/host-families.md: the `builtins.function` row removed.
- crates/movement-parser/src/lowering/expression.rs: the `Aggregate` variant gains `written` (never serialised).
- Cargo.lock: ryu-js and the ICU decimal crates removed.

## Verification
- `cargo test -p movement-engine` passes, oracles included.
- `cargo test -p movement-checker` passes.
- `cargo test -p movement-parser` passes.
- `cargo clippy` on the engine and checker is clean.
- The movement-engine TS package type-checks.
- Not run: the full `pnpm -r code:type-check`, the TS suites against a rebuilt wasm, and any end-to-end run.
