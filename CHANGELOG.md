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

### Changed

- Under language version 4 a run's result (and the run records and views built from it) no longer
  carries a write record's `old` member, the engine's own handle for the record as found (its
  instance, adapter slug, credential name and full schema). `-[:@old]->` still reads it during the
  run.
- Redis is optional. The API connects to Redis only when `MESSAGE_QUEUE_REDIS_HOSTNAME` is set
  (the port still defaults to 6379); unset, nothing ever tries to connect, in every environment.
  Without it the runaway-loop guard counts in each API process's memory (exact for one instance;
  several instances each count only their own firings), the icon cache is off, and in-flight MCP
  OAuth state is not shared between instances. The bundled composition and the Render blueprint
  still name their Redis. The `localhost` default the API used outside production moved into the
  dev loop, which exports it for the Redis container it runs.

### Fixed

- A Redis outage no longer stalls automations. The loop guard is meant to step aside when Redis is
  unreachable, but a dead Redis used to hang every trigger dispatch indefinitely. Connecting to
  Redis now gives up within seconds, and the guard lets runs through unchecked, pausing its
  counting for five seconds at a time until Redis is back.
- A file whose extracted text contains NUL characters (a PDF with glyphs its font map has no name
  for) no longer fails the run. The text is stored with each NUL replaced by a space, and a failure
  to store the extracted text as provenance is logged rather than failing the run.

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
