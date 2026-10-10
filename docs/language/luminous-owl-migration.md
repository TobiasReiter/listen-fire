# Migrating to Luminous Owl (4)

Language version 4, **Luminous Owl**, arrives after v0.10.9. The release's [changelog entry](../../CHANGELOG.md) lists each change in a line; this guide carries the full detail, grouped by topic. Every rule here that says "under Luminous Owl (4)" applies only to an automation pinned to version 4. Quiet Heron (1), Bright Otter (2) and Steady Lynx (3) keep their old behaviour, except where a rule says it applies under every version.

## Contents

- [1. How the pin moves](#1-how-the-pin-moves)
- [2. A named match yields a handle or absent](#2-a-named-match-yields-a-handle-or-absent)
- [3. Retired and refused forms](#3-retired-and-refused-forms)
- [4. A write handle has no created or committed](#4-a-write-handle-has-no-created-or-committed)
- [5. The old edge: what a write found](#5-the-old-edge-what-a-write-found)
- [6. A write on a write handle updates in place](#6-a-write-on-a-write-handle-updates-in-place)
- [7. Diagnostic code index](#7-diagnostic-code-index)
- [Appendix: every-version changes in full](#appendix-every-version-changes-in-full)

## 1. How the pin moves

- Language version 4 arrives: **Luminous Owl**. A new automation is written in it, and the deploy check moves an automation up to it when it validates cleanly there: no error and no move-up warning.
- An automation with an error under Luminous Owl (4), or with a move-up warning, stays on its version. It shows the **Review** badge, and the automation page lists the diagnostics. Three warnings are move-up warnings, because they mark places where the same text now does something different:
  - `MOV_MATCH_MISS_CONTINUES` on every bound match: a miss no longer ends the enclosing scope (see [section 2](#2-a-named-match-yields-a-handle-or-absent)).
  - `MOV_HANDLE_UPDATED_IN_PLACE` on a `write` off a write handle (see [section 6](#6-a-write-on-a-write-handle-updates-in-place)).
  - `MOV_HANDLE_READ_FOUND` on a read, off a write handle, of a field that write did not set (see [section 5](#5-the-old-edge-what-a-write-found)).
- A move-up warning fires whether or not the code was edited, so it holds the pin until you acknowledge it. Read each warning, edit what assumed the old behaviour, then upgrade with `upgradeAutomation` and acknowledge. An error cannot be acknowledged: repair it first.

## 2. A named match yields a handle or absent

- Under Luminous Owl (4) a named `match` yields `handle | absent`. A miss binds absent and the block carries on. Under versions 1 to 3 a miss ended the enclosing scope quietly. Why: ending the scope was never the intent, and it made `match` useless as a lookup, since the rest of the block could never run on a miss.
- Guard the handle before using it. The guards are `== null`, `!= null`, `EXISTS(…)` and `ISNULL(…)`:

```
existing = match crm-[:Companies]-> { unique by (`Domain`), Domain: domain }
if existing != null {
  link person -[:Employer]-> existing
}
```

- The `else` arm of a null test sees the record present: after `if existing == null { … } else { … }`, `existing` is a handle in the `else` arm.
- Using the handle unguarded where a value is required is `MOV_ABSENT_REQUIRED`. That covers a field read written into a required field, and a handle passed where a record is required.
- A `link` or `unlink` whose end may be absent is `MOV_ABSENT_REQUIRED` until guarded. This covers a match handle and a `FIRST(…)` result. Under every earlier version the end was not checked.
- `MOV_MATCH_MISS_CONTINUES` is a move-up warning, not a refusal: it holds the pin until acknowledged. It marks every bound match, because code below the match used to be skipped on a miss and now runs. If the code below assumed a hit, add the guard.
- Versions 1 to 3 keep the old behaviour exactly (proved by the version 3 conformance corpus).

## 3. Retired and refused forms

Each is refused at save under Luminous Owl (4), with what to write instead.

- An unnamed `match … { }` is `MOV_MATCH_UNNAMED`. Why: with a miss continuing, an unnamed match has nothing to say what happened. Name it and guard it:

```
# before
match crm-[:Companies]-> { unique by (`Domain`), Domain: domain } {
  write crm-[:Notes]-> { Body: "seen again" }
}

# after
existing = match crm-[:Companies]-> { unique by (`Domain`), Domain: domain }
if existing != null {
  write crm-[:Notes]-> { Body: "seen again" }
}
```

- A `link` whose target is a `match` body is `MOV_LINK_MATCH_BODY_RETIRED`. Why: it ended the scope on a miss, which no longer exists as an idea. Bind the match and guard the link:

```
# before
link a -[:Employer]-> { match crm-[:Companies]-> { unique by (`Domain`), Domain: domain } }

# after
to = match crm-[:Companies]-> { unique by (`Domain`), Domain: domain }
if to != null {
  link a -[:Employer]-> to
}
```

- Versions 1 to 3 keep both forms.

## 4. A write handle has no created or committed

- Under Luminous Owl (4), reading `.created` or `.committed` off a write handle is `MOV_HANDLE_FIELD_RETIRED`. Why: they made a write handle a different type from a read. A handle now has the record's own fields and edges only, and `-[:@old]->` (see [section 5](#5-the-old-edge-what-a-write-found)) carries what the write found, so an automation can say honestly whether it created or matched, and what changed.
- Rewrites:

| Before | After |
| --- | --- |
| `h.created` | `NOT EXISTS(h-[:@old]->)`, or `FIRST(h-[:@old]->) == null` |
| `h.committed` | `FIRST(h-[:@old]->) != h` (TRUE when the write landed: under `dry_run` a write that matched lands on the handle itself), or drop the test where `dry_run` is a literal on the instance |

- A `dry_run` create has an empty `@old`, so for a created record `!= h` alone does not say the write landed. Written out in full, `NOT EXISTS(h-[:@old]->) OR FIRST(h-[:@old]->) != h` is TRUE for every create, live or rehearsed. Where `dry_run` is a literal on the instance, drop the test.

- `committed` remains in the run log, which `inspectRun` shows.
- Versions 1 to 3 keep both fields.

## 5. The old edge: what a write found

- New under Luminous Owl (4): every write handle has a `-[:@old]->` edge. It reaches the record the write found before it wrote:

| The write | `-[:@old]->` reaches |
| --- | --- |
| Created a record | nothing (empty) |
| Matched an existing record | a snapshot: a distinct position, the values as they stood. It holds the fields the lookup fetched, plus every field this write set |
| Matched and changed nothing | equal values, but still a distinct position |
| Ran under `dry_run` and matched, an in-place `write org { … }` included | the handle itself |
| Ran under `dry_run` and created | nothing (empty) |
| Follows an earlier write to the same record | the previous handle |

```
org = write crm-[:Companies]-> { unique by (`Domain`), Domain: domain, Name: name }
was = FIRST(org-[:@old]->)
if was != null AND was.Name != org.Name {
  # the write renamed it
}
```

- After a second write, walk the chain in two steps: `prev = FIRST(org-[:@old]->)`, then `FIRST(prev-[:@old]->)`. A hop off a call inside a formula does not parse, so it cannot be written in one.
- `EXISTS(org-[:@old]->)` after a second write is always `TRUE`, since the previous handle exists.
- A write off a record found earlier (`x = write c { … }` on a traversal landing or a matched record) is a write handle too, and has `@old`.
- `@old` on a match handle, a traversal landing or a local node is `MOV_OLD_EDGE_NOT_A_WRITE`. Any other `@name` is `MOV_ARTIFICIAL_EDGE_UNKNOWN`.
- Under Quiet Heron (1), Bright Otter (2) and Steady Lynx (3) the edge does not exist: `-[:@old]->` is the plain unknown edge, `MOV_TRAVERSE_UNKNOWN_EDGE`.
- Under Luminous Owl (4), reading a field off a write handle that the write did not set with `:` reads the record as the write found it. Under versions 1 to 3 it read what the system handed back from the write, which was often nothing, and nothing when the write changed nothing. A field set with `?:` or `+:` counts as not set. Why: the handle names the record, so its fields are the record's.
- `MOV_HANDLE_READ_FOUND` is a move-up warning on each such read, and holds the pin until acknowledged. If the code assumed the old reading (for example, an empty value meaning "the write did not touch it"), change it, then upgrade.

## 6. A write on a write handle updates in place

- Under Luminous Owl (4), `write org { … }` on a write handle updates the record `org` names, in place, and `org` reads the new values below the line. Under versions 1 to 3, `org` kept the values of its own write. Why: the handle names a record, so writing to it should change what the handle shows.
- The named form, `x = write org { … }`, names the same record as `org`, and carries its own `@old` (the previous handle).

```
org = write crm-[:Companies]-> { unique by (`Domain`), Domain: domain, Name: name }
write org { Stage: "Customer" }
# org.Stage is "Customer" here; before, it was whatever the first write left
```

- `MOV_HANDLE_UPDATED_IN_PLACE` is a move-up warning on the unnamed form and on the named form, and holds the pin until acknowledged. It marks places where a read of the handle below the write sees different values than before.

## 7. Diagnostic code index

| Code | Where |
| --- | --- |
| `MOV_ABSENT_REQUIRED` | [A named match yields a handle or absent](#2-a-named-match-yields-a-handle-or-absent) (new sites: a match handle used unguarded, and an absent end of a `link` or `unlink`) |
| `MOV_ARTIFICIAL_EDGE_UNKNOWN` | [The old edge](#5-the-old-edge-what-a-write-found) |
| `MOV_HANDLE_FIELD_RETIRED` | [A write handle has no created or committed](#4-a-write-handle-has-no-created-or-committed) |
| `MOV_HANDLE_READ_FOUND` | [The old edge](#5-the-old-edge-what-a-write-found) (move-up warning) |
| `MOV_HANDLE_UPDATED_IN_PLACE` | [A write on a write handle updates in place](#6-a-write-on-a-write-handle-updates-in-place) (move-up warning) |
| `MOV_LINK_MATCH_BODY_RETIRED` | [Retired and refused forms](#3-retired-and-refused-forms) |
| `MOV_MATCH_MISS_CONTINUES` | [A named match yields a handle or absent](#2-a-named-match-yields-a-handle-or-absent) (move-up warning) |
| `MOV_MATCH_UNNAMED` | [Retired and refused forms](#3-retired-and-refused-forms) |
| `MOV_OLD_EDGE_NOT_A_WRITE` | [The old edge](#5-the-old-edge-what-a-write-found) |

## Appendix: every-version changes in full

These apply under every language version, as widenings that accept only what was refused before, or as fixes. The changelog lists each in one line; this is the full text.

- This applies to every language version: the `else` arm of a null test narrows absence. After `if x == null { … } else { … }`, `x` is present in the `else` arm. Before, the arm was refused when it used `x` as a value. It accepts only programs that were refused before.
- This applies to every language version: an adapter edge or collection whose name starts with `@` is left out of the catalog with a note, instead of failing the connection's `describe`. Names starting with `@` are reserved for the language's own edges, such as `@old`.
- This applies to every language version: an Affinity identity candidate carries the organisation's or person's fields as Affinity holds them, not the values the write asserted. A match handle's fields and `@old` therefore show the system's record, not the request.
