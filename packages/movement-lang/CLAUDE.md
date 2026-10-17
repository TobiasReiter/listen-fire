# Working on the language

Read this before changing the parser, the checker, or the type model.

## Ask these two questions first. Every time.

> ### 1. What is the simplest way to solve this using the structure of the graph?
> ### 2. What would TypeScript do?

They are not slogans. They have **repeatedly turned a feature into a deletion**,
and the times we skipped them we built a mechanism we then had to withdraw.

## Why — the evidence

From one day on `plans/2026-07-10-adapter-entry-positions` (2026-07-16/17), every
one of these came from taking the model *more* seriously, not less:

| we nearly built | asking the questions gave |
|---|---|
| extend `decidableEquality` to conjunctions | **deleted it** — narrowing evaluates a predicate; any shape composes free |
| re-key `refinementKey` over a set of (field, value) pairs | the triple **dropped out** of the design |
| a "union on the record edge" for two disagreeing listens | **withdrawn** — a listen must match the movement's signature; nothing to build |
| per-listen bookkeeping | **fell out** — identity IS the address, so two listens are two positions |
| keep the dotted type marker as an alias | **retired** — `.` is for properties, `-[:…]->` is for edges |

The things that *grew* were the hedges. 2026-07-17:

> "Adherence to a hyper-clean graph mental model has continually proven to
> simplify rather than complicate… what works best is the hyper-clean graph
> mental model that leans hard on a consistent, predictable type system (moulded
> a lot by my ts experience)."

## What the questions mean in practice

### Structural, not nominal
A type IS its structure — its derivation — never a fabricated name. **Magic
naming is nominal typing smuggled into a structural system, and it always
surfaces as a collision.** `Table "Deals"` (two bases collide, second silently
discarded) and `` `CRM — Companies` `` (had to be substring-parsed) are the same
mistake. Identity = the ADDRESS; display is a separate field.

> **The test: is it PARSED, or only COMPARED?**
> Compared-only ⇒ an identity. Parsed ⇒ magic, and it will drift.

`refinementKey` is the honest shape: an opaque token both sides derive, so they
cannot disagree.

### Predictable means it TELLS you
**Silent degradation is the absence of a guarantee, not a weaker one.** This
language's entire recurring bug class is "the type system said nothing":
`readable: true` unchecked; a listen's param type never compared; a narrowing
collision discarded; two listens comparing equal; an undescribed position
accepting any field. Treat "degrades to silence" as suspect **even where a plan
sanctions it** — several such rules have since been retired as bugs.

Watch for one value meaning two facts. "I haven't looked" and "anything goes"
are different; so are "unnarrowed" and "narrowed to nothing".

### Reach for the TS analogue — it usually dissolves the question
- a listen matching a movement = **parameter vs argument**. `f(x: int)` and
  `f(3)` both "say int"; that is type checking, not duplication.
- event action variants + their union = a **discriminated union**; `IS` = a
  **type guard**.
- a narrowing that matches nothing = **`never`** — the correct type, not a
  failure. Don't error at the narrow; error when the handle is USED.
- a typo'd literal against a known value set = an **enum** error with a
  did-you-mean (`MOV_ENUM_UNKNOWN_VALUE`), not a downstream read error.

If a design question feels novel, check whether TS already answered it.

### Be right, then break
*"If this is right then I'm happy for it to be a breaking change that I fix
up in everyone's movements."* Weighing churn against correctness is weighing the
wrong thing. Never leave a conflation in place to avoid updating fixtures.

### Be right, then break — behind a version conditional
A breaking change is still welcome, but a saved movement never sees it: it lands as a
`since`/`before` conditional on the context's `languageVersion` at the point of
difference (parser, checker, engine, plugin), the old behaviour is proved by the
older version's own test corpus run under that version, and any construct whose
meaning changed gets a diagnostic under the new version. Cleanup of a retired
version is the deletion of its conditionals and fixtures. Repo CLAUDE.md,
"Language versions", carries the full rule.

## Before you build a mechanism

**Search first.** Three times in one day the answer was already in the tree and
we nearly rebuilt it:

- `@listen-fire/shared/expression/filter.ts` — the shared predicate evaluator
  (`evaluatePredicate` / `isPurePredicate`) already handled conjunctions;
- `MOV_ENUM_UNKNOWN_VALUE` already did typo-with-did-you-mean, and simply never
  reached the event node;
- `getRecordForEvent` (Attio) was already the event→record edge the model
  wanted.

## Local gotchas

- **movement-lang's own jest is broken locally** (stale pnpm symlinks under
  `node_modules/jest` and `node_modules/ts-jest` point at `.pnpm` hashes that
  no longer exist). Run tests with `pnpm --filter @lf/movement-lang test` — the
  `test` script and the checked-in `jest.config.borrowed.cjs` borrow `apps/api`'s
  ts-jest install and jest binary instead of requiring a local reinstall.
  Expect ~60 suites / ~1770 tests green.
- **Never `pnpm build` this package in place** — the `.js` emit shadows the `.ts`
  and everything gets weird. Delete artifacts if it happens.
- A test fixture that matches one adapter's shape **cannot tell derived from
  hardcoded** — that is how a hardcoded Attio example survived in a diagnostic.
  Use a second shape.
- Diagnostics carry **no explicit severity** for errors — a test filtering
  `severity === 'error'` passes vacuously.

## The model

`plans/2026-07-10-adapter-entry-positions/` is the current authority on
type-space: describe is a walk (`2_type_space.md`), narrowing is traversal
(`4_polymorphic_edges.md`), **the path is the address** (`5_paths_as_addresses.md`),
promises belong to EDGES not nodes (`7_readable_means_readable.md`), and an event
is a meta edge you cannot traverse (`8_event_edges.md`). Later layers supersede
earlier ones; several sections are explicitly retracted — read to the end before
building.
