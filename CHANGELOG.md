# Changelog

Every pull request that changes what an operator sets or an author writes adds a line under Unreleased in the same pull request. Tagging a release moves the Unreleased entries under a heading for the new version, with the date.

Entries are written for two readers: an operator running a self-hosted installation (what to set, what a deploy applies, what behaves differently) and an author writing automations in the movement language (new or changed constructs, plugins, adapters, handbook idioms). The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are the git tags described in [`deploy/UPGRADING.md`](deploy/UPGRADING.md).

## [Unreleased]

<!-- add merged PRs here -->

### Fixed

- On a Gemini route, a call that asked for no thinking no longer thinks on Flash models. Small plugin calls that took minutes now take seconds. On Pro models, which cannot stop thinking, a call that turns thinking off now thinks at the lowest level.

## [v0.10.0] - 2026-10-06

> These changes are a broad effort to make the language more consistent and behave more predictably. With a tighter mental model, we get a handbook that's faster to grok and correct automations written faster - @Henry

Language version 3, **Steady Lynx**, arrives. New automations are written in it. The deploy check moves an existing automation up to it when it validates cleanly there. An automation that does not validate stays on its version until it is repaired and upgraded, and behaves exactly as before.

### Before you deploy (operators)

- New settings. All are optional, and a malformed value fails boot naming the variable (see "Automations" in `deploy/SELF_HOSTING.md`):
  - `MOVEMENT_MAX_RUN_COST_USD`: a cap in US dollars on what one run may spend on models and paid services. A run that reaches it **pauses** instead of failing, and stays paused until it is resumed. Unset means no cap. Setting one is encouraged, since nothing else stops a looping automation.
  - `MOVEMENT_MAX_CALL_DEPTH`: how deep one run's calls may nest (default 32). A run that would go deeper fails, naming the chain of calls. It exists because Steady Lynx (3) allows recursion.
  - `EXTRACTION_TIERS`: a JSON object choosing the model and effort behind each extraction tier (`quick`, `careful`, `thorough`). Unset, nothing changes. Boot refuses a model this deployment has no credentials for.
  - `WHATSAPP_LINK_VERIFICATION=trust`: links a user's WhatsApp number without sending a code. Only suitable for a self-host serving one organisation, since anyone with an account can then claim any number. The default, `otp`, is unchanged.
- The deploy applies one database migration, through the usual `migrate` step, with nothing to do by hand. It adds a run's pause state (`trigger_run.limit_pause`, `trigger_run.cost_cap_baseline_microdollars`) and lets a parked part of a run be parked at a limit (`parked_run.park_reason` gains `limit`).
- Building the web app from source on Render: add `packages/**` to the web service's `buildFilter` (see `deploy/guides/render.md`). Without it, a commit that only touches a shared package does not redeploy the web app's bundled checker.
- After deploying, check the automations list for the **Review** badge: those automations stayed on their older version.
- Paused runs are resumed with the Resume button on the runs page, the `resumeRun` connector tool, or `POST /v1/automation/automations/resume-run`. Resuming carries on from where the run stopped and resets its usage. A dry run, and a fired callback's body, still fail at the cap, since neither can be resumed.
- A new platform event, `Run Paused`, can be listened to (`listen to sys { events: ["Run Paused"] }`).
- Every run step now records what it spent (`costUsd`, `runCostUsd`, `costBySource`), whether or not a cap is set. Every bundled plugin is now priced, and Bright Data Web Unlocker fetches are charged at $1.50 per 1,000 requests.

### Changes to what a saved automation does (every language version)

These are bug fixes, so they apply to every language version rather than waiting for an upgrade. Each one changes what an existing automation does or whether it saves. Review automations that use these constructs. Full text: the [migration guide's appendix](docs/language/steady-lynx-migration.md#appendix-every-version-changes-in-full).

- In an `if` condition, `AND` now binds tighter than `OR`: `if a OR b AND c` means `a OR (b AND c)`. It used to run as `(a OR b) AND c`, unlike the same text anywhere else.
- An email listen without a `key` is refused at save (`MOV_LISTEN_BAD_CONFIG`), with the fix. It could never receive mail. Gmail listens are unaffected.
- An empty hop `WHERE` (`crm-[c:Companies WHERE ]->`) is refused at save and at run (`MOV_EXPR_PARSE`). It used to keep every record.
- A `WHERE` on the last hop of a `match` or `write` target now limits which records may be matched. It used to be ignored. A `write` whose candidates are all ruled out creates. Misplaced ones are refused (`MOV_TARGET_WHERE_NOT_FINAL`, `MOV_TARGET_WHERE_BIND`, `MOV_TARGET_WHERE_LOCAL`).
- A hop `WHERE` that reads through its alias (`c-[c:Companies WHERE c.Categories == "Customer"]->`) now runs. It used to fail every run. An unknown field read through the alias is now `MOV_UNKNOWN_PROPERTY`.
- A `unique by` test outside the key (`WITHIN`, `!=`, a range) is honoured when there are several `unique by` lines. It used to be dropped. A test that reads anything but the candidate's own fields, or a `unique by` line with no key, is `MOV_UNIQUE_CONJUNCT_NEEDS_WHERE`.
- Arms of `await parallel([…])` and `await race([…])` writing the same `unique by` key create the record once, not once per arm. Two arms calling the same movement are no longer refused as recursion. An arm that fails now fails the combinator only once the other arms have stopped.
- `return` always leaves its body, including after the run parks on it (`return await sleep(…)` used to carry on to the next statement).
- A run that parks inside a called movement now resumes in the right place, under versions 1 and 2 as well. Runs already parked resume as they would have.

### Language version 3, Steady Lynx: what breaks

Each item applies only to an automation on Steady Lynx (3). Versions 1 and 2 keep their old behaviour exactly (proved by a version 2 conformance corpus). The shared reason: each of these used to fail at run time, or do the wrong thing without a word, and is now refused at save. Every rule, with examples and rewrites, is in the [Steady Lynx migration guide](docs/language/steady-lynx-migration.md).

- **List literals are tuples.** `[m.Subject, file]` is `[text, file]`, and reads as a list of the members' union wherever a list is expected. Why: index reads off a mixed literal were unchecked, so text could be multiplied or written into a number list. New refusals: `MOV_ARITH_NON_NUMERIC`, `MOV_DICT_UNKNOWN_KEY`, `MOV_TRAVERSE_UNKNOWN_EDGE`, `MOV_WRITE_FIELD_TYPE`, and `MOV_LIST_MIXED` where a literal mixing records and values is read as a list.
- **Calls are checked.** A call resolves like a name: the movement's scopes, then the file and its imports, then the standard library. Why: built-in arguments were never checked (`UPPER(company)` wrote `[object Object]`) and a misspelt function failed only at run. New refusals:
  - `MOV_FUNCTION_UNKNOWN` for an unknown name (still accepted inside a write field).
  - `MOV_BUILTIN_ARG_TYPE` and `MOV_BUILTIN_ARGS` for wrong argument kinds or counts; `MOV_BUILTIN_UNUSED` for a value built-in on its own line.
  - Function names become case-insensitive. Two functions differing only by case, or one named like a built-in, are `MOV_FUNCTION_NAME_COLLISION`. Variable names keep their case.
  - `MOV_CALL_NESTED` for a call or collection op inside a walk's `WHERE`, `ORDER BY` or settings (block heads included), or inside `SORT`'s key, which are read once per member.
  - A built-in's result is now typed, so writing it into a field of the wrong type is `MOV_WRITE_FIELD_TYPE`.
- **Writes inside a function handed to `MAP` are checked.** Such a write is checked at save like the same write outside it. Why: a type reached only by walking from a record written inside the function was never described, so any field written to it was accepted.
- **`COALESCE` short-circuits.** It stops at the first present argument. Why: later arguments used to run anyway, and could call a model or fail the run.
- **Retired translation-graph forms**, each refused with its replacement. Why: none of them could run in a movement.
  - `-[t:#transform { plugin: … }]->` is `MOV_TRANSFORM_HOP_RETIRED`: import the plugin and call it.
  - `-[#linked WHERE …]->` is `MOV_LINKED_HOP_RETIRED`: keep the write's handle and read from it.
  - `@parent.created` and `@parent.external_id` are `MOV_PARENT_READ_RETIRED`: write the child off the parent write's handle.
  - `@resource.<field>` is `MOV_RESOURCE_READ_RETIRED`: use the bare field name inside a `_resources` filter.
  - These replace `MOV_META_FIELD_UNKNOWN`, and the `#linked` half of `MOV_RESOURCE_WALK_UNREAD`.
- **Silently dropped forms now refused:**
  - `JOIN` with a separator that is not literal text (`MOV_BUILTIN_ARGS`). It used to fall back to `", "`.
  - `IF … THEN … END` with no `ELSE` (`MOV_IF_WITHOUT_ELSE`). It used to give `""`.
  - `KG_EXISTS` / `KG_VALUE` with a query that is not literal text (`MOV_BUILTIN_ARGS`). It used to run an empty query.
  - Settings on a hop (`MOV_HOP_CONFIG_UNREAD`). No hop reads them.
  - A `_resources` walk that lost its root or earlier hops (`MOV_RESOURCE_WALK_UNREAD`).
  - `LLM_AGG(…)` (`MOV_BUILTIN_NOT_RUN`): join the members and call `AI(…)` instead.
- **Values that may be absent are tracked further.** A field read off `ONLY(…)`, `FIRST(…)` or `AT(…)` is `T | absent`. Writing one into a graph literal's required field is `MOV_ABSENT_REQUIRED`, and a shaped graph literal is checked again when built. Why: an extraction that found nothing produced a graph silently missing a required field.
- **Other reads now typed:**
  - `d.key` on a dict reads like `AT(d, "key")`, and an unknown key is `MOV_DICT_UNKNOWN_KEY`.
  - `await sleep(…)` is a boolean.
  - `await parallel` / `await race` results are a list of the arms' union.
  - Comparisons that relied on these being untyped may now be refused.
- **A value passed to a record parameter** is `MOV_CALL_ARG_TYPE` at save. Why: it always failed at run.
- **A wait that cannot be resumed** is `MOV_WAIT_NOT_RESUMABLE`: an `await`, or a call that awaits, inside a callback body or an `await until(…)` condition. Why: such a run parked where it could never be resumed.

### Language version 3, Steady Lynx: new

- `extract(content, Shape, { tier })` makes extraction a function returning a list of records. `extractOne(…)` returns the one record the content describes, or absent. The `extract … from` keyword is unchanged. Bad content, shape or settings are refused at save (`MOV_EXTRACT_CONTENT`, `MOV_EXTRACT_SHAPE_COMPUTED`, `MOV_EXTRACT_CONFIG`, `MOV_EXTRACT_CALL_NESTED`).
- Functions are called by position, as in TypeScript (`email_to_doc(msg)`). Named calls still work, but one call cannot mix them. Wrong argument counts are `MOV_CALL_ARITY`. Plugins stay named (`MOV_PLUGIN_ARGS_NAMED`).
- Calls nest inside any expression. They run left to right, and `IF`, `AND`, `OR` and `COALESCE` short-circuit. A call that may wait must be on its own line (`MOV_NESTED_CALL_SUSPENDS`).
- A field can be read off any call's result (`ONLY(extract(…)).name`).
- Closures can have an expression body (`(v) => v * 2`), and a closure bound to a name is called like any function. Binding the call of one that returns nothing is `MOV_CALL_RETURNS_NOTHING`.
- Parameters can take values (scalars, refinements, lists, object types such as `<{ mode: text, owner?: text }>`). A listener cannot fire such a movement (`MOV_LISTEN_PARAM_MISMATCH`).
- Functions may call themselves. A recursive function must declare its return type (`function fact(n: <number>): <number>`), or it is `MOV_RECURSIVE_RETURN_TYPE`. Any declared return type is checked (`MOV_RETURN_TYPE`).
- Narrowing as in TypeScript: an early `return`, and the left side of `AND` / `OR`, prove a value present for what follows.
- A function inside `MAP`, `FILTER`, `REDUCE`, `GROUPBY` or `KEYBY` may `await` (no longer `MOV_COLLECTION_OP_SUSPENDS`). Waiting members park on their own while the rest carry on.

### New in every language version

None of these change what an existing automation does, so no version moves.

- Graph literals build a local graph as a value: `graph<Shape> { … }` is checked like TypeScript's `satisfies`, and `graph { … }` takes its type from the literal. A walk or record entry holds a live reference, while a field body or `...r` takes a copy.
- Spreads: in lists (`[m.Body, ...m.Files]`, including a walk read for a field), in maps (`{ ...a, k: v }`), and of a record into a graph literal. A key written before a spread that always overwrites it is `MOV_MAP_KEY_OVERWRITTEN`.
- `MAP` and `FILTER` take settings: `onError` (`"error"` / `"warn"` / `"ignore"`), `concurrency`, and `initialConcurrency`. Members writing the same record take turns.
- `TEXT.SERIALISE(value, "JSON")` gives stable, sorted JSON text for prompts.
- Plugins can declare a price and report their cost per call.
- A bare walk works wherever a value goes (`COALESCE(c-[m:Messages]->, [])`). `first(…).Name` works in lower case. A hop `WHERE` works on an edge of a node the run built.
- Every expression is now read by one grammar. Meaning is unchanged apart from the fixes listed here.
- A built-in's declared effects (reading files, reading the knowledge graph) now show in a movement's effects under every version.

### Authoring agents and the automations connector

- New tool `getStarted`: in one call, it returns the handbook's front page, the team, and a digest of the team's systems.
- `readHandbook` serves a one-page front page instead of the book's index. A request for a whole hand-written chapter now points to the new `searchLanguage` tool. Why: in the authoring eval the front page plus search built 9 of 10 tasks correctly, against 5 of 10 with whole chapters, at lower cost. In-app agents and the Library page still read whole chapters.
- `describeConnection` answers compact text by default. Pass `detail: "full"` for the old JSON. Why: the JSON was the largest token cost of a build.
- `saveAutomation` and `editAutomation` validate first and save nothing while there are errors, answering `{ ok: false, saved: false, diagnostics }`. They used to save and answer `needsConfirmation`. `acknowledgeErrors: true` still saves with the user's consent. A clean save passes warnings along as `diagnostics`. Clients that branch on `needsConfirmation` need updating.
- The commonest save errors carry a machine-applicable `fix` (line, column and text) and a pointer to the handbook section that shows it.
- The connector's `initialize` instructions are now reference only. The builder skill asks the user every open decision that has a visible side effect before saving.
- The handbook teaches only the recommended forms. Older spellings still run.

### Developer tooling

- A version 2 conformance corpus: `pnpm --filter movement-lang test:conformance:v2`, and `pnpm test:conformance:v2` in apps/api.
- The authoring eval (`pnpm dev:automation-eval`) leads with time and tokens per trial.
- The fake Gmail understands `category:` searches.

### Fixed

- Waiting and resuming:
  - `x = await sleep(…)` binds `true` after waking. It used to bind null.
  - Files bound before a park can be read after resuming. An extraction used to silently lose the attachment. An unreadable file now warns (`MOVENG_FILE_BYTES_UNAVAILABLE`).
  - A node held in two places stays one node across a park, and nodes linked in a cycle can park. Cycles used to overflow the stack.
  - A block or `await parallel` that parked partway keeps the finished iterations' and arms' results.
- `MAP` over an edge of a run-built node holding a system's records reads their fields. It used to read empty fields.
- Run traces for `extract(…)` and `extractOne(…)` show the records found and what the model answered, matching the keyword.
- The cost pause message shows a small cap as set (`$0.016`, not `$0.02`).
- Expression parsing:
  - `IF a AND b THEN … END` is accepted inside an `if` condition.
  - `${…}` and a nested `EXISTS(…)` inside an `EXISTS` walk's `WHERE` are evaluated. They used to match nothing.
  - `IF(cond, a, b)` is refused with the correct spelling.
- Refused at save instead of failing at run:
  - `TEXT.SERIALISE` of an unread `lazy` edge (`MOV_STDLIB_ARG_LAZY_EDGE`).
  - An extraction shape with a field and a child node of the same name (`MOV_EXTRACT_FIELD_DUPLICATE`).
- A library file that does not parse names its position once, not twice (`MOV_IMPORT_FILE_INVALID`).
- An inbound email's `Body` strips HTML that arrived in the plain-text part.
- WhatsApp:
  - Webhook signature failures (missing, or not verifying against `WHATSAPP_WEBHOOK_SECRET`) log a `warn` with the cause.
  - Payloads containing a slash verify. They used to be refused with a 401.
- Portfolio:
  - A payout through an SPV reaches the SPV's cheque.
  - Payouts on holdings that share no unit are split by cash invested.
  - The Edit company dialog's Save button works again.
- A connector client closing its event stream no longer logs an unhandled rejection.

## [v0.9.1] - 2026-09-29

### Fixed

- A path inside `EXISTS(…)` now narrows like the same path heading a block. `` EXISTS(crm-[o:Organization WHERE …]->-[le:`List Entries` WHERE `listName` == "Master Deals List" AND `Deal Created` >= cutoff]->) `` validates, and at run time it considers only that list's entries. Before, the checker refused `Deal Created` (`… has no field 'Deal Created' — it has: listName`), or said nothing described the landing, because the path inside `EXISTS` was never narrowed. This applies to an `EXISTS` rooted at a system or at a block alias, in an assignment, an `IF … THEN` or an `if` condition. Paths inside `COUNT`, `FIRST`, `ONLY` and the other aggregates already narrowed. The language version does not change. The one new refusal is one a block already gave: a field or edge the named member does not have, read later in the same `EXISTS` path.
- A field a node declaration types as `<text>` refuses a number or a yes/no, wherever the value arrives: a `node { … }` handed to a parameter typed on the declaration, a write into a collecting node's `<Entry>` entries, and a spread into one. The refusal names the repair: `TOSTRING(…)` for a number, `IF … THEN "Yes" ELSE "No" END` for a yes/no. Before, `COALESCE(e.diverse, FALSE)` typed as nothing, so `node { diverse: COALESCE(e.diverse, FALSE) }` reached a `<text>` field unchecked and the system received the text `true` or `false`. `COALESCE` now types as the kind its arguments share (`a ?? b`), and a bare `TRUE`/`FALSE` in a write field is a boolean. A system's own text field keeps the lenient write rule. This applies under every language version rather than behind a version gate: no author meant `"true"` in a text field. The one language version 1 corpus test this reaches is triaged: it used `COALESCE` as its stand-in for a call the checker cannot type.
- `<T | null>` on a node declaration field is `T | absent` wherever the declaration is used: an extraction's shape, a parameter's type, a collecting node's entries, a spread, `IS`. Before, it counted only as an extraction's shape. A collecting node filled with `?...e` holds an unfound field null at run time, yet the checker typed it present and noted `x.via != null` as always true. Now `x.via != null` is a real test and narrows the field, as it already did on an extracted record, and a system's optional field narrows the same way. A plain write of such a field into a system's field is refused until it is guarded or written with `?:` (`?...d` for a spread). A plain write into another `<T | null>` field is accepted. This applies under every language version rather than behind a version gate: the refused writes were handing a system a null where it expected a value.

## [v0.9.0] - 2026-09-29

Language version stays **Bright Otter** (2): everything here is an addition or a refusal that became an acceptance, so no saved automation changes behaviour. Highlights: `node X extends Y`, `%`, `TEXT.PAIRS`, a scheme-less `URL.HOST`, a parameter typed on a declaration accepts any record with its fields, and the editor renders multi-line strings as one block.

### Added

- `%` remainder in the formula grammar (`a % b`), same precedence as `*` and `/`, TypeScript semantics — the sign follows the dividend (`-7 % 20` is `-7`).
- `URL.HOST` accepts a scheme-less address (`acme.com`, `acme.com:8080`, `www.Acme.com/path`), not just a full URL — an email is still not a host.
- `TEXT.PAIRS(record, separator?)` renders a record or dict as `key=value` pairs joined by `separator` (default `" | "`); nested node/edge fields are skipped.

### Changed
- The handbook now says what the checker and engine already do with a value that may be missing, such as an extracted `<boolean>` or `<text | null>` field. `==` and `!=` take one on either side with no guard: a missing value equals only `null`, so `o.stage == "Seed"` is false and `!=` is true. `if`, `IF … THEN`, `AND`, `OR` and `NOT` read a missing boolean as false, so `if o.viable { … }` needs no `COALESCE`. Ordered comparisons (`<`, `<=`, `>`, `>=`) still refuse one. Before, the reference chapter said every comparison other than `== null` needed both sides present. Nothing a movement does changes, under either language version. A `WHERE` done at a source may treat a record missing the tested field differently from one done here; the query section says so.
### Added

- `node X extends Y { … }` declares a node that is every field and nested node of `Y` (with `Y`'s types, words and `order by`), then its own, like TypeScript's `interface X extends Y`. `X` goes anywhere a declaration does: an extraction's shape, a parameter's type, a collecting node's type, `IS`, a spread, `export`. Its own record-level words follow the base: `node X extends Y: "…" { … }`. The base is a node declaration in scope, declared in the file or imported, and its words and types still read the file that declared it. Refused, by name: restating a field or nested node `Y` already has, a base that is not a node declaration, and a chain that comes back round. New syntax, so no language version changes.
- A parameter typed on a node declaration (`d: <Entry>`) accepts any record carrying every field the declaration names, with a compatible type: an extracted record, a record of another declaration (an identical one, or one that `extends` it), a record built with `node { … }`, or a system's record. This is the same comparison `x IS <Entry>` makes: extra fields are fine, and a nested node never decides the fit. Before, a record that arrived typed was accepted only when it named the same declaration, so an extracted `<Entry>` record was refused by an `<Entry>` parameter. A record that does not fit is refused with a message naming the missing or mistyped field. Only refusals became acceptances, so no language version changes.

## [v0.8.5] - 2026-09-29

### Added

- The company page warns when two prices apply to the same equity on the same day, and says which one the valuation uses.
- A company acquired for shares shows the position on the acquirer's page: shares received, cost carried over, value now. Fund totals are unchanged.

### Changed

- The portfolio list loads several times faster on a large portfolio. The valuation walk and the pricing ask the database once for every company at a level instead of once per company, the list returns its totals itself instead of valuing the portfolio a second time, the "How this was calculated" panel fetches its narration when opened instead of shipping it with every row, and API responses over a kilobyte are compressed (brotli or gzip, whichever the client accepts). Every figure on the list is unchanged. Where a company has a price recorded on itself and one on its equity on the same day, the valuation now always uses the price on the company; before, which one it used could vary between loads. The company page still warns about such a pair, since only one of them can be right.

### Fixed

- A payout to a fund holding several cheques in one company is split between them by the shares each cheque held just before the event. Before, a wind-down recorded as a share return and a cash payment on the same day, or a later distribution with nothing left held, could land wholly on one cheque. Transactions on the same day are now walked in a fixed order, so a cheque's figures no longer depend on what else is on the page.
- A company created through the REST API gets a slug, so it is reachable in the app. Before, only companies created by the seed script had one.

### Changed

- An `ORDER BY` that asks for the order a source already answers in is now done at the source: no "runs here, not at the source" note, and its `LIMIT` bounds the fetch. Gmail's `Messages` answer newest first, so `ORDER BY Date DESC LIMIT 3` now costs three message requests instead of a hundred; `ORDER BY Date ASC` still fetches up to the ceiling and sorts here. Adapters declare this as a collection's natural order (`naturalOrder` on the edge capability); Gmail's `Messages` and a Slack channel's `Messages` (`Timestamp` newest first) declare one.

## [v0.8.4] - 2026-09-29

### Fixed

- The upgrade warning that an identity key may be `""` now clears where a guard proves it is not: inside `if x != "" { … }`, `if LENGTH(x) > 0 { … }` or a conjunction containing one, and below `if x == "" { ERROR(…) }`. Before, the guard the warning itself suggested did not clear it.

## [v0.8.3] - 2026-09-29

### Added

- `NUMBER.FORMAT(number, "compact" | "grouped")` writes a number out — `"compact"` abbreviates with K/M/B/T (`1200000` → `"1.2M"`), `"grouped"` adds thousands separators (`1200000` → `"1,200,000"`). `CURRENCY.FORMAT_FIGURE(number, code)`, the inverse of `CURRENCY.GET_NUMBER_FROM_FIGURE`, writes a money figure with its symbol (`"€1.2M"`) or, for a code with none, the ISO code after the amount (`"1.2M CHF"`).

### Fixed
- A walk from a record held in a name now runs: `EXISTS(company-[:Notes WHERE …]->)`, `COUNT(…)`, `ONLY(…)` and hopped reads off a `FIRST(…)` result, a `match` result, a write handle or a block's returned records. These previously saved cleanly and then failed every run with MOVENG_UNSUPPORTED; `x = match …` / `x = link …` and a call spelled `x = plugin(…)` at file scope are now refused at save instead of at run.
- `!` is negation; it used to be dropped silently, so a condition written with it ran inverted. `!x` is `NOT x` (same precedence, so `!a == b` is `NOT (a == b)`), `!!x` is double negation, and `!=` is unchanged. This applies under every language version rather than behind a version gate: a saved automation that wrote `if !EXISTS(…)` was running the opposite of what it said, and now runs what it says.
- A character an expression has no meaning for (`&`, `&&`, `|`, `||`, `?`, `;`, `%`, a backslash outside a string, an en or em dash, a curly quote, …) is refused at save with its position, instead of being skipped. `&&` and `||` point at `AND` and `OR`; a typographic dash points at `-`.
- A source-built deployment names its release `dev+<short commit>` when the host supplies the commit (`RENDER_GIT_COMMIT`, `SOURCE_COMMIT`), so the deploy check runs once per deployed commit instead of once ever under a fixed `dev`; the health endpoint reports the same name.

## [v0.8.2] - 2026-09-29

### Added

- An extraction field, inline or in a node declaration, may be annotated `<text | null>`. A text the model did not find then arrives null instead of `""`, so `EXISTS(…)`, `!= null` and a guard clause test it and narrow it, and a plain write of it needs `?:` or a guard. The prompt is unchanged. `| null` on any other type (`<number | null>`, `<Thesis | null>`) means what the type already meant. It is accepted under every language version. `<null>` alone, a second `|`, and `| null` anywhere other than a field annotation are refused. The refusal of a null test on plain extracted text now names this annotation as the first fix.

### Fixed

- On Render the pre-deploy is one package script, `pnpm deploy:render-pre`; the previous two-command line was not run through a shell, so the deploy check never ran. Set the service's pre-deploy command to the new script. The expanded database URL also stops appearing in the deploy log.
- The audit-trigger check (CI's "Missing audit log triggers" step) was red since v0.8.0: the two tables it added, `automations.system_event` and `automations.deploy_check`, are system-written and only ever inserted, the same shape as `trigger_event` / `trigger_run`, so they now carry that same exemption instead of a needless audit trigger. No migration; `check_database_triggers.sh` also now prints which tables it flags.

## [v0.8.1] - 2026-09-29

### Changed

- The automations list's column is **Version**, and the version name renders as a monospace tag on the list and the automation page.

### Fixed

- The `migrate` one-shot carries every variable the api derives (the OAuth redirect origin among them), so the deploy check it runs can load. On v0.8.0 a missing one crashed the check and blocked the api from starting after the upgrade.
- Two integration tests: a saved run version is written with its language version; an automation source spells `Invocation` as the manual adapter does.

- The deploy check no longer keeps an automation on its older language version over a routine cost note (`WHERE on '…' runs here, not at the source`, `ORDER BY on '…' runs here`). An automation now moves up when the newer version reports no errors and nothing whose meaning changed between the versions; other warnings are printed as notes in the summary and never block. Only what blocks is stored, so the **Review** badge and `upgradeDiagnostics` mean there is something to look at. `upgradeAutomation` applies the same rule.
- `up.sh` never exits silently. When `docker compose up` fails it names the failed service, prints its log (the whole run for a one-shot such as `migrate`, the last 30 lines otherwise), and says which version the installation is still on, pointing at `deploy/UPGRADING.md`, Rolling back. It also no longer dies without a word on a machine where nothing is running yet.

## [v0.8.0] - 2026-09-29

Language versions arrive. Every automation is pinned to the language version it was written against and keeps that behaviour on every later release; a breaking change is delivered behind a version conditional and reaches an automation only when it is upgraded. Version 1 is **Quiet Heron**, the language as of v0.6.0. Version 2 is **Bright Otter**, the language as of v0.7.0 and after. Every automation saved before this release is pinned to Quiet Heron, so the v0.7.0 breaking changes below no longer apply to it until it is upgraded.

### Added

- Each automation carries a language version (name and number). `listAutomations` / `getAutomation` return `languageVersion`, `checkedAgainst` and, when an upgrade would not be clean, `upgradeDiagnostics`. The automations list shows the version with a **Review** badge when there is something to look at; the automation page lists the diagnostics.
- The deploy check: on every release the `migrate` step (Render: the pre-deploy command) re-validates every automation under its own version, then under the current one. A clean result moves the automation forward; anything else keeps it where it is and records why. `up.sh` prints the summary (advanced / to review / refused, by name); `pnpm deploy:check --summary` prints it again.
- `upgradeAutomation { automation, acknowledge }` (MCP): validates under the current version, returns the diagnostics, and moves the pin only on an acknowledged clean result. The editor and `validateAutomation` check a saved automation under its own version.
- An automation on a version a release no longer supports is refused to run, loudly, and named in the summary; on a deprecated version it runs with a warning.
- A `system` adapter, the platform as a system: `listen to sys { events: ["Run Failed"] }` fires when an automation's run fails; `Validation Issue`, `Deprecated Version` and `Release Applied` fire from the deploy check. Records carry the automation, the run, the version, the reason and a link; an automation never receives its own failure.
- A version-1 conformance corpus: the v0.6.0 test suites run against the current code under Quiet Heron (`pnpm --filter movement-lang test:conformance:v1`, `pnpm test:conformance:v1` in apps/api). Removing a version is deleting its conditionals and its corpus.
- Under an upgrade check only, two new warnings mark constructs whose meaning changed between versions: a direct plugin call whose output changed shape, and a `unique by` key that may be empty text.
- The agent dev loop (`pnpm dev:loop:agent`) runs its own Postgres and Redis (project `listen-fire-dev-agent`, ports 9434 and 6381) so it coexists with another stack on the shared ports.

### Changed

- The v0.7.0 breaking changes are now conditional on Bright Otter. Why each was made: `vc_url_retrieval` as a list — one string of all pages hid which page a fact came from, and a list lets `FIRST` and `_resources` keep the file; extracted text always present — every description already promised "empty otherwise", and `COALESCE` on every read was the cost of the type disagreeing; null tests on extracted text refused — with text always present they were always true, a silent bug; annotation required into typed fields — an unannotated field asks the model for words, and a number field given words failed at the adapter instead of at save; unknown type names refused — a typo silently became text with no option set; empty key is no key — an empty name matched every other empty name, merging unrelated records.


## [v0.7.0] - 2026-09-28

### Breaking

- `vc_url_retrieval` called on its own returns a list of records, one per fetched link (`name`, `url`, `file`, `text`), instead of one string of all the page text. Hold one first, then read its fields: `deck = FIRST(linked)`, then `deck.text`.
- A null test (`EXISTS`, `ISNULL`, `== null`, `!= null`) on an extracted text field is refused. Extracted text is always present — `""` when nothing was found — so test emptiness with `!= ""` instead.
- An extracted field written into a `number`, `date`, `boolean` or file field is refused until the field is annotated with that type.
- An unknown type name on a declared node's field is refused; it used to read silently as text.
- An empty `unique by` key component is treated as no key, and never matches.

### Added

- `match`: finds a record by identity without writing it. Same body and targets as `write` (`unique by` clauses plus asserted fields). A hit binds the record; a miss ends the enclosing scope quietly; used unbound it is a gate.
- `link` takes a match body as sugar for `match` then `link`; a body with no `unique by` identifies by all its fields.
- `FUZZY` is declared per field. The checker refuses `FUZZY` on a field the target does not list, and names the fields it does.
- Valuations Legal Entity resolves `unique by` by identity, with fuzzy matching on Name, Legal Name, Also Known As and Other Names.
- Files a `through` plugin fetched land on the extracted record's `_resources`, so the usual attach pattern puts them on any record with a file field.
- A record held in a variable (`deck = FIRST(pages)`) reads by field.
- `labels` listen option on a Gmail listener (default `["INBOX"]`) watches labels beyond the inbox, e.g. `["INBOX", "SPAM"]`.
- A node declaration can describe itself, each field and each nested node, and an extraction reuses it with `node entry: <Entry>` instead of repeating the shape inline.
- A write body can spread a record with `...e` / `?...e` — an extracted record, a declared parameter, or a record built in memory — writing each of its fields as a plain line.
- A dict literal is typed by its keys: `AT(d, "k")` on a key the literal wrote down reads that key's own type, present; an unknown key is refused with a did-you-mean.
- `AT(list, n)` reads a list by position. Like `FIRST`, it needs an ordered list and may miss.
- A `MAP` closure may run with no `return`, for its writes alone; a bare `MAP(...)` (and `FILTER`/`REDUCE`/`GROUPBY`/`KEYBY`) can run as a statement with no binding.
- `URL.HOST(text)` reads the lowercased host out of a link.
- Unary minus (`-x`) in formulas.
- A guard (`EXISTS(x.f)`, `x.f != null`, `NOT ISNULL(x.f)`) narrows a typed extracted field to present inside its arm.
- A field refused on a narrowable type (a hop landing on more than one member of a polymorphic type) names the narrowing test that admits it.
- The editor tints strings, so a multi-line prompt reads as text.

### Changed

- The handbook looks a single record up with `ONLY` and a guard (`x = ONLY(…)` then `if x == null { ERROR("…") }`) wherever one record is expected; a nested hop is for fanning out over many. Examples across the chapters and adapter sections follow it.
- The Bright Data SERP provider waits up to 90 s per request and retries a 429, a 5xx (including one reported only in `x-brd-status-code`), a timeout or an empty body, up to three attempts.
- A refusal from Google Custom Search is logged with its reason and fails the search, instead of reading as "no results".
- Website identity ignores scheme, `www.`, trailing slash and case.
- A Gmail poll reads every history page and holds an arrival the search has not indexed yet for 15 minutes, instead of dropping it.
- An imported declaration's refinements resolve in the library that declared it, instead of the importing file's own types.

### Fixed

- A PDF reached through a link is read from its own text layer before OCR, and is kept (with empty text and a warning) when no text can be read; it was sent straight to OCR and dropped when OCR was not configured. Any fetched document with no readable text is now kept rather than discarded.
- A write whose identity candidates were filtered could bind or update the wrong record.
- A valuations write with `unique by` created a new row every time instead of finding the existing one.
- `?:` on a valuations record now sees an existing value; a create no longer sends explicit nulls.
- An awaited `WHERE` stops at its first false condition, instead of reading every field it names off a candidate that already failed an earlier one.
- An extracted text field that finds nothing arrives as `""` instead of absent.

### Operator notes

- A deploy applies migration `20260928_123442_legal_entity_name_trigram.sql` (trigram indexes on legal entity names).
- Google has closed the Custom Search JSON API to new customers. New installations should set `WEB_SEARCH_PROVIDER=brightdata` with `BRIGHT_DATA_ACCESS_TOKEN` and `BRIGHT_DATA_SERP_ZONE`.

## [v0.6.2] - 2026-09-25

### Added

- Each run shows its model cost in the run history and the run detail, and on the MCP tools `listRuns`, `checkRun` and `inspectRun`.

## [v0.6.1] - 2026-09-25

### Changed

- `up.sh` refuses to start when the image store's disk has too little free space (`--no-space-check` skips this), and prunes older images after a healthy start, keeping one rollback tag in `LISTEN_FIRE_PREVIOUS_VERSION` (`--keep-images` skips this).
- The boot warning about a missing model key follows `MODEL_MAP`, so a deployment served entirely through a mapped provider is no longer warned.

## [v0.6.0] - 2026-09-25

### Breaking

- `MODEL_MAP` replaces `MODEL_ROUTE`, `ANTHROPIC_MODEL_ROUTE`, `OPENAI_MODEL_ROUTE` and `KNOWLEDGE_AGENT_PROVIDER`, which are no longer read. The map is a JSON object from a model name the product uses to `provider/wire-model`, with provider `anthropic`, `vertex`, `openai` or `gemini`. A deployment that set `MODEL_ROUTE=google` needs one of the Google maps in [`deploy/SELF_HOSTING.md`](deploy/SELF_HOSTING.md) before upgrading. Boot refuses a map it cannot serve.
- With no map set, the system, movement and ontology agents run on Claude (`claude-sonnet-5`) instead of GPT. Map `claude-sonnet-5` to `openai/gpt-5` to keep them on GPT.
- Image generation uses `gpt-image-1` on OpenAI (DALL-E 3 was shut down). Map `gpt-image-1` to a Gemini image model to keep Gemini images; a map naming `dall-e-3` is refused.
- `OPENAI_API_KEY` alone no longer powers the agents; every chat call names a Claude model, so it needs a map sending those names to `openai`.
- A team's own model key is no longer used; every call uses the deployment's credentials.

### Added

- Gemini as a native chat provider, and transcription, embeddings and image generation routed through the same map.
- Research running on `openai` or `gemini` answers its searches through the deployment's own web search service.
- `GEMINI_BASE_URL` points Gemini calls at a stand-in service, for testing.
- Prices for Fable 5.1, Opus 4.6, undated Haiku 4.5 and `gpt-image-1`.

### Fixed

- Sonnet 5 is priced at $2/$10 per million tokens; dated Haiku 4.5 is priced as Haiku 4.5.
- Gemini image generation is addressed in `GOOGLE_MODEL_REGION`, not the OCR location.

### Operator notes

- A deploy applies migration `20260924_212525_llm_usage_preferred_model.sql`. Usage rows name the provider that served each call, the wire model, and the model name the product asked for.
- Moving an embedding model to another vendor means re-embedding stored vectors; boot refuses an embedding model narrower than its column.

## [v0.5.0] - 2026-09-24

### Added

- A Gmail mailbox is connected by signing in as it. `GMAIL_CONNECT_METHOD` is `oauth` (the default) or `delegated`. The sign-in uses the Sheets and Drive OAuth client unless `GMAIL_OAUTH_CLIENT_ID` and `GMAIL_OAUTH_CLIENT_SECRET` are set.
- The Gmail connect form also accepts a pasted refresh token.
- `GMAIL_SEND_ENABLED=true` makes the sign-in ask for the send scope; without it, a signed-in mailbox is read-only.
- A team manages its own members from settings: grant and revoke access, add people directly, create service accounts, and edit the team's name, email and phone.

### Changed

- `GMAIL_MAILBOX_ALLOWLIST` is optional under `oauth`. It is still enforced when set, and still required under `delegated`.
- The dashboard is the landing page and settings sit inside the app shell. The separate onboarding flow is gone.

### Operator notes

- Existing delegated mailboxes keep working unchanged. Set `GMAIL_CONNECT_METHOD=delegated` to keep offering the delegated form for new connections.
- To use sign-in, add `<web origin>/gmail/callback` to the OAuth client's redirect URIs and list `gmail.readonly` (plus `gmail.send` if sending) on its consent screen. An Internal consent screen avoids Google's restricted-scope review.

## [v0.4.0] - 2026-09-24

### Breaking

- The Gmail connector refuses every mailbox not listed in `GMAIL_MAILBOX_ALLOWLIST` (comma separated, case insensitive). Installations already using Gmail must set it before upgrading, or their mailbox stops working.

### Added

- `ANTHROPIC_MODEL_ROUTE` and `OPENAI_MODEL_ROUTE` route each vendor separately (`direct` or `google`), overriding `MODEL_ROUTE`.
- `OPENAI_ORGANIZATION` sets the OpenAI organisation; unset, OpenAI bills the key's default organisation.

### Changed

- The Gmail send scope is optional: a read-only mailbox runs on arrival and can be searched, and a send says it lacks the scope.
- The in-app Gmail credential form checks the mailbox with Google before saving.

## [v0.3.0] - 2026-09-22

### Breaking

- The per-user Gmail sign-in is removed, with `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET`. Credentials from it no longer work; connect the mailbox again through the new connector.

### Added

- `gmail` adapter: one mailbox per connection, reached through Google domain wide delegation. Automations can run when mail arrives (polled about once a minute), search it with `where`, read attachments, and send or reply as it. A write along the mailbox's `Messages` edge sends new mail; one along a message's `Replies` edge replies.

## [v0.2.0] - 2026-09-21

### Added

- `READ(file)` returns a file's text. `CHUNKS(text, { size, overlap })` or `CHUNKS(text, { entities })` cuts a text into pieces.
- A plugin can be called on its own (`page = fetch_url(url: c.website)`); every bundled plugin declares what it returns, so the result is typed.
- A `write` into a local node builds or merges by identity, like a write into a system.
- `order by arrival`, `document` or `chronological` on a local node's entry, or after a nested declared node, keeps its order for `FIRST`, `JOIN` and `LIMIT`.
- Records are values: lists and maps can hold them, and `MAP` returns what its closure returns.
- A block can start from a list of records or from an expression that ends in one (`AT(rows, 0)-[c:company]-> { … }`).
- `research` plugin: web research on a record, resolving one that arrived with only a name.
- `dealroom` adapter: read-only companies, investors, people and funding rounds.
- Web search through Bright Data's SERP API (`WEB_SEARCH_PROVIDER=brightdata`), and a page reader of the product's own where the model host has none.
- `MODEL_ROUTE=google` sends every model call through one Google Cloud project and service account.
- An optional external judge for duplicate detection (`JEV_KEY` with `JEV_ENTITY_RESOLUTION=true`).
- Born-digital PDFs are read from their text layer without an OCR service.
- Handbook: reading and chunking files, local node writes, and enrichment as plain plugin calls followed by a second extraction.

### Changed

- A lone fuzzy duplicate candidate goes to the judge; a fuzzy value equal outright is an exact match; a bare domain name no longer matches every other domain.
- An extraction's output ceiling follows its effort; a turn that runs out steps down once, then fails with a clear error. A continued answer shows as a warning on the run.
- A narrowed polymorphic hop lands only the member it narrowed to.
- Affinity requests are cached per run.
- The checker flags a field declared twice in one extract stage, a closure in an expression slot, and a hop off a value.

### Fixed

- `${…}` in an extract field or node description is interpolated.
- Scheduled runs run as their team, so fetches inside them work.
- A file or page a run could not read says so on the run.
- One large source file can no longer crowd the rest out of an extraction prompt.
- The valuations MCP connector lists its tools again.

### Operator notes

- A deploy applies migration `001_add_dealroom_external_service_type.sql`.
- New optional settings: `MODEL_ROUTE`, `GOOGLE_MODEL_REGION`, `KNOWLEDGE_AGENT_PROVIDER`, `WEB_SEARCH_PROVIDER`, `BRIGHT_DATA_ACCESS_TOKEN`, `BRIGHT_DATA_SERP_ZONE`, `BRIGHT_DATA_UNLOCKER_ZONE`, `EXTRACTION_FILE_CHARS`, `MAX_PDF_BUFFER_BYTES`, `JEV_KEY`, `JEV_ENTITY_RESOLUTION`.
- With `MODEL_ROUTE=google`, boot refuses a leftover vendor model key.

## [v0.1.2] - 2026-09-10

### Changed

- The bundled Postgres and Redis restart with the machine.
- `up.sh` supplies base URLs and ports as defaults that `.env` overrides; `LISTEN_FIRE_BIND` binds to one address, for installations behind a reverse proxy.
- A missing model key warns at boot instead of refusing to start.
- The published web image shows the Google and Microsoft sign-in buttons without a rebuild; client ids come from the api at runtime.
- A magic link has one expiry, and an expired link says so. A core installation prints its first sign-in link.

## [v0.1.1] - 2026-09-10

### Fixed

- Each migration applies in one transaction with its ledger row, so a failure leaves nothing half built. The runner creates the `agent` and `readonly` database roles itself when it may, and otherwise stops and names the file to run.

## [v0.1.0] - 2026-09-09

### Added

- First public release: five units (`core`, `knowledge`, `automations`, `valuations`, `asks`), the movement language and its handbook, and the adapters listed in the README.
- Tagged releases publish `api`, `web`, `admin` and `fake-channels` images to `ghcr.io/listen-fire` for amd64 and arm64.
- `LISTEN_FIRE_VERSION` pins an installation to a tag; `up.sh --build` builds from source instead.
- Each bundled datastore steps aside when an external one is configured.
- The running version shows at `/healthz/workers` and under Settings, About.
- Self-hosting guides for compose, Render, AWS and a GCP VM, and an upgrade runbook.

[Unreleased]: https://github.com/listen-fire/listen-fire/compare/v0.10.0...HEAD
[v0.10.0]: https://github.com/listen-fire/listen-fire/compare/v0.9.1...v0.10.0
[v0.9.1]: https://github.com/listen-fire/listen-fire/compare/v0.9.0...v0.9.1
[v0.9.0]: https://github.com/listen-fire/listen-fire/compare/v0.8.5...v0.9.0
[v0.8.5]: https://github.com/listen-fire/listen-fire/compare/v0.8.4...v0.8.5
[v0.8.4]: https://github.com/listen-fire/listen-fire/compare/v0.8.3...v0.8.4
[v0.8.3]: https://github.com/listen-fire/listen-fire/compare/v0.8.2...v0.8.3
[v0.8.2]: https://github.com/listen-fire/listen-fire/compare/v0.8.1...v0.8.2
[v0.8.1]: https://github.com/listen-fire/listen-fire/compare/v0.8.0...v0.8.1
[v0.8.0]: https://github.com/listen-fire/listen-fire/compare/v0.7.0...v0.8.0
[v0.7.0]: https://github.com/listen-fire/listen-fire/compare/v0.6.2...v0.7.0
[v0.6.2]: https://github.com/listen-fire/listen-fire/compare/v0.6.1...v0.6.2
[v0.6.1]: https://github.com/listen-fire/listen-fire/compare/v0.6.0...v0.6.1
[v0.6.0]: https://github.com/listen-fire/listen-fire/compare/v0.5.0...v0.6.0
[v0.5.0]: https://github.com/listen-fire/listen-fire/compare/v0.4.0...v0.5.0
[v0.4.0]: https://github.com/listen-fire/listen-fire/compare/v0.3.0...v0.4.0
[v0.3.0]: https://github.com/listen-fire/listen-fire/compare/v0.2.0...v0.3.0
[v0.2.0]: https://github.com/listen-fire/listen-fire/compare/v0.1.2...v0.2.0
[v0.1.2]: https://github.com/listen-fire/listen-fire/compare/v0.1.1...v0.1.2
[v0.1.1]: https://github.com/listen-fire/listen-fire/compare/v0.1.0...v0.1.1
[v0.1.0]: https://github.com/listen-fire/listen-fire/releases/tag/v0.1.0
