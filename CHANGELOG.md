# Changelog

Every pull request that changes what an operator sets or an author writes adds a line under
Unreleased in the same pull request. Tagging a release moves the Unreleased entries under a heading
for the new version, with the date. When a new minor line is cut, move the previous minor's sections
(with their link references) into `docs/changelog/v0.N.md` and list it under Earlier releases.

Entries are written for two readers: an operator running a self-hosted installation (what to set,
what a deploy applies, what behaves differently) and an author writing automations in the movement
language (new or changed constructs, plugins, adapters, handbook idioms). The format follows [Keep a
Changelog](https://keepachangelog.com/en/1.1.0/); versions are the git tags described in
[`deploy/UPGRADING.md`](deploy/UPGRADING.md).

## [Unreleased]

Language version 5, **Dancing Wren**, arrives. New automations are written in it. Every change in
it is a refusal, so an automation that uses a retired form has an error under 5, stays on its
version, shows Review and behaves exactly as before; rewrite the form and upgrade (`lf upgrade`,
or `upgradeAutomation` through the API). Versions 1 to 4 keep their behaviour (proved by a version
4 conformance corpus). Every rule, with rewrites, is in the [Dancing Wren migration
guide](docs/language/dancing-wren-migration.md).

**An upgrade rewrites the old spellings, when asked.** `upgradeAutomation` (and the agent tool)
first rewrites an automation by the fixes the checker offers under 5 that are marked safe (they
provably keep the meaning), and lists the others with their rewrite (`applyAllFixes` applies them
too); only the rewritten text is judged, and when it is clean the text and the pin move in one
save. An automation left with errors keeps its text and its pin, and what is left is listed
against the rewritten text. The deploy check never rewrites an automation's text: it moves a pin
only when the text as written is already clean under the newer version, and otherwise tells the
team an upgrade can rewrite it. For a local project, `lf upgrade` rewrites the movement files in place
(`lf upgrade --check` prints the diff); `pnpm --filter movement-lang language:upgrade` does the same
for any file or a program on stdin. `AT(x, "k")` is rewritten to `x["k"]`, which keeps a record's
refusal (`x.k` would read the field). A narrowing a host registers matches a hop's WHERE however
the field read is spelled (`e.action` under 5, `action` before). Comments and layout outside the rewritten spans are kept byte
for byte; on text already in the version 5 spelling it changes nothing.

### Language version 5, Dancing Wren: what breaks

- **A field read off text is refused** (`MOV_TEXT_HAS_NO_FIELDS`, from version 5). `t.Name` where
  `t` holds text reads nothing: both engines answer null. Why: a text has no fields, and a read
  that always answers null is a mistake the checker said nothing about. Under 3 and 4 it is a
  warning, and the program runs as before.
- **The everyday spelling outside walk brackets** (`MOV_V5_SPELLING`, with the exact rewrite as
  the diagnostic's fix). Why: code that runs step by step reads like TypeScript, so a model or a
  person writes it right first time, and a walk's brackets read like a query because the source
  system may run them. Core words are lower case (`map filter reduce count first only exists
  coalesce sort members ai fail`); the other built-ins live in namespaces (`UPPER(t)` is
  `Text.upper(t)`, `DATE.TODAY(z)` is `Date.today(z)`, `SUM(xs)` is `List.sum(xs)`); `&& || !
  c ? a : b true false null` replace `AND OR NOT IF … END TRUE FALSE NULL`; `ISNULL(x)` is
  `x == null`, `EXISTS(value)` is `value != null`, `AT(xs, i)` is `xs[i]`; settings go last
  (`map(xs, f, { concurrency: 2 })`, `ai(p, { tier: "careful" })`, `await until(c, { every: 1h
  })`); `ERROR` is `fail`; `movement` is `function`; an `if` condition is parenthesised; an
  adapter is set up with `crm = connect attio using acme { dryRun: true }` and imported by its
  package tag (`` import { `@lf/attio` as attio } from adapters ``). Inside walk brackets the
  words stay CAPS (`WHERE … AND … CONTAINS`), and a field is read through the hop's alias
  (`-[c:Companies WHERE c.Name == n]->`); a bare name there is only ever a variable, so
  `c.Name == Name` compares the field with a variable of the same name. Messages name built-ins in the program's own version's
  spelling. Upgrade with `lf upgrade` or the API's upgrade, which apply every fix, check the
  result under 5, and move the pin only when it is clean. The handbook, the examples and the
  [migration guide](docs/language/dancing-wren-migration.md#2-the-everyday-spelling) show only
  the new spelling.
- **`write … bind` is retired** (`MOV_WRITE_BIND_RETIRED`). Why: the engine kept the
  correspondence in a store no system holds. Store the link in the system that holds it: a field
  the next write finds the record by (`unique by`), or an edge there.
- **`#` hops are retired** (`MOV_META_HOP_RETIRED`): `-[:#name]->`, `-[f:#resources]->`, on a walk,
  a head, a write or match target, or a type's address. Why: there are no meta edges, only the edges
  a system declares. A plugin is a function: `-[:#transform { plugin: … }]->` (refused since 3)
  now shows the call form, `import { p } from plugins` then `out = p(…)`.
- **`delete` only where the system declares it.** `MOV_DELETE_NOT_DECLARED` when the record's type
  does not say `deletable: true` in its describe; `MOV_DELETE_NOT_RECORD` when the target is a
  value, a list, an extracted node, a record the run built, or anything but one stored record.
  Why: each passed the save and failed at run time.
- **`_resources` only on an extraction's result** (`MOV_RESOURCES_NOT_EXTRACTED`). Off a system's
  record, walk the edge it declares to its files, which the message names from the schema: email,
  Gmail and WhatsApp `Attachments`, Slack `Files`, the knowledge graph `Resources`. Why: the
  reserved reference was read through the event's adapter whatever the record's system, and read
  nothing on the systems that had retired its bundle. Under 5 the engine no longer resolves it
  for a system's record.

- **A file is never joined into text** (`MOV_FILE_IN_TEXT`): `"Attached: ${f}"`, or a value that
  may be a file. Why: it joined as `[object Object]`. Its text is `READ(f)`
  (`"${COALESCE(READ(f), "")}"`); the file itself goes into a field that holds files.
- **A write handle's unsent file is not a file** (`MOV_HANDLE_FILE_NOT_SENT`): `READ(h.doc)`, or
  `h.doc` passed where a file is expected, when the write did not send `doc`. Why: the system
  answers with its description of the file, not a file, so `READ` failed at run time. Read the
  record back through its edge to get the file, as a walk read does; a field the write sent stays
  usable.
- **A value that may be a record, handed to a record parameter** (`MOV_CALL_ARG_MAYBE_RECORD`):
  `v = COALESCE(org, "x")` then `hp(r: v)`, an `IF` of a record and text, or a function or closure
  that returns either. Why: TypeScript's `Org | string` is no `Org`, and the engine refuses the
  value at run time. Narrow it to the record with `IS`, handle the case where it is not one, or
  fill the other arm with a record. A union of records alone is one record and still fits. A record with
  `NULL` is a maybe-absent record and fits. Inside an `IS` arm the value is the record (on every
  version, it passes as a position and enters a graph).
- **A value that may be a record, handed to a value parameter** (`MOV_CALL_ARG_MAYBE_RECORD`):
  `f(COALESCE(co, 1))` or `f(IF c THEN co ELSE 1 END)` where `f` takes `<number>`, or a name bound
  to either. Why: TypeScript's `Org | number` is no `number`. Under 3 and 4 the check said nothing,
  and the call ran with the record where the number was typed (a sum over it came out `NaN`), so
  the refusal is new under 5. Under 3 and 4 it is a warning that blocks the move up. Narrow it to
  the record with `IS` and pass a field off it, or fill every arm with a value. A plugin argument
  and a written field already refused it on every version. A built-in's argument that takes a value
  is held to the same rule: `ROUND(COALESCE(co, 1))`, `UPPER(COALESCE(co, "b"))`. Under 3 and 4 the
  built-in ran on the record as it was (`NaN`, `"[OBJECT OBJECT]"`), so there it is a warning too.
- **A call of one of several closures is held to every one of them**: a function or closure
  whose returns hand back different closures (`return made` on one path, `return label` on
  another), then `g = mk()` and `g()`. The call takes only what every closure takes (each arity,
  and an argument that fits each parameter; two closures whose parameters share no argument are
  named, `MOV_CALL_ARG_TYPE`), and its value is any of their returns, so a record a later one hands
  back is refused where it is written (`MOV_WRITE_FIELD_TYPE`). Why: TypeScript calls a union of
  function types this way. Under 3 and 4 the call was typed by the first closure alone and ran on
  whichever it reached (a record written into a text field, a number into a text parameter), so
  under 3 and 4 each is a warning that blocks the move up (`MOV_CALL_ARITY`, `MOV_CALL_ARG_TYPE`,
  `MOV_CALL_CLOSURE_RETURNS`). A declared return type (`): <() => <text>>`) narrows the closures
  to it.
- **A collection op's members are held to its function's parameters** (`MOV_CALL_ARG_TYPE`,
  `MOV_CALL_ARG_MAYBE_RECORD`): `MAP(["a"], (n: <number>) => n)`, or a function by name, under
  `MAP`, `FILTER`, `GROUPBY`, `KEYBY` and `REDUCE` (whose starting value is held to its
  accumulator). Why: the op calls the function with each member, and TypeScript refuses
  `["a"].map((n: number) => n)`. Under 3 and 4 nothing compared them and the op ran with the member
  as it was (a sum over text came out `NaN`), so under 3 and 4 it is a warning that blocks the move
  up. Type the parameter as the members are, or leave it untyped to take their type.
- **A record a `race` arm hands back reads as that record** (and so does a slot of `all`, which
  replaces `parallel`). `AT(r, 0).name`, or `h = AT(r, 0)` then `h.name`, reads the record
  the arm returned, as `AT([a, 2], 0).name` on a list does; `AT(r, 0) == null` is false. Under 4
  and earlier that slot read null while the check accepted the read, and a program pinned there
  still reads null. A move up across 5 warns a read of such a receipt (`MOV_RECEIPT_RECORD_SLOT`).
- **`count(xs)` counts every item of a list, an empty one (null) included**, as TypeScript's
  `.length` does. Why: `count` is the one way to ask a list's length from 5 (`LENGTH(xs)` is
  rewritten to it), and `LENGTH` counted every item. Under 4 and earlier `COUNT` skips empty items,
  and a program pinned there still does. A move up across 5 warns a count of a list that may hold an
  empty item (`MOV_COUNT_COUNTS_EMPTY`). The rewrites `LENGTH(xs)` → `count(xs)` and `EXISTS(xs)` →
  `count(xs) > 0` of a list keep the meaning, and are marked safe to apply automatically.
- **A hop over records the run already holds keeps its ORDER BY and LIMIT**: an extraction's
  entities (`deals-[c:company ORDER BY c.rank]->`), a `node { … }` or `graph { … }` literal's
  entries and the records written onto a local node, in a block head, an expression and `exists`.
  Under 1 to 4 those two were silently not read there (only `exists` read them). Why: a hop means
  the same thing whatever it walks over. A move up across 5 warns each such hop
  (`MOV_IN_MEMORY_HOP_ORDER`): its result may change.
- **`found != null` on the records a block returned says whether it returned any**, as
  `EXISTS(found)` does. Why: from 5 `!= null` is how a program asks what `EXISTS` asked of a
  value. Under 4 and earlier those records always counted as present, so the test was always true,
  and a program pinned there still reads it so. A move up across 5 warns each such test
  (`MOV_PRESENCE_OF_RETURNED`).
- **`parallel` is retired for `all`** (`MOV_PARALLEL_RETIRED`). `all` is the same join with its
  functions passed as arguments, as TypeScript's `Promise.all` takes its promises:
  `r = await parallel([a, b])` is `r = all(a, b)`, which the diagnostic applies for arms written
  down. The answer is the list of what each arm returned, in argument order, so `AT(r, i)` reads
  what the receipt's slot did. It takes `MAP`'s `concurrency` and `onError` as a settings record
  written last (`all(a, b, { concurrency: 2 })`); every arm runs at once without one, and an arm
  whose failure `onError` forgives leaves its slot null. Arms built at run time are rewritten by
  hand, naming each function. The `parallel { … }` block refusal points at `all` under 5.
- **The extraction keyword is retired** (`MOV_EXTRACT_KEYWORD_RETIRED`): `x = extract from [a, b]
  { node c: "…" { … } }`, with its inline node shapes and `through […]` stages. An extraction is
  the call over a declared node shape: `extract(content, Shape, { tier })` for each record the
  content holds, `extractOne(…)` for the one it describes, and a plugin is called as a function
  (the handbook's enrichment example composes them). Why: one way to extract, whose shape is an
  ordinary declaration. The diagnostic's fix declares the tree as `node XShape` (named after the
  binding, numbered past a name the file holds) and writes `x = extractOne([a, b], XShape, {
  tier })`: the one record the keyword's result was, its fields and nodes read as before. It is
  never applied on its own: that record may be absent where the keyword's result never was (a
  field read off it then needs a fallback), an untyped field becomes `<text>`, and the model is
  asked through the call's prompt. A `through […]` stage has no fix, since no composition of
  plugin calls is provably the same: rewrite it as the enrichment example does.
  **The Rust engine no longer runs the keyword on any version** (its code is deleted). A
  version 1–4 automation holding one still runs on the TypeScript engine, by its version,
  exactly as before.
- **A block's walk off a record that may be absent is refused** (`MOV_ABSENT_REQUIRED`, from
  version 5): `found-[c:company]-> { … }` where `found` is an `extractOne(…)` answer, a `match`
  that may find nothing, an unguarded pick (`only(…)`, `first(…)`, `rows[0]`). Why: the run does
  not skip such a block when the record is absent, it fails at the walk ("'found' is nothing, and
  a hop walks from a POSITION"), on every version and both engines; the checker had read it as a
  block that runs zero times. Guard the walk: `if (found != null) { found-[c:company]-> { … } }`.
  Under 1–4 nothing changes (a saved automation runs whenever the record is found); a move up
  across 5 is an upgrade warning, which holds the pin. The write-site refusal of the same records
  no longer offers the block as a way out from 5.
  A guard is any branch that always leaves (`fail(…)`, a `return`, an `if` whose every arm and
  `else` leave): below it the record counts as present, as below `if ISNULL(x) { ERROR(…) }` on
  1–4, and `x != null && …` sees `x` present on the right side. Nothing else narrows.
- **A null test on an extracted `<text>` field is refused for the call's records too**
  (`MOV_PRESENCE_TEST_ON_TEXT`, from version 5): `if (r.title != null)` where `r` is a record
  `extract(…)` or `extractOne(…)` handed back and `title` is `<text>`. Why: a text the model did
  not find is `""`, never absent, so the test always answers the same; the keyword's result has
  been refused since version 2, and versions 3 and 4 let the call's through. Annotate the field
  `<text | null>` to keep the test, or test `r.title != ""`. Under 3 and 4 nothing changes; a
  move up across 5 is an upgrade warning, which holds the pin.
- **`race` and `all` take their arms as arguments** (`MOV_COMBINATOR_ARMS_ARE_ARGUMENTS`):
  `race([q, t])` is `race(q, t)`, which the diagnostic applies. Why: a closure is not data, so there
  is no list of them to pass. A name that is not a function is refused where it is passed
  (`MOV_COMBINATOR_ARM_NOT_FUNCTION`).
- **No `await` on `race` or `all`** (`MOV_COMBINATOR_NO_AWAIT`): `r = await race(q, t)` is
  `r = race(q, t)`, which the diagnostic applies. Why: `await` marks only where the run itself
  parks (a sleep, an until, an answer read with `await FIRST(…)`), and a combinator does not park
  by itself; its arms may, and the run parks where they do. Versions 1 to 4 keep `await race([…])`
  and `await parallel([…])` exactly.
- **A callback's call that leaves its function a parameter open** (`MOV_CALL_ARITY`):
  `callback(() => book("Acme"))` where `book` takes two. Why: `() => f(x)` is a closure that takes
  nothing, so, as in TypeScript, it passes every argument itself; what the platform sends when the
  callback fires is a parameter the closure declares (`callback((d: <date>) => book("Acme", d))`).
  `callback(book)`, a function named bare, still leaves every parameter to the platform. Versions
  1 to 4 keep `callback(book("Acme"))` filling the last parameter at fire time. The diagnostic's
  fix writes the closure from `book`'s own declaration (each open parameter under its name and
  type). It is not applied on its own: both engines refuse to run the old form at fire time, so
  the rewrite turns a run that failed into one that fires.
- **A package of plugins imported without a name** (`MOV_V5_IMPORT_NEEDS_ALIAS`, the fix adds
  one): ``import { `@lf/web` } from plugins``. Why: its members are called through the name after
  `as` (`web.fetchUrl(u)`), and a tag is no name a program can write, so nothing could call them.
- **A record value handed to a plugin's text input** (`MOV_CALL_ARG_MAYBE_RECORD`):
  `research({ context: s })`, or a value that may be one. Why: as TypeScript refuses an object
  for a `string`, a text input takes text. Under 3 and 4 the record was passed through as it was,
  so there it is a warning that blocks the move up.
- **A value that may be one of several records reads only what every one offers**, as a
  TypeScript union. One rule types an `IF`, a `COALESCE`, a function's returns, a list literal's
  members and `MULTI`. Records of one type are that type (`A | A` is `A`). Records of different
  types (People or Companies) read a field every member has as the union of its types, and a field
  one lacks is `MOV_UNKNOWN_PROPERTY`, naming it. No arm is preferred: a field one arm proved present
  is present only when every arm proved it, and a function is no longer typed by its first return.
  Why: each ran unchecked (a missing field read null, or a missing value was written). Under 3 and 4
  what the rule refuses is an upgrade warning.
- **The same rule reaches three more places.** Calling one of several closures hands back the union
  of their records, so a read one record lacks is `MOV_UNKNOWN_PROPERTY`. A walk or a linked write
  off a held list of records (`both = [lead, co]`, then `both-[:Manager]->`) asks every member, so
  an edge one lacks is `MOV_TRAVERSE_UNKNOWN_EDGE` or `MOV_LINKED_UNKNOWN_EDGE`. An `IF` of plain
  values is what either arm may be: `IF c THEN p.Name ELSE p.Email END` may be absent, so a
  required field refuses it (`MOV_ABSENT_REQUIRED`). Why: each was untyped and ran unchecked. Under
  3 and 4 what this refuses is an upgrade warning; a closure value is called only from 5.
- **An undescribed event written into a json field is refused** (from version 5). An event whose system the catalog does not describe is still a record. Written into a json field (whole, inside a value, through a name, or handed back by a closure) it is refused at save (MOV_WRITE_FIELD_TYPE), as a described one is; before, the run wrote the engine's own description of it. A second name for it keeps the read refusal (MOV_EVENT_UNDESCRIBED). Versions 1–4 unchanged.
- **A file-level value holds a value only** (`MOV_FILE_VALUE_RUNS`, from version 5). A call to a function or a plugin (written whole or nested in the value), a write, an extraction, a walk, a wait, a callback or a node there is refused at save. The engines already failed such a run; a file's values are worked out before every run and again on every resume, so a call there would run, and spend, each time. A literal, a built-in's value, a closure and a construction stay.
- **A walk inside an expression off a record that may be absent is refused too** (`MOV_ABSENT_REQUIRED`,
  from version 5): `count(found-[c:company]->)`, `exists(found-[c:company]->)`, a hop read in a write
  field (`found-[c:company]->.name`), a hop in an interpolation or a condition, where `found` is an
  `extractOne(…)` answer, a `match` that may find nothing, an unguarded pick. Why: the run fails at the
  hop when the record is absent, as it does for a block, and the checker said nothing. `exists(found)`
  has no hop and answers false for an absent record, so it is allowed. Guard the walk:
  `if (found != null) { … }`. Under 1–4 nothing changes; a move up across 5 is an upgrade warning,
  which holds the pin.

- **Forms the engine does not run are refused at save** (from version 5; each message names the
  spelling that does run). Why: each passed the check and failed the run.
  - A linked write or match whose target walks more than one edge (`MOV_WRITE_MULTI_HOP`):
    walk to the parent in a block, then write off its alias.
  - A walk with no root, as a block head or in an expression (`MOV_WALK_ROOTLESS`): name the
    record it starts at. Only a rootless `exists(-[…]->)` inside a hop's WHERE or ORDER BY has a
    record to walk from (the one that hop lands on), so it stays, and it now also runs over a
    record the run built (an extraction call's nested record).
  - `unique by` on a write to a declared node (`MOV_WRITE_SHAPE_UNIQUE`): the record lands in
    memory, so there is nothing to find it in.
  - `KG_VALUE(…)` and `KG_EXISTS(…)` (`MOV_KG_QUERY_RETIRED`): walk the graph instead.
  - `await` on a name holding a list of records (`MOV_AWAIT_ON_LIST`): an await parks on one record.
  - A record written as the value of a field that is a relationship (`MOV_WRITE_LINK_FIELD`; before
    5 an info nudge): write off the record, or link the two after the write.
  - A walk off a json value (`MOV_JSON_HAS_NO_EDGES`): a json value has no relationships; read a
    key with a dot.

### Language version 5, Dancing Wren: it runs as Rust does, not as JavaScript did

Version 5 runs only on the Rust engine, so the machinery that copied JavaScript's quirks is gone.
Each line is a difference a version 5 run can show; versions 1 to 4 are unchanged.

- **Numbers print with Rust's shortest digits.** On a 17-digit tie the last digit can differ:
  `TEXT(16086.196899414062)` is `"16086.196899414063"` (JavaScript printed `…062`); both read
  back as the same number. The layout is unchanged (`1e+21`, `1.5e-7`, `0.000001`).
- **Letters and numbers are Rust's.** A FUZZY match's words split on what `char::is_alphanumeric`
  refuses, so a combining vowel sign no longer breaks a word (`हिंदी` is one word; it was `ह` and
  `द`). The CHUNKS entities estimate reads capitals with `char::is_uppercase`.
- **A regex group name is ASCII** (`$`, `_`, letters, digits): `(?<𝒜>.)` is a malformed pattern.
- **ONLY's failure quotes its argument as you wrote it.** `ONLY( [a,  b] )` fails with
  `ONLY([a,  b]) says there is exactly one, and there are 2.` (before, it re-spelled the
  expression in the old formula grammar).
- **LOWER and UPPER use Rust's Unicode tables** (Unicode 17; Node's ICU was 16). Letters Unicode 17
  gave a case now map: `UPPER("ꟓ")` is `"꟒"` (it stayed `"ꟓ"`). `ʕ` is no longer a cased letter, so a
  sigma beside it can lower differently: `LOWER("ΑΣʕ")` is `"αςʕ"` (it was `"ασʕ"`).
- **REGEX_EXTRACT reads whole characters and no Annex B.** `.` matches a whole emoji
  (`REGEX_EXTRACT("x😀y", ".(.)")` is `"😀"`; it was half of it); `\u{1F600}` names one. An octal
  escape (`\1` with no group was U+0001), `\c` without a letter and an unknown letter escape
  (`\p`, `\a`) are malformed patterns, so the call is absent. Escaped punctuation (`\-`, `\@`)
  is still itself. Groups nested past 1,000 deep are malformed (they were handed to TypeScript).
- **A date-time text is ISO 8601 / RFC 3339 only, and no offset means UTC.** `DATETIME("2024-03-05T10:00")`
  is `2024-03-05T10:00:00.000Z` whatever zone the host runs in (it was read in the process's local
  zone). A day the month lacks or the hour 24 is no date-time (`"2026-02-30T00:00Z"` rolled over
  to March 2). A comparison reads only ISO texts as dates: `"item 3" < "item 12"` is false, as
  texts (V8 read both as dates and said true); `true < "9"` no longer orders. Written dates
  (`DATE.PARSE("12 March 2026")`) are read as before.
- **Self-hosting: the engine's `builtins.function` request is gone.** A version 5 run never asks
  the TypeScript standard library for a reading; an unknown function fails the run
  (`MOVENG_RUNTIME: unknown built-in function`).
- **ROUND rounds a half away from zero:** `ROUND(-2.5)` is `-3` (it was `-2`); `ROUND(2.5)` is
  still `3`.
- **A number read from text is a plain decimal.** `NUMBER("0x10")` is absent (it was 16);
  `"0b101"` and `"0o17"` likewise. `"Infinity"`, `".5"` and `"5."` still read.
- **Whitespace is Rust's.** TRIM and a number read from text strip U+0085 and no longer strip
  U+FEFF (`TRIM("﻿ x")` keeps the mark); a regex's `\s` follows suit.
- **Fixed decimals round a tie to even.** A figure with a fixed number of decimals (compact
  numbers, a run's cost in its trace) rounds an exact tie to even: a cost of 0.03125 dollars
  shows `$0.0312` (it showed `$0.0313`).
- **Texts order by code point.** An ORDER BY, SORT or `<` over texts puts `"｡"` (U+FF61) before
  an emoji; JavaScript ordered by UTF-16 unit and put it after.
- **An empty text is no number.** `NUMBER("")` and `NUMBER("  ")` are absent (JavaScript's
  `Number("")` made them 0).
- **Self-hosting: values cross between the engine and its host as plain JSON.** A list is
  `["l", items]` and a map `["o", entries]`, in its own key order. `NaN`, `±Infinity`, `-0` and
  JavaScript's `undefined` cross as `null`; a lone surrogate crosses as U+FFFD. Nothing crosses by
  identity: an adapter that hands back the same object twice hands the engine two equal maps,
  and an object it changes after answering is not seen to change. A built-in function or
  `Object.prototype` no longer crosses; an adapter answering one is refused as any other
  non-JSON value is. A map member holding nothing is left out, as `JSON.stringify` leaves it.
- **A map is a map.** `__proto__` is an ordinary key and name: `{ __proto__: 1 }` holds it, a
  spread copies it, GROUPBY and KEYBY file under it, and a binding, a parameter, a field or a node
  may be called `__proto__` (`MOV_NAME_PROTO` and `MOV_SHAPE_FIELD_PROTO` now apply before
  version 5 only). Reading a key a map lacks is absent, whatever its name: `m.constructor` and
  `m.toString` were JavaScript's built-ins. `TEXT(m)` is `"[object Object]"` whatever keys `m`
  holds (a `toString` key no longer changes it). An extraction reply's field named after a
  built-in (`constructor`) reads as the reply wrote it.
- **A map keeps its keys in the order they were first set**, a number-like key included:
  `{ z: 0, "10": 1, "2": 2 }` lists `z`, `10`, `2` (JavaScript listed `2`, `10`, `z`). TEXT.SERIALISE
  still sorts keys, as texts: `"10"` before `"2"`.

- **A text counts and cuts by character.** `Text.length("😀 smile")` is 7 (it was 8: JavaScript
  counted an emoji's two UTF-16 units). `Text.split(t, "")`, a spread of a text, `Text.chunks`
  and every cut (a trace's 300-character prompt, a value cut at 200, a file bounded for the
  prompt) keep an emoji whole; nothing a run makes holds half of one. Self-hosting: a lone
  surrogate a host's JSON escapes (`"\ud83d"`) is read as U+FFFD, and a parked state, a trace or
  an error no longer writes the `\udXXX` escape back.
- **A field the record lacks reads nothing**, as it does on 1–4. Before, it read null, a value, so
  `node { body: msg.missing }` held a `body`, an `IS` test counted it present, and a write sent
  `body: null`. A field the record holds as null still reads null. For embedders: an
  `adapters.call` answer of nothing is `{}`, with no `result`.
- Not a run difference: the Rust engine's test fixtures for the built-ins, regexes, CHUNKS, file bounds and mixed-key sorts hold Rust's own answers, no longer regenerated from the TypeScript engine.

### Language version 5, Dancing Wren: new

- **`fail("…")` inside an expression**: `coalesce(x, fail("no x"))`, `c ? a : fail("…")`. It
  never returns, so its type is TypeScript's `never`: a choice between it and a value is that
  value (`coalesce(m, fail("…"))` is `m` present), and it fits any type. An `else` arm knows its
  condition false, and the code after a binding whose arm only fails knows what that arm ruled
  out (`y = m != null ? m : fail("…")` proves `m` present below). The run fails with the message
  exactly as the statement `fail("…")` does. Under 4, `ERROR` inside an expression stays
  `MOV_FUNCTION_UNKNOWN`.
- **`sort` by a function key**: `sort(xs, (r) => Text.lower(r.name), { order: "desc" })`. The
  function runs once per member with the member bound to its parameter, so a name inside it is
  never a field read in the member's scope, and an outer variable can never hide a field. The sort
  is stable and a missing key sorts last whichever the order, as `SORT` did. A key that answers a
  record or a value with named parts is refused (`MOV_SORT_NEEDS_KEY`), one that answers several
  values is `MOV_ORDER_KEY_MULTI`, and the one setting is `order` (`MOV_COLLECTION_OP_CONFIG`
  otherwise). The upgrade rewrites ``SORT(xs, `field`)`` to `sort(xs, (r) => r.field)`; the fix
  is marked safe only where no variable named `field` (or `r`) is in scope, because the old key
  read such a variable first.
- **A closure is not data** (`MOV_CLOSURE_NOT_DATA`). A closure lives in a variable (`g = label`,
  a call that answers one), in a parameter, or is passed as an argument to a parameter that takes
  one (`MAP(xs, (x) => …)`, `race(a, b)`, `all(a, b)`, a closure-typed parameter). It is never an
  operand of a value expression: `IF … THEN a ELSE b END` or `COALESCE(a, b)` choosing between
  closures, a comparison, interpolation, arithmetic, `NOT`/`AND`/`OR`, a condition, or a built-in's
  argument that is not its function. Refused: a closure as a list's element, a record or map's value (`{ g: label }`), a field
  written, a spread, a `MAP` whose function returns one, `GROUPBY` or `KEYBY` over closures, a
  `race` or `all` arm that returns one, and a type whose list element or record key is a closure
  (`<() => <text>>[]`, `<{ run: <() => <text>> }>`). There are no methods: a dot on a record or
  map always reads a field, and `box.g()` is `MOV_FUNCTION_UNKNOWN`, as `o.nope()` is. Under 4 a
  closure is no value at all, and a closure written in a list stays `MOV_EXPR_CLOSURE_POSITION`.
- **A value that is a closure is called**: a bound closure (`g = () => …` then `g()`), a function
  declared with a name read as a value (`g = made`, `() => made`, `return made`), a closure a call
  returns, or a closure-typed parameter. The call's type is what the closure returns, records
  included, so the record-in-data rules see a record it hands back. A value that may not be a closure, or whose type nothing shows, is refused where
  it is called (`MOV_CALL_NOT_MOVEMENT`). A body that is one call, `(f) => f()`, returns the call:
  a callee that waits parks the run, and one that returns nothing makes the closure return
  nothing. A body that is a combinator, `() => all(f, g)`, returns its answer.
- **A closure's type is written `<(params) => <return>>`**, TypeScript's function type:
  `handler: <(c: <Company>) => <text>>`, or a declared return. A closure-typed parameter is called.
  A closure fits the type with contravariant parameters (fewer is fine) and covariant returns
  (`MOV_CALL_ARG_TYPE` otherwise), and one written in place is an argument, its parameters typed by
  the type. Under 4 it does not parse.
- Adapter protocol: a type's describe may declare `deletable: true` (optional; absent means no).
  Attio, Affinity, Airtable, Evertrace (not signals), the knowledge graph and Valuations declare it
  where they delete. No protocol version bump: the field is additive, but under language version
  5 a remote adapter that does not declare it has every `delete` refused.
- The knowledge graph's `Resources` edge is walked by its name on every version
  (`c-[f:Resources]-> { … f.URL … }`), its landing typed with `Name`, `URL` and `Type`. The
  adapter matches it by its reserved address, so a team's ontology edge named `Resources` stays
  the ontology's.

- `-[f:_resources]->` reads off a record an extraction call found (`extract`, `extractOne`), and
  off its nested records: the content the call read, a FILE resource per file and a TEXT one per
  text. Before, the checker refused it. A paused run keeps them (park state: a `nodePosition` may
  carry `resources`).
- A built-in call on a line by itself (`Text.upper(x)`) parses, and the checker reports it as a
  value nothing reads, instead of a parse error.
- A node declared or written inline with a field or nested node named `__proto__` checks: the
  TypeScript checker threw on it.

### Language version 5, Dancing Wren: where it runs, and pauses

- **A run's engine is its pinned language version, with no fallback.** Version 5 and later run on
  the Rust engine, 1 to 4 on the TypeScript engine. The Rust engine refuses a run pinned below 5
  by name (`language_version_runs_on_typescript`) before it asks anything, and the TypeScript
  engine no longer runs version 5.
- **The checker is the one gate.** The Rust engine no longer screens a program before it runs
  (admission is gone). A construct it does not run fails the run where it is met
  (`MOVENG_UNSUPPORTED`, naming the reason), possibly after earlier writes; a checked program that
  reaches one is a checker or engine bug, and a test runs every version 5 program in the repository
  to catch it.
- A parked state the Rust engine cannot read fails its resume, naming why. A version 5 run the
  TypeScript engine parked (under the old emergency switch) cannot resume and fails saying so; a
  version 4 run a Rust park left resumes on the TypeScript engine.
- The Rust engine runs an extraction call's written `model` when the run carries no model list (a
  custom embedder), instead of refusing it: the checker held the model to nothing, so the host's
  model call answers for it.
- A host in any process zone runs version 5 alike: a date-time with no offset is UTC, so the shim
  sends no zone, and a process under a zone `Intl` cannot name (`TZ=GMT+3`) no longer fails its runs.
- **A paused version 5 run resumes on the library text it paused with.** Before, a resumed run read the libraries it imports from the team's saved files as they were at the resume, so an edit while it waited reached the rest of the run (code already parked kept its own copy). Now the pause pins every library the run linked, and the whole resumed run reads those texts. The movement's own text was already pinned to its version. Versions 1–4 are unchanged.
- **Park state contract version 2** (docs/contracts/park-state.md), written and read only by the Rust engine (language version 5 on). A paused run keeps all of its run state as before; code (a closure, a kept walk, a body-local node declaration, a run-time arm) is named by its place in the pinned program instead of carried as its syntax tree, and a collection op by its span. The TypeScript engine (versions 1–4) writes and reads version 1, and refuses a version 2 state by name. No version 2 state predates this (version 5 is unreleased).
- **Library texts a pause pins are kept once, by hash.** Self-hosted Postgres gains `automations.park_library_source` (migration `20261016_120000_park_library_source`); `lf` gains a `park_library_source` table in its state file. An embedder may serve the new optional host family `park.sources` (`save`, `load`); without it, a pause carries each library's text itself.
- `lf` refuses a project, or a parked run, pinned below version 5, saying to run `lf upgrade`.
- Self-hosting: `MOVEMENT_ENGINE`, `MOVEMENT_ENGINE_FALLBACK`, `MOVEMENT_ENGINE_DRY_RUN_EVERY` and
  `MOVEMENT_ENGINE_V5_ON_TS` are retired, and boot refuses any of them set. The admission dry run,
  its daily roll-up and `pnpm engine:refusals` are gone. `GET /api/v1/system/engine-stats` answers
  only the Rust segments' counters.
- Self-hosting: the `trigger_run.engine_reason` column is dropped (it was always null), by an
  ordinary migration operators run normally; the operator run views no longer carry
  `engineReason`. `engine` stays.
- For embedders: `movement.wasm` no longer exports `eval_expression`, and `movement-lang` no longer
  exports `callEvalExpression`.
- **The Rust engine runs forms it used to refuse as unsupported:**
  - a walk off a name holding a value starts from the records it holds: one record is itself, a
    list is each of its records, and anything else adds nothing to walk from (so a walk off a value
    that found nothing counts 0, and `exists` is false);
  - a walk from a callback inside an expression (`count(cb-[k:Called]->)`), reading the calls
    recorded so far, as a block over the callback does;
  - an `await` on an edge of a record the run read rather than wrote (the event, a walk's landing,
    or one record a value holds), asked of that record's system by its own id;
  - a kept (`lazy`) walk read as a bare value (`count(people)`): the records it lands on at that
    read, across a pause too;
  - the event read as a bare value (`coalesce(msg, r)`): the record that fired the run.
- **Endings that depend on what the system answers are run failures** (`MOVENG_RUNTIME`), not
  refusals by construct: an `await` on a system that cannot be awaited, or on a value holding
  nothing; an integration function such as `DOMAIN_OF()` written to a field whose system does not
  offer it; a collection op over a value that read as empty.
- **A host answer of the wrong shape ends the run with a coded runtime error** naming the host call
  and what was wrong (for example "the host's lookup.resolveActingUser answered something
  malformed: expected the principal's `id` as text, got nothing"). Before, the run ended with a raw
  JavaScript error. Covered: the acting user, a plugin's result (a `records` list must hold
  objects), a callback's calls, an awaitable adapter's resolution, a refetched record, and a file
  reader's `unreadable` reason.
- A paused run whose saved state names code the program does not hold (or a library it does not
  link) fails its resume up front, before anything runs (`resume_state_code_does_not_read`).
  Before, it failed partway through.
- A run whose host names a function taking a value as its entry fails saying the function is a
  callee, no longer that the checker should have caught it.
- The `unreproduced: true` marker beside the Rust engine's own refusals is gone: nothing read it.
  Such a refusal still ends the run as `MOVENG_UNSUPPORTED`, never forgiven by `onError`.
- The dev loop's scripts and fixtures that ship movement source (`pnpm dev:whatsapp setup`,
  `dev:airtable`, `dev:dealroom`, `dev:granola`, `dev:telegram`, `dev:gmail`, `dev:evertrace`, the
  `verify_*` probes, the `.mvt` fixtures) are written in the version 5 spelling.

### Self-hosting: the bundled object store is SeaweedFS (action needed if you used the bundled MinIO)

- **The compose bundle's object store is now [SeaweedFS](https://github.com/seaweedfs/seaweedfs)
  (`chrislusf/seaweedfs:4.48`, Apache-2.0), not MinIO.** Why: MinIO no longer publishes container
  images, so every pull of `minio/minio` — including the tag the bundle pinned — is refused, and a
  fresh installation could not start its file store. The service is `objectstore` on a new volume,
  `objectstoredata`; its profile is `objectstore`, and `minio` in `COMPOSE_PROFILES` still starts it.
  Setting `AWS_S3_ENDPOINT` parks it exactly as before. Nothing changes for an installation that
  names its own object store.
- **If your installation used the bundled MinIO, its files stay in the `miniodata` volume and the
  upgraded installation does not see them until you act.** Nothing deletes that volume (the compose
  file no longer names it, so not even `down -v` reaches it). Two safe options, both through the new
  `deploy/legacy-minio.yml` override, which runs your old MinIO from the image already on your
  machine: **(a)** keep MinIO as your own store — add the override to `COMPOSE_FILE` and point
  `AWS_S3_ENDPOINT=http://minio:9000` and the other `AWS_*` values at it; or **(b)** copy the bucket
  into SeaweedFS once — `docker compose -f docker-compose.yml -f legacy-minio.yml run --rm
  copy-from-minio` (rclone copy + check, keys unchanged, MinIO only read) — then remove the old
  volume by hand when you are satisfied. The exact steps are in deploy/SELF_HOSTING.md, "Upgrading
  from the bundled MinIO".
- **`./up.sh` now refuses to start** when the bundled store is in use, `<project>_miniodata` exists
  and `<project>_objectstoredata` does not, naming the two paths above; `--fresh-objectstore` (or
  `LF_FRESH_OBJECTSTORE=1`) is the explicit opt-in to an empty store. A bare `docker compose up`
  is not blocked (containers cannot see host volumes) but logs a WARNING when the config volume
  holds `minio_password`. The copy's check is `rclone check --one-way --size-only`.
- The bundled store's credential is a new file in the config volume, `objectstore_password`;
  `minio_password` is left where it is for option (a) and the copy.

### Security

- WhatsApp deliveries to a subscription's own webhook address (`/api/public/webhook-sync/inbound_whatsapp/...`)
  are now checked the way Meta signs them: the `X-Hub-Signature-256` header, keyed with
  `WHATSAPP_WEBHOOK_SECRET`, the same secret the main WhatsApp address uses. A missing or wrong
  signature, or no `WHATSAPP_WEBHOOK_SECRET` set at all, gets a 401 and nothing is delivered. Set
  `WHATSAPP_WEBHOOK_SECRET` if you point Meta at a subscription address. The main WhatsApp address
  also now answers a signed delivery for some other Meta product with 200 instead of leaving the
  request hanging.
- A credential is never a value, on every language version (`MOV_CREDENTIAL_NOT_A_VALUE`). Its name
  is allowed only as the `credentials:` argument where an integration is set up; the host resolves
  it there. Every other use is refused when you save: bound to a name, read with a dot, put in a
  string or a prompt, compared (with a null test too), passed to a function or a plugin, returned,
  or written into a field. Why: it is a security boundary, and every such use already failed at
  run time. The engine also stops answering a null test on a credential without reading it.
  `MOVEMENT_ENGINE=rust` does the same. The Rust engine also no longer hands out the name of the
  credential an integration was set up with, should an integration ever be held as a value.

### Changed

- The API's WebAssembly artifact (`movement.wasm`) is 1,271,541 bytes gzipped, down from
  1,527,856: the Rust engine runs only version 5 and later, so what it kept to answer as the
  TypeScript engine does is gone (admission, the expression-evaluation export, syntax trees in
  parked state). That is under CI's failure line of 1,572,864 bytes (1.5 MiB) by 301,323 bytes.
  The browser's parser artifact (`movement_parser.wasm`) is 362,824 bytes gzipped.
- **A program that runs on the Rust engine is checked by the Rust checker.** Every run on the Rust
  engine (an automation pinned to version 5 or later, any run under `MOVEMENT_ENGINE=rust`, every
  `lf` run, and their resumes) is checked inside the engine, with no `check.program` request to the
  host; saving, validating, upgrading and the deploy check of a movement pinned to version 5 or
  later use the Rust checker too, and so does `lf check`, so an author sees exactly the diagnostics
  the run enforces. Versions 1 to 4 keep the TypeScript checker, as do the editor's live
  diagnostics and completions for now. The two checkers give the same diagnostics, in the same
  order, on the whole versions 1 to 5 corpus. Nothing to set.
- **An automation runs on the engine its language version runs on.** `MOVEMENT_ENGINE` now defaults
  to `by-version` (was `ts`): an automation pinned to version 5 runs on the Rust engine, one pinned
  to 1 to 4 on the TypeScript engine, as before. A version-5 run the Rust engine refuses fails with
  the reason rather than quietly running on TypeScript. A run keeps its engine for its whole life:
  a parked run resumes on the engine its row's `engine` names. `MOVEMENT_ENGINE_V5_ON_TS` (new,
  optional, `false`) is the emergency switch: `true` runs new version-5 runs on the TypeScript
  engine (a run the Rust engine parked still resumes there). Why: version 5 is the Rust engine's
  language, and the TypeScript engine goes once nothing is pinned below 5. `rust` and `ts` still
  force one engine for every version, for testing. Boot now refuses `MOVEMENT_ENGINE_FALLBACK` set
  beside anything but `MOVEMENT_ENGINE=rust`, and the switch beside `rust` or `ts`. The admission
  dry run now counts only version-5 runs the TypeScript engine runs (every run under `ts`).
  Version-5 runs parked before this release were recorded as engine `ts` and finish on the
  TypeScript engine, so operators will see some version-5 runs on TypeScript after the upgrade.
  A version 1 to 4 run always resumes on TypeScript, which reads a Rust engine's parks.
- `MOVEMENT_ENGINE=rust` speaks language version 5 as the TypeScript engine does: a `_resources`
  walk off a system's record fails with the same error under 5 (versions 1 to 4 read it as before),
  the knowledge graph's `Resources` edge is walked by its reserved address on every version, and a
  catalog that declares a type `deletable` or an edge `resources` loads in the Rust engine. It runs
  version 5's `all(f, g, { concurrency, onError })` and `race(f, g)` whole, with the same parks and
  traces as the TypeScript engine: `concurrency` bounds how many arms run at once (an arm that waits
  frees its place), and `onError` `warn` or `ignore` leaves a failing arm's slot null, before or
  after a wait.
- `MOVEMENT_ENGINE_FALLBACK` (new, optional): `ts`, the default, runs on the TypeScript engine a run
  `MOVEMENT_ENGINE=rust` sends to Rust and Rust refuses, as before; `none` fails that run with the
  refusal's reason instead, and needs `MOVEMENT_ENGINE=rust` (boot refuses it otherwise). Under
  `none` a resume that answers a question (`resume_answer`) or defers a race's settlement
  (`resume_defers_race_settlement`) fails too, so set it only once the refusals report is empty,
  resume reasons included. Every automation run's row now records `engine` (`ts` or `rust`, for its
  latest segment) and `engine_reason` (the first reason the Rust engine's admission gave for not
  running it, `admitted` when it would take it or ran it, `shim_fault` when the Rust engine faulted
  in the shim, or `ended_at_check` when the run failed its check before either engine ran it,
  neither of which is an admission reason; empty when the dry run was skipped or faulted), shown in
  the operator run views; a deploy applies the new columns, null on earlier runs.
- `MOVEMENT_ENGINE=rust` runs more automations whole instead of handing them to the TypeScript
  engine: `@user_*` and `@actor_*` keys, an integration's field functions, `AI()`, `FILE()` and
  `READ()`, `IS <Declaration>` of a system's record, a records-output plugin's call and every plugin
  argument form, closures called by name, the extraction call (`extract(…)`, `extractOne(…)`), calls
  written inside an expression (a closure's, a plugin's, an extraction's), `ONLY` of any expression,
  `write m.k { … }`, collection ops with `concurrency`, and the file scope as the TypeScript reads
  it. The deployment's `EXTRACTION_TIERS` now reaches the Rust engine too, as run input, so a tier's
  model and effort are the same on both engines. New refusal reasons that can appear in a run's
  `engine_reason`: `nested_movement_call`, `nested_call_form`, `extract_call_shape`,
  `extract_call_settings`. Nothing to set.
- An extraction call's `model` is held at run time to the models this deployment reaches, the list
  the editor and the save already check it against, on both engines. A run whose saved catalog
  carried no model list could name a model the code knows but this deployment has no credentials
  for, pass, and fail at the provider; it now fails before the call, naming the models this
  deployment reaches. Nothing to set.
- A parked run's reason is no longer limited to a fixed list at the database: the core keeps
  `timer`, `await` and `limit`, and a unit (no unit writes its own reason yet; `ask` was a legacy
  value) may park under any other non-empty reason. The column loses its default of `ask` (migration
  `park_reason_unit_owned`). Rows already parked as `ask` are untouched. Nothing to do beyond the
  normal migrate step.
- Automations background work (cron, polls, timer resumes, inbound dispatch, await wakes,
  housekeeping) now runs from the `automations.work` table through one `drain` worker. Deployments
  may run it as an in-process loop (default) or tick it externally
  (`AUTOMATIONS_DRAIN_MODE=external` + `POST /api/v1/system/automations/drain`, body capped at
  `limit` 100 and `maxPasses` 50). The boot-time orphan sweep is replaced by lease expiry plus a
  sweep every 30 seconds that fails a run whose process died mid-step, with its inbound event.
  Events within one inbound delivery may now run concurrently or out of order. In external mode only
  the tick drains; a door enqueues without draining. Each tick records the drain's pulse on
  `/healthz/workers`, and the boot log names the drain mode.
- Automations may run as several instances at once, in either drain mode. The automations advisory
  lock is gone: every entry into a run (its first firing, a wake, a callback body, a timer, an
  operator's resume or abort) holds that run's own lease, a row lease on `trigger_run` (new columns
  `lease_owner`, `lease_until`, `lease_token`; migration `per-run-lease`), so two instances never
  step one run at once. A lease lapses a minute after its holder stops renewing it. A run another
  instance is stepping is retried rather than failed: a wake looks again two seconds later, two
  seconds more each time it finds the run busy (at most thirty), without counting as a failed
  attempt, a timer looks again five seconds later, a callback tap is recorded and answered `202` and
  its body runs from a queued `fire_callback` work row once the run is free, and resuming a paused
  run answers `409` (tRPC `CONFLICT`) to be retried. Every recorded tap writes its body's
  `fire_callback` row in the same transaction as the call, so a failure after a tap is recorded can
  no longer lose its body; a tap whose row cannot be written is not recorded, and the door's error
  may be retried. A body is marked as started before it runs, so it runs at most once: a crash part
  way through leaves that body incomplete rather than running its writes twice. A call is seen by
  `cb-[:Called]->`, and resolves an `await` on it, only once its body has started, so the awaiting
  branch never runs ahead of the body. Aborting a parked run while another instance resumes it
  stamps the cancel for that resume to settle; the periodic sweep settles a stamp that resume
  missed, whatever the run is parked on (it used to cover timer parks only). The external drain tick
  (`POST /api/v1/system/automations/drain`) answers on any instance and ticks may overlap; the `503
  not_lock_holder` answer is gone. The drain result gains `deferred`: rows released for a later
  retry because their run was busy. A segment that loses its run lease (it could not renew it within
  a minute) stops at its next statement, recording and settling nothing, since another instance may
  hold the run; the statement it was in has already run, so its effects can land twice when the new
  holder runs it again. A segment checks its lease again before it settles anything, so one whose
  lease lapsed during its last statement settles nothing either. Its lease fences its writes to the
  run's parked state: once another instance holds the run, the stopped segment can no longer write a
  park row, finish or drop a leaf, clear the run's parked rows and joins, or set the run's status
  (parked, or its terminal status). A lost lease is never forgiven by a collection op's `onError`. A
  first firing stopped this way notes why on its run for the orphan sweep; run status reads (REST
  `run-status`, `listRuns`, `inspectRun`, the run views) report that note as the failure reason only
  once the run has failed. A `parked_run` leaf being resumed is now `resuming`; one left so by a
  dead instance is parked again once its lease lapses. The other units' loops still take their lock,
  so they still run on one instance.
- The five-second await poll is gone. Answering or cancelling a question now wakes the run waiting
  on it directly, through a queued wake that survives a restart. A sweep every 30 seconds wakes runs
  still parked on a closed question whose wake was lost. A fired callback also queues a wake 30
  seconds out, so a run waiting on it still resumes if the process dies before its normal wake. A
  composed deployment that never registers its in-process ask notifier logs an error on each answer,
  and runs waiting on answered questions then resume only through that 30-second sweep. Leftover
  rows of the retired `await_resume_sweep` work kind are deleted at boot.
- Remote adapters speak adapter protocol 2. Breaking for anyone who built one: requests carry
  `protocolVersion: "2"` and a server answers its `manifest` with `protocolVersion: 2`; installing
  asks the server and refuses anything older. Names on the wire are the natural display names.
  Params are validated, and a mismatch answers `bad_request` naming the path. A remote adapter can
  now make an automation wait on its system (`resolveAwait`, `wakeKeys`), push to two new doors with
  its install's own secret (`POST /api/public/adapter/<type>/emit` for new events, `/wake` to resume
  waiting runs; the optional `x-listen-fire-team` header picks the team when one secret serves
  several), page large collections (`iterateRelatedPage`), and move files by URL. A remote's webhook
  subscription must return a secret, and deliveries are signed in `x-listen-fire-signature`. The
  contract is [`docs/adapter-protocol.md`](docs/adapter-protocol.md); the dev loop's fake CRM is the
  reference adapter.
- Identity writes are now serialised across runs, not only within one. Two runs, in one process or
  several, no longer both create the same record. An identity write (`unique by`) takes a Postgres
  advisory lock on its record type in the team (one system, one record type), held for that write's
  find-then-create and released after it. The cost: identity writes to one record type in a team run
  one at a time across all runs. Updates, deletes, links and bound writes lock their own record,
  edge or binding the same way. A write waits up to `MOVEMENT_WRITE_LOCK_TIMEOUT_MS` (new, optional,
  default 60000) for another run's lock, then fails the step with `write lock timeout: <name>`; two
  runs that each hold what the other wants fail this way rather than hang. Each running segment that
  writes holds one database connection of its own for its locks, outside the shared pool, so size
  `max_connections` for one per in-flight segment (see "Automations" in `deploy/SELF_HOSTING.md`).
  Test runs lock in memory, so they never wait on a live firing.
- A resumed run whose adapter has been uninstalled, or whose credential is gone or now serves
  another system, fails naming the instance (`instance <system>(credentials: <name>) is not in the
  catalog snapshot`).
- For embedders: the movement engine reaches everything outside the program through one
  `EngineHost`: adapters, model calls, parking (with record bindings), the trace, cancellation,
  files, acting-user lookup and write locks. A run takes a `CatalogSnapshot`, the team's catalog as
  plain JSON, rather than a live catalog. `makeTestHost` builds an in-memory host for tests. See
  [`docs/engine-host.md`](docs/engine-host.md).

- Remote adapters: every call Listen-Fire makes to a remote adapter now carries `x-listen-fire-team:
  <team id>`, so a server serving several teams knows which install is calling. The push doors
  (`emit`, `wake`) refuse a body over 1 MB with 413 (the limit was 25 MB).
- A remote adapter may no longer take a slug that a built-in adapter answers to (its slug, trigger
  kinds or aliases, in any casing), nor `callback` or `ask`. Installing one is refused, the push
  doors answer 401 for it, and the webhook door never routes to it. An existing install with such a
  slug was already shadowed by the built-in at resolution; it now also stops receiving pushes.
- The webhook door queues a delivery's await wakes before it answers 200. When the adapter's wake
  keys cannot be read, or their wakes cannot be queued, the door answers 500 after the delivery's
  events are receipted and queued, so the sender's retry re-attempts the wakes without running the
  events twice. It used to log the failure and answer 200, losing the wakes.
- For embedders: `EngineHost.park` gains `wake({ segmentId, adapterType, correlationKey })`, and
  `ParkSink.commitAwaitPark` no longer takes a `resolvesNow` closure. The engine re-checks an await
  itself once the park is durable and calls `park.wake` when it already resolved, so every host call
  carries plain data.
- For embedders: the engine host boundary is JSON-complete. Every method of every `EngineHost`
  family takes one JSON request and answers one awaited JSON answer, and
  [`docs/engine-host.md`](docs/engine-host.md) is now the frozen contract, method by method (shapes,
  errors, idempotency, what the host persists, which families are optional). A test round-trips
  every method through JSON and holds the method set to the document. By family:
  - `segment`: new. `open({ runId?, teamId, languageVersion })` answers `{ segmentId }`; `close({
    segmentId })` answers what the segment's adapter calls spent.
  - `adapters`: the engine holds no live adapter. `resolve` answers the instance as data and an
    opaque id; `call({ segmentId, instance, method, args })` answers `{ result }` or `{ error }`. An
    adapter failure carries its `name` and a `detail` (`{ status?, code? }`), and the host logs the
    original at warn. `resolveFileRef` is not callable: bytes stay on the host. Credential ids are
    run input (`credentialIds`).
  - `llm` and `files.resolveFileText`: every priced call takes the run's `budget` and answers its
    `cost`, or a `budget` refusal as data. `arbitrateEntities` answers `{ index, judgeUnavailable?
    }` in place of a callback. A plugin's arguments, output and pricing come from the catalog
    snapshot.
  - `park`: a timer's `wakeAt` and a callback's `expiresAt` are ISO 8601 strings.
  - `control`: `suspendWhen` is gone (a run takes `suspendAt` addresses as input), and the cancel
    gate's reason no longer crosses.
  - `files`: `resolveFile` is gone (imports resolve from the snapshot); files cross as descriptors
    only.
  - `lookup`: `resolveActingUser` names the source instance and the event; the host asks the source
    for actor candidates itself.
  - `locks`: `acquire({ segmentId, names })` answers a token; `release({ segmentId, token })`.
  - `trace`: new. `append({ segmentId, entries })` as the run goes.
  - `makeTestHost` and `makeFakeParkSink` moved to `movement_engine/test_host.ts`.
  - Every call names its segment: `segmentId` is on every request but `segment.open`'s
    (`control.cancel.cancelled({ segmentId })`, `park.callbacks.calls({ segmentId, callbackId })`),
    and the host answers each for the run and team the segment was opened for, so `teamId` is gone
    from `adapters.resolve`, `park.wake`, `park.bindings` and `lookup.resolveActingUser`.
    `adapters.resolve` answers one instance per resolution (system, credential, construction args,
    rehearsal) within a segment, and refuses a segment that is not open. `makeTestHost`'s default
    `park.wake` records each wake with the segment's team.
- For embedders: the five contracts the movement core speaks are written down under
  [`docs/contracts/`](docs/contracts/README.md), each with an integer version of its own and an
  index of what this release supports. The engine host contract moved there as `host-families.md`,
  and the adapter protocol as `adapter-protocol.md`. Two of them now carry their version on the
  wire, and an unsupported version is refused, naming the contract, the version and the supported
  set:
  - The catalog snapshot carries `contractVersion` (version 1). Both readers refuse another version;
    a snapshot without one reads as version 1.
  - When the web app and the API deploy separately, deploy the web app first. A browser still
    running an older bundle has a strict catalog reader that refuses a snapshot carrying
    `contractVersion`, so its editor cannot check until the page is reloaded.
  - `segment.open` carries `hostFamiliesVersion` (version 1). Both of this repository's hosts refuse
    an open under another version, or under none, before opening anything. Breaking for an
    embedder's host: it receives the new field.
  - `lookup.resolveActingUser` answers a principal, `{ principal: { id, display? }, email? }`, in
    place of a team user `{ id, email, name? }`. `@user_id` reads the principal's id, `@user_name`
    its display, and `@user_email` the email, which only a host that has one supplies; without it
    `@user_email` reads as absent. Saved automations are unchanged: this repository's host supplies
    all three as before.
- For embedders: two conformance kits. The host kit is every distinct run of the engine's v1 and v2
  test corpora, recorded at the host boundary (input, each request and its answer, the result) and
  replayable against any engine and host; ours replay on the TypeScript engine, the Rust engine and
  over an HTTP host double. The language kit replays a checks corpus against the checker: `pnpm
  language:conformance <checks.json>`. See "Conformance kits" in
  [`docs/contracts/README.md`](docs/contracts/README.md).
- For embedders: our checks corpus is no longer a file in the repository. The pin holds each
  program's hash, not its text, so `pnpm checks:corpus` in `packages/movement-lang` harvests the
  texts from the tests and writes the corpus to `target/checks/checks.json`; replay that file. The
  corpus format, and replaying your own, are unchanged.
- For embedders: an engine host must serve `clock.now` and `ids.mint`. They are required families of
  host families version 1: the engine reads no wall clock and mints no random id of its own, and a
  host that lacks either is refused before `segment.open`, naming the missing methods. See
  [`docs/contracts/host-families.md`](docs/contracts/host-families.md).
- For adapter vendors: `pnpm adapter:conformance --url <server> --auth bearer|secret` checks a
  remote adapter server against adapter protocol 2 without a Listen-Fire stack or a database. It
  prints `PASS`, `FAIL` or `SKIP` per check and exits 1 on any `FAIL`. See "Build your first
  adapter" in [`docs/contracts/adapter-protocol.md`](docs/contracts/adapter-protocol.md).

- The movement parser is implemented in Rust and loaded as WebAssembly; the TypeScript grammar is
  removed. Browser callers await `initParser()` before parsing. Two parses differ, under every
  language version:
  - Nesting deeper than 128 levels is refused with "nesting too deep". Statements and expressions
    are bounded separately: statements count their own levels, and each expression counts its own
    from zero. It used to be accepted. Much deeper nesting would overflow the WebAssembly parser's
    stack; real automations nest a few levels.
  - An expression error naming an unrecognised character outside the Basic Multilingual Plane (an
    emoji, say) now quotes the whole character. It used to quote half of it.

- Movement-language expression lowering is Rust; the TypeScript lowering is deleted.
- The checker's catalog and type-model core is Rust, behind `catalog_query`, held to the TypeScript
  by a differential.
- Added a checker conformance corpus (`checks.json` and snapshots) that pins diagnostics across the
  checker port.
- `constructor`-style keys (`constructor`, `__proto__`) no longer lower as properties.
- Chains over 1,024 members are refused ("chain too long"). A resource limit, not a language rule,
  so no language-version conditional (same precedent as the 128 nesting limit).
- Deep nesting is refused at the limits: 128 for parse, 2,048 for JSON reads, 256 for typed catalog
  reads. Resource limits, not language rules, so no language-version conditional.
- The movement engine has a second implementation, in Rust (`crates/movement-engine`), behind
  `MOVEMENT_ENGINE` (new, optional): `ts`, the default, runs every movement on the TypeScript engine
  as before; `rust` runs on the Rust engine every run it can run whole, and the rest on TypeScript.
  Any other value fails startup. Under `rust` it runs reads of the event and of values, bindings,
  `if`, `return`, the built-ins, writes (with `unique by`, a `WHERE` on the target, off a traversed
  record, in place on one), `match`, `link`, `unlink`, `delete`, node and graph literals, traversal
  blocks of one hop (nested, bound, with `WHERE`, `ORDER BY` and `LIMIT`), `sleep` with its resume,
  and a pause at the run's cost cap, the extraction keyword (`x = extract from […] { tree }`,
  without a tier: its model calls, `through` stages, fenced children, files and resources, heads
  over what it yielded) and a plugin's plain call (of a plugin declaring a value or a record),
  walks, folds (`FIRST`, `COUNT`, `SORT`, …), `EXISTS` and `IS` tests in an expression, a record
  named twice and `ERROR(…)`, and hands a run back before any effect when it needs more (a pause or
  a cost cap inside a block stays on TypeScript, which joins a fan-out's parked iterations). The
  Rust engine decides what it runs on its own parse of the program, before it touches anything, and
  a run it hands back costs no second check. Each run logs one line naming the engine that ran it
  and why (`movement engine: engine=rust|ts run=<id> reason=<reason|admitted>`), at info under
  `rust` and at debug under `ts`, and `GET /api/v1/system/engine-stats` (the `system` scope) answers
  the process's counts since it started: runs not admitted and declined by reason, runs routed and
  run whole, and the evaluator's. Both engines park in one format, so a run parked on one resumes on
  the other. Chunk 6A moved the conformance corpora's runs whole on the Rust engine (v1 and v2) from
  117 and 139 (109 and 126 replayed) in steps: file-level declarations and plugin imports 119 and
  141, extraction and plugin calls 223 and 268 (195 and 234 replayed), folds, `EXISTS`, `IS` and a
  record named twice 289 and 352 (256 and 313); admission walking only what the fired movement
  reaches, 290 and 353 (257 and 314). Before that, 69 and 75 before traversal blocks and the record
  verbs. Each later step is counted in the burn-down entry below. Authors see no difference.
- Under `MOVEMENT_ENGINE=rust`, the Rust engine's admission walks only the movement a run fires and
  the movements it reaches, with the file's declarations and values. A helper movement nothing calls
  no longer sends its whole file to TypeScript. Admission also no longer stops at the first
  construct it does not run: a refusal names every reason it holds, and `GET
  /api/v1/system/engine-stats` gains `runs.allReasons` (runs not admitted, counted under every
  reason each holds) beside `runs.notAdmitted` (counted under the first). Which runs the Rust engine
  takes changes only by the helpers no longer walked: the corpora run one more run each whole on it.
- Under `MOVEMENT_ENGINE=rust`, the Rust engine now runs calls of the movements a program declares
  (as a statement, bound, returned, or as another call's argument; recursion refused before language
  version 3 and bounded by `MOVEMENT_MAX_CALL_DEPTH` from it, which the Rust engine reads once per
  segment where the TypeScript engine reads it per call) and the graphs a run builds: declared edges
  (`companies: <Company>`), writes, matches, position writes and links into a node's edge, block
  heads and expression reads (a field, `COUNT`, `EXISTS`) over one, traversal entries, `lazy`
  entries and `x = lazy …`, and `graph<Shape> { … }`. A source the Rust parser refuses goes on to
  the check, which fails it with its own parse error. Refusals it adds, each before anything is
  asked: `call_park` (an `await sleep` inside a called movement), `cost_cap_inside_call` (a capped
  run that could suspend inside a call) and `lazy_park` (a run that may park holding a lazy walk).
  The corpora now run 394 (v1) and 469 (v2) runs whole on it, the binding × consumer matrix's
  admitted cells included, and 312 and 379 recorded runs replay on it. Authors see no difference.
- Under `MOVEMENT_ENGINE=rust`, the Rust engine now runs records held as values, as the TypeScript
  engine reads them: a walk read as a list of records, a record passed to or returned from a
  closure, fields an object lacks read off `Object.prototype`, records compared by identity, a dict
  made text through its own `toString` or `valueOf`. It also runs `MAP`, `FILTER`, `REDUCE`,
  `GROUPBY`, `KEYBY` and `MEMBERS` whose concurrency is 1, tuple writes, writes and links rooted at
  or spreading any record, and `EXISTS` over a value. The event no longer goes to TypeScript for
  holding such a dict. Mid-run, a record handed to a host request fails the run with
  `MOVENG_UNSUPPORTED` before the request is made. The corpora now run 1006 (v1) and 1309 (v2) runs
  whole on it, and 346 and 429 recorded runs replay on it. Authors see no difference.
- Under `MOVEMENT_ENGINE=rust`, a program that could hand its host a record held as a value — inside
  a plugin's argument, a system write's field, an extraction's `from` text, a reading the Rust
  engine passes to the TypeScript one — now runs on the TypeScript engine from the start
  (`plugin_arg_record`, `write_field_record`, `extract_from_record`, `builtin_arg_record`; likewise
  `at_record_key` and `node_spread_record`), where it used to fail partway. A GROUPBY or KEYBY that
  files a record under the key `__proto__`, and event values shaped like the engine's own records,
  now read as on the TypeScript engine. A collection op's `onError: "warn"` or `"ignore"` no longer
  drops a member the Rust engine could not read; the run fails naming it. Authors see no difference.
- Under `MOVEMENT_ENGINE=rust`, a text holding half of a surrogate pair (a host's JSON can carry one
  as a `\udXXX` escape; a cut through an emoji, `SPLIT(text, "")` or `TEXT.REGEX_EXTRACT` makes one)
  is held and read as on the TypeScript engine. A plugin's, a file reader's or a model's answer
  holding one used to fail the statement, and an extraction reply holding one was asked again; an
  event holding one, `SPLIT(text, "")` of an emoji and a match through one ran on the TypeScript
  engine; a cut through an emoji (a trace's sample, a source file bounded for the prompt) dropped
  the emoji where the TypeScript engine keeps its first half. Authors see no difference.
- Under `MOVEMENT_ENGINE=rust`, the Rust engine reads date text as the TypeScript engine's `Date`
  does: V8's parser, its ISO form and its legacy one (`March 12, 2026 9:30 PM`, `12/03/2026`, `Thu,
  12 Mar 2026 09:30:00 GMT+0530`, two-digit years, zone words, comments in parentheses), NaN where
  V8 gives NaN. `DATE`, `DATETIME`, `DATE.FORMAT`, `DATE.FORMAT_ISO` and a filter's `<`/`>` between
  two texts no longer go back to TypeScript. A date-time with no offset is read in the local zone,
  which is now a run input: the shim hands the engine its process's zone
  (`Intl.DateTimeFormat().resolvedOptions().timeZone`, the zone `Date` reads in), checked against
  `Date`'s own wall clock first — under a `TZ` whose zone `Intl` cannot name as `Date` reads it
  (`GMT+3`, `UTC+3`; a `TZ` `Intl` names no zone for, such as `utc`, is read as `UTC` when `Date`
  agrees) the run and the expression stay on the TypeScript engine (`local_zone_unverified`) — and
  an embedder's run with none reads UTC (`localZone` in
  [`docs/contracts/host-families.md`](docs/contracts/host-families.md); optional, so the contract's
  version is unchanged).
- Under `MOVEMENT_ENGINE=rust`, the Rust engine retirement's burn-down (chunk 7A), as the
  conformance corpora count it. Each step's runs run whole on the Rust engine, all agreeing with
  TypeScript (v1 / v2, and v3 once its corpus arrived), with the recorded runs replayed on it (of
  443 / 542):
  - Task 1, admission walks only what the fired movement reaches and names every reason: 290 / 353
    (257 / 314 replayed).
  - Task 2, calls of declared movements and the graphs a run builds: 394 / 469 (312 / 379).
  - Task 3, records held as values and collection ops: 1,006 / 1,309 (346 / 429). These counts, and
    every count before Task 7's, include programs that only ever failed their check: the run-whole
    definition that excludes them arrived with Task 7.
  - Task 4, awaits, `parallel` and `race`, parks anywhere and every park state resumed: 1,060 /
    1,363 (392 / 475). The forward merge that brought the v3 corpus: 1,060 / 1,362 / 1,918.
  - Task 4b, data never read as an engine object; Task 4c, language version 4's four changed
    constructs; Task 5, the regex dialect, Unicode case mapping, mixed-key sorts and
    `Object.prototype` reply fields mirrored from V8 and zod; Task 5b, V8's date parser and the
    local zone as run input: the same 1,060 / 1,362 / 1,918.
  - Task 6, the rest of the burn-down (the entry above): 1,188 / 1,499 / 2,556.
  - Task 4d, a file is only what an envelope declares: 1,180 / 1,491 / 2,547 (the corpus cases that
    handed the engine a descriptor-shaped dict as a file are triaged).
  - Task 6b, admission reads the checker's types for parameters, calls and spreads: 1,174 / 1,485 /
    2,566, with 6 / 6 / 4 runs counted apart as failing mid-run by name (`MOVENG_UNSUPPORTED`), each
    a corpus case pinning that same failure on both engines. Its fix round's commit subject says
    "text coercions are values", which is not what it did: `MULTI(co)` written into a field
    (`write_field_record`) or handed to a value parameter (`call_arg_record`) stays refused.
  - Task 7, the counts made honest. A Rust-routed program is now checked before its segment opens,
    as the TypeScript route checks it, so a program that fails its check makes no host request on
    either engine and never reaches the Rust engine; such runs used to count as run whole. Of 1,193
    / 1,514 / 2,662 runs attempted, 1,023 / 1,251 / 2,152 run whole; 12 / 21 / 86 are refused at
    admission by name, 6 / 6 / 4 fail by name, 0 / 0 / 3 are declined, and 152 / 236 / 417 fail
    their check before a segment opens. The recorded runs replay 430 / 519, every run the Rust
    engine ran to an ending judged by its verdict. Nothing to set.
- CI's size warning for the API's WebAssembly artifact (`movement.wasm`) moves from 800 KiB to 1 MiB
  gzipped, and its failure line from 1 MiB to 1.5 MiB: it is 963 KiB (986,091 bytes) as chunk 7A
  ends, the readings of records held as values having first taken it past the old line. The
  browser's artifact is unchanged. It now crosses the 1 MiB warning at 1,171,349 bytes, still under
  the failure line: a paused run's closures, walks and local shapes are rebuilt on resume from the
  syntax tree saved with the pause rather than looked up by position, and reading that tree back
  takes about 100 KB. The Rust checker now ships inside it too (a run on the Rust engine is checked
  by it), which takes it to 1,494,633 bytes, still under the failure line.
- The browser now loads the parser's own WebAssembly artifact (`movement_parser.wasm`, 325 KB
  gzipped, a little over the earlier 323 KB because the parser reads text in the engine's in-band
  form, so a U+FDD0 or a lone surrogate half in a source crosses it exactly), not the API's
  (`movement.wasm`, parser and engine, 711 KB gzipped). The API artifact's size warning in CI moves
  from 600 KiB to 800 KiB gzipped (it still fails at 1 MiB): the Rust engine's traversal blocks,
  record verbs and wake-driven executor took it past the old line, and extraction, the next slice,
  adds more.
- A second deployment shape for automations' background work, push-tick (`deploy/SELF_HOSTING.md`,
  "Deployment shapes"). In `AUTOMATIONS_DRAIN_MODE=external`, `AUTOMATIONS_TICK_URLS` and
  `AUTOMATIONS_TICK_KEY` (new, optional, set together or not at all; half the pair fails boot) make
  each enqueue POST a drain tick to every URL, so a door's work starts without waiting for the
  scheduled tick. `node build/scripts/drain_once.js` (new) drains until idle and exits, for a
  scheduled job with no HTTP. Nothing changes for a deployment that sets none of them.
- On every language version, a binding, function or closure whose inferred type has more than
  10,000 distinct parts is refused (`MOV_TYPE_TOO_LARGE`); split the value into named parts or
  declare its shape. Why: a chain of closures, each returning a map of the last one's value, made
  saving an automation take minutes. The checker is now linear in a type's distinct parts, and this
  limit bounds what one program can cost to check. It is a safety limit, not a language rule: no
  program that reaches it ever checked in reasonable time.
- From language version 5, a dotted call of a function that is no built-in (`o.nope()`, `box.g()`) is
  `MOV_FUNCTION_UNKNOWN`. The engine runs `o.f(…)` as `f` in `o`'s scope, and outside a write field
  there was never such a function: the run always failed where it reached the call. Versions 1–4
  are unchanged, as are a built-in in a record's scope (`o.UPPER(name)`) and a write field's own function.
- The engine's unsupported-construct scan reads a movement as the language version it is pinned
  to, so a form version 5 reads differently is scanned as what it means under the pin.
- A closure written in a movement body holds the scope it was written in by reference, as a
  JavaScript closure does (and a file-level closure already did), rather than a copy of it. A wait
  writes each scope once and each closure as its code and the scope's number, so a parked state
  grows by a few hundred bytes per closure: 14 unused closures in one body park at 8 KB, where
  each copied every earlier one and the state doubled per closure (15 MB). Every language version,
  and a run parked before this resumes with its copies as it did. A parked run now sees what an
  unparked run sees: under version 4 and later, a `MAP` member that parks and returns closures
  which write an outer handle, run by `parallel`, ends with the handle all of them wrote (the outer
  read `"v2"`, as unparked), where it split the handle across the park and the outer read a stale
  `"one"`.
- A named function's declared return no longer hides what its body may hand back: under language
  versions 3 and 4, `function f(): <text> { return COALESCE(org, "x") }` is a call whose use in a
  graph entry, a spread, a written field or a plugin argument is refused at the use, as a closure's
  call is (a use that reaches data cannot hold a record, on every version). A call back into a
  function from its own body (declared recursion) carries nothing for that edge, so recursion is
  no call cycle. The declaration itself is refused only from version 5.
- Security: a Mailgun inbound attachment is fetched with the deployment's key only from an https
  storage URL under `MAILGUN_SENDING_DOMAIN` (`/v3/domains/<domain>/…` on a `mailgun.net` host);
  any other Mailgun URL is refused. Inbound-only deployments must now set `MAILGUN_SENDING_DOMAIN`
  to the domain of their route.
- Moving an automation up to language version 4 now warns (`MOV_HANDLE_READ_FOUND`, a move-up
  warning) on a read of a write handle's `url`. Under version 4 it reads the found record's url,
  where versions 1 to 3 read the link the write returned (null when the update returned none).
  The handle's own result-shape fields other than `url` (today only `externalId`) are exempt.
- A field or child node named `__proto__` in a node declaration or an extraction is refused
  (`MOV_SHAPE_FIELD_PROTO`), and so is a binding, parameter or alias named `__proto__`
  (`MOV_NAME_PROTO`), on every language version. Both used to validate but misbehaved at run time,
  because JavaScript reads that key as an object's prototype: the extracted record never held the
  field, a closure's parameter read as `{}`, and a parked binding was dropped so its resume
  failed. A bug fix, not a language version: an automation using one now fails its check; rename
  it.
- A map spread into a graph (`held = { k: r }` then `graph { ...held }`) that holds a record under
  any key, at any depth or in one arm of an operator, is refused where it is written
  (`MOV_GRAPH_SPREAD_RECORD`, with the path), on every language version. It used to validate from
  version 2 and fail the run at the spread. A bug fix, not a language version: write a field off
  the record, or write the record into the graph as an entry of its own (`k: r`). An unshaped
  spread whose keys nothing names (version 1's map literals) is refused as untyped alone; the
  record's refusal comes with the shape it asks for.
- A graph entry that is not one record or a list of them but may hold a record
  (`graph { a: COALESCE(r, "x") }`, an `IF` arm) is refused where it is written
  (`MOV_GRAPH_ENTRY_RECORD`, with the path), on every language version, on the same terms as a
  spread: it used to validate and the run stored the record as a field. `a: r` (an edge holding
  the record) is untouched.
- A call's value holds what any of the function's returns may hold, so a record or file a return
  hands back through `COALESCE`, `IF` or `MULTI` (`f = () => COALESCE(org, "x")`, or returns that
  disagree) is refused where the call's value goes, as the bound conditional is: a graph entry
  (`name: f()`), a spread, a written field, a plugin argument, an extraction input, a `MAP` or
  `REDUCE` over it. A named function's bound call on every version; a closure's call (and any call
  inside an expression) from version 3, where they run. It used to validate, and the engine handed
  its own record object onward. A bug fix, not a language version: return a field off the record.
  A declared return type that does not take what a return may hold (`(): <text> => COALESCE(org,
  "x")`) is `MOV_RETURN_TYPE` at the declaration from **version 5 (Dancing Wren)**: it ran on
  versions 3 and 4 while the call was unused or only compared, so there the declaration is clean
  and the call carries what the body may hold, refused where it reaches data.
- A `parallel` or `race` receipt holds what its arms return, as `[a(), b()]` does, so a record an
  arm hands back (a write handle, a found record) is refused where the receipt or a slot of it
  (`AT(r, 0)`) is written into a field, a graph entry, a plugin argument or an extraction input:
  inline closure arms, named closure arms and named movement arms alike, on every language
  version. It used to validate, and the engine wrote its own handle object into the field
  (`{"kind":"handle",…}`). A bug fix, not a language version: return a field off the record. A
  literal index reads its own slot (`AT(r, 1)` of a text arm is written; `graph { a: AT(r, 0) }` is
  an edge, as over `[a, "x"]`). Arms that return values leave the receipt plain data. A receipt
  whose every slot is a record is an edge list at a graph entry (`graph { a: r }`), as
  `graph { a: [made(), made()] }` is; one that mixes a record with a value stays refused, and the
  message offers the record slot (`a: AT(r, 0)`). A record slot of a parallel/race receipt written
  as a graph entry (`graph { a: AT(r, 0) }`, or `h = AT(r, 0)` then `graph { a: h }`) was stored as
  the engine's own object; it is now an edge to that record (both engines), on every version, as a
  bug fix under the no-record-inside-data rule, not a version change. On version 1, which does not
  type a call's value (the documented B4 gap), a receipt is stricter than the list literal
  `[made(), made()]`: it is refused where the literal is accepted, because accepting it leaks.
  Arms known where they are written are typed too: a name bound to a list of functions
  (`arms = [made, label]`), or to a `MAP` whose closure returns a closure
  (`MAP(xs, (n) => () => made())`), type the receipt by what those return. Arms known only at run
  time (a `FILTER` or concatenation of such lists, a list passed in or returned by a call) stay
  untyped, so a checked program can still hand a record through them.
- A union whose every member is a record (`COALESCE(a, b)` of two records, or a function returning
  one of two) is one record for the graph entry: `a: r` over it is an edge, as it is over one
  record, on every version. It was refused as a field holding a record. A union that mixes a record
  with a value is still refused.
- A closure's or function's returns are flattened and deduplicated, and the kinds of engine object
  a type holds are remembered per type, so a chain or fan of calls checks in linear time.
- A plugin argument the plugin declares a value type for (text, a file, …) takes no record or file
  that type does not hold, on every language version (`MOV_CALL_ARG_TYPE`, with the path): a file
  handed to a text argument (`tag(label: f)`, or one arm of a `COALESCE`), a file or record under a
  key or in a list of the value (`tag(label: { a: f })`, `ocr(doc: { a: f })`). Each used to
  validate, and the plugin was handed the engine's own description of the file or record. A bug
  fix, not a language version: pass the file's text (`READ(f)`), a field of the record, or the
  file itself to an argument that takes a file.
- A run's result (and the run records and views built from it) never carries a write record's
  `old` member (it only exists under language version 4), the engine's own handle for the record as
  found (its instance, adapter slug, credential name and full schema). `-[:@old]->` still reads it
  during the run.
- Redis is optional. The API connects to Redis only when `MESSAGE_QUEUE_REDIS_HOSTNAME` is set
  (the port still defaults to 6379); unset, nothing ever tries to connect, in every environment.
  Without it the runaway-loop guard counts in each API process's memory (exact for one instance;
  several instances each count only their own firings), the icon cache is off, and in-flight MCP
  OAuth state is not shared between instances. The bundled composition and the Render blueprint
  still name their Redis. The `localhost` default the API used outside production moved into the
  dev loop, which exports it for the Redis container it runs.

### Fixed

- A hop's alias read under 5 (`c.name` in `-[c:company WHERE c.name == "Acme"]->`) works over
  records the run already holds: an extraction's entities, nested ones too, a `node { … }` or
  `graph { … }` literal's entries and the records written onto a local node. Before, both engines
  failed the run with "edge-property reads outside a traversal WHERE", so these programs had no
  runnable version 5 spelling. A bare name there is the variable it names, as everywhere under 5.
- A hop's WHERE over an extraction's entities runs in a block head and an expression
  (`deals-[c:company WHERE …]-> { … }`, `Text.join(deals-[c:company WHERE …]->.name, ", ")`), on
  every language version. Before, only `exists` ran it; the others failed the run.
- `MOVEMENT_ENGINE=rust`: a file bound to a name such as `fields`, `body`, `head`, `position`, `op`,
  `mapping`, `closure`, `params`, `origin` or `handle` is a file again after a park and resume
  (before, it came back as a dict and `READ` of it failed). The host now finds a parked state's
  files by the park's structure, never by a member's name, so data shaped like a file (a JSON field,
  an adapter's answer) is never revived as one, whatever key it sits under.
- A graph literal spreading the event (`graph { ...msg }`) or a member of a record (`graph<S> {
  ...co.meta }`, `...msg.meta`) passed its check and then failed every run (MOVENG_UNSUPPORTED for
  the event, MOVENG_RUNTIME for a record's member). The event is now copied as any record is, and a
  record's member reads its field, on both engines.
- `MOVEMENT_ENGINE=rust` runs more automations whole instead of handing them to the TypeScript
  engine: a `match` over a tuple of paths, `IS <Declaration>` of a graph literal holding a system's
  records, a graph spread of the event or of a record's member, `refresh`, and a function (a
  library's too) returning its closure's call. Nothing to set.
- `MOVEMENT_ENGINE=rust` parks and resumes as the TypeScript engine now does: one write handle two
  names hold is written once and comes back as one, a library's node declaration or function is
  found again in its library, and a closure bound at a file's top level is in scope in that file's
  functions and parks by name. A state either engine parks resumes on the other.
- `IS <Declaration>` against a declaration a library writes, of a system's record, failed on
  `MOVEMENT_ENGINE=rust` naming the declaration as unknown; it now compares as on the TypeScript
  engine.
- An extraction's `through` stage naming a priced plugin imported under another name (`import {
  fetch_url as fetch } from plugins`, then `through [fetch(url: …)]`) escaped the run's cost cap:
  the engine looked the plugin up by the name the stage wrote, found no plugin of that name, and
  invoked it as unpriced, under that name. It is now looked up and invoked by the name it is
  registered under, so a run that has spent its cap stops before the plugin starts, and the plugin
  is fed the arguments it declares (its required and extraction-fed ones). A plain call (`page =
  fetch(url: …)`) was already priced by its registered name.
- A run parking on an await could miss a wake that arrived while it parked, and then wait forever.
  The park now writes the parked run before the correlation that points at it, so a wake in between
  finds both or neither. When the re-check after parking itself fails (the remote is down), the run
  stays parked without a wake and the failure is logged with the await's key; the adapter's own wake
  covers later landings.
- Engine: the interpretability scan honours the run's language pin. The save-time check of which
  constructs the engine can run now reads an automation under its pinned language version, not the
  current one, so it reports for a version 1 or 2 automation what the engine would refuse under that
  version. For example, a call to a function written in another letter case reaches the function
  only from version 3: under version 1 or 2 the check now reports it as an unsupported function
  call. The demand scan (which systems' schemas a run's check is given) also reads an automation
  under its pin, including a version 1 or 2 collection operation (`MAP`, `FILTER`, `REDUCE`, …),
  which demands what it read before.
- For embedders: the Rust engine's `eval_expression` refuses an envelope with no `languageVersion`,
  naming it. It used to read a missing version as the oldest behaviour. Pass the movement's pin.
- For embedders: `trace.append` now requires `wire: true`, with its entries on the eval wire. The
  Rust engine now also asks `ids.mint`, `llm.client.call`, `llm.transforms.invoke`,
  `files.resolveFileText` and `log.write`.
- `write v { … }`, where `v` is an `IF` or a `COALESCE` of two records with no one type, no longer
  reports the checker's own internal error (`MOV_INTERNAL_UNTYPED_BINDING`) on any language version.
  `v` is read as what it may hold, as `delete` and a graph entry read it: records alone are one
  record; one that may be absent, or a value among them, is `MOV_WRITE_POSITION_NOT_RECORD`.
  A write in place to one of several records (`write who { … }`) is held to every member on every
  version, so a field one member lacks is `MOV_WRITE_UNKNOWN_FIELD` and every write check applies to
  each.
- A run that names a credential for a remote adapter (`x(credentials: X)`) now fails when it is not
  the credential the adapter was installed with, saying the remote install serves only its own. It
  used to be ignored: two accounts on one remote adapter silently reached the install's account, so
  writes landed in the wrong workspace. Naming the install's own credential, or none, is unchanged.
  Per-run credentials for remote adapters are still to come.
- A `parallel` or `race` arm that names a closure written in the movement body (`f = () => { … }`
  then `parallel([f, g])` or `race([f, g])`) and waits inside it resumes. It used to fail "resume:
  no body for arm 0", because the resume looked an arm's name up only as a movement. It now finds
  the closure by its name in the scope around the combinator, as the run did, and its arm resumes
  with the scope it brought in. Every language version; a parked state is unchanged. `MOVEMENT_ENGINE=rust` resumes it the same way, and a scope cycle
  (a closure whose scope reaches back to itself) settles there as on the TypeScript engine.
- A movement that holds a written record (or a built node) and then waits inside a function it
  calls resumes again. Since the previous fix below, resuming it failed "the parked state refers to
  write handle(s) #0 that it never wrote", because the resume read the movement's own names from
  a copy that only pointed at the record. The resume now finds each record wherever the parked
  state wrote it. Every language version; a parked state written before is unchanged and resumes.
  `MOVEMENT_ENGINE=rust` resumes it the same way, and also resumes one whose name matches a part of
  the parked state's own layout (a record named `body`, `position` or `fields`, say).
- `MOVEMENT_ENGINE=rust` reads a `parallel` / `race` receipt's record slot as the TypeScript engine
  does (the record from language version 5, null before), and runs whole a value that may be a
  record or a value handed to a record parameter under versions 1 to 4 (`position_arg_record` no
  longer appears for it), ending as the TypeScript engine does.
- Two names for one written record stay one across a wait (`b = a`, `b = write a { … }`, or a
  closure that captured it). After resuming, an in-place `write a { … }` or `refresh a` used to
  leave `b` reading the record as it was before the wait; it now reads what `a` does, as a run that
  never waits always did. Every language version: a wait is not part of the language, so what a
  name reads must not depend on it. The same holds for the names a `parallel` / `race` arm or a
  fan-out iteration leaves when it finishes after a wait, and for a node held under two names
  there. A parked state that holds each record once is unchanged.
- A library's closure that waited before testing `x IS <Decl>` against the library's own
  declaration now resumes. The resume looked the declaration up in the root program, so it failed
  "cannot re-resolve code ref", or used the root's declaration of the same name. A parked node
  declaration or function now says which library it belongs to, and is found again there. Every
  language version: the run before the wait already read the library's, so nothing else changes.
  A run that was already waiting when this shipped resumes as before, since its parked state
  does not say which library: one whose library declaration is shadowed by a same-named
  declaration in the root program still reads the root's.
- A closure bound at a file's top level (`f = (n: <number>) => …`), in a library or the root
  program, is now in scope inside that file's functions. The run used to fail "'f' is not in
  scope". It holds its file's scope by reference, as a JavaScript closure holds its module's, so
  it also sees the file's later closures (`f = (n) => g(n) + 1` before `g = …`), and a wait
  stores it by name, so a parked state stays small however many a file declares. Every language
  version from 3, where a closure became callable; it always failed before, so nothing that ran
  changes.
- A record passed to a function another file exports is no longer refused when that file constructs
  the same system ("expects inbox.message, but this argument is inbox.message"). A system is its
  address (the adapter, the credential and the values of literal construction arguments), not
  the name a file binds it to, so two names, in one file or two, for the same system hold the
  same records; a different credential or literal is still a different system, and the refusal
  says which differs. A construction with an argument that is not a literal (`base: b`) stays a
  system of its own. Every language version.
- A Redis outage no longer stalls automations. The loop guard is meant to step aside when Redis is
  unreachable, but a dead Redis used to hang every trigger dispatch indefinitely. Connecting to
  Redis now gives up within seconds, and the guard lets runs through unchecked, pausing its
  counting for five seconds at a time until Redis is back.
- A file whose extracted text contains NUL characters (a PDF with glyphs its font map has no name
  for) no longer fails the run. The text is stored with each NUL replaced by a space, and a failure
  to store the extracted text as provenance is logged rather than failing the run.

### Security

- The Rust engine never takes data an automation reads (a webhook body, an adapter's answer, an
  answer to a question, a callback's fired values, a plugin's output) for one of the engine's own
  objects, whatever keys it carries. Before, a dict whose `kind` named an engine object (`lazyWalk`,
  `closure`, `instance`, `toString`, …) was read as that object, so a webhook body could make the
  run walk a system, or run expression text the body carried. Now such a dict is a plain dict on the
  Rust engine: its `kind` reads as text and a hop off it is refused as a hop off any value is. The
  TypeScript engine has the same fix (the entry below), so a run the Rust engine refuses at
  admission and hands to the TypeScript engine reads such data as data too. Not a language version:
  no construct's meaning changes, and a saved automation runs as it did unless its data impersonated
  an engine object.

- A file is read only where the envelope carrying it declares one, on both engines. Before, any
  value spelling a file's descriptor (`{ "__brand": "FileRef", "source": { … } }`) — a webhook
  body's field, a field answer, a knowledge-graph property, a remote adapter's answer anywhere in it
  — was taken for a live file: `READ`, `extract from [ … ]`, a plugin's fetched record and a write's
  file field read the bytes it named, which could be another team's stored document or any
  connection's file. Now the engine makes a file only at a field a system's schema types `file`, a
  resource's `fileRef`, a field a plugin's output declares a file, `FILE()`'s answer, and a parked
  file the park says is one. The same shape anywhere else is plain data: its keys read and print
  (`TEXT.SERIALISE`), an extraction reads it as its JSON text, `READ` refuses it. No automation
  changes, and there is no new language version.
  - A remote adapter's file is read only at a field its `describe` declares `kind: "file"` (or a
    resource's `fileRef`); the conformance CLI's new `files-declared` check names a field that
    answers one undeclared. File refs sent to a remote adapter (a write, a position's resources and
    evidence) no longer name Listen-Fire's credential or construction args.
  - A callback's `file` parameter is the calling system's handle, and stays data.
  - A run parked before this release that held a file in a value or a record's field resumes holding
    its descriptor as data (`READ` of it fails, naming it); a resource's file still revives as a
    file.
- Every file's bytes are read only for the team the run belongs to. A stored document is read only
  when it is the team's (`FILE()` artifacts and a manual run's uploaded files are now stored under a
  per-team key prefix; a plugin's stored document is the team's by its document row); the store
  reads a key only from a URI of its own bucket with no empty, `.` or `..` segment. A connected
  system's file is read only through the instance the run itself holds for that system, never one
  the file names. A file whose handle is a URL (email, WhatsApp) is fetched only from where its
  system's configuration says it issued it: the email provider's own storage; WhatsApp's configured
  Twilio account's media (none when `TWILIO_ACCOUNT_SID` is unset) or a URL this deployment exposed.
  A file written into text — a field, a prompt, a trace — is only its name, type, size and handle;
  its source, credential and URL are never written, and reading them off a file gives nothing.
  Anything else fails the run with `FileOutsideTeamError` (`FILE_OUTSIDE_TEAM`), never an empty
  read, and nothing is fetched. Operators: a `FILE()` artifact or a manual run's file stored before
  this release, still held by a parked run, is no longer readable by it.

### Changes to what a saved automation does (every language version)

- A field or child node named `__proto__`, in a node declaration or an extraction, is refused
  (`MOV_SHAPE_FIELD_PROTO`). It used to validate, but the extracted record never held the field:
  JavaScript set the record's prototype from the model's answer instead. A bug fix, not a language
  version: an automation declaring one now fails its check on every version; rename the field.
- A binding, a parameter or an alias named `__proto__` is refused (`MOV_NAME_PROTO`). The engine
  keeps a scope's names as an object's keys, and JavaScript reads that key as the object's
  prototype: a closure's parameter so named read as `{}`, and a parked binding so named was dropped,
  failing its resume. A bug fix, not a language version: rename it.
- A record plugin's answer whose data holds an own `__proto__` key (as JSON text makes one) keeps it
  as a key on both engines. Before, the TypeScript engine lost it: preparing the answer assigned
  each key, which made it the answer's prototype. Merging the data into the record still assigns, as
  JavaScript's `Object.assign` does, so the key becomes the record's prototype and a field read goes
  through it.
- A prototype a record plugin's data gives its record does not survive a park, on either engine: the
  parked record holds its own fields only.

### ev1-protocol

- Adapter protocol 2 gains module declarations, without a version bump: a manifest may declare
  `credentials` (`static` or `oauth2`, with its authorize and token URLs), `inbound` (the door's
  provider key, a signature scheme and the headers carrying it), `poll` and `periodic`. A request
  may carry the install's resolved `credential`, and a response (success or failure) a
  `credentialUpdate`. Three optional methods: `poll`, `refreshCredential` and `runPeriodic`. A
  declaration without its method, or a method without its declaration, refuses the manifest. An
  older server declares none of it and is unchanged; nothing in the host acts on it yet.

### ev1-public

- Contributors: the engine package now has public entries under `packages/movement-engine/public/` (the engine, host, run host, adapter, catalog, inbound, models, files, log, testing), and `code:type-check` in apps/api runs an engine boundary guard that fails if the API imports more engine internals than the recorded baseline. No change to a deployment.

### ev1-golden

- A golden corpus now records how every inbound door answers today (webhook-sync per provider, the
  remote adapter push doors, the shared Telegram bot, both Slack app doors, WhatsApp, Resend mail,
  `/api/cb`, `/api/asks`, the valuations webhook routes), with the callback URL of every provider key
  and every mount path. No behaviour changes; it is the baseline the shared inbound core must match.

### ev1-judge

- The entity identity judge (which candidate record is the one being written) moved into the engine package with its prompts as files; the hosted platform wires it to its model and Jev clients and decides exactly as before (replayed against recorded cases).

### ev1-filetext

- Reading a file's text (PDF text layer then OCR, decks, spreadsheets, CSV, audio) moved into its own
  package, `packages/file-text`. OCR, transcription, the spreadsheet model call, the byte source and
  the logger are passed in, so a shell without the hosted product can read files. The text read from
  the same files is unchanged.

### ev1-providers

- The model providers (OpenAI, Gemini, Claude on Vertex, Anthropic) and the embedding, image and
  transcription callers moved into a new `model-providers` package. Vendor SDKs load on first use,
  and the package reads no process environment; the hosted API passes its own. No behaviour change.

### ev1-pricing

- Model prices are data: `packages/movement-engine/lib/models/prices.json`, read through `pricing.ts`. The hosted product's costs are unchanged to the microdollar.
- `lf` now prices its model calls from the same table and charges them to the run, so a run's cost cap sees them.
- The extraction output budget is a host input (`outputBudget`) rather than an environment read inside the engine; the hosted product still reads `EXTRACTION_OUTPUT_BUDGET`.

### ev1-callbacks

- `lf` takes callbacks: a run's `callback(…)` is called at `lf serve`'s `POST /api/cb/<id>` (its
  `url`) or with `lf call <id> --body <values.json>`. The values are checked against the callback's
  parameters; the body runs once, then the run's `await cb-[:Called]->` resumes. A callback closes
  when its run ends, however it ends.
- `lf.yaml` takes `publicUrl`: where this lf is reached from outside. A callback's `url` is under it
  (else under where `lf serve` listens).
- `lf cancel <run> [--reason <text>]`: a parked run is settled failed with the reason, its
  callbacks closed. A run another lf process is stepping stops at its next statement.
- The hosted product's callbacks are unchanged (same table, ids, links and answers); their store now
  serves the run host core's callback family, which lf's SQLite store serves too.

### ev1-lfhost

- `lf-host`, a new Rust binary (`crates/lf-host`), is the first slice of the one-binary `lf`. It reads
  the same project (`lf.yaml`, the externals, the secrets) and `lf-host check` prints exactly what
  `lf check` prints: it starts the externals, builds the same catalog byte for byte, and runs the Rust
  checker natively. Nothing else of `lf` is in it yet; the TypeScript `lf` is unchanged and still
  the one to use.
- The run host's state can now live in a Rust SQLite store with the TypeScript lf's schema. The run
  host's contract suite drives it over a stdio JSON-RPC bridge (`lf-host --contract-store`) and it
  passes every case (30 of 30).
- `lf check` reports a file that does not parse at the column the parser names. It reported column 1
  for every such file.

### ev2-cbhost

- The hosted product now runs a fired callback's body with the same body runner lf uses (the run
  host's core). Webhook URLs, callback ids, door answers, database rows and the `fire_callback`
  work kind are unchanged, so callbacks already queued still run.

### ev2-plugins

- The bundled plugins' specs are data in the engine package (`movement-engine/public/plugins`): each
  one's parameters, declared output and effects, and whether it is priced. The hosted catalog reads
  them from there; the product keeps only each plugin's implementation and its catalogue page text.
  What the checkers see is unchanged (held against a recording taken before the move).

### ev2-secrets

- One secrets family for every host: resolve a credential, write it back at the version it was read
  at (a write against a newer version is refused), and refresh it at most once at a time, across
  processes too. The host refreshes an `oauth2` credential itself with the standard refresh-token
  grant at the token URL the module declares.
- The platform's connected credentials: the Dropbox refresh, and the Google and Gmail token
  rotations, now write back through it. Two workers that find the same expired Dropbox token now
  make one token call; before, both refreshed. The stored encryption and each payload's shape are
  unchanged, so existing connections read and write as before.
- `lf`: a refreshed token is written back under a lock file beside the secrets file, so `lf serve`
  and an `lf run` beside it spend a refresh token once. A credential from the environment is still
  used for the run only, with one warning.
- Adapter protocol 2, within version 2: a module whose manifest declares a credential is sent the
  install's credential on every call (only the fields it declares, only over HTTPS or loopback),
  and its `credentialUpdate` is written back, from a failed call too. An update naming a field the
  module does not declare is refused. In `lf` today; hosted installs do not store declarations yet.

### ev2-inbound

- Every inbound webhook now goes through one shared inbound core in the engine package (signature
  schemes, the capture-queue-ack pipeline, the emit and wake push doors, and an HTTP contract suite),
  so `lf` can serve the same doors next. Webhook URLs, signature headers and keys are unchanged for
  every provider.
- Fixed: a built-in provider's delivery is no longer refused 401 because an `x-listen-fire-signature`
  header beside its own good signature was wrong. That header now verifies remote installs only.
- Fixed: a webhook delivery whose receipt could not be queued was acked 200 and the receipt never
  ran. It now answers 500, so the provider retries and the stored receipt is queued again.
- Fixed: a webhook body over 100 KB is answered 413 with `{"error":"payload_too_large"}`, the doors'
  JSON error shape, instead of an HTML page.

### ev2-lfengine

- `lf-host run --event <file> [--dry-run]`, `lf-host resume [<run>]` and `lf-host runs` run movements.
  The Rust engine is linked into the binary and driven natively, not through WASM. A sleep or an await
  parks into the same SQLite state file the TypeScript `lf` writes, and either binary resumes it.
- Externals are processes reached over adapter protocol 2. Every answer is held to the protocol's
  schemas, files cross as URLs, and the per-run call ceiling and dry-run capture behave as in `lf`.
- On the example project, its fixtures and the reference fake CRM, both binaries print the same lines
  and leave the same state file and the same writes in the external.
- Not in `lf-host` yet: `serve` and the inbound doors, callbacks, `cancel`, model calls, credential
  refresh, and `run --webhook`. The TypeScript `lf` is unchanged and still has them all.

### ev3-oauthfake

- The dev loop has a fake OAuth2 provider in fake-channels (`/oauth`): authorize, token for the authorization_code and refresh_token grants with rotating refresh tokens, a protected endpoint, and injectable expiry and failures.
- With `MOCK_OUTPUT_ADAPTERS=true` the Dropbox auth client signs in and refreshes against it, and the fake Dropbox refuses access tokens the provider has expired.
- `pnpm dev:oauth setup`, `pnpm dev:inject oauth-expire|oauth-config` and `pnpm dev:inspect oauth` drive and read it; documented in `docs/dev-loop.md`.

### ev3-otherdoors

- The mail doors (Resend, Mailgun inbound, Mailgun events) and the shared Slack app and Telegram bot doors now run on the inbound core. Every path, header and signature is unchanged; the golden corpus gained 21 Mailgun cases and passes unchanged except the fixes below.
- Fixed: emit and wake bodies over 1 MB answer `{"error":"payload_too_large"}` with 413, like the webhook door (they answered express's HTML page).
- Fixed: a Mailgun event whose signature is the wrong length, or missing, answers 406 (it answered a 500 that Mailgun would retry).

### ev3-connect

- `lf connect <credential>` connects an OAuth credential the way its external's manifest declares
  it. lf prints the provider's sign-in URL and opens it, takes the redirect on a loopback port
  (`--redirect-port N` for a provider that wants an exact redirect URI, `--no-browser` to only
  print the URL), exchanges the code, and writes the tokens into the secrets file. The secrets
  entry must already name its external and your app's `client_id` (and `client_secret`); those
  and every other field are kept.
- One connect flow in the engine package, driven by the declaration (authorize and token URLs,
  scopes, where the client authenticates, PKCE, extra authorize parameters). The platform's
  Attio, Airtable, Dropbox, Google and Gmail sign-ins now run on it. Their callback URLs, the
  parameters of each authorize URL and code exchange, the 15 minute single-use state, and the
  stored credential shapes are unchanged, so existing connections and registered redirect URIs
  keep working. Slack keeps its own installer flow.

### ev3-lfdoors

- `lf serve` takes deliveries at `/api/public/webhook-sync/<provider>/<install>`, the same door the hosted
  product serves, on the shared inbound core. `/hooks/<external>/<install>` keeps working as lf's older
  name for it and still answers `202 { runs }` with the runs it started. The webhook-sync door queues
  events and answers `{ ok, eventsProcessed }`.
- An external that declares `inbound` in its manifest has its deliveries verified by the declared scheme.
  The secret is the install's `webhook_secret` field, or the field `webhook.secretField` in
  `lf-external.yaml` names. An external with only the `webhook:` block verifies as before.
- A signed delivery with a missing, empty or placeholder secret is refused, whatever the scheme.
- The push doors (`emit`, `wake`) and `lf run --webhook` run on the same core. A pull cursor an external
  returns from `preprocessInbound` is now kept in lf's state and handed back on the next delivery.
- A delivery with an unreadable body now answers 500 (it was 400), and a refusal now carries a code
  (`signature_invalid`, `unknown_provider`, `subscription_not_found`) in place of a sentence.

### ev3-kit

- A built-in integration can now be a module: written once with the module kit
  (`packages/module-kit`, `defineModule`), loaded in process by the platform and served as a
  protocol-2 process by `serve-module` everywhere else. A module reaches no part of the hosted
  product, no database and no recording layer; a check in each module's type-check holds that.
- Dealroom is the first: `@lf/dealroom` (`modules/dealroom`). Nothing changes for a team using it:
  the same requests, the same answers and the same polled events, held by a recording of the old
  adapter replayed against the module both ways. Switching back is one line (`BUILTIN_MODULES`).
- Plugins are modules too. A plugin module declares its plugins as one package, imported by tag
  (``import { `@lf/web` as web } from plugins``) and called through the protocol's new
  `invokePlugin`. The six bundled plugins are still the platform's own for now.
- `lf`: an `lf-external.yaml` may name a `module` instead of a command or a URL, and a plugin
  external is now served (its plugins checked and called). `lf-host` does the same, except a module
  that needs a declared credential, which it checks but cannot run yet.
- Adapter protocol 2 (no version bump): a manifest may declare `plugins`, paired with
  `invokePlugin`; the install manifest file keeps a module's declarations. When a module declares a
  signed inbound, the host refuses a delivery with a missing, blank or placeholder key, or a bad
  signature, whatever the scheme. Built-in doors keep their current behaviour until they move.

### ev4-cleanup
- Dev loop: `pnpm dev:oauth setup` signs an existing Dropbox credential in again when the fake
  OAuth provider no longer knows its refresh token (a fresh checkout, a reset), so the first
  refresh after setup succeeds. An injected WhatsApp document is now a PDF with a text layer, and
  `pnpm dev:whatsapp setup` also provisions `wa_document_intake`, which extracts from it.
- `pnpm checks:corpus`: the reader pass over the still incomplete corpus no longer prints an
  upgrade-rate failure (the floor is checked on the final pass), and the pinned test-only language
  version 99 is accepted rather than warned about.

## [v0.11.0] - 2026-10-12

Language version 4, **Luminous Owl**, arrives. New automations are written in it. The deploy check
moves an existing automation up to it when it validates cleanly there. An automation with an error,
or with a move-up warning (`MOV_MATCH_MISS_CONTINUES`, `MOV_HANDLE_UPDATED_IN_PLACE`,
`MOV_HANDLE_READ_FOUND`: the same text now does something different), stays on its version, shows
Review and lists the diagnostics, and behaves exactly as before. Read each warning, edit what
assumed the old behaviour, and upgrade with `upgradeAutomation`, acknowledging it.

### Language version 4, Luminous Owl: what breaks

Each item applies only to an automation on Luminous Owl (4). Versions 1 to 3 keep their old
behaviour exactly (proved by a version 3 conformance corpus). Every rule, with examples and
rewrites, is in the [Luminous Owl migration guide](docs/language/luminous-owl-migration.md).

- **A named `match` yields a handle or absent.** A miss binds absent and the block carries on. Why:
  a miss ending the enclosing scope was never the intent, and it made `match` useless as a lookup.
  Guard with `== null`, `!= null`, `EXISTS` or `ISNULL`. Unguarded use where a value is required is
  `MOV_ABSENT_REQUIRED`, and so is a `link` or `unlink` whose end may be absent. Move-up warning on
  every bound match, held until acknowledged: `MOV_MATCH_MISS_CONTINUES`.
  - An unnamed `match … { }` is `MOV_MATCH_UNNAMED`: write `existing = match … { … }` then
    `if existing != null { … }`.
  - `link a -[:e]-> { match … }` is `MOV_LINK_MATCH_BODY_RETIRED`: bind the match, then
    `if to != null { link a -[:e]-> to }`.
- **`created` and `committed` leave the write handle** (`MOV_HANDLE_FIELD_RETIRED`). Why: they made
  a write handle a different type from a read. `-[:@old]->` carries the pre-write record instead, so
  an automation can say honestly whether it created or matched, and what changed. `.created` becomes
  `NOT EXISTS(h-[:@old]->)`. `.committed` becomes `FIRST(h-[:@old]->) != h` (TRUE when the write
  landed; under `dry_run` a write that matched lands on the handle itself), or is dropped where
  `dry_run` is a literal on the instance. A `dry_run` create has an empty `@old`, so for a created
  record `!= h` alone does not say the write landed. `committed` remains in the run log.
- **`write org { … }` on a write handle updates the record `org` names in place.** `org` reads the
  new values below the line; before, it kept the values of its own write. Why: the handle names a
  record, so a write to it should change what it shows. Move-up warning
  `MOV_HANDLE_UPDATED_IN_PLACE`, held until acknowledged, on the unnamed form and on
  `x = write org { … }`, which names the same record.
- **Reading a field the write did not set, off its handle, reads the record as the write found it.**
  Before, it read what the system handed back from the write, often nothing. A field set with `?:`
  or `+:` counts as not set. Why: the handle names the record, so its fields are the record's.
  Move-up warning on each such read, held until acknowledged: `MOV_HANDLE_READ_FOUND`.

### Language version 4, Luminous Owl: new

- `-[:@old]->` on any write handle: empty when the write created (under `dry_run` too), a snapshot
  of the record as it stood when it matched, the handle itself under `dry_run` when the write
  matched (an in-place write included), and the previous handle after a second write. `@old` on a
  match handle, a traversal landing or a local node is `MOV_OLD_EDGE_NOT_A_WRITE`; any other `@name`
  is `MOV_ARTIFICIAL_EDGE_UNKNOWN`.
- The named match pattern: `existing = match … { … }` then `if existing != null { … }`.
- A write off a record found earlier (`x = write c { … }` on a traversal landing or a matched
  record) is a write handle, with `@old`.

### Changes to what a saved automation does (every language version)

These apply to every language version. Full text: the [migration guide's
appendix](docs/language/luminous-owl-migration.md#appendix-every-version-changes-in-full).

- The `else` arm of a null test narrows absence. It accepts only programs that were refused before.
- An adapter edge or collection whose name starts with `@` is left out of the catalog with a note,
  instead of failing the connection's `describe`.
- An Affinity identity candidate carries the organisation's or person's fields as Affinity holds
  them, not the asserted values.

### Fixed

- An awaited `parallel` or `race` whose arms are built at run time (`await parallel(arms)`) now
  binds its result as a value that nobody can type, as the same combinator does without `await`.
  Before, it was bound as a record, so writing it into a field was refused even when the arms
  returned values. Arms that return records are now accepted there too, because the result is still
  not typed from what its arms return. The same holds, as before, for a literal arm that returns a
  record (`await parallel([() => { return org }])`). Typing the result from its arms, so both forms
  are refused, is a follow-up.

### Security

- Data from a connected system or a webhook is always treated as data. Before, a value that copied
  the shape of one of the engine's internal objects could be run as part of the automation: a
  webhook body or a field answer could make the engine follow its edges and evaluate expression text
  it carried. The engine now marks its own objects in a way no data can carry. No automation
  changes, and there is no new language version.
- A record placed inside a value is now refused when the automation is validated, as a record placed
  directly in a field already was. This covers a write or match field (`MOV_WRITE_FIELD_TYPE`) and a
  plugin argument that takes structured data or declares no type (`MOV_CALL_ARG_TYPE`), with the
  record under a key of a dict, in a list, or in either arm of an `IF`. The message names where in
  the value the record sits. Before, such an automation validated, and the connector or plugin
  received the engine's internal description of the record, including the connection's schema and
  credential name, and passed it to the vendor. Write a field off the record in its place. For a
  record the automation wrote, you can instead spread the fields it was written with (`{ ...org }`).
  Passing a whole record to a plugin argument that takes structured data still hands the plugin the
  record's fields. This applies to every language version, with no new version:
  - An affected automation shows a Validation Issue at the next release's deploy check. Its runs
    fail with `MOVENG_CHECK` until the record is taken out of the value.
  - Operators will see one `[DeployCheck] PRESERVATION FAILURE` log line for each affected
    automation. This is expected for this release.
  - The class is not fully closed. On language versions 1 and 2 only, a record handed back by a
    function called inside an expression (`company: f()`, `summarise(data: { a: f() })`) is still
    accepted, and is a follow-up. Those versions do not type a call written inside an expression.
    Versions 3 and 4 refuse it.
- A file placed inside a value is now refused when the automation is validated, as a record is. A
  file goes only into a field that holds files. This covers a write or match field
  (`MOV_WRITE_FIELD_TYPE`) and a plugin argument that takes structured data or declares no type
  (`MOV_CALL_ARG_TYPE`). The file may be under a key of a dict, in a list, in either arm of an `IF`,
  in a dict that is spread, among the fields of a record handed whole to a plugin, or handed back by
  a function. A file written straight into a field that is not a file field is refused the same way,
  a text field included. The message says "a file, not a value" and names where in the value the
  file sits. Before, only a file written straight into a json field was refused; otherwise the
  automation validated, and the connector or plugin received the file's internal descriptor. Put the
  file in a file field, or put its text in its place (`READ(f)` inside a value,
  `COALESCE(READ(f), "")` for a whole field). A field that only takes files still refuses a record,
  in either arm of an `IF` or in a spread list. This applies to every language version, with no new
  version:
  - An affected automation shows a Validation Issue at the next release's deploy check. Its runs
    fail with `MOVENG_CHECK` until it is edited. Operators will see one
    `[DeployCheck] PRESERVATION FAILURE` log line for each affected automation.
  - Attio pulled a file out of any field of a record it was writing and uploaded it as an
    attachment. So a file written into an Attio text field worked by accident; it is now refused at
    validation. Write it into a file field instead.
  - Not closed yet, and follow-ups:
    - on language versions 1 and 2 only, a file handed back by a function called inside an
      expression, for the same reason as a record;
    - a file passed to a plugin argument typed text, or a dict holding a file passed to one
      (`tag(label: f)`, `tag(label: { a: f })`);
    - a dict holding a file passed to a plugin argument typed file (`ocr(doc: { a: f })`);
    - a file joined into a text (`"x${f}"`), which renders as `[object Object]`.
- A record or file reached through `COALESCE`, `IF … THEN … ELSE … END` or `MULTI`, through a
  `through [ … ]` stage, through an extraction input, or through `AT` on a record is now refused
  when the automation is validated, or rendered as its fields. Before, the checker could not see the
  record or file there, and the engine handed its internal object onward, to a connector, a plugin,
  an extraction prompt, or a lookup. This applies to every language version, with no new version:
  - `COALESCE`, `IF` and `MULTI` hold what their operands hold. A record or file in any arm is
    refused where the direct form is (`MOV_WRITE_FIELD_TYPE`, `MOV_CALL_ARG_TYPE`), as in
    `company: COALESCE(org, "x")`, `summarise(data: MULTI(org))` or
    `title: IF c THEN f ELSE "" END`. A name bound to one carries its arms, so
    `x = IF c THEN f ELSE org END` then `upload: x` is refused, and so is `x = COALESCE(org, "x")`
    then `company: x`. `AND` and `OR` always give true or false, so a record among their operands
    goes nowhere and is still accepted.
  - A `through [ … ]` stage's argument is held to what the plugin takes, as a plain call's argument
    is (`MOV_CALL_ARG_TYPE`). A record passed whole to an argument that takes structured data, or
    that declares no type, is handed the record's fields, as a plain call's is. Before, the stage
    was handed the engine's internal object.
  - An extraction prompt shows a record as its fields, as a JSON object, at any depth
    (`extract from [org]`, `extract from [{ a: org }]`). Before, the prompt showed the engine's
    internal object, including its handle and the connection it came from. A file input is read as a
    file, as before. Every record in an input is checked, at any depth and in any arm of an
    operator, and so is a record passed whole to a plugin argument that takes structured data or
    declares no type:
    - a record whose fields include a file is refused (`MOV_EXTRACT_CONTENT`, `MOV_CALL_ARG_TYPE`),
      because the prompt or plugin would receive the file's internal descriptor. Pass the file as an
      input of its own, or its text (`READ(f)`). This is decided by the record's type, so a record
      whose system has a file field is refused even when that field is empty;
    - a system's record, whose fields are read one at a time, is refused: pass a dict of the fields
      it needs. So is a connection (`extract from [crm]`);
    - a file inside an input (under a key) is refused: pass it as an input of its own.
    - The engine refuses all of these too (`MOVENG_UNSUPPORTED`), so a file's descriptor never
      reaches a prompt.
  - `MULTI(…)` of records or files now has the type of a list of them, so `FIRST(MULTI(org))` is the
    record `org` is, and the field rules apply to it. A `MULTI` of plain values stays untyped, as
    before. `FIRST`, `LAST`, `ONLY` and `AT` at an index over a list whose type says nothing
    (`MULTI(org, "x")`, `COALESCE([org], ["x"])`) may hand back any member, so a record or file
    among the members is refused where it lands.
  - An adapter instance written straight into a field (`company: crm`, or `x = crm` then
    `company: x`, in a write or a match) is refused with `MOV_WRITE_FIELD_TYPE`, as
    `company: { a: crm }` already was. This is older than this change.
  - `AT(r, key)` on a record is refused with `MOV_AT_RECORD_KEY` for any key that is not an index
    (`AT(org, "graph")`, `AT(org, k)`, `AT(COALESCE(org, "x"), "graph")`). A record is not a map;
    read a field with a dot (`` org.`Name` ``). Before, such a lookup read nothing or the engine's
    internal member.
  - An affected automation shows a Validation Issue at the next release's deploy check. Its runs
    fail with `MOVENG_CHECK` until it is edited.

## Earlier releases

Releases before v0.11 are kept one file per minor line, newest first:

- [v0.10.x](docs/changelog/v0.10.md) (v0.10.0 to v0.10.9)
- [v0.9.x](docs/changelog/v0.9.md) (v0.9.0 to v0.9.1)
- [v0.8.x](docs/changelog/v0.8.md) (v0.8.0 to v0.8.5)
- [v0.7.x](docs/changelog/v0.7.md) (v0.7.0)
- [v0.6.x](docs/changelog/v0.6.md) (v0.6.0 to v0.6.2)
- [v0.5.x](docs/changelog/v0.5.md) (v0.5.0)
- [v0.4.x](docs/changelog/v0.4.md) (v0.4.0)
- [v0.3.x](docs/changelog/v0.3.md) (v0.3.0)
- [v0.2.x](docs/changelog/v0.2.md) (v0.2.0)
- [v0.1.x](docs/changelog/v0.1.md) (v0.1.0 to v0.1.2)

[Unreleased]: https://github.com/listen-fire/listen-fire/compare/v0.11.0...HEAD
[v0.11.0]: https://github.com/listen-fire/listen-fire/compare/v0.10.9...v0.11.0
