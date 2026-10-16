# v5-plugins report

## Item 1 — positional plugin calls under language version 5

Branch `v5-plugins`, base 7a36f66e, commits c666ba87..a190a56f. Versions 1–4 are unchanged: every change is gated on version 5.

### The binding (one place per language)

- Rust: `crates/movement-parser/src/catalog/plugin_args.rs`.
  - `PluginSpec::positional_params(site: PluginCallSite) -> Vec<&str>`
  - `PluginSpec::bind_args(site, args: &[CallArg]) -> PluginArgBinding { args, misfits }`
  - `PluginSpec::bind_stage_args(stage: &PluginCall) -> StageArgBinding { args: Vec<NamedArg>, misfits }`
  - `PluginArgMisfit::message(callee, positional)` gives the one wording both checkers report.
- TypeScript: `packages/movement-lang/checker/catalog.ts`, exported through the package index.
  - `pluginPositionalParams`, `bindPluginArgs`, `bindStageArgs`, `pluginArgMisfitMessage`
  - `callArgSpan` moved here from check.ts.
- Users: the Rust checker, the Rust engine, and Rust admission use the Rust binding. The TS checker and the TS engine use the TS binding.

### Per point

1. **Positional parameters.** Landed as briefed.
   - A plain call: the required fed inputs, then `requiredArgs` in `args` order.
   - A stage: `requiredArgs` only.
   - The rationale is in docs/contracts/catalog-snapshot.md.
2. **Binding.** Landed as briefed.
   - The argument after the positional ones becomes the settings when it is a record literal. Each entry gets its own slot with the file's span.
   - Misfits, all reported as `MOV_THROUGH_BAD_ARG` (no new code):
     - too many arguments by position;
     - a settings key that names a positional parameter;
     - a settings member that is not `name: value` (a spread, or a quoted key);
     - a non-record argument where the settings go.
   - A record literal that sits at the settings position with more arguments after it is still the settings. Only the arguments after it are misfits. That points the error at the right argument.
3. **Checkers.** Landed.
   - Under 5 the call is bound at the top of the call check. So the named checks (types, missing input, bad argument, output) and the argument type walk see one form.
   - That includes a plugin call passed as another call's argument, and one nested in an expression (tested).
   - `MOV_PLUGIN_ARGS_NAMED` now fires only before 5.
   - The fed-input hint is written positionally under 5: `` `vcUrlRetrieval(text)` ``.
4. **Old named form under 5.** Landed.
   - The checker records the plugin's order: the positional parameters plus the names its settings take.
   - The fix writer appends non-positional names as a trailing `{ … }`.
   - There is a fix when every positional input is written and every name is known; otherwise none. It is marked safe only when the written order is kept, which is the same rule as for functions. Example: `research(context: s, name: n)` gets a fix that is not safe.
5. **Engines.** Landed in the Rust `invoke_plugin`, the TS `executePluginCall`, and Rust admission.
   - Admission's plugin table now carries each imported plugin's spec, so admission binds exactly as the engine does.
   - Without that, a settings record holding a record would have been refused as a whole map.
   - A misfit fails the call with "… — the checker should have caught this".
6. **`through [ … ]` stages.** Landed.
   - `PluginCall` gained `positional: Vec<ExprSlot>` (TS: `positional?: ExprSlot[]`), omitted when empty.
   - Under 5 the parser reads named or positional stage arguments, never a mix. It reuses the call's mixed-argument refusal.
   - Old named stage arguments under 5 now raise the parser's named-argument finding, and the checker writes the positional fix.
   - Bound in both checkers' stage checks, both engines' stage invocation, and Rust admission.
7. **Tests.** Done; results below.

### Tests run

- `cargo test -p movement-checker --test v5_plugins`: 8/8.
  - The test file is new. It covers v4 unchanged, v5 positional, misfits with messages and spans, settings spans, nested calls, the fixes and their safe marks, fixes applied and re-checked clean, and stages.
- `cargo test -p movement-checker --test v5_scope`: 10/10. Two tests were updated to the positional form, and their catalog's `url` was made required, as in the real `fetch_url`.
- `cargo test -p movement-parser`: green.
- `cargo test -p movement-engine`: green.
- TS `checker/__test__/v5_plugins.unit.test.ts` (new) and `v5_scope.unit.test.ts`: 23/23.
  - Includes a full v4→v5 `upgradeSource` of plugin calls that ends clean, and a stage rewrite applied and checked clean.
  - These need the wasm rebuilt locally. It was rebuilt and is not committed.
- apps/api `movement_engine/__test__/v5_plugin_call.unit.test.ts` (new): 6/6. On the Rust engine and on the TS reference engine (`MOVEMENT_ENGINE_V5_ON_TS`), the plugin receives the named config. Cases:
  - `{ url }`
  - `{ name, context, questions }`
  - `{ text, email }`
  - nested and argument calls
  - a stage: `{ name, questions }`
- Type-check is clean in movement-lang, movement-engine and apps/api. apps/api needed `npx prisma generate` once.
- `crates/movement-checker/parity/run.sh`: 244/244 codes; 139,822/139,822 diagnostics; 0 extra; 28,328/28,328 records exact, including v1–4. PARITY.md is committed.

### Failures that are not this slice's

These fail on old spellings in v5 tests, which another agent rewrites:

- the Rust checker's calls, hang, nodes, rules, write_target and extraction tests;
- apps/api `plugin_call.unit.test.ts`.

The extraction test now also shows its `lookup(q: "x")` named finding. That is intended: plugin calls get the fix now.

### Decisions for Henry

- **Settings keys are matched exactly as the manifest spells them.** They are not converted from camelCase (§2.7 says settings keys are camelCase). Every real plugin input today is one lowercase word, so nothing differs yet. A plugin with `max_results` would need `{ max_results: … }`, or a conversion rule like `connect`'s.
- **An optional input never takes a position.** A plugin with no required input is called `p({ url: u })`.
- **A settings value is bound as an expression slot.** That holds even when it is a function call. The value is the same, but such a call runs through the nested-call staging, not as a call argument.
- **An existing gap, not fixed here:** a record literal passed to a text input is silent in both checkers under v4 as well. Under 5 this shows up as `research({ context: s })` binding the record to `name` with no error.

### Left for Item 2

Package tags. Build them on `bind_args` / `bindPluginArgs`; nothing else is pending from Item 1.

## Item 2 — plugin package tags under language version 5

Commits 31c1cc38..f2b7ea50. Every change is gated on version 5; versions 1–4 are unchanged.

### The mechanism (as briefed)

- A package import binds each member under the dotted local name `web.fetchUrl`.
- After that, a member call is an ordinary plugin call: Item 1's binding applies unchanged.
- Rust: `crates/movement-parser/src/catalog/packages.rs` (`package_members`, `member_local`, `expand_package_imports`).
- TypeScript: `packageMembers`, `memberLocal`, `expandPackageImports` in checker/catalog.ts.

### Per point

1. **Catalog.** Landed.
   - The plugin spec has an optional `package` field in both languages.
   - The TS `Catalog` gained an optional `pluginNames()`. The snapshot reader, `mockCatalog` and the harvest recorder provide it.
   - No real plugin declares a package.
2. **Exact match.** Landed.
   - A plugin import whose name equals some spec's `package` is a package import.
   - Its members are named by `plugin_name(key)`.
3. **Reach.**
   - Parser:
     - a plugin import's local name heads a dotted callee: bound, bare, named and empty calls;
     - `through [web.member]`;
     - a nested call read on its own (the fresh parse) reads a dotted head whole.
   - Checkers: the package import declares the members as Plugin symbols. An expression call `web.x(…)` runs as a call and is hoisted.
   - Engines:
     - Rust expands the imports after the check, so the native check sees the source as written;
     - Rust admission's plugin table is keyed by member, and it stages member calls;
     - the TS engine binds the members at the import;
     - both engines run the member call nested in an expression (`runs_as_call`).
   - All five shapes are verified on both checkers and both engines: bound, bare, nested, in a block closure (also a concise closure), and a through stage.
4. **Diagnostics.** Landed.
   - `web.nope(u)` gives `MOV_V5_UNKNOWN_MEMBER`, an existing code: "`web` has no member `nope` (its members: …) — did you mean `…`?".
   - There is no fix; the did-you-mean is in the message only.
   - An unknown tag gives `MOV_IMPORT_UNKNOWN` ("Unknown plugin '@lf/nope'").
   - Under 4 a tag import is an unknown plugin.
   - A local binding is never a package: `box.fetchUrl()` keeps the "no methods" `FUNCTION_UNKNOWN`.
5. **Tests.** All pass.
   - Rust `cargo test -p movement-checker --test v5_packages`: 7/7. With v5_plugins and v5_scope: 8/8 and 10/10.
   - `cargo test -p movement-parser` and `-p movement-engine`: green.
   - TS `checker/__test__/v5_packages.unit.test.ts` with v5_plugins and v5_scope: 32/32. This uses the locally rebuilt wasm, which is not committed.
   - apps/api `v5_plugin_call.unit.test.ts`: 10/10. Its 4 new package cases show the plugin invoked by its catalog key with the named config, on Rust and on TS.
   - Type-check is clean in movement-lang, movement-engine and apps/api.
6. **Contract doc.** catalog-snapshot.md documents `package` and the package rule. The positional rule was already added in Item 1.

### Parity

- `crates/movement-checker/parity/run.sh` did not complete in this run.
- A first attempt without node 22 on PATH skipped every record.
- The rerun with node 22 was still running at handback.
- No corpus program uses a package, and both sides read the same snapshot, so 0 extra is expected. **Not verified.** Rerun it, then commit PARITY.md.

### Decisions for Henry

- **The parser knows which names are plugin imports, not which are packages.** It reads `x.m(` as one name only when `x` is a plugin import. A record-scope built-in (`o.UPPER(n)`) is therefore untouched.
  - Case 1: `x` is a plain plugin import. The call `x.m(…)` then reads as an unknown function `x.m`.
  - Case 2: a block closure inside a nested call that is parsed later, which has no import list. There a *bare* `web.f(u)` statement does not parse. A bound one (`p = web.f(u)`) works through hoisting.
- **A package import without an alias** binds `` `@lf/web`.fetchUrl ``, which cannot be written. It is not refused yet.
- **The Rust engine's expanded program** is used for the run only. Its stored tree JSON keeps the import as written.
