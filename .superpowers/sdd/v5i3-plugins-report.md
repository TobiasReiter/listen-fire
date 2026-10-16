# v5i3-plugins — plugins fed only by an extraction are callable from version 5

## Read

- `linkedinEnrichment(person)` now works under version 5: it hands back a record with `linkedin_url` and `linkedin_profile`, and either one may be absent.
- Versions 1–4 do not change: a plain call is still refused as MOV_PLUGIN_FED_BY_EXTRACTION, with the same message.
- Under version 5, the message that retires the extraction keyword now names each stage's plugin as the call that replaces it, e.g. `('linkedinEnrichment(record)')`.
- Both engines hand the record to the plugin the way a stage handed it: as the extracted context (the same wire, so the plugin itself is untouched).
- Not done: no handbook chapter for `linkedinEnrichment` (the handbook test still pins that it has none).

## The call shape chosen, and why

- **One positional argument: the record the plugin runs on.** A stage fed this plugin the record it enriched, implicitly. The v5-plugins ruling says a stage's implicit input becomes an explicit argument, and required inputs are positional. This plugin has no inputs of its own, so the record is its only argument. There are no settings either, but the trailing settings record is still accepted by the general binding.
- **The record is treated as a "fed" argument.** A fed argument is something a stage fills and a plain call writes itself, which is exactly what this is. That reuse means positional binding, the "missing argument" message, argument typing and the `#transform` hop message all handle it with no new code. The argument is typed as structured data (`json`), the way a plugin argument that takes a record is typed everywhere else.
- **The parameter name `record` is fixed in the language, not declared by the plugin.** Under version 5, named arguments to plugins are retired, so nobody writes the name in a program. It only appears in messages and as the binding key, and it is compared, never parsed. Declaring a name per plugin would add a manifest field that only this one plugin uses.
- **It is a version conditional applied when the spec is read.** The catalog keeps saying "fed by extraction". A single view, `pluginSpecUnder(spec, version)` in TypeScript and `PluginSpec::under` in Rust, turns that into "one required fed argument `record`" from version 5. A plain call reads the view; a stage reads the raw spec. Versions 1–4 get the spec unchanged.
- **The output is declared on the plugin's signature.** It is a record with two fields, each maybe absent: the fields the plugin already adds. Under versions 1–4 nothing reads it, because the "fed by extraction" refusal comes before the output check.

## What changed, per layer

- **Catalog (apps/api):** the `linkedin-enrichment` signature declares its `output`. The catalog test now pins that output, and the handbook test comment was updated.
- **Shared spec view:**
  - TypeScript: `EXTRACTED_RECORD_PARAM` and `pluginSpecUnder` in packages/movement-lang/checker/catalog.ts.
  - Rust: the twins in crates/movement-parser/src/catalog/plugin_args.rs.
- **TypeScript checker (check.ts):** `plainPluginSpec` routes the four plain-call reads through the view: binding, the application check, argument types, and the `#transform` hop message. extract_keyword_retired.ts lists the stage plugins and builds the hand rewrite with each plugin's call.
- **Rust checker:**
  - `plugin_spec_of` and `plain_plugin_spec` read through the view, and now return an owned spec.
  - walks.rs: the hop message uses the view.
  - extract_keyword.rs: the same rewrite message as TypeScript.
- **TypeScript engine (run.ts, `executePluginCall`):** binds positional arguments through the view. Under version 5, for a plugin fed by extraction, the `record` argument is moved out of the config and into the extracted context.
- **Rust engine (plugin.rs):** the same, at the same point.
- **Rust admission:** no change needed. It admits a plugin call by its declared output, which now exists.

## Tests

- TypeScript checker: `checker/__test__/v5_fed_by_extraction.unit.test.ts` (7 tests), plus v5_plugins, extract_keyword_retired and meta_hops_retired. All 43 pass.
- Rust checker: `tests/v5_fed_by_extraction.rs` (7 tests, the TypeScript twin) and v5_plugins pass. `cargo test` for movement-parser and movement-engine is all green. Clippy reports nothing on the lines I changed.
- Both engines: a new describe block in apps/api `movement_engine/__test__/v5_plugin_call.unit.test.ts` runs on Rust and on the TypeScript reference. Each engine:
  - hands the plugin an empty config and the record `{ name, company: { name } }` as its extracted context;
  - binds what the plugin returns, so `found.linkedin_url` feeds a later `fetchUrl`.
  - Identical results on both engines.
- The catalog and handbook suites pass.
- Type-check is clean for movement-engine and apps/api; apps/api includes movement-lang.
- Parity: unchanged from the e46730ca baseline. That is 246 of 253 codes, 1 extra diagnostic in Rust (the one already there), and 46676 of 46749 records exact. PARITY.md is not committed.

## Problem found that I did not fix

- Four tests in v5_plugin_call.unit.test.ts already failed before this change, on both engines: "binds a through stage by position" and the package version "is a through stage". They run the extraction keyword under version 5, which the v5-extract work retired, so the check refuses them (MOV_EXTRACT_KEYWORD_RETIRED). They belong to the v5-extract fallout; whoever owns that should rewrite them or delete them.
- A plugin that declares no effects or no output is still advised, under version 5, to "write it in a 'through […]' stage". That advice is stale now the keyword is retired. No bundled plugin hits it, so I left it.
