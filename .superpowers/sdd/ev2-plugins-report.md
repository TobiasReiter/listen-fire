# ev2-plugins report: plugin specs as data (Plan 22 #3 C3)

Branch `ev2-plugins` from da4342f9. Two commits: the recording test, then the move.

## What already existed at HEAD (so was not rebuilt)
- The `llm.transforms.invoke` host wire: the engine (TypeScript and Rust, through the shim) asks the host to run plugin X with its arguments.
- The engine reading plugin facts from the catalog snapshot's `plugins`. So DESIGN §9.8 (the engine reading the process transform registry) was already closed on the engine side. What was left was the data itself: it lived inside apps/api's plugin implementation files and the apps/api catalog.

## Done
- `packages/movement-engine/services/plugins/spec.ts`: a plugin declaration (signature + priced) and the checker projection `pluginSpecOf`, moved verbatim from apps/api `movement/catalog.ts`.
- `packages/movement-engine/services/plugins/registry.ts`: the six bundled declarations (signatures moved verbatim with their comments), `BUNDLED_PLUGINS`, `bundledPluginSpecs()`, `bundledPluginNamed()`.
- `packages/movement-engine/public/plugins.ts`: the new public entry.
- apps/api plugin files keep only the implementation and the Plugins-page manifest. Each implementation takes its signature and price from its declaration (`implementing(...)`).
- `register-bundled.ts` now also fails at load if the implementations and the declarations do not match one to one, by name, signature and price.
- The hosted catalog (static, team and editor snapshot) reads the declarations instead of the live transform registry. `registeredPluginSpecs` is removed; its callers now use `bundledPluginSpecs`.
- The invoker registers the bundled bodies itself. Before, the catalog did that as a side effect.
- Three catalog tests had mocks of the registry that nothing uses now; removed.
- The engine boundary baseline went down from 813 to 807.
- `docs/contracts/host-families.md` `llm.transforms` section: one paragraph saying where the declarations live.

## Decisions
- Specs are TypeScript data, not JSON. The Rust checker and engine already get them through the snapshot JSON, so a JSON file would add a second way to read the same thing.
- No `credentials` field on a declaration. None of the six declares one, and nothing would read it.
- lf is unchanged. Its snapshot still lists no plugins, and its invoker already refuses by name ("plugin X cannot run: lf does not serve plugins yet"). If lf listed the bundled plugins, programs using them would pass `lf check` and then fail at run time. Adopting them is a choice for Henry.
- The hosted behaviour for an unknown plugin is unchanged: a warning and an empty answer. The checker refuses unknown plugins before any run.

## Tests
- New `plugin_catalog_equality.unit.test.ts` with a fixture recorded from the code before the move. It records:
  - the plugin specs
  - the snapshot's `plugins` (what the Rust checker reads)
  - the live catalog's answer for each name, in both spellings
  - the TypeScript diagnostics (v4 and v5) and Rust diagnostics (v5) for 12 programs that call each plugin
- After the move it passes unchanged.
- Scoped unit tests:
  - catalog, invoker, handbook and trpc views: 24 suites, 778 tests, all pass.
  - plugin-calling movement_engine tests (extraction*, read_builtin, binding_consumer_matrix, rust_extract, rust_native_check) plus the catalog tests: 14 suites, 2093 tests, all pass. None of these test files was changed.
  - conformance v1 to v4 for extraction and read_builtin: 622 pass, 62 skipped (the skips are the corpora's own), 0 fail.
- Type-check passes for apps/api (including the boundary guard) and packages/movement-engine.
- Parity: the Rust parity corpus (`crates/movement-checker/parity`) uses its own oracle catalogs, not the product's plugins, so this change cannot add a divergence there. Not re-run.
- No integration tests run.

## Files outside my stream
- `docs/contracts/host-families.md`: one paragraph added. ev2-secrets owns protocol.ts and adapter-protocol.md, not this file.
- `scripts/engine-boundary-baseline.json`: lowered.
