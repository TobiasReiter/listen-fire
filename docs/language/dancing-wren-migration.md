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
- [11. Diagnostic code index](#11-diagnostic-code-index)

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
| `-[:#name]->` | `MOV_HANDLE_FILE_NOT_SENT` | [A write handle's unsent file is not a file](#10-a-write-handles-unsent-file-is-not-a-file) |
| `MOV_META_HOP_RETIRED` | an edge the record has, or the plugin called as a function |
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
## 9. A record a combinator arm hands back reads as itself

- Under Dancing Wren (5) a slot of a `parallel` / `race` receipt that holds the record an arm returned reads as that record: `AT(r, 0).name`, `h = AT(r, 0)` then `h.name`, and `AT(r, 0) == null` (false). It is the reading `AT([a, 2], 0)` already had on a list.
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
write crm-[:notes]-> { title: AT(r, 0).name }   # 5: "Acme"; 4 and earlier: null
```

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

## 11. Diagnostic code index

| Code | Where |
| --- | --- |
| `MOV_CALL_ARG_MAYBE_RECORD` | [A value that may be a record is no record parameter](#8-a-value-that-may-be-a-record-is-no-record-parameter) |
| `MOV_DELETE_NOT_DECLARED` | [`delete` only where the system declares it](#4-delete-only-where-the-system-declares-it) |
| `MOV_DELETE_NOT_RECORD` | [`delete` only where the system declares it](#4-delete-only-where-the-system-declares-it) |
| `MOV_FILE_IN_TEXT` | [A file is never joined into text](#6-a-file-is-never-joined-into-text) |
| `MOV_META_HOP_RETIRED` | [`#` hops are retired](#3--hops-are-retired-a-plugin-is-a-function) |
| `MOV_RECEIPT_RECORD_SLOT` | [A record a combinator arm hands back reads as itself](#9-a-record-a-combinator-arm-hands-back-reads-as-itself) (warning, on a move up across 5) |
| `MOV_RETURN_TYPE` | [A declared return takes what the body may return](#7-a-declared-return-takes-what-the-body-may-return) (a body's returns that may hold a record or file; since 5) |
| `MOV_RESOURCES_NOT_EXTRACTED` | [`_resources` only on an extraction's result](#5-_resources-only-on-an-extractions-result) |
| `MOV_TRANSFORM_HOP_RETIRED` | [`#` hops are retired](#3--hops-are-retired-a-plugin-is-a-function) (since 3; under 5 the message shows the function form) |
| `MOV_WRITE_BIND_RETIRED` | [`write … bind` is retired](#2-write--bind-is-retired) |
