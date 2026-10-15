# Migrating to Dancing Wren (5)

Language version 5, **Dancing Wren**, follows Luminous Owl (4). The [changelog entry](../../CHANGELOG.md) lists each change in a line; this guide carries the full detail. Every rule here that says "under Dancing Wren (5)" applies only to an automation pinned to version 5. Quiet Heron (1), Bright Otter (2), Steady Lynx (3) and Luminous Owl (4) keep their old behaviour exactly (proved by the version 4 conformance corpus).

The first four changes share one idea: there is no engine-side store and there are no meta edges. Everything a movement reads or writes is an edge or a record that a system declares, and a plugin is a function.

## Contents

- [1. How the pin moves](#1-how-the-pin-moves)
- [2. `write … bind` is retired](#2-write--bind-is-retired)
- [3. `#` hops are retired; a plugin is a function](#3--hops-are-retired-a-plugin-is-a-function)
- [4. `delete` only where the system declares it](#4-delete-only-where-the-system-declares-it)
- [5. `_resources` only on an extraction's result](#5-_resources-only-on-an-extractions-result)
- [6. A file is never joined into text](#6-a-file-is-never-joined-into-text)
- [7. A declared return takes what the body may return](#7-a-declared-return-takes-what-the-body-may-return)
- [8. A value that may be a record is no record parameter](#8-a-value-that-may-be-a-record-is-no-record-parameter)
- [9. A record a combinator arm hands back reads as itself](#9-a-record-a-combinator-arm-hands-back-reads-as-itself)
- [10. A write handle's unsent file is not a file](#10-a-write-handles-unsent-file-is-not-a-file)
- [11. A closure is not data](#11-a-closure-is-not-data)
- [12. A value that is a closure is called](#12-a-value-that-is-a-closure-is-called)
- [13. A closure's type is written `<(params) => <return>>`](#13-a-closures-type-is-written-params--return)
- [14. `parallel` is retired for `all`; combinators take arguments and no `await`](#14-parallel-is-retired-for-all-combinators-take-arguments-and-no-await)
- [15. Diagnostic code index](#15-diagnostic-code-index)

## 1. How the pin moves

- A new automation is written in Dancing Wren (5). The deploy check moves an existing automation up to it when it validates cleanly there.
- Every change below is a refusal under version 5, not a move-up warning: an automation that uses a retired form has an error under 5, so its pin cannot move. It stays on its version, shows **Review**, lists the diagnostics, and runs exactly as before. Rewrite each form as below, then upgrade with `upgradeAutomation`.

## 2. `write … bind` is retired

- Under Dancing Wren (5) a `bind` clause on a write is `MOV_WRITE_BIND_RETIRED`. Why: `bind` kept the correspondence between two systems' records in a store the engine owned and no system held, so nothing outside a run could see it, and the next system to need the link could not find it.
- Store the link explicitly, in the system that holds it: a field carrying the other record's identity, which the next write finds the record by (`unique by`), or an edge there.

```
# before
write crm-[:Companies]-> bind deal { Name: deal.Name }

# after: the CRM holds the link, and the next write finds the record by it
write crm-[:Companies]-> { unique by (`Deal ID`), `Deal ID`: deal.id, Name: deal.Name }
```

- The version 4 rules on a bound write (and `MOV_TARGET_WHERE_BIND`) are quiet under 5: the retirement is the one refusal. The retired `#linked` hop's message no longer suggests `bind` under 5.

## 3. `#` hops are retired; a plugin is a function

- Under Dancing Wren (5) a hop whose edge name starts with `#` is refused: `-[:#name]->`, `-[#name]->` and `` -[:`#name`]-> ``, on a walk, a block head, a write or match target, or in a type's address. Why: there are no meta edges, only the edges a system declares. The engine handed a `#` name to the system as one of its own references; on a system that described its edges it was an unknown edge, and on one that did not, or in a parameter's type, it said nothing at all.

| Form | Under 5 | Write instead |
| --- | --- | --- |
| `-[:#name]->`, `-[#name]->`, `` -[:`#name`]-> `` | `MOV_META_HOP_RETIRED` | an edge the record has, or the plugin called as a function |
| `-[f:#resources]->` | `MOV_META_HOP_RETIRED` | `-[f:_resources]->` off an extraction's result, or the system's file edge ([section 5](#5-_resources-only-on-an-extractions-result)) |
| `-[t:#transform { plugin: "…" }]->` | `MOV_TRANSFORM_HOP_RETIRED` (since 3) | the plugin imported and called |
| `-[#linked …]->` | `MOV_LINKED_HOP_RETIRED` (since 3) | the write's handle, or a link stored in the system |

- A plugin is an externally provided function. Import it and call it, and bind its result like any function's. Its declared output is the call's return type:

```
# before
pages = msg-[u:#transform { plugin: "vc_url_retrieval" }]->

# after
import { vc_url_retrieval } from plugins
pages = vc_url_retrieval(text: msg.`Body`)
```

- A plugin that only an extraction can feed (one with no call form, such as `linkedin_enrichment`) stays a stage: `extract from [ … ] through [linkedin_enrichment] { … }`. The `through [ … ]` stage is not a hop and is unchanged.
- Not retired: the `#` prefix on the engine's own binding names (`MOV_RESERVED_NAME`), which keeps `#return` uncollidable. `-[:#extract]->` was never accepted.

## 4. `delete` only where the system declares it

- A system's `describe` now says, per type, whether its `deleteRecord` removes a record of that type (`deletable: true`; absent means no). The in-process adapters declare it where they delete: Attio objects; Affinity organisations, people, notes and a named list's entries; Airtable rows; Evertrace searches, lists and list entries; every knowledge-graph node; the Valuations entities. Slack, Telegram, Dropbox, Google Drive, Sheets, Ask, email, Gmail and WhatsApp declare none.
- Under Dancing Wren (5) the checker refuses `delete x`:
  - `MOV_DELETE_NOT_DECLARED` where `x`'s type does not declare deletion. A union is deletable only when every member is.
  - `MOV_DELETE_NOT_RECORD` where `x` is not one stored record: a value, a name that may hold one (a list of records, `IF … THEN r ELSE "a" END`), an extraction's root or an extracted node (a transient graph nothing stores), a record on a node the run built, the instance itself, a closure or a local node.
- Why: under version 4 each of these passed the save and failed (or did nothing) at run time, after everything before the `delete` had already run.
- A name bound to an `IF` or a `COALESCE` is checked as the union of its operands: every operand a deletable record passes, an operand whose type does not declare deletion is `MOV_DELETE_NOT_DECLARED`, and an operand that is not a record (`null`, a value) is `MOV_DELETE_NOT_RECORD`.
- A system that describes nothing, or a type not yet described, says nothing, so nothing is refused there. Change the record instead (`write x { … }`), or delete it in a system that can.
- A remote (protocol) adapter written before `deletable` existed declares no type deletable, so under version 5 every `delete` of its records is refused. This is accepted: the field is additive and the protocol version is unchanged, but version 5 requires it. The adapter's author adds `"deletable": true` to the types its `deleteRecord` removes (see the adapter handbook's protocol chapter); movements pinned to version 4 or earlier are unaffected.

## 5. `_resources` only on an extraction's result

- Under Dancing Wren (5) `x-[f:_resources]->` is `MOV_RESOURCES_NOT_EXTRACTED` unless `x` is provably an extraction's result: its root or an extracted node, where `_resources` is the source content the extraction read. The rule needs no schema, so a root nothing proves to be one is refused too: a record of a system that describes nothing, or a name bound to an `IF` whose arms are not all extractions' results. A rootless `-[:_resources]->` (the event's record) is refused too. Why: off a system's record, `_resources` was a reserved reference the engine resolved through the event's adapter, whatever system the record belonged to. Email, Gmail, WhatsApp and Slack had already retired the bundle it read, so there it read nothing useful; on the knowledge graph it duplicated an edge the graph declares.
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

## 6. A file is never joined into text

- Under Dancing Wren (5) a file (or a value that may be one, such as `COALESCE(f, "none")`) inside an interpolated text is `MOV_FILE_IN_TEXT`: `"Attached: ${f}"`.
- Why: a file is a byte channel, not text, and has no text form but the one `READ` gives. Under version 4 and earlier the engine joined the file's description in, and the text read `Attached: [object Object]`. A record in the same place has been refused on every version (`MOV_RECORD_NOT_A_VALUE`).
- Versions 1 to 4 keep the old behaviour. The error under 5 keeps such an automation on its version until the text is rewritten.

```
# before (refused under 5)
write crm-[:notes]-> { title: "Attached: ${f}" }

# after: the file's text
write crm-[:notes]-> { title: "Attached: ${COALESCE(READ(f), "")}" }

# after: the file itself, into a field that holds files
write crm-[:notes]-> { title: "Attached", upload: f }
```

## 7. A declared return takes what the body may return

- Under Dancing Wren (5) a closure's declared return type that does not take what a return may hand back is `MOV_RETURN_TYPE` at the declaration: `c = (): <text> => COALESCE(org, "x")` (a record may come back where text was declared; TypeScript's `Org | string` is no `string`).
- A named function's declaration is held to the same rule (`function f(): <text> { return COALESCE(org, "x") }`), and under 3 and 4 its call holds what the body may return, a call back into it from its own body carrying nothing for that edge.
- Why: a call is typed by what it declares, so the declaration is the last place the record or file is seen. Versions 3 and 4 ran such a program while the call was unused or only compared, so the refusal is new under 5 only. Under 3 and 4 the declaration is clean, and the call still holds what the body may return: a use that reaches data (a graph entry, a written field, a plugin argument) is refused at the use, on every version.
- Return a field off the record (`org.name`), or declare the type the body returns.

## 8. A value that may be a record is no record parameter

- Under Dancing Wren (5) a value that MAY be a record and may be something else, handed to a parameter that takes a record position, is `MOV_CALL_ARG_MAYBE_RECORD`: `v = COALESCE(org, "x")` then `hp(r: v)`, `hp(r: IF cond THEN org ELSE "x" END)`, or a function or closure whose returns are a record on one path and text on another.
- Why: TypeScript's `Org | string` is no `Org`. The value that is not a record has nowhere to go, and the engine refuses it by name at run time, which a checked program could reach.
- Narrow it to the record with `IS` before passing it, handle the case where it is not one, or fill the other arm with a record. A union of records alone (`COALESCE(org, other)`) is one record and passes. Versions 1 to 4 are unchanged.
- The same value handed to a parameter typed as a VALUE (`function f(n: <number>)`, then `f(COALESCE(org, 1))`, `f(IF cond THEN org ELSE 1 END)`, or a name bound to either) is `MOV_CALL_ARG_MAYBE_RECORD` too, through a function by name, a closure in a variable, or a list handed to `<number[]>`.
- Why: `Org | number` is no `number`. Under versions 3 and 4 the check said nothing and the call ran: the record arrived where the number was typed, and a sum over it came out `NaN`. So under 3 and 4 it is a warning that blocks the move up, and the refusal is new under 5.
- Narrow it to the record with `IS` and pass a field off it (`f(COALESCE(org.size, 1))`), or fill every arm with a value.
- A collection op calls its function with each member, so each member is an argument too: `MAP(["a"], (n: <number>) => n)` is `MOV_CALL_ARG_TYPE` (TypeScript refuses `["a"].map((n: number) => n)`), and a member that may be a record, handed to a value parameter, is `MOV_CALL_ARG_MAYBE_RECORD`. The same holds for `FILTER`, `GROUPBY`, `KEYBY`, a function passed by name, and `REDUCE`, whose starting value is held to its accumulator. Under 3 and 4 the op ran with each member as it was (a sum over text came out `NaN`), so there it is a warning that blocks the move up. Type the parameter as the members are, or leave it untyped to take their type.

## 9. A record a combinator arm hands back reads as itself

- Under Dancing Wren (5) a slot of a `race` receipt that holds the record an arm returned reads as that record: `AT(r, 0).name`, `h = AT(r, 0)` then `h.name`, and `AT(r, 0) == null` (false). It is the reading `AT([a, 2], 0)` already had on a list. `parallel` is retired under 5 ([section 14](#14-parallel-is-retired-for-all-combinators-take-arguments-and-no-await)); the `all` that replaces it reads its slots the same way.
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

Under 5 the same join is `r = all(() => { … }, () => 2)`, and `AT(r, 0).name` reads "Acme".

## 10. A write handle's unsent file is not a file

- Under Dancing Wren (5) a write handle's file field that the write did not send, used as a file, is `MOV_HANDLE_FILE_NOT_SENT`: `READ(h.doc)`, `ocr(doc: h.doc)`, or `h.doc` into another write's file field, after `h = write d-[:docs]-> { name: "a" }`.
- Why: the system answers a write with its own description of the file, a dict, not a file the run can read. `READ` failed with "reads a file, and this is object" though the program had validated. A file field the write did send (`doc: f`) is the program's own file and stays usable.
- Versions 1 to 4 keep the old behaviour. Read the record back through its edge to get the file, as a walk read does, or send the file in the write.

```
# before (refused under 5)
h = write d-[:docs]-> { name: "a" }
text = READ(h.doc)

# after: the file off the record's edge
text = READ(FIRST(h-[:Files]->).`File`)
```

## 11. A closure is not data

- Under Dancing Wren (5) a closure is a value, as TypeScript's functions are, but it is never data. It lives in exactly three places:
  - a variable: `g = label`, `g = () => { … }`, or a call that answers one (`h = mk()`);
  - a parameter, including one typed as a closure (`handler: <(c: <Company>) => <text>>`, [section 13](#13-a-closures-type-is-written-params--return));
  - an argument to a parameter that takes one: `MAP(xs, (x) => …)`, `race(a, b)`, `all(a, b)`, `run(label)`.
- It is never an operand of a value expression (`MOV_CLOSURE_NOT_DATA`): `IF c THEN a ELSE b END` or `COALESCE(a, b)` choosing between closures, a comparison (`a == b`), interpolation (`"${a}"`), arithmetic, `NOT`/`AND`/`OR`, a condition (`if a { … }`), or a built-in's argument that is not its function (`UPPER(a)`). Choose with a statement instead: `if c { v = a() } else { v = b() }`.
- Anywhere a value would be kept as data it is `MOV_CLOSURE_NOT_DATA`: a list's element (`[label]`, `[() => { … }]`), a record or map's value (`{ g: label }`, `{ g: () => 1 }`), a field written, a spread, a `MAP` whose function returns a closure, `GROUPBY` or `KEYBY` over closures, a `race` or `all` arm that returns a closure, and a type whose list element or record key is a closure (`<() => <text>>[]`, `<{ run: <() => <text>> }>`).
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

## 12. A value that is a closure is called

- Under Dancing Wren (5) a name whose VALUE is a closure is called as TypeScript calls one. The value may come from anywhere a closure may be ([section 11](#11-a-closure-is-not-data)):
  - a bound closure (`g = () => { … }` then `g()`);
  - a function declared with a name, read as a value: bound (`g = made` then `g()`) or handed back (`() => made`, `return made`, a function that returns one, then `h = mk()` and `h()`);
  - a closure a closure returns in place (`mk = () => { return () => { … } }`);
  - a parameter whose type is a closure type ([section 13](#13-a-closures-type-is-written-params--return)).

  Under 4 such a call is refused (`MOV_CONSTRUCT_NOT_ADAPTER` / `MOV_CALL_NOT_MOVEMENT`).
- The call's type is what the closure returns, records included, so the rules for a record in data (a written field, a graph entry, a plugin argument) see a record it hands back.
- A value that may not be a closure (`COALESCE(c, 2)`), or whose type nothing shows, is refused where it is called (`MOV_CALL_NOT_MOVEMENT`), never run on the chance.
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

- There are no methods: a dot on a record or map always reads a field, and a closure is never under a key ([section 11](#11-a-closure-is-not-data)). Why: a closure under a key made `box.g()` a second way to call a function, and `box.g` mean two things.
- Under Dancing Wren (5), a dotted call of a function that is no built-in (`o.nope()`, `box.g()`) is `MOV_FUNCTION_UNKNOWN`. The engine reads `o.f(…)` as `f` run in `o`'s scope, and outside a write field there is no such function to run, so the run always failed where it reached the call; the checker now says so where it is written. Versions 1–4 are unchanged (a saved movement never breaks). Two forms are unchanged on every version: a built-in in a record's scope (`o.UPPER(name)`), and a function inside a write field, which the target may advertise.

## 13. A closure's type is written `<(params) => <return>>`

- Under Dancing Wren (5) a closure's type is written as TypeScript's function type, in angle brackets: `<(params) => <return>>`. Each parameter is typed as a function's is, and the return is written as a function's return annotation is.

```
function run(handler: <(c: <crm-[:company]->>) => <text>>) { … }   # a parameter
function pick(): <() => <text>> { … }                               # a declared return
```

- A closure type is never a list's element or a record type's key (`<() => <text>>[]` and `<{ run: <() => <text>> }>` are `MOV_CLOSURE_NOT_DATA`): a closure is not data.
- A closure that returns a list is `<() => <text[]>>`; `<() => <text>[]>` is ambiguous and refused. Every parameter needs a type: a caller of the closure is checked against it.
- A parameter of closure type is called (`handler(c)`), typed by its return and held to its parameters (`MOV_CALL_ARITY`).
- A closure fits a closure type as TypeScript's assignability says. Parameters are contravariant: each of the closure's parameters takes what the type's hands it. Returns are covariant: what the closure returns, what it may hold included, is what the type's returns. A closure that takes fewer parameters fits, and the extra arguments are dropped; one that takes more does not. A misfit is `MOV_CALL_ARG_TYPE` (or `MOV_RETURN_TYPE` for a declared return), naming what the closure returns.
- A closure written in place is an argument to a closure-typed parameter: `run((c) => c.name)`. Its untyped parameters are typed by the closure type (contextual typing).
- Under Quiet Heron (1) to Luminous Owl (4) the syntax is a parse error that names version 5, because a closure is not a value there.

## 14. `parallel` is retired for `all`; combinators take arguments and no `await`

- Under Dancing Wren (5) every `parallel` form is `MOV_PARALLEL_RETIRED`. `all(f, g, …)` is the same join, as TypeScript's `Promise.all` is: every arm runs, at once, and the answer is the list of what each returned, in argument order. Why: a closure is not data ([section 11](#11-a-closure-is-not-data)), so the arms are passed as arguments, not in a list.
- For arms written down the diagnostic carries the exact rewrite, which a tool applies:

```
# before
r = await parallel([a, () => { … }])

# after
r = all(a, () => { … })
```

- Later reads stay clean: the answer is a tuple, slot by slot, so `AT(r, i)` reads exactly what slot `i` of the receipt did: a value arm's value, a record arm's record (`AT(r, 0).name`), and an arm that returns nothing reads absent.
- `all` takes `MAP`'s settings where they mean something for a join, as a record written last: `all(a, b, { concurrency: 2, onError: "warn" })`. `concurrency` is how many arms run at once (all of them without it); an arm that parks is waiting, not running, so it frees its place for the next. `onError: "warn"` or `"ignore"` leaves the slot of an arm that fails null (and its slot type may be absent), `"warn"` saying so on the trace; the default fails the run, as before. `initialConcurrency` is refused.
- `race` takes its arms as arguments too: `race([q, t])` is `MOV_COMBINATOR_ARMS_ARE_ARGUMENTS` (`all([…])` as well), and the fix drops the brackets: `race(q, t)`. `race` takes no settings.
- No `await` on `race` or `all`: `await` marks only the suspension itself, where the run parks (`await sleep(…)`, `await until(…)`, reading an answer with `await FIRST(q-[:Response]->)`). A combinator does not park by itself; its arms may, and the run parks where they do. `await race(…)` and `await all(…)` are `MOV_COMBINATOR_NO_AWAIT`, and the fix removes the `await`. An arrow body that awaits one, `g = () => await parallel([…])`, gets the same fixes: `g = () => all(…)`.
- Arms built at run time (`parallel(fs)`) have no fix: name each function as an argument, `all(f, g)`.
- The refusal of the `parallel { … }` block points at `all` under 5. Under 4 and earlier `await race([…])` and `await parallel([…])` are unchanged, and `all` is still a retired name.

## 15. Diagnostic code index

| Code | Where |
| --- | --- |
| `MOV_CALL_ARG_MAYBE_RECORD` | [A value that may be a record is no record parameter](#8-a-value-that-may-be-a-record-is-no-record-parameter) (a value parameter, a collection op's member included) |
| `MOV_CALL_ARITY` | [A value that is a closure is called](#12-a-value-that-is-a-closure-is-called) (a call of one of several closures names every arity) |
| `MOV_CALL_ARG_TYPE` | [A closure's type is written `<(params) => <return>>`](#13-a-closures-type-is-written-params--return) (a closure that does not fit a closure type); [A value that is a closure is called](#12-a-value-that-is-a-closure-is-called) (two of several closures whose parameters share no argument); [A value that may be a record is no record parameter](#8-a-value-that-may-be-a-record-is-no-record-parameter) (a collection op's member against its function's parameter) |
| `MOV_CALL_CLOSURE_RETURNS` | [A value that is a closure is called](#12-a-value-that-is-a-closure-is-called) (warning under 3 and 4: a later closure may hand back a record the first does not) |
| `MOV_CALL_NOT_MOVEMENT` | [A value that is a closure is called](#12-a-value-that-is-a-closure-is-called) (a value that may not be a closure, or whose type nothing shows) |
| `MOV_CLOSURE_NOT_DATA` | [A closure is not data](#11-a-closure-is-not-data) (a closure as a list element, a record or map value, a field, an op's or a combinator's answer, or a type's list element or key; since 5) |
| `MOV_COMBINATOR_ARM_NOT_FUNCTION` | [`all` and `race`](#14-parallel-is-retired-for-all-combinators-take-arguments-and-no-await) (an argument that is no function) |
| `MOV_COMBINATOR_ARMS_ARE_ARGUMENTS` | [`all` and `race`](#14-parallel-is-retired-for-all-combinators-take-arguments-and-no-await) (arms in a list; the fix drops the brackets; since 5) |
| `MOV_COMBINATOR_NO_AWAIT` | [`all` and `race`](#14-parallel-is-retired-for-all-combinators-take-arguments-and-no-await) (`await race(…)`, `await all(…)`; the fix drops the `await`; since 5) |
| `MOV_DELETE_NOT_DECLARED` | [`delete` only where the system declares it](#4-delete-only-where-the-system-declares-it) |
| `MOV_DELETE_NOT_RECORD` | [`delete` only where the system declares it](#4-delete-only-where-the-system-declares-it) |
| `MOV_EXPR_CLOSURE_POSITION` | [A closure is not data](#11-a-closure-is-not-data) (under 4 and earlier; under 5 a closure written in a list or map is `MOV_CLOSURE_NOT_DATA`) |
| `MOV_FUNCTION_UNKNOWN` | [No methods](#no-methods) (a dotted call of no built-in, `box.g()` included; version 5) |
| `MOV_FILE_IN_TEXT` | [A file is never joined into text](#6-a-file-is-never-joined-into-text) |
| `MOV_HANDLE_FILE_NOT_SENT` | [A write handle's unsent file is not a file](#10-a-write-handles-unsent-file-is-not-a-file) |
| `MOV_META_HOP_RETIRED` | [`#` hops are retired](#3--hops-are-retired-a-plugin-is-a-function) |
| `MOV_PARALLEL_RETIRED` | [`parallel` is retired for `all`](#14-parallel-is-retired-for-all-combinators-take-arguments-and-no-await) (with the `all` rewrite for arms written down) |
| `MOV_RECEIPT_RECORD_SLOT` | [A record a combinator arm hands back reads as itself](#9-a-record-a-combinator-arm-hands-back-reads-as-itself) (warning, on a move up across 5) |
| `MOV_RETURN_TYPE` | [A declared return takes what the body may return](#7-a-declared-return-takes-what-the-body-may-return) (a body's returns that may hold a record or file; since 5) |
| `MOV_RESOURCES_NOT_EXTRACTED` | [`_resources` only on an extraction's result](#5-_resources-only-on-an-extractions-result) |
| `MOV_TRANSFORM_HOP_RETIRED` | [`#` hops are retired](#3--hops-are-retired-a-plugin-is-a-function) (since 3; under 5 the message shows the function form) |
| `MOV_WRITE_BIND_RETIRED` | [`write … bind` is retired](#2-write--bind-is-retired) |
