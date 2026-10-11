# Language versions

Version: 4

Every saved movement is pinned to the language version it was written against: an integer with a two-word name. The pin governs syntax and semantics, and every layer honours it: the parser, the checker, both engines, plugins and adapters. The version above is the current one, what a movement saved today is pinned to and what an entry point given no version compiles and runs under.

- **The table:** `LANGUAGE_VERSIONS`, `CURRENT_LANGUAGE_VERSION`, `SUPPORTED_LANGUAGE_VERSIONS` and `DEPRECATED_LANGUAGE_VERSIONS` (`packages/movement-lang/language_version.ts`); the Rust side's is `crates/movement-parser/src/version.rs`. A test holds them equal to this document.
- **On the wire:** the pin travels as `languageVersion` with a run's input, on `segment.open` (so an in-process adapter reads it from its segment), and on the checker's `check.program`. A remote adapter does not receive it: the adapter protocol carries no `languageVersion` today.

## The versions

| version | name | supported | deprecated | is |
|---|---|---|---|---|
| 1 | Quiet Heron | yes | no | the language as of tag v0.6.0 |
| 2 | Bright Otter | yes | no | the language from v0.7.0 through v0.9.1 |
| 3 | Steady Lynx | yes | no | the language from v0.10.0: a list literal is a tuple, exact at a literal index and a list of its members' union elsewhere |
| 4 | Luminous Owl | yes | no | the language from v0.11.0: a match yields absent on a miss, a write handle reaches its pre-write record through `@old` |

The integer is the identity: code compares it and never parses the name, which is display only. A version keeps its row after it leaves the supported set, so a movement pinned to it can still be refused by name. [`docs/language/steady-lynx-migration.md`](../language/steady-lynx-migration.md) is the migration guide from version 2 to 3, and [`docs/language/luminous-owl-migration.md`](../language/luminous-owl-migration.md) from 3 to 4.

## The rules

Breaking changes never break a saved movement.

- **A break is a version conditional, never a fork.** A spelling retired, a construct's meaning changed, a plugin's output reshaped, an engine rule tightened: each lands as a conditional (`since(v, n)` or `before(v, n)` on the compile or run context's `languageVersion`) at the point of difference in the parser, checker, engine, plugin or adapter. Never a forked parser, never a second engine.
- **The old behaviour is proved by its own corpus.** Each older version's test corpus runs against the current code under that version. Adding a version adds its fixtures; removing one deletes its conditionals and its fixtures.
- **A changed meaning is diagnosed.** Any construct whose meaning changed gets a checker diagnostic under the new version, so "validates clean under the new version" can never hide a silent behaviour change.
- **A release names what it supports and deprecates.** Unsupported: validate and run refuse, loudly (`MOV_LANGUAGE_VERSION_UNSUPPORTED`, naming the version and the fix). Deprecated: it runs, with a warning (`MOV_LANGUAGE_VERSION_DEPRECATED`).
- **The pin moves only on purpose.** By the deploy check (auto-advance when the movement validates clean under the newer version) or an explicit upgrade; never by an ordinary edit.
- **The CHANGELOG says why.** The entry for a break names the version that introduces it and why.

## Changes

- **4, Luminous Owl** (v0.11.0): a named `match` yields its handle or absent, and a miss no longer ends the scope (an unnamed match and `link … { match … }` are refused); `created` and `committed` are retired; `-[:@old]->` off a write handle is the record the write found; `write org { … }` on a handle updates it in place; a handle reads the record as found for a field its write did not set; `@` is reserved for artificial edges. Both engines run them (the Rust engine since PLAN-07A Task 4c, each change a `since(v, 4)` conditional where it differs).
- **3, Steady Lynx** (v0.10.0): a list literal is a tuple. Exact at a literal index; a list of its members' union elsewhere.
- **2, Bright Otter** (v0.7.0 through v0.9.1).
- **1, Quiet Heron**: the language as of tag v0.6.0, the first pinned version.
