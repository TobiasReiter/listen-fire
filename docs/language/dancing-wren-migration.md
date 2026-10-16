# Migrating to Dancing Wren (5)

Language version 5, **Dancing Wren**, follows Luminous Owl (4). The [changelog entry](../../CHANGELOG.md) lists each change in a line; this guide carries the full detail. Every rule here that says "under Dancing Wren (5)" applies only to an automation pinned to version 5. Quiet Heron (1), Bright Otter (2), Steady Lynx (3) and Luminous Owl (4) keep their old behaviour exactly (proved by the version 4 conformance corpus).

Section 2 respells the whole surface; nothing in it changes what a program means. The four changes after it share one idea: there is no engine-side store and there are no meta edges. Everything a movement reads or writes is an edge or a record that a system declares, and a plugin is a function.

## Contents

- [1. How the pin moves](#1-how-the-pin-moves)
- [2. The everyday spelling](#2-the-everyday-spelling)
- [3. `write … bind` is retired](#3-write--bind-is-retired)
- [4. `#` hops are retired; a plugin is a function](#4--hops-are-retired-a-plugin-is-a-function)
- [5. `delete` only where the system declares it](#5-delete-only-where-the-system-declares-it)
- [6. `_resources` only on an extraction's result](#6-_resources-only-on-an-extractions-result)
- [7. A file is never joined into text](#7-a-file-is-never-joined-into-text)
- [8. A declared return takes what the body may return](#8-a-declared-return-takes-what-the-body-may-return)
- [9. A value that may be a record is no record parameter](#9-a-value-that-may-be-a-record-is-no-record-parameter)
- [10. A record a combinator arm hands back reads as itself](#10-a-record-a-combinator-arm-hands-back-reads-as-itself)
- [11. A write handle's unsent file is not a file](#11-a-write-handles-unsent-file-is-not-a-file)
- [12. A closure is not data](#12-a-closure-is-not-data)
- [13. A value that is a closure is called](#13-a-value-that-is-a-closure-is-called)
- [14. A closure's type is written `<(params) => <return>>`](#14-a-closures-type-is-written-params--return)
- [15. `parallel` is retired for `all`; combinators take arguments and no `await`](#15-parallel-is-retired-for-all-combinators-take-arguments-and-no-await)
- [16. The extraction keyword is retired](#16-the-extraction-keyword-is-retired)
- [17. Diagnostic code index](#17-diagnostic-code-index)

## 1. How the pin moves

- A new automation is written in Dancing Wren (5). The deploy check moves an existing automation up to it when it validates cleanly there.
- Every change below is a refusal under version 5, not a move-up warning: an automation that uses a retired form has an error under 5, so its pin cannot move. It stays on its version, shows **Review**, lists the diagnostics, and runs exactly as before. Rewrite each form as below, then upgrade (`lf upgrade`, or `upgradeAutomation` through the API). The respellings of [section 2](#2-the-everyday-spelling) carry their rewrite, so the upgrade applies them itself.

## 2. The everyday spelling

- Under Dancing Wren (5) a program has two kinds of code, and each reads like what it is:
  - a walk's brackets (`-[…]->`) and a write's `unique by` are a query the source system may run itself, so they read like SQL: CAPS words, `AND` / `OR` / `NOT`;
  - everything else runs here, step by step, so it reads like TypeScript: `&&`, `? :`, lower-case core words, functions in namespaces, exact letter case.
- Why: a model or a person who writes TypeScript writes the second kind right first time, and the first kind is honest about what the source system runs.
- Every old spelling is `MOV_V5_SPELLING` under 5, and the diagnostic carries the exact rewrite as its fix. It changes spelling, never meaning: the new spelling reads into the same program the old one did under 4.
- Versions 1 to 4 read exactly as before. Under them the new spelling is not read at all.

### Upgrading

- An upgrade runs only when someone asks for it: `lf upgrade <file>` (the CLI), the API's upgrade (`upgradeAutomation`), or the agent tool. It applies the fixes marked safe (they provably keep the meaning), checks again, and repeats until no fix is left. Every other fix is listed with its rewrite; `lf upgrade --all` (the API's `applyAllFixes`) applies those too. An outer rewrite is written from the original text, so a fix inside it comes round on the next pass.
- The result is checked under 5. The pin moves only when it checks clean; otherwise the automation stays on its version, runs as before, and lists what is left.
- A release's deploy check never rewrites an automation. It moves a pin only when the automation's text, as written, is already clean under 5; an automation in an older spelling stays on its version, and the team is told that an upgrade can rewrite it.
- Check a few rewrites by hand, because the right one depends on what the value is:
  - `LENGTH(x)` is rewritten to `Text.length(x)`. On a list, write `count(x)`.
  - `x CONTAINS v` outside brackets is rewritten to `Text.includes(x, v)` when `v` is a text literal, else to `List.includes(x, v)`. Check that it matches what `x` is.
  - `SORT(xs, key)` whose key is anything but one field has no fix yet (`MOV_V5_NOT_YET`). Write `sort(xs, (r) => …)`.
  - A WHERE that calls out (`AI(…)` per record, a plugin, your own function) moves to `filter(walk, (r) => …)`, then `map` over what it kept.

### Core words, lower case

| Before | After |
| --- | --- |
| `MAP(xs, { concurrency: 2 }, (r) => …)` | `map(xs, (r) => …, { concurrency: 2 })` (settings last) |
| `FILTER(xs, (t) => …)` | `filter(xs, (t) => …)` |
| `REDUCE(xs, 0, (acc, t) => …)` | `reduce(xs, (acc, t) => …, 0)` (TypeScript's order) |
| `COUNT FIRST ONLY COALESCE MEMBERS` | `count first only coalesce members` |
| ``SORT(rows, `score`, DESC)`` | `sort(rows, (r) => r.score, { order: "desc" })` |
| `AI(prompt, "careful")` | `ai(prompt, { tier: "careful" })` |
| `ERROR("…")` | `fail("…")` |
| `callback(f(x))` | `callback(() => f(x))` |
| `await until(c, every: 1h)` | `await until(c, { every: 1h })` |
| `movement f() { … }` | `function f() { … }` |

`exists`, `extract`, `extractOne`, `all`, `race`, `sleep` keep their spelling.

### Namespaces

| Before | After |
| --- | --- |
| `TRIM LOWER UPPER LENGTH SPLIT CONCAT JOIN` | `Text.trim Text.lower Text.upper Text.length Text.split Text.concat Text.join` |
| `TOSTRING(v)`, `CHUNKS(t, …)` | `Text.from(v)`, `Text.chunks(t, …)` |
| `TEXT.REGEX_EXTRACT TEXT.SLUG TEXT.PAIRS` | `Text.regexExtract Text.slug Text.pairs` |
| `TEXT.SERIALISE(v, "JSON")` | `Json.stringify(v)` |
| `ABS ROUND FLOOR CEIL`, `NUMBER.FORMAT` | `Number.abs Number.round Number.floor Number.ceil`, `Number.format` |
| `TONUMBER(t)`, `NUMBER(v)` | `Number.parse(v)` |
| `DATE(v)`, `DATE.PARSE DATE.ADD_DAYS DATE.FORMAT DATE.TODAY` | `Date.from(v)`, `Date.parse Date.addDays Date.format Date.today` |
| `DATETIME(v)`, `DATETIME.AT`, `DATE.FORMAT_ISO` | `DateTime.from(v)`, `DateTime.at`, `DateTime.toIso` |
| `CURRENCY.GET_NUMBER_FROM_FIGURE` and its family | `Currency.numberFromFigure Currency.codeFromFigure Currency.formatFigure` |
| `URL.HOST(t)` | `Url.host(t)` |
| `SUM AVG MIN MAX LAST COLLECT MULTI GROUPBY KEYBY` | `List.sum List.avg List.min List.max List.last List.from List.compact List.groupBy List.keyBy` |
| `x IN [..]`, `xs CONTAINS v` | `List.includes(xs, v)` |
| `FILE(content, "pdf")`, `READ(f)` | `File.from(content, "pdf")`, `File.read(f)` |
| `AT(xs, 0)`, `AT(d, "k")`, `AT(d, key)` | `xs[0]`, `d["k"]`, `d[key]` (the upgrade writes `d["k"]`: on a record, `d.k` would read the field where `AT` refused; on a dict, `d.k` reads the same key) |

- A built-in run in a record's scope (`o.UPPER(n)`) is gone: a dot reads a field, or a namespace's function.
- Letter case is exact outside brackets. A name in the wrong case is refused with a did-you-mean: `Upper(x)`, `Text.Upper(x)` and `Text.uper(x)` each name `Text.upper`.

### Operators, conditionals and presence

```
# before
if NOT ISNULL(x) AND (a OR b) { … }
line = IF EXISTS(domain) THEN "https://${domain}" ELSE "" END
if ISNULL(ch) { ERROR("no channel") }
if EXISTS(msg-[:Attachments]->) { … }
ok = TRUE

# after
if (x != null && (a || b)) { … }
line = domain != null ? "https://${domain}" : ""
if (ch == null) { fail("no channel") }
if (exists(msg-[:Attachments]->)) { … }
ok = true
```

- An `if` condition is parenthesised. `rec IS <T>` is `rec is <T>` outside brackets.
- `exists(…)` takes a walk only. On a value it is refused with the `!= null` rewrite. `x != null` narrows `x` inside the arm, and `if (x == null) { fail(…) }` narrows it after, as before.
- `count(xs)` counts every item of a list, an empty one (null) included, as TypeScript's `.length` does; under 4 and earlier `COUNT` skipped empty items. A move up across 5 warns a count of a list that may hold an empty item (`MOV_COUNT_COUNTS_EMPTY`). To count only the items that are there: `count(filter(xs, (x) => x != null))`.
- One answer changes. `found != null` on the records a block returned (`found = c-[m:Messages]-> { return m }`) says whether the block returned any, as `EXISTS(found)` did. Under 4 and earlier those records always counted as present, so `found != NULL` was always true. A move up across 5 warns each such test (`MOV_PRESENCE_OF_RETURNED`): if the program relied on the old answer, change it, then upgrade.
- Unchanged: `== != < <= > >=`, arithmetic, `"${…}"`, `[a, ...xs]`, `{ k: v }`, durations, `@` fields, and `Owner ?: x` in a write.

### Walk brackets

- The words inside `-[…]->` stay CAPS and ignore letter case: `WHERE AND OR NOT CONTAINS IN IS WITHIN TRUE FALSE NULL ORDER BY LIMIT`, and the walk functions `LOWER UPPER TRIM LENGTH ABS ROUND FLOOR CEIL DATE DATETIME NUMBER COALESCE EXISTS`. The everyday spelling there is refused with the CAPS word.
- A field is read through the hop's alias. A bare name inside the brackets is an outer variable, as it is outside. A hop that filters needs an alias:

```
# before
crm-[c:Companies WHERE `Categories` == "Customer" ORDER BY `Created At` DESC LIMIT 10]->
exists(m-[:Attachments WHERE `Name` CONTAINS "pdf"]->)

# after
crm-[c:Companies WHERE c.Categories == "Customer" ORDER BY c.`Created At` DESC LIMIT 10]->
exists(m-[a:Attachments WHERE a.Name CONTAINS "pdf"]->)
```

- Writes keep their statement words and modifiers. `unique by (Domain)` and `FUZZY` follow walk rules. Field values are everyday expressions: `Name: Text.upper(m.Subject)`.

### Systems and imports

```
# before
import { attio, email } from adapters
import { acme_main as acme } from credentials

crm   = attio(credentials: acme, dry_run: true)
inbox = email()

# after
import { `@lf/attio` as attio, `@lf/email` as email } from adapters
import { acme_main as acme } from credentials

crm   = connect attio using acme { dryRun: true }
inbox = connect email
```

- `connect` is grammar, not a call: a credential is legal only after `using`, and a connection is made at file scope. Settings keys are camelCase (`dryRun`).
- A built-in adapter is imported by its package tag, whole in backticks. Credentials and your own files are imported as before. A plugin is imported by its name in camelCase (`fetch_url` → `fetchUrl`) and called as a function is: its required inputs by position, any other in one settings record last (`fetchUrl(u, { email: e })`). A package of plugins is imported under a name (``import { `@lf/web` as web } from plugins``) and its members called through it (`web.fetchUrl(u)`); without the name it is `MOV_V5_IMPORT_NEEDS_ALIAS`.

## 3. `write … bind` is retired

- Under Dancing Wren (5) a `bind` clause on a write is `MOV_WRITE_BIND_RETIRED`. Why: `bind` kept the correspondence between two systems' records in a store the engine owned and no system held, so nothing outside a run could see it, and the next system to need the link could not find it.
- Store the link explicitly, in the system that holds it: a field carrying the other record's identity, which the next write finds the record by (`unique by`), or an edge there.

```
# before
write crm-[:Companies]-> bind deal { Name: deal.Name }

# after: the CRM holds the link, and the next write finds the record by it
write crm-[:Companies]-> { unique by (`Deal ID`), `Deal ID`: deal.id, Name: deal.Name }
```

- The version 4 rules on a bound write (and `MOV_TARGET_WHERE_BIND`) are quiet under 5: the retirement is the one refusal. The retired `#linked` hop's message no longer suggests `bind` under 5.

## 4. `#` hops are retired; a plugin is a function

- Under Dancing Wren (5) a hop whose edge name starts with `#` is refused: `-[:#name]->`, `-[#name]->` and `` -[:`#name`]-> ``, on a walk, a block head, a write or match target, or in a type's address. Why: there are no meta edges, only the edges a system declares. The engine handed a `#` name to the system as one of its own references; on a system that described its edges it was an unknown edge, and on one that did not, or in a parameter's type, it said nothing at all.

| Form | Under 5 | Write instead |
| --- | --- | --- |
| `-[:#name]->`, `-[#name]->`, `` -[:`#name`]-> `` | `MOV_META_HOP_RETIRED` | an edge the record has, or the plugin called as a function |
| `-[f:#resources]->` | `MOV_META_HOP_RETIRED` | `-[f:_resources]->` off an extraction's result, or the system's file edge ([section 6](#6-_resources-only-on-an-extractions-result)) |
| `-[t:#transform { plugin: "…" }]->` | `MOV_TRANSFORM_HOP_RETIRED` (since 3) | the plugin imported and called |
| `-[#linked …]->` | `MOV_LINKED_HOP_RETIRED` (since 3) | the write's handle, or a link stored in the system |

- A plugin is an externally provided function. Import it and call it, and bind its result like any function's. Its declared output is the call's return type:

```
# before
pages = msg-[u:#transform { plugin: "vc_url_retrieval" }]->

# after
import { vcUrlRetrieval } from plugins
pages = vcUrlRetrieval(msg.Body)
```

- A plugin that only an extraction can feed (one with no call form, such as `linkedinEnrichment`) stays a stage: `extract from [ … ] through [linkedinEnrichment] { … }`. The `through [ … ]` stage is not a hop; under 5 it takes its arguments by position, as a call does.
- Not retired: the `#` prefix on the engine's own binding names (`MOV_RESERVED_NAME`), which keeps `#return` uncollidable. `-[:#extract]->` was never accepted.

## 5. `delete` only where the system declares it

- A system's `describe` now says, per type, whether its `deleteRecord` removes a record of that type (`deletable: true`; absent means no). The in-process adapters declare it where they delete: Attio objects; Affinity organisations, people, notes and a named list's entries; Airtable rows; Evertrace searches, lists and list entries; every knowledge-graph node; the Valuations entities. Slack, Telegram, Dropbox, Google Drive, Sheets, Ask, email, Gmail and WhatsApp declare none.
- Under Dancing Wren (5) the checker refuses `delete x`:
  - `MOV_DELETE_NOT_DECLARED` where `x`'s type does not declare deletion. A union is deletable only when every member is.
  - `MOV_DELETE_NOT_RECORD` where `x` is not one stored record: a value, a name that may hold one (a list of records, `c ? r : "a"`), an extraction's root or an extracted node (a transient graph nothing stores), a record on a node the run built, the instance itself, a closure or a local node.
- Why: under version 4 each of these passed the save and failed (or did nothing) at run time, after everything before the `delete` had already run.
- A name bound to a conditional (`c ? a : b`) or a `coalesce` is checked as the union of its operands: every operand a deletable record passes, an operand whose type does not declare deletion is `MOV_DELETE_NOT_DECLARED`, and an operand that is not a record (`null`, a value) is `MOV_DELETE_NOT_RECORD`.
- A system that describes nothing, or a type not yet described, says nothing, so nothing is refused there. Change the record instead (`write x { … }`), or delete it in a system that can.
- A remote (protocol) adapter written before `deletable` existed declares no type deletable, so under version 5 every `delete` of its records is refused. This is accepted: the field is additive and the protocol version is unchanged, but version 5 requires it. The adapter's author adds `"deletable": true` to the types its `deleteRecord` removes (see the adapter handbook's protocol chapter); movements pinned to version 4 or earlier are unaffected.

## 6. `_resources` only on an extraction's result

- Under Dancing Wren (5) `x-[f:_resources]->` is `MOV_RESOURCES_NOT_EXTRACTED` unless `x` is provably an extraction's result: its root or an extracted node, where `_resources` is the source content the extraction read. The rule needs no schema, so a root nothing proves to be one is refused too: a record of a system that describes nothing, or a name bound to a conditional whose arms are not all extractions' results. A rootless `-[:_resources]->` (the event's record) is refused too. Why: off a system's record, `_resources` was a reserved reference the engine resolved through the event's adapter, whatever system the record belonged to. Email, Gmail, WhatsApp and Slack had already retired the bundle it read, so there it read nothing useful; on the knowledge graph it duplicated an edge the graph declares.
- A record reaches its files over an edge its system declares, and the diagnostic names it:

| System | Write instead of `x-[f:_resources]->` |
| --- | --- |
| Email, Gmail, WhatsApp | `x-[f:Attachments]-> { … f.File … }` |
| Slack | `x-[f:Files]-> { … f.File … }` |
| Knowledge graph | `x-[f:Resources]-> { … f.URL … }` (fields `Name`, `URL`, `Type`) |

- The edge in the message is derived from the system's schema, not from a list: the edge the system declares as its resources (the knowledge graph's `Resources`), else every readable edge whose landing has a file-typed field. A record that holds a file itself (an email's attachment) is pointed at its own file field (`a.File`). Where there is neither the message says the system exposes no files.
- The knowledge graph's `Resources` edge is matched by its reserved address, never by its name: a team's own ontology edge named `Resources` is that edge, in every version.

```
# before (an extraction's result: unchanged)
deck = extract from [msg-[:Attachments]->.File] { … }
deck-[f:_resources]-> { write drive-[:files]-> { name: f.name, data: f.file } }

# before (a record: refused under 5)
msg-[f:_resources]-> { … }

# after
msg-[f:Attachments]-> { … f.File … }
```

- The engine follows the checker: under version 5 the movement engine never resolves the reserved reference for a system's record. Versions 1 to 4 keep it, including its quirk of reading another system's record through the event's adapter.

## 7. A file is never joined into text

- Under Dancing Wren (5) a file (or a value that may be one, such as `coalesce(f, "none")`) inside an interpolated text is `MOV_FILE_IN_TEXT`: `"Attached: ${f}"`.
- Why: a file is a byte channel, not text, and has no text form but the one `File.read` gives. Under version 4 and earlier the engine joined the file's description in, and the text read `Attached: [object Object]`. A record in the same place has been refused on every version (`MOV_RECORD_NOT_A_VALUE`).
- Versions 1 to 4 keep the old behaviour. The error under 5 keeps such an automation on its version until the text is rewritten.

```
# before (refused under 5)
write crm-[:notes]-> { title: "Attached: ${f}" }

# after: the file's text
write crm-[:notes]-> { title: "Attached: ${coalesce(File.read(f), "")}" }

# after: the file itself, into a field that holds files
write crm-[:notes]-> { title: "Attached", upload: f }
```

## 8. A declared return takes what the body may return

- Under Dancing Wren (5) a closure's declared return type that does not take what a return may hand back is `MOV_RETURN_TYPE` at the declaration: `c = (): <text> => coalesce(org, "x")` (a record may come back where text was declared; TypeScript's `Org | string` is no `string`).
- A named function's declaration is held to the same rule (`function f(): <text> { return coalesce(org, "x") }`), and under 3 and 4 its call holds what the body may return, a call back into it from its own body carrying nothing for that edge.
- Why: a call is typed by what it declares, so the declaration is the last place the record or file is seen. Versions 3 and 4 ran such a program while the call was unused or only compared, so the refusal is new under 5 only. Under 3 and 4 the declaration is clean, and the call still holds what the body may return: a use that reaches data (a graph entry, a written field, a plugin argument) is refused at the use, on every version.
- Return a field off the record (`org.name`), or declare the type the body returns.

## 9. A value that may be a record is no record parameter

- Under Dancing Wren (5) a value that MAY be a record and may be something else, handed to a parameter that takes a record position, is `MOV_CALL_ARG_MAYBE_RECORD`: `v = coalesce(org, "x")` then `hp(v)`, `hp(cond ? org : "x")`, or a function or closure whose returns are a record on one path and text on another.
- Why: TypeScript's `Org | string` is no `Org`. The value that is not a record has nowhere to go, and the engine refuses it by name at run time, which a checked program could reach.
- Narrow it to the record with `is` before passing it, handle the case where it is not one, or fill the other arm with a record. A union of records alone (`coalesce(org, other)`) is one record and passes. Versions 1 to 4 are unchanged.
- The same value handed to a parameter typed as a VALUE (`function f(n: <number>)`, then `f(coalesce(org, 1))`, `f(cond ? org : 1)`, or a name bound to either) is `MOV_CALL_ARG_MAYBE_RECORD` too, through a function by name, a closure in a variable, or a list handed to `<number[]>`.
- Why: `Org | number` is no `number`. Under versions 3 and 4 the check said nothing and the call ran: the record arrived where the number was typed, and a sum over it came out `NaN`. So under 3 and 4 it is a warning that blocks the move up, and the refusal is new under 5.
- Narrow it to the record with `is` and pass a field off it (`f(coalesce(org.size, 1))`), or fill every arm with a value.
- A built-in whose argument takes a value is held to the same rule: `Number.round(coalesce(org, 1))` and `Text.upper(coalesce(org, "b"))` are `MOV_CALL_ARG_MAYBE_RECORD`. Under 3 and 4 the built-in ran on the record as it was (`ROUND` gave `NaN`, `UPPER` gave `"[OBJECT OBJECT]"`), so there it is a warning that blocks the move up.
- A plugin's text input is held to it for a record value (`{ … }`) as well: `research({ context: s })`, or a value that may be one, is `MOV_CALL_ARG_MAYBE_RECORD`. Under 3 and 4 the record was passed through as it was, so there it is a warning that blocks the move up.
- A collection op calls its function with each member, so each member is an argument too: `map(["a"], (n: <number>) => n)` is `MOV_CALL_ARG_TYPE` (TypeScript refuses `["a"].map((n: number) => n)`), and a member that may be a record, handed to a value parameter, is `MOV_CALL_ARG_MAYBE_RECORD`. The same holds for `filter`, `List.groupBy`, `List.keyBy`, a function passed by name, and `reduce`, whose starting value is held to its accumulator. Under 3 and 4 the op ran with each member as it was (a sum over text came out `NaN`), so there it is a warning that blocks the move up. Type the parameter as the members are, or leave it untyped to take their type.

## 10. A record a combinator arm hands back reads as itself

- Under Dancing Wren (5) a slot of a `race` receipt that holds the record an arm returned reads as that record: `r[0].name`, `h = r[0]` then `h.name`, and `r[0] == null` (false). It is the reading `[a, 2][0]` already had on a list. `parallel` is retired under 5 ([section 15](#15-parallel-is-retired-for-all-combinators-take-arguments-and-no-await)); the `all` that replaces it reads its slots the same way.
- Why: the check accepted the field read, and the run read null. A program that checked clean silently read nothing.
- Under Luminous Owl (4) and earlier the slot still reads null. A move up across 5 warns every read of a receipt one of whose arms returns a record (`MOV_RECEIPT_RECORD_SLOT`): if the program relied on the null, change it, then upgrade.

```
r = await parallel([
  () => {
    a = write crm-[:companies]-> { name: "Acme" }
    return a
  },
  () => 2
])
write crm-[:notes]-> { title: AT(r, 0).name }   # 4 and earlier: null
```

Under 5 the same join is `r = all(() => { … }, () => 2)`, and `r[0].name` reads "Acme".

## 11. A write handle's unsent file is not a file

- Under Dancing Wren (5) a write handle's file field that the write did not send, used as a file, is `MOV_HANDLE_FILE_NOT_SENT`: `File.read(h.doc)`, `ocr(doc: h.doc)`, or `h.doc` into another write's file field, after `h = write d-[:docs]-> { name: "a" }`.
- Why: the system answers a write with its own description of the file, a dict, not a file the run can read. `File.read` failed with "reads a file, and this is object" though the program had validated. A file field the write did send (`doc: f`) is the program's own file and stays usable.
- Versions 1 to 4 keep the old behaviour. Read the record back through its edge to get the file, as a walk read does, or send the file in the write.

```
# before (refused under 5)
h = write d-[:docs]-> { name: "a" }
text = File.read(h.doc)

# after: the file off the record's edge
text = File.read(first(h-[:Files]->).File)
```

## 12. A closure is not data

- Under Dancing Wren (5) a closure is a value, as TypeScript's functions are, but it is never data. It lives in exactly three places:
  - a variable: `g = label`, `g = () => { … }`, or a call that answers one (`h = mk()`);
  - a parameter, including one typed as a closure (`handler: <(c: <Company>) => <text>>`, [section 14](#14-a-closures-type-is-written-params--return));
  - an argument to a parameter that takes one: `map(xs, (x) => …)`, `race(a, b)`, `all(a, b)`, `run(label)`.
- It is never an operand of a value expression (`MOV_CLOSURE_NOT_DATA`): `c ? a : b` or `coalesce(a, b)` choosing between closures, a comparison (`a == b`), interpolation (`"${a}"`), arithmetic, `!`/`&&`/`||`, a condition (`if (a) { … }`), or a built-in's argument that is not its function (`Text.upper(a)`). Choose with a statement instead: `if (c) { v = a() } else { v = b() }`.
- Anywhere a value would be kept as data it is `MOV_CLOSURE_NOT_DATA`: a list's element (`[label]`, `[() => { … }]`), a record or map's value (`{ g: label }`, `{ g: () => 1 }`), a field written, a spread, a `map` whose function returns a closure, `List.groupBy` or `List.keyBy` over closures, a `race` or `all` arm that returns a closure, and a type whose list element or record key is a closure (`<() => <text>>[]`, `<{ run: <() => <text>> }>`).
- Why: a closure stored as data is a function that outlives the scope that made it, travels through records and lists, and has to be called back through whatever holds it. Kept in a variable or passed as an argument, every call of it is visible where it is written.
- Under Luminous Owl (4) and earlier a closure is no value at all: written in a list it stays `MOV_EXPR_CLOSURE_POSITION` (bind it to a name first).

```
# refused under 5: closures kept as data
fs = [label, () => { return "x" }]   # MOV_CLOSURE_NOT_DATA
box = { g: label }                   # MOV_CLOSURE_NOT_DATA

# instead: a variable, or arguments
g = label
v = g()
r = all(label, () => { return "x" })
```

## 13. A value that is a closure is called

- Under Dancing Wren (5) a name whose VALUE is a closure is called as TypeScript calls one. The value may come from anywhere a closure may be ([section 12](#12-a-closure-is-not-data)):
  - a bound closure (`g = () => { … }` then `g()`);
  - a function declared with a name, read as a value: bound (`g = made` then `g()`) or handed back (`() => made`, `return made`, a function that returns one, then `h = mk()` and `h()`);
  - a closure a closure returns in place (`mk = () => { return () => { … } }`);
  - a parameter whose type is a closure type ([section 14](#14-a-closures-type-is-written-params--return)).

  Under 4 such a call is refused (`MOV_CONSTRUCT_NOT_ADAPTER` / `MOV_CALL_NOT_MOVEMENT`).
- The call's type is what the closure returns, records included, so the rules for a record in data (a written field, a graph entry, a plugin argument) see a record it hands back.
- A value that may not be a closure (`coalesce(c, 2)`), or whose type nothing shows, is refused where it is called (`MOV_CALL_NOT_MOVEMENT`), never run on the chance.
- A value that may be any of several closures (a function or closure whose returns hand back different ones, `return made` on one path and `return label` on another) is called as TypeScript calls a union of function types:
  - every closure's arity (`MOV_CALL_ARITY`, naming each);
  - an argument that fits every closure's parameter; two closures whose parameters share no argument are named (`MOV_CALL_ARG_TYPE`);
  - the call's value is any of their returns, so a record a later one hands back is refused where it is written (`MOV_WRITE_FIELD_TYPE`).

  A declared return type (`function mk(): <() => <text>>`) narrows the closures to it. Why: under 3 and 4 the call was typed by the first closure alone, and ran on whichever it reached: a record written into a text field, a number handed to a text parameter. So under 3 and 4 each is a warning that blocks the move up (`MOV_CALL_ARITY`, `MOV_CALL_ARG_TYPE`, `MOV_CALL_CLOSURE_RETURNS`).
- A body that is one call, `(f) => f()`, returns the call, as `(f) => { return f() }` does: a callee that waits parks the run where the call is, and a callee that returns nothing makes the closure return nothing (TypeScript's `() => g()` when `g` returns `void`). A body that is a combinator, `() => all(f, g)`, returns its answer.

```
a = () => { return made() }
g = a
v = g()
write crm-[:notes]-> { title: v }   # a record: MOV_WRITE_FIELD_TYPE
```

### No methods

- There are no methods: a dot on a record or map always reads a field, and a closure is never under a key ([section 12](#12-a-closure-is-not-data)). Why: a closure under a key made `box.g()` a second way to call a function, and `box.g` mean two things.
- Under Dancing Wren (5), a dotted call of a function that is no built-in (`o.nope()`, `box.g()`) is `MOV_FUNCTION_UNKNOWN`. The engine reads `o.f(…)` as `f` run in `o`'s scope, and outside a write field there is no such function to run, so the run always failed where it reached the call; the checker now says so where it is written. Versions 1–4 are unchanged (a saved movement never breaks). A function inside a write field, which the target may advertise, is unchanged; under 5 it is a member of the adapter's package. A built-in in a record's scope (`o.UPPER(name)`) is gone under 5 ([section 2](#2-the-everyday-spelling)).

## 14. A closure's type is written `<(params) => <return>>`

- Under Dancing Wren (5) a closure's type is written as TypeScript's function type, in angle brackets: `<(params) => <return>>`. Each parameter is typed as a function's is, and the return is written as a function's return annotation is.

```
function run(handler: <(c: <crm-[:company]->>) => <text>>) { … }   # a parameter
function pick(): <() => <text>> { … }                               # a declared return
```

- A closure type is never a list's element or a record type's key (`<() => <text>>[]` and `<{ run: <() => <text>> }>` are `MOV_CLOSURE_NOT_DATA`): a closure is not data.
- A closure that returns a list is `<() => <text[]>>`; `<() => <text>[]>` is ambiguous and refused. Every parameter needs a type: a caller of the closure is checked against it.
- A parameter of closure type is called (`handler(c)`), typed by its return and held to its parameters (`MOV_CALL_ARITY`).
- A callback's closure is held to the same rule: `callback(() => f(x))` takes nothing, so it passes every argument of `f` itself, and a parameter left open is `MOV_CALL_ARITY`. What the platform sends when it fires is a parameter the closure declares: `callback((d: <date>) => f(x, d))`. A function named bare (`callback(f)`) still leaves every parameter to the platform.
- A closure fits a closure type as TypeScript's assignability says. Parameters are contravariant: each of the closure's parameters takes what the type's hands it. Returns are covariant: what the closure returns, what it may hold included, is what the type's returns. A closure that takes fewer parameters fits, and the extra arguments are dropped; one that takes more does not. A misfit is `MOV_CALL_ARG_TYPE` (or `MOV_RETURN_TYPE` for a declared return), naming what the closure returns.
- A closure written in place is an argument to a closure-typed parameter: `run((c) => c.name)`. Its untyped parameters are typed by the closure type (contextual typing).
- Under Quiet Heron (1) to Luminous Owl (4) the syntax is a parse error that names version 5, because a closure is not a value there.

## 15. `parallel` is retired for `all`; combinators take arguments and no `await`

- Under Dancing Wren (5) every `parallel` form is `MOV_PARALLEL_RETIRED`. `all(f, g, …)` is the same join, as TypeScript's `Promise.all` is: every arm runs, at once, and the answer is the list of what each returned, in argument order. Why: a closure is not data ([section 12](#12-a-closure-is-not-data)), so the arms are passed as arguments, not in a list.
- For arms written down the diagnostic carries the exact rewrite, which a tool applies:

```
# before
r = await parallel([a, () => { … }])

# after
r = all(a, () => { … })
```

- Later reads stay clean: the answer is a tuple, slot by slot, so `r[i]` reads exactly what slot `i` of the receipt did: a value arm's value, a record arm's record (`r[0].name`), and an arm that returns nothing reads absent.
- `all` takes `map`'s settings where they mean something for a join, as a record written last: `all(a, b, { concurrency: 2, onError: "warn" })`. `concurrency` is how many arms run at once (all of them without it); an arm that parks is waiting, not running, so it frees its place for the next. `onError: "warn"` or `"ignore"` leaves the slot of an arm that fails null (and its slot type may be absent), `"warn"` saying so on the trace; the default fails the run, as before. `initialConcurrency` is refused.
- `race` takes its arms as arguments too: `race([q, t])` is `MOV_COMBINATOR_ARMS_ARE_ARGUMENTS` (`all([…])` as well), and the fix drops the brackets: `race(q, t)`. `race` takes no settings.
- No `await` on `race` or `all`: `await` marks only the suspension itself, where the run parks (`await sleep(…)`, `await until(…)`, reading an answer with `await first(q-[:Response]->)`). A combinator does not park by itself; its arms may, and the run parks where they do. `await race(…)` and `await all(…)` are `MOV_COMBINATOR_NO_AWAIT`, and the fix removes the `await`. An arrow body that awaits one, `g = () => await parallel([…])`, gets the same fixes: `g = () => all(…)`.
- Arms built at run time (`parallel(fs)`) have no fix: name each function as an argument, `all(f, g)`.
- The refusal of the `parallel { … }` block points at `all` under 5. Under 4 and earlier `await race([…])` and `await parallel([…])` are unchanged, and `all` is still a retired name.

## 16. The extraction keyword is retired

- Under Dancing Wren (5) the keyword `x = extract from […] { … }` is `MOV_EXTRACT_KEYWORD_RETIRED`, with its inline node shapes and its `through […]` stages. An extraction is the call over a declared node shape: `extract(content, Shape, { tier })` hands back each record the content holds, and `extractOne(content, Shape, { tier })` the one it describes, or nothing. A plugin is a function you call. Why: one way to extract, whose shape is an ordinary declaration you can reuse, spread into a graph and pass around.
- Where the rewrite is mechanical the diagnostic carries it. It declares the tree as a node shape named after the binding (`found` is `FoundShape`; a name the file already holds gets the next number, `FoundShape2`), and calls `extractOne` over the same content and tier:

```
# before
found = extract "careful" from [m.Body] {
  node company: "each company named" {
    name: <text> "its name"
    website: "its website"
  }
}

# after
node FoundShape: "the relevant information in the content" {
  node company: "each company named" {
    name: <text> "its name"
    website: <text> "its website"
  }
}

found = extractOne([m.Body], FoundShape, { tier: "careful" })
```

- `found` is the one record the keyword's result was: its fields read off it (`found.summary`) and its nodes walk from it (`found-[c:company]-> { … }`) as before. A node that took a declaration (`node lead: <Lead>`) is written out in place, its words the use site's. A declaration whose words interpolate a value of the body (`"the topic of ${m.Subject}"`) stays in the body, where they are read; any other goes before the function at file level.
- The fix is offered, never applied on its own. Check three things: the record may be absent where the keyword's result never was, so a field read off it where a value is needed is `MOV_ABSENT_REQUIRED` (write `coalesce(found.summary, "")`, which that diagnostic offers); a field written without a type becomes `<text>`; and the model is asked through the call's prompt, which lays out the content for the prompt cache.
- A `through […]` stage has no fix. It hands each record's plugin answers to a further extraction of that record and merges what that finds into it; plugins called as functions hand back values of their own, so no rewrite is provably the same. Write the composition out: declare the shape, `extract` it, `map` over the records calling each plugin, `extractOne` over the content plus what the plugin returned, and merge the two with a spread into `graph<Shape> { ...c, ...details }`. The handbook's enrichment example is exactly this.
- The Rust engine does not run the keyword on any version. A Quiet Heron (1) to Luminous Owl (4) automation that holds one runs on the TypeScript engine by its version, exactly as before; a run forced onto the Rust engine (`lf`, or `MOVEMENT_ENGINE=rust` with `MOVEMENT_ENGINE_FALLBACK=none`) fails naming `legacy_extraction`.

## 17. Diagnostic code index

| Code | Where |
| --- | --- |
| `MOV_CALL_ARG_MAYBE_RECORD` | [A value that may be a record is no record parameter](#9-a-value-that-may-be-a-record-is-no-record-parameter) (a value parameter, a collection op's member and a built-in's argument included) |
| `MOV_CALL_ARITY` | [A value that is a closure is called](#13-a-value-that-is-a-closure-is-called) (a call of one of several closures names every arity) |
| `MOV_CALL_ARG_TYPE` | [A closure's type is written `<(params) => <return>>`](#14-a-closures-type-is-written-params--return) (a closure that does not fit a closure type); [A value that is a closure is called](#13-a-value-that-is-a-closure-is-called) (two of several closures whose parameters share no argument); [A value that may be a record is no record parameter](#9-a-value-that-may-be-a-record-is-no-record-parameter) (a collection op's member against its function's parameter) |
| `MOV_CALL_CLOSURE_RETURNS` | [A value that is a closure is called](#13-a-value-that-is-a-closure-is-called) (warning under 3 and 4: a later closure may hand back a record the first does not) |
| `MOV_CALL_NOT_MOVEMENT` | [A value that is a closure is called](#13-a-value-that-is-a-closure-is-called) (a value that may not be a closure, or whose type nothing shows) |
| `MOV_CLOSURE_NOT_DATA` | [A closure is not data](#12-a-closure-is-not-data) (a closure as a list element, a record or map value, a field, an op's or a combinator's answer, or a type's list element or key; since 5) |
| `MOV_COMBINATOR_ARM_NOT_FUNCTION` | [`all` and `race`](#15-parallel-is-retired-for-all-combinators-take-arguments-and-no-await) (an argument that is no function) |
| `MOV_COMBINATOR_ARMS_ARE_ARGUMENTS` | [`all` and `race`](#15-parallel-is-retired-for-all-combinators-take-arguments-and-no-await) (arms in a list; the fix drops the brackets; since 5) |
| `MOV_COMBINATOR_NO_AWAIT` | [`all` and `race`](#15-parallel-is-retired-for-all-combinators-take-arguments-and-no-await) (`await race(…)`, `await all(…)`; the fix drops the `await`; since 5) |
| `MOV_DELETE_NOT_DECLARED` | [`delete` only where the system declares it](#5-delete-only-where-the-system-declares-it) |
| `MOV_COUNT_COUNTS_EMPTY` | [Operators, conditionals and presence](#operators-conditionals-and-presence) (warning, on a move up across 5: a count of a list that may hold an empty item) |
| `MOV_DELETE_NOT_RECORD` | [`delete` only where the system declares it](#5-delete-only-where-the-system-declares-it) |
| `MOV_EXPR_CLOSURE_POSITION` | [A closure is not data](#12-a-closure-is-not-data) (under 4 and earlier; under 5 a closure written in a list or map is `MOV_CLOSURE_NOT_DATA`) |
| `MOV_EXTRACT_KEYWORD_RETIRED` | [The extraction keyword is retired](#16-the-extraction-keyword-is-retired) (the rewrite to `extractOne` over a declared shape where it is mechanical; none for a `through […]` stage) |
| `MOV_FUNCTION_UNKNOWN` | [No methods](#no-methods) (a dotted call of no built-in, `box.g()` included; version 5) |
| `MOV_FILE_IN_TEXT` | [A file is never joined into text](#7-a-file-is-never-joined-into-text) |
| `MOV_HANDLE_FILE_NOT_SENT` | [A write handle's unsent file is not a file](#11-a-write-handles-unsent-file-is-not-a-file) |
| `MOV_META_HOP_RETIRED` | [`#` hops are retired](#4--hops-are-retired-a-plugin-is-a-function) |
| `MOV_PARALLEL_RETIRED` | [`parallel` is retired for `all`](#15-parallel-is-retired-for-all-combinators-take-arguments-and-no-await) (with the `all` rewrite for arms written down) |
| `MOV_PRESENCE_OF_RETURNED` | [Operators, conditionals and presence](#operators-conditionals-and-presence) (warning, on a move up across 5: a null test on a block's returned records) |
| `MOV_RECEIPT_RECORD_SLOT` | [A record a combinator arm hands back reads as itself](#10-a-record-a-combinator-arm-hands-back-reads-as-itself) (warning, on a move up across 5) |
| `MOV_RETURN_TYPE` | [A declared return takes what the body may return](#8-a-declared-return-takes-what-the-body-may-return) (a body's returns that may hold a record or file; since 5) |
| `MOV_RESOURCES_NOT_EXTRACTED` | [`_resources` only on an extraction's result](#6-_resources-only-on-an-extractions-result) |
| `MOV_TRANSFORM_HOP_RETIRED` | [`#` hops are retired](#4--hops-are-retired-a-plugin-is-a-function) (since 3; under 5 the message shows the function form) |
| `MOV_V5_IMPORT_NEEDS_ALIAS` | [The everyday spelling](#2-the-everyday-spelling) (a package of plugins imported without `as`; the fix adds the name) |
| `MOV_V5_NOT_YET` | [The everyday spelling](#2-the-everyday-spelling) (an old spelling whose rewrite needs a person, such as a `SORT` key that is not one field) |
| `MOV_V5_SPELLING` | [The everyday spelling](#2-the-everyday-spelling) (an old spelling under 5; the fix is the rewrite) |
| `MOV_V5_UNKNOWN_MEMBER` | [The everyday spelling](#2-the-everyday-spelling) (a namespace member that does not exist, with a did-you-mean) |
| `MOV_WRITE_BIND_RETIRED` | [`write … bind` is retired](#3-write--bind-is-retired) |
